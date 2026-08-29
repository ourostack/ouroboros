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

    expect(first).toMatchObject({ schemaVersion: 2, executionState: "queued", generation: 1, shouldWake: true })
    expect(duplicate).toMatchObject({ executionState: "queued", generation: 1, duplicateCount: 1, shouldWake: false })
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
    expect(changed).toMatchObject({ generation: 2, executionState: "queued", shouldWake: true })
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
})
