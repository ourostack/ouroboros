import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  applicableGuidance, readGuidance, recordShepherdCorrection, updateShepherdPrinciple,
  forgetShepherdPrinciple, setShepherdSessionPause, shepherdReturnId,
  type ShepherdGuidanceTarget,
} from "../../../senses/shepherd/guidance"
import { appendReturn, shepherdStateDir, type ReturnRecord } from "../../../senses/shepherd/returns"

// Only inject otherwise nondeterministic read/stat faults; normal persistence and locking remain real.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readFileSync: vi.fn(actual.readFileSync) }
})

let root: string
const target: ShepherdGuidanceTarget = { host: "cmux", session: "uuid-1", cwd: "/code/app", task: "desk/task" }
const returned: ReturnRecord = {
  at: "2026-10-13T20:00:00Z", host: "cmux", session: "uuid-1", transition: "stop-1",
  cwd: "/code/app", task: "desk/task", agent: "coding", kind: "premature", action: "respond",
  reason: "Stopped at a plan", reply: "Continue.", latencyMs: 1, inputTokens: 2,
}
const input = (requestId = "r1") => ({ actorId: "ari", requestId, target, feedback: "That review was an outside dependency.", principle: "Wait for outside reviewers." })
const file = () => path.join(shepherdStateDir(root), "guidance.json")
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-guidance-"))
  appendReturn(root, returned)
})

