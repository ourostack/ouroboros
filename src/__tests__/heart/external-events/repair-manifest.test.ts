import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, lstatSync: vi.fn((...args: Parameters<typeof actual.lstatSync>) => actual.lstatSync(...args)) }
})

import { claimExternalEvent, failExternalEventAttempt, readExternalEventRecord, recordExternalEvent, repairExternalEventsFromManifest, reviveExternalEventAfterRecovery } from "../../../heart/external-events/router"

const roots: string[] = []
const sha = (raw: Buffer | string) => createHash("sha256").update(raw).digest("hex")
function root(): string { const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "event-repair-"))); roots.push(value); return value }
afterEach(() => { vi.mocked(fs.lstatSync).mockClear(); for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true }) })

function fixture(eventRoot: string, eventId = "evt-1") {
  const first = recordExternalEvent({ agent: "agent-a", source: "source-a", eventType: "health.observed", eventId }, { root: eventRoot, now: () => "2026-01-01T00:00:00.000Z" })
  const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
  const dead = failExternalEventAttempt(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, error: "provider unavailable", failureClass: "provider_lane_unavailable", maxAttempts: 1, now: () => "2026-01-01T00:00:01.000Z" })
  const revived = reviveExternalEventAfterRecovery(first.recordPath, { expectedVersion: dead.version, expectedGeneration: 1, evidence: { class: "provider_lane_unavailable", observedAt: "2026-01-01T00:00:02.000Z" }, now: () => "2026-01-01T00:00:02.000Z" })
  const recoveryClaim = claimExternalEvent(first.recordPath, { owner: "recovery", expectedVersion: revived.record.version, expectedGeneration: 1 })
  const providerDead = failExternalEventAttempt(first.recordPath, { owner: "recovery", expectedVersion: recoveryClaim.version, expectedGeneration: 1, error: "turn failed", maxAttempts: 5, now: () => "2026-01-01T00:00:03.000Z" })
  const raw = fs.readFileSync(first.recordPath)
  return { record: providerDead, raw }
}

function manifestPath(eventRoot: string, entries: Array<{ record: ReturnType<typeof readExternalEventRecord>; raw: Buffer }>): string {
  const target = path.join(root(), "repair.json")
  const repairedAt = "2026-01-02T00:00:00.000Z"
  fs.writeFileSync(target, JSON.stringify({
    schemaVersion: 1,
    repairedAt,
    reason: "A reviewed recovery attempt lost its execution lease.",
    evidence: ["audit:repair-1"],
    requestedBy: "operator:owner",
    reviewedBy: "reviewer:independent",
    entries: entries.map(({ record, raw }) => {
      const post = { ...record, version: record.version + 1, updatedAt: repairedAt, failureProvenance: { class: "execution_lease_expired", failedAt: repairedAt } }
      delete post.recoveryGrant
      return { agent: record.agent, source: record.source, eventId: record.eventId, preimageSha256: sha(raw), postimageSha256: sha(`${JSON.stringify(post, null, 2)}\n`), version: record.version, generation: record.generation, failureProvenance: record.failureProvenance, recoveryGrant: record.recoveryGrant }
    }),
  }))
  return target
}

