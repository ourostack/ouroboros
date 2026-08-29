import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import {
  advanceExternalEventFromAwait,
  claimExternalEvent,
  commitExternalEventDisposition,
  failExternalEventAttempt,
  listExternalEventStatus,
  readExternalEventRecord,
  reconcileExternalEvent,
  recordExternalEvent,
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
        classifiedRevision: "rev-1", classification: "expected", stewardPolicy: { key: "service:books", version: 3 },
        decision: "silent", reason: "Books is intentionally available only when requested.", nextWake: { kind: "on_change" },
        careId: null, awaitId: null, actionRefs: [], verificationRefs: [],
      },
    })

    expect(handled).toMatchObject({ executionState: "handled", shouldWake: false, disposition: { reason: "Books is intentionally available only when requested." } })
    expect(listExternalEventStatus(eventRoot)).toEqual([expect.objectContaining({
      source: "sanctuary-health", eventId: "container:books", executionState: "handled", classification: "expected",
      decision: "silent", reason: "Books is intentionally available only when requested.", stewardPolicy: { key: "service:books", version: 3 },
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
        stewardPolicy: { key: "service:books", version: 1 },
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
        stewardPolicy: { key: "storage:health", version: 1 },
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
        classifiedRevision: first.observationRevision, classification: "snoozed", stewardPolicy: { key: "downloads:credit", version: 2 },
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
      disposition: { classifiedRevision: first.observationRevision, classification: "snoozed", stewardPolicy: { key: "downloads:credit", version: 1 }, decision: "silent", reason: "Wait.", nextWake: { kind: "at", at: "2026-08-30T17:00:00.000Z" }, careId: null, awaitId: "await-default", actionRefs: [], verificationRefs: [] },
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
        stewardPolicy: { key: "downloads:credit", version: 2 },
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
      disposition: { classifiedRevision: first.observationRevision, classification: "expected", stewardPolicy: { key: "test", version: 1 }, decision: "silent", reason: "test", nextWake: { kind: "on_change" }, careId: null, awaitId: null, actionRefs: [], verificationRefs: [] },
    })).toThrow(/owner mismatch/u)
    expect(() => commitExternalEventDisposition(first.recordPath, {
      owner: "worker",
      expectedVersion: claim.version,
      expectedGeneration: 1,
      disposition: { classifiedRevision: first.observationRevision, classification: "expected", stewardPolicy: { key: "test", version: 1 }, decision: "silent", reason: "test", nextWake: { kind: "on_change" }, careId: null, awaitId: "unexpected", actionRefs: [], verificationRefs: [] },
    })).toThrow(/does not match/u)
    expect(() => failExternalEventAttempt(first.recordPath, { owner: "worker", expectedVersion: claim.version, expectedGeneration: 1, error: "failed", maxAttempts: 0 })).toThrow(/retry policy/u)
    expect(reconcileExternalEvent(first.recordPath)).toEqual(claim)
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
        stewardPolicy: { key: "service:test", version: 1 },
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
