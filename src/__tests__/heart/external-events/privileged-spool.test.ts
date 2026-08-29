import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it, vi } from "vitest"

import { listExternalEventStatus, readExternalEventRecord, recordExternalEvent, scanPrivilegedEventSpool } from "../../../heart/external-events/router"

const spoolMock = vi.hoisted(() => ({ root: "", readOnly: false }))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    lstatSync(target: fs.PathLike) {
      const stat = actual.lstatSync(target)
      const resolved = path.resolve(String(target))
      if (!spoolMock.root || (resolved !== path.resolve(spoolMock.root) && path.dirname(resolved) !== path.resolve(spoolMock.root))) return stat
      return new Proxy(stat, { get(value, property, receiver) { return property === "uid" ? 0 : Reflect.get(value, property, receiver) } })
    },
    readFileSync(target: Parameters<typeof actual.readFileSync>[0], options?: unknown) {
      if (target === "/proc/self/mountinfo" && spoolMock.root && spoolMock.readOnly) {
        return `1 1 0:1 / ${spoolMock.root.replace(/ /gu, "\\040")} ro,nosuid,nodev - bind none ro\n`
      }
      return actual.readFileSync(target, options as never)
    },
  }
})

const roots: string[] = []
const NOW = "2026-08-29T20:00:00.000Z"

function root(name: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  roots.push(value)
  return value
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agent: "sanctuary",
    source: "sanctuary-usenet",
    eventType: "usenet.protective_action",
    incidentKey: "spend-guard",
    transitionId: "2026-08-29:pause:50000:20",
    observationRevision: "a".repeat(64),
    action: "sabnzbd.pause",
    actionReceipt: "sabnzbd:pause:2026-08-29:50000:20",
    critical: true,
    summary: "SABnzbd was paused after article success fell below the spend guard.",
    evidence: ["50,000 articles attempted; 20% succeeded."],
    createdAt: "2026-08-29T19:55:00.000Z",
    expiresAt: "2026-08-29T20:10:00.000Z",
    nonce: "b".repeat(64),
    ...overrides,
  }
}

function envelopeName(value: Record<string, unknown>): string {
  return `${createHash("sha256").update(`${value.source}\0${value.incidentKey}\0${value.transitionId}`).digest("hex")}.json`
}

function writeSpoolFile(spoolRoot: string, value: Record<string, unknown>, mode = 0o444): string {
  const filePath = path.join(spoolRoot, envelopeName(value))
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode })
  fs.chmodSync(filePath, mode)
  return filePath
}

function spoofRootOwnership(spoolRoot: string): void {
  spoolMock.root = spoolRoot
  spoolMock.readOnly = true
}

afterEach(() => {
  spoolMock.root = ""
  spoolMock.readOnly = false
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("privileged external-event spool", () => {
  it("accepts one root-owned file from a read-only mount into the canonical receipt and fences replay across scanner restart", () => {
    const spoolRoot = root("ouro-privileged-spool")
    const eventRoot = root("ouro-privileged-events")
    fs.chmodSync(spoolRoot, 0o755)
    const value = envelope()
    writeSpoolFile(spoolRoot, value)
    spoofRootOwnership(spoolRoot)

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 1, rejected: 0, replayed: 0 })
    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 0, replayed: 1 })
    const [status] = listExternalEventStatus(eventRoot)
    expect(status).toMatchObject({ agent: "sanctuary", source: "sanctuary-usenet", eventId: "spend-guard", executionState: "received" })
    expect(readExternalEventRecord(status!.recordPath)).toMatchObject({
      observationRevision: "a".repeat(64),
      privilegedReplayNonces: ["b".repeat(64)],
      evidence: expect.arrayContaining(["protective action receipt: sabnzbd:pause:2026-08-29:50000:20"]),
    })
  })

  it.each([
    ["wrong source", { source: "attacker" }],
    ["wrong schema", { schemaVersion: 2 }],
    ["wrong action", { action: "shell.exec" }],
    ["expired", { expiresAt: "2026-08-29T19:59:59.000Z" }],
    ["future", { createdAt: "2026-08-29T20:00:01.000Z" }],
    ["bad nonce", { nonce: "not-a-nonce" }],
  ])("rejects %s envelopes without creating a receipt", (_label, overrides) => {
    const spoolRoot = root("ouro-privileged-spoof")
    const eventRoot = root("ouro-privileged-spoof-events")
    fs.chmodSync(spoolRoot, 0o755)
    writeSpoolFile(spoolRoot, envelope(overrides))
    spoofRootOwnership(spoolRoot)

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW })).toEqual({ accepted: 0, rejected: 1, replayed: 0 })
    expect(listExternalEventStatus(eventRoot)).toEqual([])
  })

  it("rejects writable mounts, non-root owners, unsafe modes, symlinks, and oversized files", () => {
    const eventRoot = root("ouro-privileged-permissions-events")
    const cases = [
      { configure: (_root: string) => undefined },
      { configure: (spoolRoot: string) => { spoofRootOwnership(spoolRoot); fs.chmodSync(path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!), 0o644) } },
      { configure: (spoolRoot: string) => { spoofRootOwnership(spoolRoot); const file = path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!); fs.unlinkSync(file); fs.symlinkSync("/etc/hosts", file) } },
      { configure: (spoolRoot: string) => { spoofRootOwnership(spoolRoot); const file = path.join(spoolRoot, fs.readdirSync(spoolRoot)[0]!); fs.chmodSync(file, 0o600); fs.appendFileSync(file, "x".repeat(64 * 1024)); fs.chmodSync(file, 0o444) } },
    ]
    for (const entry of cases) {
      spoolMock.root = ""
      spoolMock.readOnly = false
      const spoolRoot = root("ouro-privileged-permissions")
      fs.chmodSync(spoolRoot, 0o755)
      writeSpoolFile(spoolRoot, envelope())
      entry.configure(spoolRoot)
      expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot, now: () => NOW }).accepted).toBe(0)
    }
    expect(listExternalEventStatus(eventRoot)).toEqual([])
  })

  it("keeps the reserved privileged source unavailable to ordinary event submission", () => {
    expect(() => recordExternalEvent({ agent: "sanctuary", source: "sanctuary-usenet", eventType: "usenet.protective_action", eventId: "spoof" }, { root: root("ordinary-event") }))
      .toThrow("reserved for privileged spool ingress")
  })
})