describe("durable Shepherd guidance", () => {
  it("derives return identity from the full immutable tuple, not judgment or short ref", () => {
    const id = shepherdReturnId(returned)
    expect(id).toMatch(/^return:[a-f0-9]{64}$/)
    expect(shepherdReturnId({ ...returned, reason: "different" })).toBe(id)
    for (const change of [{ host: "other" }, { session: "other" }, { transition: "other" }, { at: "other" }]) {
      expect(shepherdReturnId({ ...returned, ...change })).not.toBe(id)
    }
  })

  it("starts empty and persists a correction with actual judgment, operator provenance and session-default learning", async () => {
    expect(applicableGuidance(readGuidance(root), target)).toEqual({ revision: 0, paused: false, principles: [] })
    const receipt = await recordShepherdCorrection(root, { ...input(), returnId: shepherdReturnId(returned) })
    expect(receipt).toMatchObject({ revision: 1, correctionId: expect.any(String), principleId: expect.any(String) })
    const state = readGuidance(root)
    expect(state.corrections[0]).toMatchObject({ feedback: input().feedback, returnRecord: returned, provenance: { actorId: "ari", kind: "operator correction", returnId: shepherdReturnId(returned) } })
    expect(applicableGuidance(state, target)).toMatchObject({
      revision: 1, paused: false, principles: [{ id: receipt.principleId, scope: "session", text: "Wait for outside reviewers.", provenance: { actorId: "ari" } }],
    })
    expect(applicableGuidance(state, { ...target, session: "other" }).principles).toEqual([])
    vi.resetModules()
    const fresh = await import("../../../senses/shepherd/guidance")
    expect(fresh.readGuidance(root)).toEqual(state)
    expect(fs.statSync(shepherdStateDir(root)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(shepherdStateDir(root))).not.toContain("guidance.json.tmp")
  })

  it("keeps prospective instruction honest and project/global generalization explicit", async () => {
    await recordShepherdCorrection(root, { ...input(), scope: "project" })
    const state = readGuidance(root)
    expect(state.corrections[0]!.returnRecord).toBeNull()
    expect(state.corrections[0]!.provenance.kind).toBe("operator instruction")
    expect(applicableGuidance(state, { ...target, session: "new" }).principles).toHaveLength(1)
    for (const other of [{ cwd: "/code/else" }, { task: "other" }, { cwd: "/code/application" }]) {
      expect(applicableGuidance(state, { ...target, ...other }).principles).toEqual([])
    }
    await recordShepherdCorrection(root, { ...input("global"), scope: "global", principle: "Never imply a review is delivered." })
    expect(applicableGuidance(readGuidance(root), { host: "else", session: "else", cwd: null, task: null }).principles).toHaveLength(1)
  })

  it("refuses fabricated returns, mismatched targets, unknown sessions and missing/unsupported project cwd", async () => {
    await expect(recordShepherdCorrection(root, { ...input(), returnId: "fake" })).rejects.toThrow(/return.*not found/)
    await expect(recordShepherdCorrection(root, { ...input(), returnId: shepherdReturnId(returned), target: { ...target, session: "wrong" } })).rejects.toThrow(/target/)
    await expect(recordShepherdCorrection(root, { ...input(), target: { ...target, session: "unknown" } })).rejects.toThrow(/unknown session/)
    appendReturn(root, { ...returned, session: "no-cwd", cwd: null })
    await expect(recordShepherdCorrection(root, { ...input(), scope: "project", target: { ...target, session: "no-cwd", cwd: null } })).rejects.toThrow(/cwd/)
    appendReturn(root, { ...returned, session: "relative", cwd: "relative" })
    await expect(recordShepherdCorrection(root, { ...input(), scope: "project", target: { ...target, session: "relative", cwd: "relative" } })).rejects.toThrow(/project/)
    expect(readGuidance(root).revision).toBe(0)
  })

  it("serializes concurrent changes and returns the original receipt for duplicate same-body requests", async () => {
    const requests = Array.from({ length: 8 }, (_, i) => ({ ...input(`c${i}`), principle: `Principle ${i}` }))
    const receipts = await Promise.all(requests.map(request => recordShepherdCorrection(root, request)))
    expect(readGuidance(root).revision).toBe(8)
    expect(readGuidance(root).principles).toHaveLength(8)
    expect(await recordShepherdCorrection(root, requests[0]!)).toEqual(receipts[0])
    await expect(recordShepherdCorrection(root, { ...requests[0]!, feedback: "different" })).rejects.toThrow(/request.*different/)
    expect(readGuidance(root).revision).toBe(8)
  })

  it("keeps independently launched process writers from losing corrections", async () => {
    const script = `
      const fs = require("node:fs"), ts = require("typescript");
      require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText, file);
      const guidance = require(process.argv[1]);
      guidance.recordShepherdCorrection(process.argv[2], JSON.parse(process.argv[3])).then(
        receipt => process.stdout.write(JSON.stringify(receipt)),
        error => { process.stderr.write(error.message); process.exitCode = 1; }
      );
    `
    const run = promisify(execFile)
    const results = await Promise.all(Array.from({ length: 3 }, (_, i) => run(process.execPath, [
      "-e", script, path.resolve("src/senses/shepherd/guidance.ts"), root, JSON.stringify(input(`process-${i}`)),
    ], { cwd: path.resolve(".") })))
    expect(results.map(r => JSON.parse(r.stdout).revision).sort()).toEqual([1, 2, 3])
    expect(readGuidance(root).corrections).toHaveLength(3)
  })

  it("records correction-only feedback and matches project-wide rules with no task restriction", async () => {
    const receipt = await recordShepherdCorrection(root, { actorId: "ari", requestId: "feedback", target, feedback: "Wrong return", returnId: shepherdReturnId(returned) })
    expect(receipt.principleId).toBeUndefined()
    expect(readGuidance(root).principles).toEqual([])
    const projectTarget = { ...target, session: "all-tasks", task: null }
    appendReturn(root, { ...returned, ...projectTarget })
    await recordShepherdCorrection(root, { ...input("project-wide"), target: projectTarget, scope: "project" })
    expect(applicableGuidance(readGuidance(root), { ...target, task: "other" }).principles).toHaveLength(1)
  })

  it("accepts verified live targets but rejects invalid or stale target coordinates and non-boolean pause", async () => {
    const live = { host: "cmux", session: "new", cwd: null, task: null }
    await recordShepherdCorrection(root, { ...input(), target: live }, [live])
    await setShepherdSessionPause(root, { actorId: "ari", requestId: "live-pause", target: live, paused: true }, [live])
    expect(applicableGuidance(readGuidance(root), live).paused).toBe(true)
    await expect(recordShepherdCorrection(root, { ...input("bad"), target: { ...target, host: "" } })).rejects.toThrow(/target/)
    await expect(recordShepherdCorrection(root, { ...input("bad"), target: { ...target, cwd: "/wrong" } })).rejects.toThrow(/target/)
    await expect(setShepherdSessionPause(root, { actorId: "ari", requestId: "bad-pause", target, paused: "true" } as never)).rejects.toThrow(/boolean/)
  })

  it("bounds the whole snapshot without losing the last good revision or silently pruning rules", async () => {
    await recordShepherdCorrection(root, { ...input(), principle: undefined })
    const state = readGuidance(root)
    // Fill with valid historical feedback, not active principles, so the byte limit is the only refusal.
    const old = state.corrections[0]!
    while (Buffer.byteLength(JSON.stringify(state)) < 2 * 1024 * 1024 - 3000) {
      state.corrections.push({ ...old, id: `old-${state.corrections.length}`, feedback: "x".repeat(2000) })
    }
    fs.writeFileSync(file(), JSON.stringify(state))
    const before = fs.readFileSync(file(), "utf8")
    await expect(recordShepherdCorrection(root, { ...input("too-large"), feedback: "x".repeat(2000) })).rejects.toThrow(/2 MiB/)
    expect(fs.readFileSync(file(), "utf8")).toBe(before)
    expect(readGuidance(root).revision).toBe(1)
  })

  it("refuses nested malformed state instead of broadening its applicability", async () => {
    await recordShepherdCorrection(root, { ...input(), returnId: shepherdReturnId(returned), scope: "project" })
    await setShepherdSessionPause(root, { actorId: "ari", requestId: "pause", target, paused: true })
    const baseline = readGuidance(root)
    const damage: Array<(state: typeof baseline) => void> = [
      s => { s.revision = -1 },
      s => { s.corrections[0]!.returnRecord!.action = "bogus" as never },
      s => { s.corrections[0]!.returnRecord!.latencyMs = null; s.corrections[0]!.returnRecord!.inputTokens = null; s.corrections[0]!.provenance.returnId = "wrong" },
      s => { s.principles[0]!.target.cwd = null },
      s => { s.principles[0]!.target.cwd = "relative" },
      s => { s.principles[0]!.target.cwd = "/code/../code/app" },
      s => { s.principles[0]!.text = "" },
      s => { s.principles[0]!.scope = "unsupported" as never },
      s => { s.pauses[0]!.paused = "yes" as never },
      s => { s.requests[0]!.receipt.provenance.kind = "fabricated" as never },
      s => { s.principles = Array.from({ length: 21 }, () => s.principles[0]!) },
    ]
    for (const corrupt of damage) {
      const state = structuredClone(baseline)
      corrupt(state)
      fs.writeFileSync(file(), JSON.stringify(state))
      expect(() => readGuidance(root)).toThrow(/malformed/)
    }
  })

  it("updates, forgets and pauses/resumes without typing or erasing the operator trail", async () => {
    const receipt = await recordShepherdCorrection(root, input())
    const update = { actorId: "ari", requestId: "update", principleId: receipt.principleId!, text: "Wait for reviews, but report failures." }
    const changed = await updateShepherdPrinciple(root, update)
    expect(await updateShepherdPrinciple(root, update)).toEqual(changed)
    expect(applicableGuidance(readGuidance(root), target).principles[0]).toMatchObject({ text: update.text, provenance: { actorId: "ari" } })
    const pause = { actorId: "ari", requestId: "pause", target, paused: true }
    const paused = await setShepherdSessionPause(root, pause)
    expect(await setShepherdSessionPause(root, pause)).toEqual(paused)
    expect(applicableGuidance(readGuidance(root), target).paused).toBe(true)
    expect(applicableGuidance(readGuidance(root), { ...target, host: "other" }).paused).toBe(false)
    await setShepherdSessionPause(root, { ...pause, requestId: "resume", paused: false })
    expect(applicableGuidance(readGuidance(root), target).paused).toBe(false)
    const forget = { actorId: "ari", requestId: "forget", principleId: receipt.principleId! }
    const forgotten = await forgetShepherdPrinciple(root, forget)
    expect(await forgetShepherdPrinciple(root, forget)).toEqual(forgotten)
    expect(applicableGuidance(readGuidance(root), target).principles).toEqual([])
    expect(readGuidance(root).corrections).toHaveLength(1)
    await expect(updateShepherdPrinciple(root, { ...update, requestId: "missing", principleId: "missing" })).rejects.toThrow(/active principle/)
    await expect(forgetShepherdPrinciple(root, { ...forget, requestId: "missing" })).rejects.toThrow(/active principle/)
  })

  it("redacts before persistence and refuses oversize content and excess active principles", async () => {
    await recordShepherdCorrection(root, { ...input(), feedback: `token=abc123secret`, principle: `Do not share ghp_${"a".repeat(36)}` })
    expect(fs.readFileSync(file(), "utf8")).not.toMatch(/abc123secret|ghp_aaa/)
    for (const invalid of [{ feedback: "x".repeat(2001) }, { principle: "x".repeat(1001) }, { feedback: "" }, { principle: "" }, { actorId: "" }, { requestId: "" }, { scope: "bad" }]) {
      await expect(recordShepherdCorrection(root, { ...input("bad"), ...invalid } as never)).rejects.toThrow()
    }
    for (let i = 1; i < 20; i++) await recordShepherdCorrection(root, input(`p${i}`))
    await expect(recordShepherdCorrection(root, input("overflow"))).rejects.toThrow(/20 active/)
    const id = readGuidance(root).principles[0]!.id
    await forgetShepherdPrinciple(root, { actorId: "ari", requestId: "forget", principleId: id })
    await recordShepherdCorrection(root, input("after-forget"))
    expect(applicableGuidance(readGuidance(root), target).principles).toHaveLength(20)
  })

  it("fails explicitly on corrupt, unsupported, unreadable and oversized state", () => {
    fs.mkdirSync(shepherdStateDir(root), { recursive: true })
    for (const raw of ["not json", "null", "{}", '{"version":2}', '{"version":1,"revision":0,"principles":[]}', "x".repeat(2 * 1024 * 1024 + 1)]) {
      fs.writeFileSync(file(), raw)
      expect(() => readGuidance(root)).toThrow(/Shepherd guidance/)
    }
    fs.renameSync(file(), `${file()}.unreadable-fixture`)
    fs.mkdirSync(file())
    expect(() => readGuidance(root)).toThrow(/Shepherd guidance could not be read/)
  })

  it("refuses a dangling state symlink instead of mistaking it for missing guidance", () => {
    fs.symlinkSync(path.join(root, "not-created"), file())
    expect(() => readGuidance(root)).toThrow(/Shepherd guidance/)
  })

  it("fails closed when state grows or disappears between stat and read, and on permission errors", async () => {
    await recordShepherdCorrection(root, input())
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }) })
    expect(() => readGuidance(root)).toThrow(/Shepherd guidance could not be read.*denied/)
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("disappeared"), { code: "ENOENT" }) })
    expect(() => readGuidance(root)).toThrow(/Shepherd guidance could not be read.*disappeared/)
    fs.writeFileSync(file(), "x".repeat(2 * 1024 * 1024 + 1))
    vi.mocked(fs.lstatSync).mockReturnValueOnce({ isFile: () => true, size: 1 } as never)
    expect(() => readGuidance(root)).toThrow(/exceeds 2 MiB/)
  })

  it("refuses an explicit null scope rather than silently treating it as the session default", async () => {
    await expect(recordShepherdCorrection(root, { ...input(), scope: null } as never)).rejects.toThrow(/scope/)
    expect(readGuidance(root).revision).toBe(0)
  })

  it("refuses redaction-expanded bounds and secret-shaped identity coordinates without writing invalid state", async () => {
    await expect(recordShepherdCorrection(root, { ...input(), feedback: `${"x".repeat(1990)} token=abc` })).rejects.toThrow(/feedback/)
    await expect(recordShepherdCorrection(root, { ...input(), principle: `${"x".repeat(990)} token=abc` })).rejects.toThrow(/principle/)
    for (const invalid of [{ actorId: "token=abc" }, { requestId: "token=abc" }, { target: { ...target, cwd: "/code/token=abc" } }]) {
      await expect(recordShepherdCorrection(root, { ...input(), ...invalid })).rejects.toThrow(/identity|target/)
    }
    expect(readGuidance(root).revision).toBe(0)
  })

  it("rejects duplicate principle identities and impossible idempotence receipts as malformed state", async () => {
    await recordShepherdCorrection(root, input())
    const state = readGuidance(root)
    state.principles.push(structuredClone(state.principles[0]!))
    fs.writeFileSync(file(), JSON.stringify(state))
    expect(() => readGuidance(root)).toThrow(/malformed/)
    state.principles.pop()
    state.requests[0]!.receipt.revision = 99
    fs.writeFileSync(file(), JSON.stringify(state))
    expect(() => readGuidance(root)).toThrow(/malformed/)
  })

  it("refuses an invalid trusted-adapter fingerprint rather than persisting an unusable request key", async () => {
    await expect(recordShepherdCorrection(root, { ...input(), requestFingerprint: "token=abc" })).rejects.toThrow(/fingerprint/)
    expect(readGuidance(root).revision).toBe(0)
  })
})
