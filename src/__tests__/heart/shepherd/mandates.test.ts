import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  readShepherdMandates, resolveShepherdMandate, updateShepherdMandate,
} from "../../../heart/shepherd/mandates"
import type { ShepherdMandateRequest, ShepherdMandateState, ShepherdMandateTarget } from "../../../heart/shepherd/types"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual, mkdirSync: vi.fn(actual.mkdirSync), fstatSync: vi.fn(actual.fstatSync), readSync: vi.fn(actual.readSync),
    realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: vi.fn(actual.realpathSync.native) }),
  }
})

let root: string
let project: string
const DAY = 86_400_000
const NOW = Date.parse("2026-10-17T20:00:00.000Z")
const directory = () => path.join(root, "state", "senses", "shepherd")
const file = () => path.join(directory(), "mandates.json")
const context = (requestId: string) => ({ kind: "local_owner_administration" as const, actorId: "existing-owner", requestId })
const target = (): ShepherdMandateTarget => ({ project, host: "cmux", session: "session-1", instance: "pid:123:start:456" })
const grant = (requestId = "grant-1", expectedRevision = 0): ShepherdMandateRequest => ({
  operation: "grant", context: context(requestId), expectedRevision,
  target: { project }, task: "Finish the agreed implementation and verify it.", expiresAt: new Date(NOW + DAY).toISOString(),
})
const save = (state: ShepherdMandateState) => fs.writeFileSync(file(), JSON.stringify(state), { mode: 0o600 })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(Date, "now").mockReturnValue(NOW)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-mandates-")))
  project = fs.mkdirSync(path.join(root, "project"), { recursive: true })!
})