describe("external event repair manifest", () => {
  it("applies the only allowed transition and reruns idempotently", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({ applied: ["agent-a/source-a/evt-1"], alreadyApplied: [], failed: [], pending: [] })
    expect(readExternalEventRecord(item.record.recordPath)).toMatchObject({ failureProvenance: { class: "execution_lease_expired", failedAt: "2026-01-02T00:00:00.000Z" } })
    expect(readExternalEventRecord(item.record.recordPath).recoveryGrant).toBeUndefined()
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({ applied: [], alreadyApplied: ["agent-a/source-a/evt-1"], failed: [], pending: [] })
  })

  it("prevalidates every entry before writing and rejects duplicate or changed preimages", () => {
    const eventRoot = root(); const one = fixture(eventRoot, "one"); const two = fixture(eventRoot, "two")
    const bad = { record: two.record, raw: Buffer.from("wrong") }
    const manifest = manifestPath(eventRoot, [one, bad])
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({
      applied: [],
      failed: [{ identity: "agent-a/source-a/two", error: expect.stringMatching(/preimage/u) }],
      pending: ["agent-a/source-a/one"],
    })
    expect(fs.readFileSync(one.record.recordPath)).toEqual(one.raw)
    const duplicate = manifestPath(eventRoot, [one, one])
    expect(() => repairExternalEventsFromManifest(duplicate, { root: eventRoot })).toThrow(/duplicate/u)
  })

  it("rejects symlinked records and malformed or unauthorized manifests", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    const actual = `${item.record.recordPath}.actual`; fs.renameSync(item.record.recordPath, actual); fs.symlinkSync(actual, item.record.recordPath)
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({ failed: [{ error: expect.stringMatching(/symlink/u) }] })
    fs.unlinkSync(item.record.recordPath); fs.renameSync(actual, item.record.recordPath)
    fs.renameSync(item.record.recordPath, actual); fs.mkdirSync(item.record.recordPath)
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({ failed: [{ error: expect.stringMatching(/shape/u) }] })
    fs.rmdirSync(item.record.recordPath); fs.renameSync(actual, item.record.recordPath)
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")); parsed.entries[0].recoveryGrant.generation = 2; fs.writeFileSync(manifest, JSON.stringify(parsed))
    expect(() => repairExternalEventsFromManifest(manifest, { root: eventRoot })).toThrow(/invalid/u)
  })

  it("requires an exact bounded manifest contract with distinct pre/post images", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"))
    parsed.unreviewedAuthority = true
    fs.writeFileSync(manifest, JSON.stringify(parsed))
    expect(() => repairExternalEventsFromManifest(manifest, { root: eventRoot })).toThrow(/invalid/u)

    delete parsed.unreviewedAuthority
    parsed.entries[0].agent = "a".repeat(161)
    fs.writeFileSync(manifest, JSON.stringify(parsed))
    expect(() => repairExternalEventsFromManifest(manifest, { root: eventRoot })).toThrow(/invalid/u)

    parsed.entries[0].agent = item.record.agent
    parsed.entries[0].postimageSha256 = parsed.entries[0].preimageSha256
    fs.writeFileSync(manifest, JSON.stringify(parsed))
    expect(() => repairExternalEventsFromManifest(manifest, { root: eventRoot })).toThrow(/invalid/u)
  })

  it("rejects non-file, non-object, and non-object-entry manifests", () => {
    const eventRoot = root(); const item = fixture(eventRoot)
    expect(() => repairExternalEventsFromManifest(root(), { root: eventRoot })).toThrow(/regular file/u)

    const arrayManifest = manifestPath(eventRoot, [item])
    fs.writeFileSync(arrayManifest, "[]")
    expect(() => repairExternalEventsFromManifest(arrayManifest, { root: eventRoot })).toThrow(/manifest is invalid/u)

    const invalidJson = manifestPath(eventRoot, [item])
    fs.writeFileSync(invalidJson, "{")
    expect(() => repairExternalEventsFromManifest(invalidJson, { root: eventRoot })).toThrow(/invalid JSON/u)

    const primitiveEntry = manifestPath(eventRoot, [item])
    const parsed = JSON.parse(fs.readFileSync(primitiveEntry, "utf8"))
    parsed.entries = [null]
    fs.writeFileSync(primitiveEntry, JSON.stringify(parsed))
    expect(() => repairExternalEventsFromManifest(primitiveEntry, { root: eventRoot })).toThrow(/entry is invalid/u)
  })

  it("rejects a reviewed postimage digest that does not encode the only allowed transition", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"))
    parsed.entries[0].postimageSha256 = "f".repeat(64)
    fs.writeFileSync(manifest, JSON.stringify(parsed))
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({
      applied: [], alreadyApplied: [], pending: [],
      failed: [{ identity: "agent-a/source-a/evt-1", error: expect.stringMatching(/unauthorized/u) }],
    })
  })

  it("rejects a symlinked configured root and false already-applied postimages", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    const symlinkRoot = path.join(root(), "events-link")
    fs.symlinkSync(eventRoot, symlinkRoot)
    expect(repairExternalEventsFromManifest(manifest, { root: symlinkRoot })).toMatchObject({ failed: [{ error: expect.stringMatching(/symlink/u) }] })

    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"))
    const falsePost = { ...item.record, version: item.record.version + 1, updatedAt: parsed.repairedAt }
    const falsePostRaw = `${JSON.stringify(falsePost, null, 2)}\n`
    fs.writeFileSync(item.record.recordPath, falsePostRaw)
    parsed.entries[0].postimageSha256 = sha(falsePostRaw)
    fs.writeFileSync(manifest, JSON.stringify(parsed))
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({
      applied: [],
      alreadyApplied: [],
      failed: [{ identity: "agent-a/source-a/evt-1", error: expect.stringMatching(/postimage/u) }],
      pending: [],
    })
  })

  it("reports a locked record and leaves later records pending without dispatch or writes", () => {
    const eventRoot = root(); const one = fixture(eventRoot, "one"); const two = fixture(eventRoot, "two"); const three = fixture(eventRoot, "three")
    const manifest = manifestPath(eventRoot, [one, two, three])
    fs.mkdirSync(`${two.record.recordPath}.lock`)
    fs.writeFileSync(path.join(`${two.record.recordPath}.lock`, "owner"), "live-owner")
    const result = repairExternalEventsFromManifest(manifest, { root: eventRoot })
    expect(result).toMatchObject({
      applied: ["agent-a/source-a/one"],
      alreadyApplied: [],
      failed: [{ identity: "agent-a/source-a/two", error: expect.stringMatching(/busy/u) }],
      pending: ["agent-a/source-a/three"],
    })
    expect(fs.readFileSync(two.record.recordPath)).toEqual(two.raw)
    expect(fs.readFileSync(three.record.recordPath)).toEqual(three.raw)
    fs.unlinkSync(path.join(`${two.record.recordPath}.lock`, "owner"))
    fs.rmdirSync(`${two.record.recordPath}.lock`)
    expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({
      applied: ["agent-a/source-a/two", "agent-a/source-a/three"],
      alreadyApplied: ["agent-a/source-a/one"],
      failed: [], pending: [],
    })
  })

  it("recognizes a valid postimage written after prevalidation without overwriting it", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    const repairedAt = "2026-01-02T00:00:00.000Z"
    const post = { ...item.record, version: item.record.version + 1, updatedAt: repairedAt, failureProvenance: { class: "execution_lease_expired", failedAt: repairedAt } }
    delete post.recoveryGrant
    const postRaw = `${JSON.stringify(post, null, 2)}\n`
    const lstatSync = vi.mocked(fs.lstatSync)
    const originalLstatSync = lstatSync.getMockImplementation()!
    let recordStats = 0
    lstatSync.mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(target) === item.record.recordPath && ++recordStats === 2) fs.writeFileSync(item.record.recordPath, postRaw)
      return originalLstatSync(target, options as never)
    }) as typeof fs.lstatSync)
    try {
      expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({
        applied: [], alreadyApplied: ["agent-a/source-a/evt-1"], failed: [], pending: [],
      })
    } finally {
      lstatSync.mockImplementation(originalLstatSync)
    }
    expect(fs.readFileSync(item.record.recordPath, "utf8")).toBe(postRaw)
  })

  it("rejects a record that advances to an unreviewed image after prevalidation", () => {
    const eventRoot = root(); const item = fixture(eventRoot); const manifest = manifestPath(eventRoot, [item])
    const lstatSync = vi.mocked(fs.lstatSync)
    const originalLstatSync = lstatSync.getMockImplementation()!
    let recordStats = 0
    lstatSync.mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(target) === item.record.recordPath && ++recordStats === 2) fs.writeFileSync(item.record.recordPath, "{}")
      return originalLstatSync(target, options as never)
    }) as typeof fs.lstatSync)
    try {
      expect(repairExternalEventsFromManifest(manifest, { root: eventRoot })).toMatchObject({
        applied: [], alreadyApplied: [], pending: [],
        failed: [{ identity: "agent-a/source-a/evt-1", error: expect.stringMatching(/advanced after prevalidation/u) }],
      })
    } finally {
      lstatSync.mockImplementation(originalLstatSync)
    }
  })
})
