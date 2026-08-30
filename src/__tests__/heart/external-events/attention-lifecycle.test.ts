import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import {
  advanceExternalEventsFromAwait,
  advanceExternalEventFromAwait,
  bindPrivilegedFailsafeArtifact,
  claimExternalEvent,
  commitExternalEventDisposition,
  failExternalEventAttempt,
  listExternalEventStatus,
  readExternalEventRecord,
  reconcileExternalEvent,
  recordExternalEvent,
  renewExternalEventClaim,
  externalEventRecordPath,
} from "../../../heart/external-events/router"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "external-attention-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("external event attention lifecycle", () => {
  it("wakes once before classification and updates unchanged evidence without another generation", () => {
    const eventRoot = root()
    const input = {
      agent: "sanctuary",
      source: "sanctuary-health",
      eventType: "health.observed",
      eventId: "container:jellyfin",
      observationRevision: "rev-1",
      transition: "opened" as const,
      evidence: ["Jellyfin is stopped"],
    }

    const first = recordExternalEvent(input, { root: eventRoot, now: () => "2026-08-29T17:00:00.000Z" })
    const duplicate = recordExternalEvent(input, { root: eventRoot, now: () => "2026-08-29T17:01:00.000Z" })

    expect(first).toMatchObject({ schemaVersion: 2, executionState: "received", generation: 1, shouldWake: true })
    expect(duplicate).toMatchObject({ executionState: "received", generation: 1, duplicateCount: 1, shouldWake: false })
  })

  it("persists a Butler disposition and evaluates only its saved wake predicate", () => {
    const eventRoot = root()
    const first = recordExternalEvent({
      agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed", eventId: "container:books",
      observationRevision: "rev-1", transition: "opened", evidence: ["Books is stopped"],
    }, { root: eventRoot, now: () => "2026-08-29T17:00:00.000Z" })
    const claimed = claimExternalEvent(first.recordPath, {
      owner: "private-runtime:1", expectedVersion: first.version, expectedGeneration: 1,
      now: () => "2026-08-29T17:00:01.000Z", leaseMs: 30_000,
    })
    const handled = commitExternalEventDisposition(first.recordPath, {
      owner: "private-runtime:1", expectedVersion: claimed.version, expectedGeneration: 1,
      now: () => "2026-08-29T17:00:02.000Z",
      disposition: {
        classifiedRevision: "rev-1", classification: "expected", stewardPolicy: { kind: "current", key: "service:books", version: 3 },
        decision: "silent", reason: "Books is intentionally available only when requested.", nextWake: { kind: "on_change" },
        careId: null, awaitId: null, actionRefs: [], verificationRefs: [],
      },
    })

    expect(handled).toMatchObject({ executionState: "handled", shouldWake: false, disposition: { reason: "Books is intentionally available only when requested." } })
    expect(listExternalEventStatus(eventRoot)).toEqual([expect.objectContaining({
      source: "sanctuary-health", eventId: "container:books", executionState: "handled", classification: "expected",
      decision: "silent", reason: "Books is intentionally available only when requested.", stewardPolicy: { kind: "current", key: "service:books", version: 3 },
    })])

    const unchanged = recordExternalEvent({
      agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed", eventId: "container:books",
      observationRevision: "rev-1", transition: "unchanged", evidence: ["Books is stopped"],
    }, { root: eventRoot, now: () => "2026-08-29T17:05:00.000Z" })
    const changed = recordExternalEvent({
      agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed", eventId: "container:books",
      observationRevision: "rev-2", transition: "changed", evidence: ["Books is unhealthy rather than stopped"],
    }, { root: eventRoot, now: () => "2026-08-29T17:06:00.000Z" })

    expect(unchanged).toMatchObject({ generation: 1, executionState: "handled", shouldWake: false })
    expect(changed).toMatchObject({ generation: 2, executionState: "received", shouldWake: true })
    expect(changed.disposition).toBeNull()
  })

  it("fences claims by version and generation, retries with a bound, and reclaims stale leases", () => {
    const eventRoot = root()
    const first = recordExternalEvent({
      agent: "sanctuary", source: "guard", eventType: "download.failed", eventId: "usenet-credit",
      observationRevision: "rev-1", transition: "opened",
    }, { root: eventRoot, now: () => "2026-08-29T17:00:00.000Z" })
    const claim = claimExternalEvent(first.recordPath, {
      owner: "worker-a", expectedVersion: first.version, expectedGeneration: 1,
      now: () => "2026-08-29T17:00:01.000Z", leaseMs: 1_000,
    })

    expect(() => claimExternalEvent(first.recordPath, {
      owner: "worker-b", expectedVersion: first.version, expectedGeneration: 1,
      now: () => "2026-08-29T17:00:01.500Z", leaseMs: 1_000,
    })).toThrow(/CAS|claimed/u)

    const retry = failExternalEventAttempt(first.recordPath, {
      owner: "worker-a", expectedVersion: claim.version, expectedGeneration: 1, error: "provider timeout",
      now: () => "2026-08-29T17:00:02.000Z", maxAttempts: 2, baseDelayMs: 1_000,
    })
    expect(retry).toMatchObject({ executionState: "retry_wait", attemptCount: 1, nextAttemptAt: "2026-08-29T17:00:03.000Z" })

    const secondClaim = claimExternalEvent(first.recordPath, {
      owner: "worker-b", expectedVersion: retry.version, expectedGeneration: 1,
      now: () => "2026-08-29T17:00:03.000Z", leaseMs: 1_000,
    })
    const dead = failExternalEventAttempt(first.recordPath, {
      owner: "worker-b", expectedVersion: secondClaim.version, expectedGeneration: 1, error: "provider unavailable",
      now: () => "2026-08-29T17:00:04.000Z", maxAttempts: 2, baseDelayMs: 1_000,
    })
    expect(dead).toMatchObject({ executionState: "dead_letter", attemptCount: 2, nextAttemptAt: null })

    const other = recordExternalEvent({
      agent: "sanctuary", source: "guard", eventType: "download.failed", eventId: "another",
    }, { root: eventRoot, now: () => "2026-08-29T18:00:00.000Z" })
    claimExternalEvent(other.recordPath, {
      owner: "crashed-worker", expectedVersion: other.version, expectedGeneration: 1,
      now: () => "2026-08-29T18:00:00.000Z", leaseMs: 1_000,
    })
    const reclaimed = reconcileExternalEvent(other.recordPath, {
      now: () => "2026-08-29T18:00:02.000Z", maxAttempts: 3, baseDelayMs: 1_000,
    })
    expect(reclaimed).toMatchObject({ executionState: "retry_wait", claimOwner: null, lastError: "execution lease expired" })
  })

  it("directly reclaims an expired running lease with a new attempt owner", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "expired-direct" }, { root: eventRoot, now: () => "2026-08-29T18:00:00.000Z" })
    const expired = claimExternalEvent(first.recordPath, { owner: "worker-a", expectedVersion: first.version, expectedGeneration: 1, leaseMs: 1, now: () => "2026-08-29T18:00:00.000Z" })
    expect(claimExternalEvent(first.recordPath, { owner: "worker-b", expectedVersion: expired.version, expectedGeneration: 1, now: () => "2026-08-29T18:00:01.000Z" })).toMatchObject({ claimOwner: "worker-b", attemptCount: 2 })
  })

  it("renews only the exact live claim so a long turn is not reclaimed", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "long-turn" }, { root: eventRoot, now: () => "2026-08-29T18:00:00.000Z" })
    const claimed = claimExternalEvent(first.recordPath, { owner: "worker-a", expectedVersion: first.version, expectedGeneration: 1, leaseMs: 1_000, now: () => "2026-08-29T18:00:00.000Z" })
    const renewed = renewExternalEventClaim(first.recordPath, { owner: "worker-a", expectedGeneration: 1, leaseMs: 1_000, now: () => "2026-08-29T18:00:00.900Z" })

    expect(renewed).toMatchObject({ claimOwner: "worker-a", claimExpiresAt: "2026-08-29T18:00:01.900Z" })
    expect(reconcileExternalEvent(first.recordPath, { now: () => "2026-08-29T18:00:01.100Z" })).toEqual(renewed)
    expect(() => renewExternalEventClaim(first.recordPath, { owner: "worker-b", expectedGeneration: 1 })).toThrow(/claim owner/u)
    expect(renewed.version).toBeGreaterThan(claimed.version)
  })

  it("rejects unbounded event input before writing a receipt", () => {
    const eventRoot = root()
    expect(() => recordExternalEvent({
      agent: "sanctuary",
      source: "guard",
      eventType: "health.observed",
      eventId: "oversized",
      evidence: Array.from({ length: 33 }, () => "evidence"),
    }, { root: eventRoot })).toThrow(/bounded/u)
    expect(fs.readdirSync(eventRoot, { recursive: true })).toEqual([])
  })

  it("rejects an unbounded disposition without changing the live claim", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "bounded-disposition" }, { root: eventRoot })
    const claimed = claimExternalEvent(first.recordPath, { owner: "lease-1", expectedVersion: first.version, expectedGeneration: 1 })
    expect(() => commitExternalEventDisposition(first.recordPath, {
      owner: "lease-1", expectedVersion: claimed.version, expectedGeneration: 1,
      disposition: {
        classifiedRevision: claimed.observationRevision, classification: "resolved", stewardPolicy: { kind: "current", key: "service:test", version: 1 }, decision: "silent",
        reason: "r".repeat(4_097), nextWake: { kind: "on_change" }, careId: null, awaitId: null, actionRefs: [], verificationRefs: [],
      },
    })).toThrow(/bounded/u)
    expect(readExternalEventRecord(first.recordPath)).toEqual(claimed)
  })

  it("compacts oldest handled receipts but preserves active and dead-letter truth", () => {
    const eventRoot = root()
    const sourceDir = path.join(eventRoot, "sanctuary", "guard")
    fs.mkdirSync(sourceDir, { recursive: true })
    const template = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "template" }, { root: eventRoot })
    fs.unlinkSync(template.recordPath)
    for (let index = 0; index < 512; index += 1) {
      const state = index === 510 ? "received" : index === 511 ? "dead_letter" : "handled"
      const recordPath = path.join(sourceDir, `old-${String(index).padStart(3, "0")}.json`)
      fs.writeFileSync(recordPath, JSON.stringify({ ...template, eventId: `old-${index}`, recordPath, executionState: state, updatedAt: new Date(index).toISOString() }))
    }

    const newest = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "new" }, { root: eventRoot })
    const statuses = listExternalEventStatus(eventRoot)
    expect(statuses).toHaveLength(512)
    expect(statuses.some((row) => row.eventId === "old-510" && row.executionState === "received")).toBe(true)
    expect(statuses.some((row) => row.eventId === "old-511" && row.executionState === "dead_letter")).toBe(true)
    expect(statuses.some((row) => row.recordPath === newest.recordPath)).toBe(true)
    expect(statuses.find((row) => row.recordPath === newest.recordPath)?.retentionSummary).toMatchObject({ compactedHandledCount: 1 })
  })

  it("merges prior retention bounds and fails closed when capacity contains no handled receipt", () => {
    const eventRoot = root()
    const sourceDir = path.join(eventRoot, "sanctuary", "guard")
    fs.mkdirSync(sourceDir, { recursive: true })
    const template = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "template" }, { root: eventRoot })
    fs.unlinkSync(template.recordPath)
    for (let index = 0; index < 513; index += 1) {
      const recordPath = path.join(sourceDir, `handled-${index}.json`)
      fs.writeFileSync(recordPath, JSON.stringify({
        ...template,
        eventId: `handled-${index}`,
        recordPath,
        executionState: "handled",
        updatedAt: new Date(index * 1_000).toISOString(),
        ...(index === 0 ? { retentionSummary: { compactedHandledCount: 2, oldestCompactedAt: new Date(-1_000).toISOString(), newestCompactedAt: new Date(99_999).toISOString(), digest: "a".repeat(64) } } : {}),
      }))
    }
    const newest = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "new" }, { root: eventRoot })
    expect(newest.retentionSummary).toMatchObject({ compactedHandledCount: 4, oldestCompactedAt: new Date(-1_000).toISOString(), newestCompactedAt: new Date(99_999).toISOString() })

    const blockedRoot = root()
    const blockedDir = path.join(blockedRoot, "sanctuary", "guard")
    fs.mkdirSync(blockedDir, { recursive: true })
    for (let index = 0; index < 512; index += 1) {
      const recordPath = path.join(blockedDir, `active-${index}.json`)
      fs.writeFileSync(recordPath, JSON.stringify({ ...template, eventId: `active-${index}`, recordPath, executionState: "received" }))
    }
    expect(() => recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "blocked" }, { root: blockedRoot })).toThrow("capacity is exhausted")
  })

  it("bounds distinct sources per agent before creating another source directory", () => {
    const eventRoot = root()
    const agentDir = path.join(eventRoot, "sanctuary")
    for (let index = 0; index < 64; index += 1) fs.mkdirSync(path.join(agentDir, `source-${index}`), { recursive: true })
    expect(() => recordExternalEvent({ agent: "sanctuary", source: "source-overflow", eventType: "health.observed", eventId: "event" }, { root: eventRoot })).toThrow(/source capacity/u)
    expect(fs.existsSync(path.join(agentDir, "source-overflow"))).toBe(false)
  })

  it("uses a cross-process record lock and reclaims only stale lock directories", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "download.failed", eventId: "locked" }, { root: eventRoot })
    const lockPath = `${first.recordPath}.lock`
    fs.mkdirSync(lockPath)
    expect(() => claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })).toThrow(/busy/u)
    const stale = new Date(Date.now() - 31_000)
    fs.utimesSync(lockPath, stale, stale)
    expect(claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })).toMatchObject({ executionState: "running" })
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("fails closed when stale-lock cleanup cannot establish a successor lock", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "download.failed", eventId: "broken-lock" }, { root: eventRoot })
    const lockPath = `${first.recordPath}.lock`
    fs.mkdirSync(path.join(lockPath, "owner"), { recursive: true })
    const stale = new Date(Date.now() - 31_000)
    fs.utimesSync(lockPath, stale, stale)
    expect(() => claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })).toThrow(/busy/u)
  })

  it("uses collision-safe canonical paths and reports corrupt receipts truthfully", () => {
    const eventRoot = root()
    const slash = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "download.failed", eventId: "a/b" }, { root: eventRoot })
    const underscore = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "download.failed", eventId: "a_b" }, { root: eventRoot })
    expect(slash.recordPath).not.toBe(underscore.recordPath)

    const corruptPath = path.join(eventRoot, "sanctuary", "guard", "corrupt.json")
    fs.writeFileSync(corruptPath, "{bad")
    expect(listExternalEventStatus(eventRoot)).toContainEqual(expect.objectContaining({
      recordPath: corruptPath,
      corrupt: true,
      executionState: "corrupt",
      lastError: expect.stringContaining("invalid"),
    }))
  })

  it("ignores non-receipt filesystem entries while retaining invalid structured duplicate counts", () => {
    const eventRoot = root()
    fs.writeFileSync(path.join(eventRoot, "not-an-agent"), "ignored")
    fs.mkdirSync(path.join(eventRoot, "sanctuary"), { recursive: true })
    fs.writeFileSync(path.join(eventRoot, "sanctuary", "not-a-source"), "ignored")
    fs.mkdirSync(path.join(eventRoot, "sanctuary", "guard"), { recursive: true })
    fs.mkdirSync(path.join(eventRoot, "sanctuary", "guard", "directory.json"))
    fs.writeFileSync(path.join(eventRoot, "sanctuary", "guard", "notes.txt"), "ignored")
    const invalidPath = path.join(eventRoot, "sanctuary", "guard", "invalid.json")
    fs.writeFileSync(invalidPath, JSON.stringify({ duplicateCount: 4 }))

    const recorded = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "invalid" }, { root: eventRoot })
    expect(recorded.duplicateCount).toBe(5)
    expect(listExternalEventStatus(eventRoot)).toHaveLength(1)
  })

  it.each([null, "invalid", []])("replaces invalid receipt shape %j safely", (invalid) => {
    const eventRoot = root()
    const receiptDir = path.join(eventRoot, "sanctuary", "guard")
    fs.mkdirSync(receiptDir, { recursive: true })
    fs.writeFileSync(path.join(receiptDir, "shape.json"), JSON.stringify(invalid))
    expect(recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "shape" }, { root: eventRoot })).toMatchObject({ generation: 1, duplicateCount: 1 })
  })

  it("preserves a generation claim while unchanged telemetry advances the receipt version", () => {
    const eventRoot = root()
    const first = recordExternalEvent({
      agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed", eventId: "container:books",
      observationRevision: "rev-1", transition: "opened", evidence: ["Books is stopped"],
    }, { root: eventRoot, now: () => "2026-08-29T17:00:00.000Z" })
    const claimed = claimExternalEvent(first.recordPath, {
      owner: "agent-disposition:sanctuary:1", expectedVersion: first.version, expectedGeneration: first.generation,
      now: () => "2026-08-29T17:00:01.000Z",
    })
    const duplicate = recordExternalEvent({
      agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed", eventId: "container:books",
      observationRevision: "rev-1", transition: "unchanged", evidence: ["Books is stopped"],
    }, { root: eventRoot, now: () => "2026-08-29T17:00:02.000Z" })

    expect(duplicate).toMatchObject({
      version: claimed.version,
      generation: claimed.generation,
      executionState: "running",
      claimOwner: "agent-disposition:sanctuary:1",
      shouldWake: false,
    })
    expect(commitExternalEventDisposition(first.recordPath, {
      owner: "agent-disposition:sanctuary:1",
      expectedVersion: duplicate.version,
      expectedGeneration: duplicate.generation,
      disposition: {
        classifiedRevision: duplicate.observationRevision,
        classification: "expected",
        stewardPolicy: { kind: "current", key: "service:books", version: 1 },
        decision: "silent",
        reason: "Expected while unused.",
        nextWake: { kind: "on_change" },
        careId: null,
        awaitId: null,
        actionRefs: [],
        verificationRefs: [],
      },
    })).toMatchObject({ executionState: "handled" })
  })

  it("fences changed evidence behind the running generation and promotes it after disposition", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "array", observationRevision: "rev-1", evidence: ["array degraded"] }, { root: eventRoot })
    const claimed = claimExternalEvent(first.recordPath, { owner: "lease-1", expectedVersion: first.version, expectedGeneration: first.generation })
    const pending = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "array", observationRevision: "rev-2", transition: "changed", evidence: ["array degraded and disk hot"] }, { root: eventRoot })

    expect(pending).toMatchObject({ generation: 1, observationRevision: "rev-1", executionState: "running", pendingObservation: { observationRevision: "rev-2" } })
    const promoted = commitExternalEventDisposition(first.recordPath, {
      owner: "lease-1",
      expectedVersion: pending.version,
      expectedGeneration: 1,
      disposition: {
        classifiedRevision: "rev-1",
        classification: "needs_attention",
        stewardPolicy: { kind: "current", key: "storage:health", version: 1 },
        decision: "act",
        reason: "Investigating the original degradation.",
        nextWake: { kind: "on_change" },
        careId: null,
        awaitId: null,
        actionRefs: [],
        verificationRefs: [],
      },
    })
    expect(promoted).toMatchObject({ generation: 2, observationRevision: "rev-2", executionState: "received", pendingObservation: null, disposition: null, shouldWake: true })
    expect(claimed.observationRevision).toBe("rev-1")
  })

  it("defaults optional changed-observation fields without overwriting the active generation", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "defaults", observationRevision: "rev-1" }, { root: eventRoot })
    claimExternalEvent(first.recordPath, { owner: "lease", expectedVersion: first.version, expectedGeneration: 1 })
    expect(recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "defaults", observationRevision: "rev-1" }, { root: eventRoot })).toMatchObject({ executionState: "running", shouldWake: false })
    const pending = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "defaults", observationRevision: "rev-2" }, { root: eventRoot })
    expect(pending.pendingObservation).toMatchObject({ summary: null, evidence: [], payloadPath: null, priority: "high", transition: "changed" })
  })

  it("keeps a dead-lettered unchanged revision dormant", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "poison", observationRevision: "rev-1" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    const dead = failExternalEventAttempt(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, error: "poison", maxAttempts: 1 })
    const unchanged = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "poison", observationRevision: "rev-1" }, { root: eventRoot })
    expect(dead.executionState).toBe("dead_letter")
    expect(unchanged).toMatchObject({ executionState: "dead_letter", generation: 1, shouldWake: false })
  })

  it("advances an exact await-backed disposition once and exposes persisted silence status", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "credit.low", eventId: "usenet" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    const handled = commitExternalEventDisposition(first.recordPath, {
      owner: "worker", expectedVersion: claim.version, expectedGeneration: 1,
      disposition: {
        classifiedRevision: first.observationRevision, classification: "snoozed", stewardPolicy: { kind: "current", key: "downloads:credit", version: 2 },
        decision: "silent", reason: "Ari asked for a reminder tomorrow.", nextWake: { kind: "at", at: "2026-08-30T17:00:00.000Z" },
        careId: null, awaitId: "await-top-up", actionRefs: [], verificationRefs: [],
      },
    })

    const advanced = advanceExternalEventFromAwait(first.recordPath, {
      awaitId: "await-top-up", expectedVersion: handled.version, expectedGeneration: 1,
      now: () => "2026-08-30T17:00:00.000Z",
    })
    expect(advanced).toMatchObject({ generation: 2, executionState: "queued", shouldWake: true, disposition: null })
    expect(() => advanceExternalEventFromAwait(first.recordPath, {
      awaitId: "await-top-up", expectedVersion: advanced.version, expectedGeneration: 2,
    })).toThrow(/await/u)
    expect(readExternalEventRecord(first.recordPath)).toEqual(advanced)
  })

  it("uses the current time when an await-backed advance has no injected clock", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "credit.low", eventId: "default-time" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    const handled = commitExternalEventDisposition(first.recordPath, {
      owner: "worker",
      expectedVersion: claim.version,
      expectedGeneration: 1,
      disposition: { classifiedRevision: first.observationRevision, classification: "snoozed", stewardPolicy: { kind: "current", key: "downloads:credit", version: 1 }, decision: "silent", reason: "Wait.", nextWake: { kind: "at", at: "2026-08-30T17:00:00.000Z" }, careId: null, awaitId: "await-default", actionRefs: [], verificationRefs: [] },
    })
    expect(advanceExternalEventFromAwait(first.recordPath, { awaitId: "await-default", expectedVersion: handled.version, expectedGeneration: 1 }).updatedAt).toMatch(/^\d{4}-/u)
  })

  it("rejects a time disposition without a valid await-backed return", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "credit.low", eventId: "invalid-await" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    expect(() => commitExternalEventDisposition(first.recordPath, {
      owner: "worker",
      expectedVersion: claim.version,
      expectedGeneration: 1,
      disposition: {
        classifiedRevision: first.observationRevision,
        classification: "snoozed",
        stewardPolicy: { kind: "current", key: "downloads:credit", version: 2 },
        decision: "silent",
        reason: "Wait for top-up.",
        nextWake: { kind: "at", at: "not-a-time" },
        careId: null,
        awaitId: null,
        actionRefs: [],
        verificationRefs: [],
      },
    })).toThrow(/await receipt/u)
  })

  it("rejects an unknown steward-policy shape", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "invalid-policy" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    expect(() => commitExternalEventDisposition(first.recordPath, {
      owner: "worker", expectedVersion: claim.version, expectedGeneration: 1,
      disposition: { classifiedRevision: first.observationRevision, classification: "resolved", stewardPolicy: { kind: "future" } as never, decision: "silent", reason: "invalid", nextWake: { kind: "on_change" }, careId: null, awaitId: null, actionRefs: [], verificationRefs: [] },
    })).toThrow("steward policy is invalid")
  })

  it("rejects invalid claims, owners, retry policies, and await combinations", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "validation" }, { root: eventRoot })
    expect(() => claimExternalEvent(first.recordPath, { owner: "", expectedVersion: first.version, expectedGeneration: 1 })).toThrow(/claim is invalid/u)
    expect(() => claimExternalEvent(first.recordPath, { owner: "worker", leaseMs: 0, expectedVersion: first.version, expectedGeneration: 1 })).toThrow(/claim is invalid/u)
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    expect(() => claimExternalEvent(first.recordPath, { owner: "other", expectedVersion: claim.version, expectedGeneration: 1 })).toThrow(/already claimed/u)
    expect(() => commitExternalEventDisposition(first.recordPath, {
      owner: "other",
      expectedVersion: claim.version,
      expectedGeneration: 1,
      disposition: { classifiedRevision: first.observationRevision, classification: "expected", stewardPolicy: { kind: "current", key: "test", version: 1 }, decision: "silent", reason: "test", nextWake: { kind: "on_change" }, careId: null, awaitId: null, actionRefs: [], verificationRefs: [] },
    })).toThrow(/owner mismatch/u)
    expect(() => commitExternalEventDisposition(first.recordPath, {
      owner: "worker",
      expectedVersion: claim.version,
      expectedGeneration: 1,
      disposition: { classifiedRevision: first.observationRevision, classification: "expected", stewardPolicy: { kind: "current", key: "test", version: 1 }, decision: "silent", reason: "test", nextWake: { kind: "on_change" }, careId: null, awaitId: "unexpected", actionRefs: [], verificationRefs: [] },
    })).toThrow(/does not match/u)
    expect(() => failExternalEventAttempt(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, error: "failed", maxAttempts: 0 })).toThrow(/retry policy/u)
    expect(reconcileExternalEvent(first.recordPath)).toEqual(claim)
  })

  it("covers claim renewal, disposition, and input validation boundaries", () => {
    const eventRoot = root()
    for (const input of [
      { agent: "", source: "guard", eventType: "health", eventId: "id" },
      { agent: " sanctuary", source: "guard", eventType: "health", eventId: "id" },
      { agent: "sanctuary", source: "guard", eventType: "health", eventId: "id", evidence: ["x".repeat(4_097)] },
      { agent: "sanctuary", source: "guard", eventType: "health", eventId: "id", summary: "x".repeat(70_000) },
      { agent: "sanctuary", source: "guard", eventType: "health", eventId: "id", evidence: Array.from({ length: 32 }, () => "x".repeat(4_096)) },
    ]) expect(() => recordExternalEvent(input as any, { root: eventRoot })).toThrow()

    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health", eventId: "bounds" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    expect(() => renewExternalEventClaim(first.recordPath, { owner: "worker", expectedGeneration: 2 })).toThrow("generation")
    expect(() => renewExternalEventClaim(first.recordPath, { owner: "worker", expectedGeneration: 1, leaseMs: 0 })).toThrow("renewal")
    expect(renewExternalEventClaim(first.recordPath, { owner: "worker", expectedGeneration: 1 })).toMatchObject({ claimOwner: "worker", claimExpiresAt: expect.any(String) })
    const base = { classifiedRevision: first.observationRevision, classification: "expected" as const, stewardPolicy: { kind: "current" as const, key: "test", version: 1 }, decision: "silent" as const, reason: "test", nextWake: { kind: "on_change" as const }, careId: null, awaitId: null, actionRefs: [], verificationRefs: [] }
    for (const disposition of [
      { ...base, stewardPolicy: { kind: "current", key: "test", version: Number.NaN } },
      { ...base, stewardPolicy: { kind: "current", key: "test", version: 0 } },
      { ...base, stewardPolicy: { kind: "invalid" } },
      { ...base, actionRefs: Array.from({ length: 33 }, () => "ref") },
      { ...base, verificationRefs: Array.from({ length: 33 }, () => "ref") },
      { ...base, actionRefs: ["x".repeat(513)] },
    ]) expect(() => commitExternalEventDisposition(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, disposition: disposition as any })).toThrow()
  })

  it.each([
    ["current", { kind: "current", key: "test", version: 1 }, [], []],
    ["none", { kind: "none" }, [], []],
  ] as const)("accepts a valid %s steward disposition with bounded receipt lists", (_label, stewardPolicy, actionRefs, verificationRefs) => {
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health", eventId: `valid-${_label}` }, { root: root() })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    expect(commitExternalEventDisposition(first.recordPath, {
      owner: "worker", expectedVersion: claim.version, expectedGeneration: 1,
      disposition: { classifiedRevision: first.observationRevision, classification: "expected", stewardPolicy, decision: "silent", reason: "quiet", nextWake: { kind: "on_change" }, careId: null, awaitId: null, actionRefs: [...actionRefs], verificationRefs: [...verificationRefs] },
    })).toMatchObject({ executionState: "handled" })
  })

  it.each([
    ["non-integer policy", { stewardPolicy: { kind: "current", key: "test", version: Number.NaN } }],
    ["zero policy", { stewardPolicy: { kind: "current", key: "test", version: 0 } }],
    ["too many action receipts", { actionRefs: Array.from({ length: 33 }, () => "action") }],
    ["too many verification receipts", { verificationRefs: Array.from({ length: 33 }, () => "verification") }],
  ] as const)("rejects %s in an independently claimed event", (_label, override) => {
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health", eventId: `invalid-${_label}` }, { root: root() })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    const base = { classifiedRevision: first.observationRevision, classification: "expected" as const, stewardPolicy: { kind: "current" as const, key: "test", version: 1 }, decision: "silent" as const, reason: "quiet", nextWake: { kind: "on_change" as const }, careId: null, awaitId: null, actionRefs: [], verificationRefs: [] }
    expect(() => commitExternalEventDisposition(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, disposition: { ...base, ...override } as any })).toThrow()
  })

  it("preserves compacted retention while fencing a changed running observation", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "retained-running", observationRevision: "rev-1" }, { root: eventRoot })
    claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    const running = readExternalEventRecord(first.recordPath)
    fs.writeFileSync(first.recordPath, JSON.stringify({
      ...running,
      retentionSummary: {
        compactedHandledCount: 2,
        oldestCompactedAt: "2026-08-20T00:00:00.000Z",
        newestCompactedAt: "2026-08-21T00:00:00.000Z",
        digest: "retained",
      },
    }))

    expect(recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId: "retained-running", observationRevision: "rev-2" }, { root: eventRoot }))
      .toMatchObject({ pendingObservation: { observationRevision: "rev-2" }, retentionSummary: { compactedHandledCount: 2 } })
  })

  it("binds a privileged failsafe exactly once and rejects changed or invalid bindings", () => {
    const eventRoot = root()
    const ordinarySeed = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "usenet.protective_action", eventId: "spend" }, { root: eventRoot })
    const recordPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", "spend.json")
    fs.mkdirSync(path.dirname(recordPath), { recursive: true })
    const privileged = { ...ordinarySeed, source: "sanctuary-usenet", recordPath, privilegedProtectiveAction: { action: "sabnzbd.pause", actionReceipt: "receipt", transitionId: "transition", critical: true, createdAt: "2026-08-29T00:00:00.000Z", expiresAt: "2026-08-30T00:00:00.000Z", verification: { verified: true, digest: "d".repeat(64), observedAt: "2026-08-29T00:00:00.000Z" } } }
    fs.writeFileSync(recordPath, JSON.stringify(privileged))
    expect(() => bindPrivilegedFailsafeArtifact(recordPath, { artifactId: "bad", verificationRef: "verified" })).toThrow("artifact id")
    expect(() => bindPrivilegedFailsafeArtifact(recordPath, { artifactId: "a".repeat(64), verificationRef: " " })).toThrow("reference")
    expect(() => bindPrivilegedFailsafeArtifact(recordPath, { artifactId: "a".repeat(64), verificationRef: "verified", recordedAt: "bad" })).toThrow("recorded time")
    const bound = bindPrivilegedFailsafeArtifact(recordPath, { artifactId: "a".repeat(64), verificationRef: "verified", recordedAt: "2026-08-29T01:00:00.000Z" })
    expect(bound.privilegedFailsafe?.artifactId).toBe("a".repeat(64))
    expect(bindPrivilegedFailsafeArtifact(recordPath, { artifactId: "a".repeat(64), verificationRef: "verified" })).toMatchObject({ version: bound.version })
    expect(() => bindPrivilegedFailsafeArtifact(recordPath, { artifactId: "b".repeat(64), verificationRef: "verified" })).toThrow("binding changed")
    const ordinary = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health", eventId: "ordinary" }, { root: eventRoot })
    expect(() => bindPrivilegedFailsafeArtifact(ordinary.recordPath, { artifactId: "a".repeat(64), verificationRef: "verified" })).toThrow("privileged")

    const preseededPath = externalEventRecordPath(eventRoot, { agent: "sanctuary", source: "sanctuary-usenet", eventId: "preseeded" })
    fs.writeFileSync(preseededPath, JSON.stringify({ ...privileged, eventId: "preseeded", recordPath: preseededPath, evidence: [`system failsafe artifact: ${"c".repeat(64)}`], privilegedFailsafe: undefined }))
    expect(bindPrivilegedFailsafeArtifact(preseededPath, { artifactId: "c".repeat(64), verificationRef: "checked" }).evidence).toContain("protective state verification: checked")

    const fullPath = externalEventRecordPath(eventRoot, { agent: "sanctuary", source: "sanctuary-usenet", eventId: "full" })
    fs.writeFileSync(fullPath, JSON.stringify({ ...privileged, eventId: "full", recordPath: fullPath, evidence: Array.from({ length: 32 }, (_, index) => `evidence-${index}`), privilegedFailsafe: undefined }))
    expect(() => bindPrivilegedFailsafeArtifact(fullPath, { artifactId: "d".repeat(64), verificationRef: "checked" })).toThrow("evidence exceeds")
  })

  it("advances every exact Await-bound status and ignores corrupt or unrelated rows", () => {
    const eventRoot = root()
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "credit", eventId: "bulk-await" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    commitExternalEventDisposition(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, disposition: { classifiedRevision: first.observationRevision, classification: "snoozed", stewardPolicy: { kind: "none" }, decision: "silent", reason: "wait", nextWake: { kind: "at", at: "2026-09-01T00:00:00.000Z" }, careId: null, awaitId: "wake", actionRefs: [], verificationRefs: [] } })
    const corruptPath = path.join(eventRoot, "sanctuary", "guard", "corrupt.json")
    fs.writeFileSync(corruptPath, "bad")
    expect(advanceExternalEventsFromAwait(eventRoot, "other", "wake")).toEqual([])
    expect(advanceExternalEventsFromAwait(eventRoot, "sanctuary", "wake")).toEqual([expect.objectContaining({ executionState: "queued" })])
  })

  it.each([
    ["on_escalation", "escalated", true],
    ["on_escalation", "changed", false],
    ["on_recovery", "recovered", true],
    ["on_recovery", "changed", false],
    ["at", "changed", false],
  ] as const)("evaluates %s wake predicates against %s evidence", (kind, transition, shouldWake) => {
    const eventRoot = root()
    const eventId = `${kind}-${transition}`
    const first = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId, observationRevision: "rev-1" }, { root: eventRoot })
    const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: 1 })
    const nextWake = kind === "at" ? { kind, at: "2026-08-30T17:00:00.000Z" } : { kind }
    commitExternalEventDisposition(first.recordPath, {
      owner: "worker",
      expectedVersion: claim.version,
      expectedGeneration: 1,
      disposition: {
        classifiedRevision: "rev-1",
        classification: "expected",
        stewardPolicy: { kind: "current", key: "service:test", version: 1 },
        decision: "silent",
        reason: "Predicate coverage.",
        nextWake,
        careId: null,
        awaitId: kind === "at" ? "await-test" : null,
        actionRefs: [],
        verificationRefs: [],
      },
    })
    const observed = recordExternalEvent({ agent: "sanctuary", source: "guard", eventType: "health.observed", eventId, observationRevision: "rev-2", transition }, { root: eventRoot })
    expect(observed.shouldWake).toBe(shouldWake)
  })
})