describe("trusted Shepherd mandate store", () => {
  it("reads missing state without creating anything and grants no authority", () => {
    expect(readShepherdMandates(root)).toEqual({ version: 1, revision: 0, mandates: [], requests: [] })
    expect(fs.existsSync(path.join(root, "state"))).toBe(false)
    expect(resolveShepherdMandate(readShepherdMandates(root), target(), NOW)).toEqual({ state: "withheld", reason: "no_applicable_mandate" })
  })

  it("persists a bounded continuation-only grant and owner provenance across reloads", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      const receipt = await updateShepherdMandate(root, grant())
      expect(receipt).toMatchObject({ revision: 1, operation: "grant", mandateId: expect.stringMatching(/^mandate:[a-f0-9]{64}$/), provenance: { ...context("grant-1"), at: new Date(NOW).toISOString() } })
      const state = readShepherdMandates(root)
      expect(state.mandates[0]).toMatchObject({
        id: receipt.mandateId, revision: 1, target: { project }, task: "Finish the agreed implementation and verify it.",
        action: "continue_text", status: "active", createdAt: new Date(NOW).toISOString(), revoked: null,
      })
      expect(resolveShepherdMandate(state, target(), NOW)).toEqual({ state: "authorized", mandate: state.mandates[0] })
      expect(fs.statSync(directory()).mode & 0o777).toBe(0o700)
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(directory())).toEqual(["mandates.json"])
      expect(events).toContainEqual(expect.objectContaining({ event: "heart.shepherd_mandate_mutated", meta: { operation: "grant", revision: 1 } }))
      expect(JSON.stringify(events)).not.toContain("Finish the agreed implementation")
    } finally { unregister() }
  })

  it("matches exact project and optional exact host/session/instance, never prefixes or aliases", async () => {
    await updateShepherdMandate(root, { ...grant(), target: target() })
    const state = readShepherdMandates(root)
    for (const changed of [{ project: `${project}-other` }, { host: "herdr" }, { session: "session-2" }, { instance: "pid:123:start:789" }, { instance: undefined }]) {
      expect(resolveShepherdMandate(state, { ...target(), ...changed }, NOW).state).toBe("withheld")
    }
    const alias = path.join(root, "alias")
    fs.symlinkSync(project, alias)
    expect(resolveShepherdMandate(state, { ...target(), project: alias }, NOW).state).toBe("withheld")
    for (const invalid of [alias, `${project}/..`, `${project}/`, project.toUpperCase(), "project", path.join(root, "missing")]) {
      await expect(updateShepherdMandate(root, { ...grant("invalid", 1), target: { project: invalid } })).rejects.toThrow(/canonical project/)
    }
    expect(readShepherdMandates(root).revision).toBe(1)
  })

  it("withholds expired and revoked grants, preserves original grant and revocation provenance", async () => {
    const receipt = await updateShepherdMandate(root, grant())
    expect(resolveShepherdMandate(readShepherdMandates(root), target(), NOW + DAY).state).toBe("withheld")
    const revoked = await updateShepherdMandate(root, { operation: "revoke", context: context("revoke"), expectedRevision: 1, mandateId: receipt.mandateId })
    expect(revoked.revision).toBe(2)
    expect(readShepherdMandates(root).mandates[0]).toMatchObject({
      status: "revoked", revision: 2, provenance: { requestId: "grant-1" }, revoked: { requestId: "revoke" },
    })
    expect(resolveShepherdMandate(readShepherdMandates(root), target(), NOW).state).toBe("withheld")
    await expect(updateShepherdMandate(root, { operation: "revoke", context: context("unknown"), expectedRevision: 2, mandateId: "missing" })).rejects.toThrow(/mandate.*not found/)
  })

  it("refuses overlapping applicable grants rather than picking specificity or last writer", async () => {
    await updateShepherdMandate(root, grant())
    await updateShepherdMandate(root, { ...grant("specific", 1), target: target() })
    expect(resolveShepherdMandate(readShepherdMandates(root), target(), NOW)).toEqual({ state: "withheld", reason: "ambiguous_mandates" })
  })

  it("replays the original receipt, conflicts on changed arguments and checks optimistic revisions", async () => {
    const request = grant()
    const receipt = await updateShepherdMandate(root, request)
    vi.spyOn(Date, "now").mockReturnValue(NOW + 8 * DAY)
    expect(await updateShepherdMandate(root, request)).toEqual(receipt)
    await expect(updateShepherdMandate(root, { ...request, task: "Different task" } as ShepherdMandateRequest)).rejects.toThrow(/request.*different/)
    await expect(updateShepherdMandate(root, { ...request, context: context("stale") })).rejects.toThrow(/revision/)
    expect(readShepherdMandates(root).revision).toBe(1)
  })

  it("serializes concurrent writers without losing successful revisions or replay barriers", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => updateShepherdMandate(root, grant(`writer-${i}`))))
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(4)
    expect(readShepherdMandates(root).revision).toBe(1)
    const duplicate = grant("duplicate", 1)
    const receipts = await Promise.all(Array.from({ length: 5 }, () => updateShepherdMandate(root, duplicate)))
    expect(new Set(receipts.map(receipt => JSON.stringify(receipt))).size).toBe(1)
    expect(readShepherdMandates(root).revision).toBe(2)
  })

  it("serializes independently launched processes with explicit revision conflicts", async () => {
    const script = `
      const fs = require("node:fs"), ts = require("typescript");
      require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText, file);
      require(process.argv[1]).updateShepherdMandate(process.argv[2], JSON.parse(process.argv[3])).then(
        receipt => process.stdout.write(JSON.stringify(receipt)),
        error => { process.stdout.write(JSON.stringify({ error: error.message })); }
      );
    `
    const request = grant("process-replay")
    // Child clocks are real; keep the explicit expiry inside seven days of both clocks.
    if (request.operation === "grant") request.expiresAt = new Date(new Date().getTime() + DAY).toISOString()
    const run = promisify(execFile)
    const results = await Promise.all(Array.from({ length: 3 }, () => run(process.execPath, [
      "-e", script, path.resolve("src/heart/shepherd/mandates.ts"), root, JSON.stringify(request),
    ])))
    const receipts = results.map(result => JSON.parse(result.stdout))
    expect(receipts[0]).toMatchObject({ revision: 1, operation: "grant" })
    expect(receipts).toEqual([receipts[0], receipts[0], receipts[0]])
    expect(readShepherdMandates(root).revision).toBe(1)
  })

  it("rejects malformed administrative requests without creating state", async () => {
    const invalid: unknown[] = [
      { ...grant(), context: { ...context("x"), kind: "browser" } },
      { ...grant(), context: { ...context("x"), actorId: "" } },
      { ...grant(), context: { ...context("x"), requestId: "x\n" } },
      { ...grant(), context: { ...context("x"), actorId: "a".repeat(201) } },
      { ...grant(), expectedRevision: -1 }, { ...grant(), expectedRevision: 0.5 },
      { ...grant(), task: "" }, { ...grant(), task: "x".repeat(2001) },
      { ...grant(), expiresAt: new Date(NOW).toISOString() },
      { ...grant(), expiresAt: new Date(NOW + 7 * DAY + 1).toISOString() },
      { ...grant(), expiresAt: "not a date" }, { ...grant(), expiresAt: "2026-10-18" },
      { ...grant(), target: { project, host: "" } }, { ...grant(), target: { project, session: "session-1" } },
      { ...grant(), target: { project, instance: "instance-without-host-session" } },
      { ...grant(), action: "press_key" }, null,
    ]
    for (const input of invalid) {
      await expect(updateShepherdMandate(root, input as ShepherdMandateRequest)).rejects.toThrow()
      expect(fs.existsSync(directory())).toBe(false)
    }
  })

  it("accepts exactly seven days and 2000 task characters but bounds active grants at 100", async () => {
    await updateShepherdMandate(root, { ...grant(), task: "x".repeat(2000), expiresAt: new Date(NOW + 7 * DAY).toISOString() } as ShepherdMandateRequest)
    for (let i = 1; i < 100; i++) await updateShepherdMandate(root, grant(`g${i}`, i))
    const before = fs.readFileSync(file(), "utf8")
    await expect(updateShepherdMandate(root, grant("overflow", 100))).rejects.toThrow(/100 active/)
    expect(fs.readFileSync(file(), "utf8")).toBe(before)
    const id = readShepherdMandates(root).mandates[0]!.id
    await updateShepherdMandate(root, { operation: "revoke", context: context("free-slot"), expectedRevision: 100, mandateId: id })
    await updateShepherdMandate(root, grant("replacement", 101))
    expect(readShepherdMandates(root).mandates).toHaveLength(101)
  })

  it("bounds encoded bytes without pruning historical provenance or changing the last good state", async () => {
    const receipt = await updateShepherdMandate(root, { ...grant(), task: "\u{1f9ed}".repeat(1000) } as ShepherdMandateRequest)
    await updateShepherdMandate(root, { operation: "revoke", context: context("revoke"), expectedRevision: 1, mandateId: receipt.mandateId })
    const state = readShepherdMandates(root)
    // Seed valid revoked history so this tests bytes, not hundreds of unrelated fsyncs.
    while (Buffer.byteLength(JSON.stringify(state)) < 2 * 1024 * 1024 - 3000) {
      const previous = state.mandates[0]!
      const requestId = `historical-${state.revision}`
      const id = `mandate:${createHash("sha256").update(JSON.stringify(["existing-owner", requestId])).digest("hex")}`
      const provenance = { ...previous.provenance, requestId }
      const revoked = { ...previous.revoked!, requestId: `revoke-${requestId}` }
      const grantReceipt = { ...state.requests[0]!.receipt, revision: ++state.revision, mandateId: id, provenance }
      const revokeReceipt = { ...state.requests[1]!.receipt, revision: ++state.revision, mandateId: id, provenance: revoked }
      state.mandates.push({ ...previous, id, revision: state.revision, provenance, revoked })
      state.requests.push(
        { ...state.requests[0]!, requestId, receipt: grantReceipt },
        { ...state.requests[1]!, requestId: revoked.requestId, receipt: revokeReceipt },
      )
    }
    save(state)
    expect(readShepherdMandates(root).revision).toBe(state.revision)
    const before = fs.readFileSync(file(), "utf8")
    await expect(updateShepherdMandate(root, { ...grant("too-large", state.revision), task: "\u{1f9ed}".repeat(1000) } as ShepherdMandateRequest)).rejects.toThrow(/2 MiB/)
    expect(fs.readFileSync(file(), "utf8")).toBe(before)
  })

  it("refuses corrupt, linked, oversized or incorrectly permissioned stores", async () => {
    await updateShepherdMandate(root, grant())
    const baseline = readShepherdMandates(root)
    const invalid: unknown[] = [
      { ...baseline, version: 2 }, { ...baseline, revision: -1 }, { ...baseline, mandates: null },
      { ...baseline, mandates: [{ ...baseline.mandates[0], action: "press_key" }] },
      { ...baseline, mandates: [{ ...baseline.mandates[0], status: "revoked" }] },
      { ...baseline, mandates: [{ ...baseline.mandates[0], expiresAt: "tomorrow" }] },
      { ...baseline, mandates: [{ ...baseline.mandates[0], target: { project: "relative" } }] },
      { ...baseline, requests: [...baseline.requests, baseline.requests[0]] },
      { ...baseline, requests: [{ ...baseline.requests[0], hash: "bad" }] },
    ]
    for (const corrupt of invalid) {
      fs.writeFileSync(file(), JSON.stringify(corrupt))
      expect(() => readShepherdMandates(root)).toThrow(/schema/)
      await expect(updateShepherdMandate(root, grant("after-corrupt", 1))).rejects.toThrow(/schema/)
    }
    fs.writeFileSync(file(), "{")
    expect(() => readShepherdMandates(root)).toThrow(/JSON/)
    fs.writeFileSync(file(), " ".repeat(2 * 1024 * 1024 + 1))
    expect(() => readShepherdMandates(root)).toThrow(/2 MiB/)
    save(baseline)
    fs.chmodSync(file(), 0o644)
    expect(() => readShepherdMandates(root)).toThrow(/0600/)
    fs.chmodSync(file(), 0o600)
    fs.chmodSync(directory(), 0o755)
    expect(() => readShepherdMandates(root)).toThrow(/0700/)
    fs.chmodSync(directory(), 0o700)
    fs.renameSync(file(), `${file()}.saved`)
    fs.symlinkSync(`${file()}.saved`, file())
    expect(() => readShepherdMandates(root)).toThrow(/regular file/)
    await expect(updateShepherdMandate(root, grant("linked", 1))).rejects.toThrow(/regular file/)
  })

  it("does not follow ancestor links or repair insecure directories during mutation", async () => {
    const outside = fs.mkdtempSync(path.join(root, "outside-"))
    fs.symlinkSync(outside, path.join(root, "state"))
    expect(() => readShepherdMandates(root)).toThrow(/directory/)
    await expect(updateShepherdMandate(root, grant())).rejects.toThrow(/directory/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it("refuses wrong ownership and hard-linked authority files", async () => {
    await updateShepherdMandate(root, grant())
    fs.linkSync(file(), path.join(directory(), "hardlink"))
    expect(() => readShepherdMandates(root)).toThrow(/single link/)
    const owner = process.getuid!()
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1)
    expect(() => readShepherdMandates(root)).toThrow(/owner/)
  })

  it("refuses invalid in-memory authority and noncanonical live project observations", async () => {
    await updateShepherdMandate(root, grant())
    const state = readShepherdMandates(root)
    expect(resolveShepherdMandate(null as never, target(), NOW)).toEqual({ state: "withheld", reason: "invalid_mandate_state" })
    expect(resolveShepherdMandate(state, target(), NaN).state).toBe("withheld")
    expect(resolveShepherdMandate(state, { project: "relative" }, NOW)).toEqual({ state: "withheld", reason: "invalid_project" })
    expect(resolveShepherdMandate(state, { project: path.join(root, "missing") }, NOW)).toEqual({ state: "withheld", reason: "invalid_project" })
    expect(resolveShepherdMandate(state, target(), NOW - 1).state).toBe("withheld")
    expect(resolveShepherdMandate(state, { project: "/" }, NOW).state).toBe("withheld")
    const notDirectory = path.join(root, "plain-file")
    fs.writeFileSync(notDirectory, "")
    await expect(updateShepherdMandate(root, { ...grant("plain-file", 1), target: { project: notDirectory } })).rejects.toThrow(/canonical project/)
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" })
    vi.mocked(fs.realpathSync.native).mockImplementationOnce(() => { throw denied })
    expect(() => resolveShepherdMandate(state, target(), NOW)).toThrow(denied)
    vi.mocked(fs.realpathSync.native).mockImplementationOnce(() => { throw new Error("unexpected filesystem fault") })
    expect(() => resolveShepherdMandate(state, target(), NOW)).toThrow(/unexpected filesystem fault/)
  })

  it("does not create state for unknown revocations or stale initial grants", async () => {
    await expect(updateShepherdMandate(root, { operation: "revoke", context: context("unknown"), expectedRevision: 0, mandateId: "unknown" })).rejects.toThrow(/not found/)
    await expect(updateShepherdMandate(root, grant("stale", 1))).rejects.toThrow(/revision/)
    expect(fs.existsSync(directory())).toBe(false)
  })

  it("rejects new expired grants in an existing store and refuses repeated revocation or a backward clock", async () => {
    const first = await updateShepherdMandate(root, grant())
    await expect(updateShepherdMandate(root, { ...grant("expired", 1), expiresAt: new Date(NOW).toISOString() } as ShepherdMandateRequest)).rejects.toThrow(/seven days/)
    vi.spyOn(Date, "now").mockReturnValue(NOW - 1)
    await expect(updateShepherdMandate(root, { operation: "revoke", context: context("clock"), expectedRevision: 1, mandateId: first.mandateId })).rejects.toThrow(/clock/)
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    await updateShepherdMandate(root, { operation: "revoke", context: context("revoke"), expectedRevision: 1, mandateId: first.mandateId })
    await expect(updateShepherdMandate(root, { operation: "revoke", context: context("again"), expectedRevision: 2, mandateId: first.mandateId })).rejects.toThrow(/already revoked/)
    expect(readShepherdMandates(root).revision).toBe(2)
  })

  it("rejects duplicate mandate identities and fabricated operation history", async () => {
    const first = await updateShepherdMandate(root, grant())
    await updateShepherdMandate(root, { operation: "revoke", context: context("revoke"), expectedRevision: 1, mandateId: first.mandateId })
    const baseline = readShepherdMandates(root)
    for (const corrupt of [
      { ...baseline, mandates: [baseline.mandates[0], baseline.mandates[0]] },
      { ...baseline, requests: [baseline.requests[0], { ...baseline.requests[1], receipt: { ...baseline.requests[1]!.receipt, operation: "grant" } }] },
      { ...baseline, requests: [], revision: 0 },
    ]) {
      fs.writeFileSync(file(), JSON.stringify(corrupt))
      expect(() => readShepherdMandates(root)).toThrow(/schema/)
    }
  })

  it("tolerates a concurrent mkdir winner but surfaces real directory creation errors", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    vi.mocked(fs.mkdirSync).mockImplementationOnce((candidate, options) => {
      actual.mkdirSync(candidate, options)
      throw Object.assign(new Error("concurrent creator"), { code: "EEXIST" })
    })
    await updateShepherdMandate(root, grant())
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-mandates-fault-")))
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("access denied"), { code: "EACCES" }) })
    await expect(updateShepherdMandate(root, grant())).rejects.toThrow(/access denied/)
  })

  it("refuses changed inodes and growing files rather than trusting the path check", async () => {
    await updateShepherdMandate(root, grant())
    vi.mocked(fs.fstatSync).mockReturnValueOnce(Object.assign(fs.statSync(file()), { ino: 0 }))
    expect(() => readShepherdMandates(root)).toThrow(/changed during read/)
    vi.mocked(fs.readSync).mockReturnValueOnce(2 * 1024 * 1024 + 1)
    expect(() => readShepherdMandates(root)).toThrow(/2 MiB/)
  })

  it("refuses missing bundles, unsafe ancestors and platforms without ownership checks", () => {
    expect(() => readShepherdMandates(path.join(root, "missing"))).toThrow(/bundle directory is missing/)
    fs.chmodSync(root, 0o777)
    expect(() => readShepherdMandates(root)).toThrow(/0700/)
    fs.chmodSync(root, 0o700)
    const getuid = process.getuid
    Reflect.set(process, "getuid", undefined)
    try { expect(() => readShepherdMandates(root)).toThrow(/ownership/) } finally { Reflect.set(process, "getuid", getuid) }
  })

  it("binds replay to the original snapshot even if the caller mutates while waiting", async () => {
    await updateShepherdMandate(root, grant())
    const lock = path.join(directory(), "mandates.lock")
    fs.mkdirSync(lock)
    const request = grant("mutable", 1)
    const waiting = updateShepherdMandate(root, request)
    if (request.operation === "grant") request.task = "Changed while acquiring lock"
    fs.renameSync(lock, `${lock}.released`)
    await waiting
    const state = readShepherdMandates(root)
    expect(state.mandates[1]!.task).toBe("Finish the agreed implementation and verify it.")
    await expect(updateShepherdMandate(root, request)).rejects.toThrow(/different arguments/)
  })

  it("validates the active limit on reads while allowing expired grants to release capacity", async () => {
    await updateShepherdMandate(root, grant())
    const state = readShepherdMandates(root)
    for (let i = 1; i <= 100; i++) {
      const requestId = `seed-${i}`
      const provenance = { ...state.mandates[0]!.provenance, requestId }
      const id = `mandate:${createHash("sha256").update(JSON.stringify(["existing-owner", requestId])).digest("hex")}`
      const revision = ++state.revision
      state.mandates.push({ ...state.mandates[0]!, id, provenance, revision })
      state.requests.push({ ...state.requests[0]!, requestId, receipt: { ...state.requests[0]!.receipt, mandateId: id, provenance, revision } })
    }
    save(state)
    expect(() => readShepherdMandates(root)).toThrow(/schema/)
    expect(resolveShepherdMandate(state, target(), NOW).state).toBe("withheld")
    vi.spyOn(Date, "now").mockReturnValue(NOW + 2 * DAY)
    expect(readShepherdMandates(root).mandates).toHaveLength(101)
    await updateShepherdMandate(root, { ...grant("after-expiry", state.revision), expiresAt: new Date(NOW + 3 * DAY).toISOString() } as ShepherdMandateRequest)
    expect(readShepherdMandates(root).mandates).toHaveLength(102)
    expect(resolveShepherdMandate(readShepherdMandates(root), target(), NOW + 2 * DAY).state).toBe("authorized")
  })
})