describe("packaged root event producer", () => {
  it("writes one canonical bounded envelope with fsync then atomic rename and is idempotent", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?test=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: { spoolRoot: string; effectiveUid: number; now: () => string; nonce: () => string }): { filePath: string; created: boolean }
    }
    const spoolRoot = root("ouro-producer")
    fs.chmodSync(spoolRoot, 0o755)
    const input = envelope({ createdAt: undefined, expiresAt: undefined, nonce: undefined })
    const first = producer.emitEvent(input, { spoolRoot, effectiveUid: 0, now: () => "2026-08-29T19:55:00.000Z", nonce: () => "b".repeat(64) })
    const second = producer.emitEvent(input, { spoolRoot, effectiveUid: 0, now: () => "2026-08-29T19:56:00.000Z", nonce: () => "c".repeat(64) })

    expect(first).toEqual({ filePath: path.join(spoolRoot, envelopeName(envelope())), created: true })
    expect(second).toEqual({ filePath: first.filePath, created: false })
    expect(fs.readdirSync(spoolRoot)).toEqual([path.basename(first.filePath)])
    expect(fs.statSync(first.filePath).mode & 0o777).toBe(0o444)
    expect(JSON.parse(fs.readFileSync(first.filePath, "utf8"))).toMatchObject({ ...envelope(), createdAt: "2026-08-29T19:55:00.000Z", expiresAt: "2026-08-29T20:10:00.000Z", nonce: "b".repeat(64) })
  })

  it("rejects non-root CLI execution, traversal, oversized content, and conflicting transition reuse", async () => {
    const producerPath = path.resolve(__dirname, "../../../../deploy/unraid/ouro-events/emit-event.mjs")
    const producer = await import(`${pathToFileURL(producerPath).href}?negative=${Date.now()}`) as {
      emitEvent(input: Record<string, unknown>, options: { spoolRoot: string; effectiveUid: number; now: () => string; nonce: () => string }): unknown
    }
    const spoolRoot = root("ouro-producer-negative")
    fs.chmodSync(spoolRoot, 0o755)
    expect(() => producer.emitEvent(envelope(), { spoolRoot, effectiveUid: 10001, now: () => NOW, nonce: () => "b".repeat(64) })).toThrow("must run as root")
    expect(() => producer.emitEvent(envelope({ incidentKey: "../escape" }), { spoolRoot, effectiveUid: 0, now: () => NOW, nonce: () => "b".repeat(64) })).toThrow("invalid")
    expect(() => producer.emitEvent(envelope({ summary: "x".repeat(4097) }), { spoolRoot, effectiveUid: 0, now: () => NOW, nonce: () => "b".repeat(64) })).toThrow("bounded")
    producer.emitEvent(envelope(), { spoolRoot, effectiveUid: 0, now: () => "2026-08-29T19:55:00.000Z", nonce: () => "b".repeat(64) })
    expect(() => producer.emitEvent(envelope({ summary: "different" }), { spoolRoot, effectiveUid: 0, now: () => "2026-08-29T19:56:00.000Z", nonce: () => "c".repeat(64) })).toThrow("transition already exists with different content")
  })
})
