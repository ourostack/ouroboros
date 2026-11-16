import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildExternalEventMessage,
  claimExternalEvent,
  commitExternalEventDisposition,
  externalEventRecordPath,
  getExternalEventRoot,
  recordExternalEvent,
  readExternalEventRecord,
  listExternalEventStatus,
  renewExternalEventClaim,
  settleExternalEventFailureIfOwned,
} from "../../../heart/external-events/router"

const cleanupPaths: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanupPaths.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of cleanupPaths.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function disposition(classifiedRevision: string) {
  return {
    classifiedRevision,
    classification: "expected" as const,
    stewardPolicy: { kind: "none" as const },
    decision: "silent" as const,
    reason: "Expected while the library is sleeping.",
    nextWake: { kind: "on_change" as const },
    careId: null,
    awaitId: null,
    actionRefs: [],
    verificationRefs: [],
  }
}

describe("external event router", () => {
  it("resolves the daemon external-event root under an injected CLI home", () => {
    const home = tempDir("ouro-external-event-home-")

    expect(getExternalEventRoot(home)).toBe(path.join(home, ".ouro-cli", "daemon", "external-events"))
  })

  it("sanitizes provider-controlled path segments before writing receipts", () => {
    const root = tempDir("ouro-external-event-root-")

    expect(externalEventRecordPath(root, {
      agent: " !!! ",
      source: "app store/connect",
      eventId: "feedback:1/2",
    })).toMatch(new RegExp(`^${root}/unknown-[a-f0-9]{16}/app_store_connect-[a-f0-9]{16}/feedback_1_2-[a-f0-9]{16}\\.json$`, "u"))
  })

  it("recovers duplicate counting when an existing receipt is corrupt", () => {
    const root = tempDir("ouro-external-event-root-")
    const input = {
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      receivedAt: "2026-07-06T00:00:00.000Z",
    }
    const recordPath = externalEventRecordPath(root, input)
    fs.mkdirSync(path.dirname(recordPath), { recursive: true })
    fs.writeFileSync(recordPath, "{not-json", "utf-8")

    const record = recordExternalEvent(input, {
      root,
      now: () => "2026-07-06T00:01:00.000Z",
    })

    expect(record.duplicateCount).toBe(1)
    expect(JSON.parse(fs.readFileSync(recordPath, "utf-8"))).toMatchObject({
      eventId: "feedback-1",
      duplicateCount: 1,
      updatedAt: "2026-07-06T00:01:00.000Z",
    })
  })

  it("falls back to one duplicate when an existing receipt has a nonnumeric count", () => {
    const root = tempDir("ouro-external-event-root-")
    const input = {
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      receivedAt: "2026-07-06T00:00:00.000Z",
    }
    const recordPath = externalEventRecordPath(root, input)
    fs.mkdirSync(path.dirname(recordPath), { recursive: true })
    fs.writeFileSync(recordPath, JSON.stringify({ duplicateCount: "one" }), "utf-8")

    expect(recordExternalEvent(input, {
      root,
      now: () => "2026-07-06T00:01:00.000Z",
    }).duplicateCount).toBe(1)
  })

  it("renders a minimal untrusted-event message without optional fields", () => {
    const root = tempDir("ouro-external-event-root-")
    const record = recordExternalEvent({
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      receivedAt: "2026-07-06T00:00:00.000Z",
    }, {
      root,
      now: () => "2026-07-06T00:01:00.000Z",
    })

    expect(buildExternalEventMessage(record)).toContain("Evidence:\n- none")
    expect(buildExternalEventMessage(record)).not.toContain("summary:")
    expect(buildExternalEventMessage(record)).not.toContain("payload:")
  })

  it("renders optional evidence, summary, and payload and rejects invalid receipt identity", () => {
    const root = tempDir("ouro-external-event-root-")
    const record = recordExternalEvent({ agent: "slugger", source: "guard", eventType: "health", eventId: "rich", summary: "Summary", payloadPath: "/payload", evidence: ["one", "two"] }, { root })
    expect(buildExternalEventMessage(record)).toContain("- one\n- two")
    expect(buildExternalEventMessage(record)).toContain("summary: Summary")
    expect(buildExternalEventMessage(record)).toContain("payload: /payload")
    fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, recordPath: `${record.recordPath}.other` }))
    expect(() => readExternalEventRecord(record.recordPath)).toThrow("identity")
    fs.writeFileSync(record.recordPath, JSON.stringify({ schemaVersion: 1 }))
    expect(() => readExternalEventRecord(record.recordPath)).toThrow("invalid")
    expect(listExternalEventStatus(path.join(root, "missing"))).toEqual([])
  })

  it("ignores dot directories without entering a disappearing capacity lock", () => {
    const root = tempDir("ouro-external-event-dot-dirs-")
    const hiddenAgent = path.join(root, ".capacity.lock")
    const hiddenSource = path.join(root, "slugger", ".capacity.lock")
    fs.mkdirSync(hiddenAgent, { recursive: true })
    fs.mkdirSync(hiddenSource, { recursive: true })
    fs.mkdirSync(path.join(hiddenAgent, "source"))
    fs.writeFileSync(path.join(hiddenAgent, "source", "lock-race.json"), "{partial")
    fs.writeFileSync(path.join(hiddenSource, "lock-race.json"), "{partial")

    expect(listExternalEventStatus(root)).toEqual([])
  })

  it("settles an exact owned generation from current in-lock state despite version churn", () => {
    const root = tempDir("ouro-external-event-owned-failure-")
    const initial = recordExternalEvent({
      agent: "sanctuary",
      source: "sanctuary-health",
      eventType: "health.observed",
      eventId: "books",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T03:00:00.000Z" })
    const claimed = claimExternalEvent(initial.recordPath, {
      owner: "turn-1",
      expectedVersion: initial.version,
      expectedGeneration: initial.generation,
      now: () => "2026-09-02T03:00:01.000Z",
    })
    renewExternalEventClaim(claimed.recordPath, {
      owner: "turn-1",
      expectedGeneration: claimed.generation,
      now: () => "2026-09-02T03:00:02.000Z",
    })
    recordExternalEvent({
      agent: "sanctuary",
      source: "sanctuary-health",
      eventType: "health.observed",
      eventId: "books",
      observationRevision: "revision-2",
      summary: "new observation while the turn is running",
    }, { root, now: () => "2026-09-02T03:00:03.000Z" })

    const result = settleExternalEventFailureIfOwned(claimed.recordPath, {
      owner: "turn-1",
      expectedGeneration: claimed.generation,
      error: "private turn failed",
      now: () => "2026-09-02T03:00:04.000Z",
    })

    expect(result.settled).toBe(true)
    expect(result.record).toMatchObject({
      executionState: "retry_wait",
      claimOwner: null,
      claimExpiresAt: null,
      lastError: "private turn failed",
      pendingObservation: { observationRevision: "revision-2" },
      version: 5,
    })
    expect(readExternalEventRecord(claimed.recordPath)).toEqual(result.record)
  })

  it("defers a turn that never ran without spending a retry attempt, even after many blocks", () => {
    const root = tempDir("ouro-external-event-owned-defer-")
    let record = recordExternalEvent({
      agent: "sanctuary",
      source: "sanctuary-health",
      eventType: "health.observed",
      eventId: "disk:sdb:smart",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T03:00:00.000Z" })
    for (let attempt = 0; attempt < 7; attempt++) {
      const minute = String(10 + attempt).padStart(2, "0")
      const claimed = claimExternalEvent(record.recordPath, {
        owner: `turn-${attempt}`,
        expectedVersion: record.version,
        expectedGeneration: record.generation,
        now: () => `2026-09-02T03:${minute}:00.000Z`,
      })
      const result = settleExternalEventFailureIfOwned(claimed.recordPath, {
        owner: `turn-${attempt}`,
        expectedGeneration: claimed.generation,
        error: "external-event turn was blocked",
        deferUntil: `2026-09-02T03:${minute}:30.000Z`,
        now: () => `2026-09-02T03:${minute}:01.000Z`,
      })
      expect(result.record).toMatchObject({ executionState: "retry_wait", attemptCount: 0, nextAttemptAt: `2026-09-02T03:${minute}:30.000Z`, claimOwner: null })
      record = result.record
    }
  })

  it("ignores records that are no longer running under the exact owner and generation", () => {
    const root = tempDir("ouro-external-event-owned-failure-ignore-")
    const received = recordExternalEvent({
      agent: "sanctuary",
      source: "sanctuary-health",
      eventType: "health.observed",
      eventId: "books",
    }, { root, now: () => "2026-09-02T03:10:00.000Z" })

    expect(settleExternalEventFailureIfOwned(received.recordPath, {
      owner: "turn-1",
      expectedGeneration: received.generation,
      error: "must not apply",
    })).toEqual({ settled: false, record: received })

    const claimed = claimExternalEvent(received.recordPath, {
      owner: "turn-1",
      expectedVersion: received.version,
      expectedGeneration: received.generation,
      now: () => "2026-09-02T03:10:01.000Z",
    })
    expect(settleExternalEventFailureIfOwned(claimed.recordPath, {
      owner: "turn-2",
      expectedGeneration: claimed.generation,
      error: "must not apply",
    })).toEqual({ settled: false, record: claimed })
    expect(settleExternalEventFailureIfOwned(claimed.recordPath, {
      owner: "turn-1",
      expectedGeneration: claimed.generation + 1,
      error: "must not apply",
    })).toEqual({ settled: false, record: claimed })
    expect(readExternalEventRecord(claimed.recordPath)).toEqual(claimed)
  })

  it("records a disposition after the lease heartbeat moved the receipt version", () => {
    const root = tempDir("ouro-external-event-disposition-heartbeat-")
    const received = recordExternalEvent({
      agent: "slugger",
      source: "app-store-connect",
      eventType: "betaFeedbackCrashSubmissionCreated",
      eventId: "books",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T04:00:00.000Z" })
    const owner = `external-event:slugger:app-store-connect:books:generation:${received.generation}:attempt:1`
    const claimed = claimExternalEvent(received.recordPath, {
      owner,
      expectedVersion: received.version,
      expectedGeneration: received.generation,
      now: () => "2026-09-02T04:00:01.000Z",
    })
    // The turn's own heartbeat advances the receipt version while the turn is still working.
    const renewed = renewExternalEventClaim(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      now: () => "2026-09-02T04:00:02.000Z",
    })
    expect(renewed.version).toBeGreaterThan(claimed.version)

    const handled = commitExternalEventDisposition(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T04:00:03.000Z",
    })

    expect(handled).toMatchObject({
      executionState: "handled",
      claimOwner: null,
      disposition: { classifiedRevision: "revision-1", classification: "expected" },
    })
    expect(readExternalEventRecord(claimed.recordPath)).toEqual(handled)
  })

  it("records a disposition after the lease was released and the receipt settled to retry_wait", () => {
    const root = tempDir("ouro-external-event-disposition-released-")
    const received = recordExternalEvent({
      agent: "slugger",
      source: "app-store-connect",
      eventType: "betaFeedbackCrashSubmissionCreated",
      eventId: "books",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T05:00:00.000Z" })
    const owner = `external-event:slugger:app-store-connect:books:generation:${received.generation}:attempt:1`
    const claimed = claimExternalEvent(received.recordPath, {
      owner,
      expectedVersion: received.version,
      expectedGeneration: received.generation,
      now: () => "2026-09-02T05:00:01.000Z",
    })
    const settled = settleExternalEventFailureIfOwned(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      error: "private turn failed",
      now: () => "2026-09-02T05:00:02.000Z",
    })
    expect(settled.record).toMatchObject({ executionState: "retry_wait", claimOwner: null })

    const handled = commitExternalEventDisposition(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T05:00:03.000Z",
    })

    expect(handled).toMatchObject({ executionState: "handled", disposition: { classifiedRevision: "revision-1" } })
  })

  it("accepts the exact claim owner the receipt carries, and refuses any other opaque owner", () => {
    const root = tempDir("ouro-external-event-disposition-opaque-owner-")
    const received = recordExternalEvent({
      agent: "sanctuary",
      source: "guard",
      eventType: "health.observed",
      eventId: "opaque-owner",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T08:00:00.000Z" })
    // The general API treats the owner as an opaque claim token, not only a canonical lease.
    const claimed = claimExternalEvent(received.recordPath, {
      owner: "worker-a",
      expectedVersion: received.version,
      expectedGeneration: received.generation,
      now: () => "2026-09-02T08:00:01.000Z",
    })
    expect(claimed.claimOwner).toBe("worker-a")

    // An owner that is not the current claim owner cannot disposition the receipt.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner: "worker-b",
      expectedVersion: claimed.version,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T08:00:02.000Z",
    })).toThrow(/claim owner mismatch/u)

    // The current claim owner can.
    const handled = commitExternalEventDisposition(claimed.recordPath, {
      owner: "worker-a",
      expectedVersion: claimed.version,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T08:00:03.000Z",
    })
    expect(handled).toMatchObject({ executionState: "handled", disposition: { classifiedRevision: "revision-1" } })
  })

  it("refuses a malformed or foreign lease owner even after the lease was released", () => {
    const root = tempDir("ouro-external-event-disposition-owner-")
    const received = recordExternalEvent({
      agent: "slugger",
      source: "app-store-connect",
      eventType: "betaFeedbackCrashSubmissionCreated",
      eventId: "books",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T07:00:00.000Z" })
    const owner = `external-event:slugger:app-store-connect:books:generation:${received.generation}:attempt:1`
    const claimed = claimExternalEvent(received.recordPath, {
      owner,
      expectedVersion: received.version,
      expectedGeneration: received.generation,
      now: () => "2026-09-02T07:00:01.000Z",
    })
    // The lease is released, so the receipt no longer names a claim owner at all. The turn's own
    // lease is still the only thing that can authorize the disposition.
    const settled = settleExternalEventFailureIfOwned(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      error: "private turn failed",
      now: () => "2026-09-02T07:00:02.000Z",
    })
    expect(settled.record).toMatchObject({ executionState: "retry_wait", claimOwner: null })

    // A malformed owner is refused rather than silently accepted.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner: "external-event:slugger:app-store-connect:books:garbage",
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T07:00:03.000Z",
    })).toThrow(/claim owner mismatch/u)

    // A lease for a different receipt is refused.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner: `external-event:slugger:app-store-connect:other-books:generation:${claimed.generation}:attempt:1`,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T07:00:04.000Z",
    })).toThrow(/claim owner mismatch/u)

    // A lease for another agent is refused.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner: `external-event:other-agent:app-store-connect:books:generation:${claimed.generation}:attempt:1`,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T07:00:05.000Z",
    })).toThrow(/claim owner mismatch/u)

    // A lease for another generation is refused.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner: `external-event:slugger:app-store-connect:books:generation:${claimed.generation + 1}:attempt:1`,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T07:00:06.000Z",
    })).toThrow(/claim owner mismatch/u)

    // The receipt is untouched by every refused attempt.
    expect(readExternalEventRecord(claimed.recordPath)).toMatchObject({
      executionState: "retry_wait",
      claimOwner: null,
      disposition: null,
    })

    // A later attempt of the SAME generation is the same piece of work, so it is accepted.
    const handled = commitExternalEventDisposition(claimed.recordPath, {
      owner: `external-event:slugger:app-store-connect:books:generation:${claimed.generation}:attempt:4`,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T07:00:07.000Z",
    })
    expect(handled).toMatchObject({ executionState: "handled", disposition: { classifiedRevision: "revision-1" } })
  })

  it("refuses a disposition for another generation, another lease, or an already-dispositioned receipt", () => {
    const root = tempDir("ouro-external-event-disposition-refused-")
    const received = recordExternalEvent({
      agent: "slugger",
      source: "app-store-connect",
      eventType: "betaFeedbackCrashSubmissionCreated",
      eventId: "books",
      observationRevision: "revision-1",
    }, { root, now: () => "2026-09-02T06:00:00.000Z" })
    const owner = `external-event:slugger:app-store-connect:books:generation:${received.generation}:attempt:1`
    const claimed = claimExternalEvent(received.recordPath, {
      owner,
      expectedVersion: received.version,
      expectedGeneration: received.generation,
      now: () => "2026-09-02T06:00:01.000Z",
    })

    // A different generation of the same receipt is a different piece of work.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation + 1,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T06:00:02.000Z",
    })).toThrow(/CAS mismatch/u)

    // A lease minted for another generation must not disposition this one.
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner: `external-event:slugger:app-store-connect:books:generation:${claimed.generation + 7}:attempt:1`,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T06:00:03.000Z",
    })).toThrow(/claim owner mismatch/u)

    // One disposition per generation.
    commitExternalEventDisposition(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T06:00:04.000Z",
    })
    expect(() => commitExternalEventDisposition(claimed.recordPath, {
      owner,
      expectedGeneration: claimed.generation,
      disposition: disposition("revision-1"),
      now: () => "2026-09-02T06:00:05.000Z",
    })).toThrow(/already dispositioned/u)
  })
})
