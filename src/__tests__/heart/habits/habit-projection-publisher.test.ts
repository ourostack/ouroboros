import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { listHabitRunReceipts, type HabitRunReceipt } from "../../../arc/flight-recorder"
import { occurrenceIdentityForScheduledSlot } from "../../../heart/habits/habit-cadence-v1"
import type { HabitEvidenceV1, HabitExecutionEnvelopeV1 } from "../../../heart/habits/habit-execution"
import { HabitOccurrenceStore, type HabitOccurrenceClaimInput } from "../../../heart/habits/habit-occurrence-store"
import {
  readHabitProjectionCandidate,
  writeHabitProjectionCandidate,
} from "../../../heart/habits/habit-projection-candidate"
import { publishHabitProjection } from "../../../heart/habits/habit-projection-publisher"
import { HabitProjectionStore } from "../../../heart/habits/habit-projection-store"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"

const roots: string[] = []
const owner: ProcessIdentity & { daemonInstanceId: string } = {
  uid: 501,
  pid: 4242,
  startIdentity: "darwin-proc:1770000000:000123",
  bootId: "boot-a",
  daemonInstanceId: "daemon-a",
}
const execution: HabitExecutionEnvelopeV1 = {
  version: 1,
  adapter: "fake",
  config: {},
  policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
}
const retryEvidence: HabitEvidenceV1 = {
  kind: "adapter-owned",
  ref: "evidence:retry",
  sha256: "a".repeat(64),
  observedAt: "2026-07-24T10:00:01.000Z",
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(now = "2026-07-24T10:00:00.000Z") {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "habit-projection-publisher-"))
  roots.push(bundleRoot)
  const proveOwnerState = (candidate: ProcessIdentity): ExactProcessState => ({ state: "alive", observed: candidate })
  const occurrenceStore = new HabitOccurrenceStore({
    bundleRoot,
    agent: "slugger",
    owner,
    now: () => now,
    proveOwnerState,
  })
  const projectionStore = new HabitProjectionStore({
    bundleRoot,
    agent: "slugger",
    owner,
    proveOwnerState,
    occurrenceStore,
  })
  return { bundleRoot, occurrenceStore, projectionStore }
}

function claimInput(): HabitOccurrenceClaimInput {
  const scheduledAtUtc = "2026-07-24T10:00:00.000Z"
  const identity = occurrenceIdentityForScheduledSlot("slugger", "daily", {
    scheduleRevision: "a".repeat(43),
    scheduledAtUtc,
  })
  return {
    habitId: "daily",
    slot: {
      kind: "scheduled",
      slotKey: identity.slotKey,
      scheduleRevision: "a".repeat(43),
      scheduledAtUtc,
    },
    execution,
    trigger: { kind: "launchd", observedAt: scheduledAtUtc, scheduleProofRef: "schedule:proof" },
    deadlineAt: "2026-07-24T10:05:00.000Z",
  }
}

function runReceipt(runId = "run-daily"): HabitRunReceipt {
  return {
    schemaVersion: 2,
    runId,
    sessionId: runId,
    habitName: "daily",
    trigger: "launchd",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:00:01.000Z",
    outcome: "no_change",
    definitionLocator: "habits/daily.md",
    sessionLocator: `state/habit-sessions/${runId}/session.json`,
    pendingLocator: `state/habit-sessions/${runId}/pending`,
    runtimeStateLocator: "state/habits/daily.json",
    receiptLocator: `arc/flight-recorder/habit-receipts/${runId}.json`,
    operationId: "operation-daily",
    nextRunAt: null,
    permissionEnvelope: {
      schemaVersion: 1,
      canMessageOutward: false,
      returnRoutes: [],
      deniedTools: [],
      warnings: [],
    },
    toolPolicy: {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: false,
    },
    summarySnapshot: { summary: "No changes.", decisions: [], nextLikelyStep: null },
    producedRefs: [],
    surfaceAttempts: [],
    traceSteps: [],
    errors: [],
  }
}

function claim(fixtureValue: ReturnType<typeof fixture>) {
  const claimed = fixtureValue.occurrenceStore.claimNext(claimInput())
  if (claimed.kind !== "claimed") throw new Error("expected claim")
  return claimed
}

describe("habit projection candidate and publisher", () => {
  it("writes immutable correlated session evidence and rejects corruption or conflict", () => {
    const { bundleRoot } = fixture()
    const first = writeHabitProjectionCandidate(bundleRoot, "occurrence-a", "attempt-a", runReceipt())
    const replay = writeHabitProjectionCandidate(bundleRoot, "occurrence-a", "attempt-a", runReceipt())

    expect(replay).toEqual(first)
    expect(readHabitProjectionCandidate(bundleRoot, "occurrence-a", "attempt-a")).toEqual(first.candidate)
    expect(first.candidateRef).toBe("state/habits/projection-candidates/occurrence-a/attempt-a.json")
    expect(first.candidateSha256).toMatch(/^[0-9a-f]{64}$/)

    expect(() => writeHabitProjectionCandidate(
      bundleRoot,
      "occurrence-a",
      "attempt-a",
      runReceipt("run-conflicting"),
    )).toThrow(/conflict/i)
    fs.writeFileSync(first.candidatePath, "{", { mode: 0o600 })
    expect(() => readHabitProjectionCandidate(bundleRoot, "occurrence-a", "attempt-a")).toThrow(/corrupt/i)
    expect(() => writeHabitProjectionCandidate(bundleRoot, "../escape", "attempt-a", runReceipt())).toThrow(/path-safe/i)
    expect(() => writeHabitProjectionCandidate(bundleRoot, "occ..escape", "attempt-a", runReceipt())).toThrow(/path-safe/i)
  })

  it("fails closed for malformed, mismatched, and non-Error candidate reads", () => {
    const malformed: unknown[] = [
      null,
      { schemaVersion: 1, occurrenceId: "occurrence-a", attemptId: "attempt-a", receipt: runReceipt(), extra: true },
      { schemaVersion: 2, occurrenceId: "occurrence-a", attemptId: "attempt-a", receipt: runReceipt() },
      { schemaVersion: 1, occurrenceId: 1, attemptId: "attempt-a", receipt: runReceipt() },
      { schemaVersion: 1, occurrenceId: "occurrence-a", attemptId: "attempt-a", receipt: null },
      { schemaVersion: 1, occurrenceId: "occurrence-a", attemptId: "attempt-a", receipt: { schemaVersion: 1 } },
    ]
    for (const value of malformed) {
      const { bundleRoot } = fixture()
      const written = writeHabitProjectionCandidate(bundleRoot, "occurrence-a", "attempt-a", runReceipt())
      fs.writeFileSync(written.candidatePath, JSON.stringify(value), { mode: 0o600 })
      expect(() => readHabitProjectionCandidate(bundleRoot, "occurrence-a", "attempt-a")).toThrow(/corrupt/i)
    }

    const mismatched = fixture()
    const written = writeHabitProjectionCandidate(mismatched.bundleRoot, "occurrence-a", "attempt-a", runReceipt())
    fs.writeFileSync(written.candidatePath, JSON.stringify({
      ...written.candidate,
      occurrenceId: "occurrence-other",
    }), { mode: 0o600 })
    expect(() => readHabitProjectionCandidate(mismatched.bundleRoot, "occurrence-a", "attempt-a")).toThrow(/correlation/i)

    const nonError = fixture()
    writeHabitProjectionCandidate(nonError.bundleRoot, "occurrence-a", "attempt-a", runReceipt())
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => { throw "parse failed" })
    expect(() => readHabitProjectionCandidate(nonError.bundleRoot, "occurrence-a", "attempt-a")).toThrow(/parse failed/i)
    parse.mockRestore()
  })

  it("closes and removes a partial candidate when its durable write fails", () => {
    const { bundleRoot } = fixture()
    expect(() => writeHabitProjectionCandidate(
      bundleRoot,
      "occurrence-fsync",
      "attempt-fsync",
      runReceipt(),
      {
        mkdirSync: fs.mkdirSync,
        openSync: fs.openSync,
        writeFileSync: fs.writeFileSync,
        fsyncSync: () => { throw new Error("fsync failed") },
        closeSync: fs.closeSync,
        renameSync: fs.renameSync,
        rmSync: fs.rmSync,
      },
    )).toThrow(/fsync failed/i)
    const directory = path.join(bundleRoot, "state", "habits", "projection-candidates", "occurrence-fsync")
    expect(fs.existsSync(directory) ? fs.readdirSync(directory) : []).toEqual([])
  })

  it("publishes completed session, flight, and lastRun projections idempotently after authority", () => {
    const state = fixture("2026-07-24T10:00:01.000Z")
    const claimed = claim(state)
    const candidate = writeHabitProjectionCandidate(
      state.bundleRoot,
      claimed.occurrence.occurrenceId,
      claimed.attempt.attemptId,
      runReceipt(),
    )
    state.occurrenceStore.settle(claimed.occurrence.occurrenceId, claimed.attempt.attemptId, {
      version: 1,
      status: "completed",
      resultRef: candidate.candidateRef,
    })
    const projection = state.projectionStore.project(claimed.occurrence.occurrenceId, claimed.attempt.attemptId)

    expect(listHabitRunReceipts(state.bundleRoot)).toEqual([])
    expect(fs.existsSync(path.join(state.bundleRoot, "state", "habits", "daily.json"))).toBe(false)
    const first = publishHabitProjection(state.bundleRoot, projection)
    const eventPath = path.join(state.bundleRoot, "arc", "flight-recorder", "events", "2026-07-24.jsonl")
    const events = fs.readFileSync(eventPath, "utf-8")
    const replay = publishHabitProjection(state.bundleRoot, projection)

    expect(first).toEqual({ sessionProjected: true, runtimeStateRecorded: true })
    expect(replay).toEqual(first)
    expect(listHabitRunReceipts(state.bundleRoot)).toEqual([expect.objectContaining({ runId: "run-daily" })])
    expect(fs.readFileSync(eventPath, "utf-8")).toBe(events)
    expect(JSON.parse(fs.readFileSync(path.join(state.bundleRoot, "state", "habits", "daily.json"), "utf-8"))).toEqual({
      schemaVersion: 1,
      name: "daily",
      lastRun: "2026-07-24T10:00:01.000Z",
      updatedAt: "2026-07-24T10:00:01.000Z",
      activeOperationId: "operation-daily",
      latestRunId: "run-daily",
      latestReceiptLocator: projection.receiptRef,
    })
  })

  it("keeps failed and unknown projections diagnostic without advancing lastRun", () => {
    const failed = fixture("2026-07-24T10:00:01.000Z")
    const failedClaim = claim(failed)
    writeHabitProjectionCandidate(
      failed.bundleRoot,
      failedClaim.occurrence.occurrenceId,
      failedClaim.attempt.attemptId,
      { ...runReceipt("run-failed"), outcome: "error", errors: ["failed"] },
    )
    failed.occurrenceStore.settle(failedClaim.occurrence.occurrenceId, failedClaim.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "later", message: "later", retryable: true },
      safeRetryEvidence: retryEvidence,
      notBefore: "2026-07-24T11:00:00.000Z",
    })
    const failedProjection = failed.projectionStore.project(
      failedClaim.occurrence.occurrenceId,
      failedClaim.attempt.attemptId,
    )

    expect(publishHabitProjection(failed.bundleRoot, failedProjection)).toEqual({
      sessionProjected: true,
      runtimeStateRecorded: false,
    })
    expect(listHabitRunReceipts(failed.bundleRoot)).toEqual([expect.objectContaining({ runId: "run-failed" })])
    expect(fs.existsSync(path.join(failed.bundleRoot, "state", "habits", "daily.json"))).toBe(false)

    const unknown = fixture("2026-07-24T10:00:01.000Z")
    const unknownClaim = claim(unknown)
    unknown.occurrenceStore.markUnknown(
      unknownClaim.occurrence.occurrenceId,
      unknownClaim.attempt.attemptId,
      "adapter_reported_unknown",
      [{ ...retryEvidence, ref: "evidence:unknown" }],
    )
    const unknownProjection = unknown.projectionStore.project(
      unknownClaim.occurrence.occurrenceId,
      unknownClaim.attempt.attemptId,
    )

    expect(publishHabitProjection(unknown.bundleRoot, unknownProjection)).toEqual({
      sessionProjected: false,
      runtimeStateRecorded: false,
    })
    expect(fs.existsSync(path.join(unknown.bundleRoot, "state", "habits", "daily.json"))).toBe(false)
  })

  it("publishes a completed generic adapter result without a session candidate", () => {
    const state = fixture("2026-07-24T10:00:01.000Z")
    const claimed = claim(state)
    state.occurrenceStore.settle(claimed.occurrence.occurrenceId, claimed.attempt.attemptId, {
      version: 1,
      status: "completed",
      resultRef: "adapter:result",
    })
    const projection = state.projectionStore.project(claimed.occurrence.occurrenceId, claimed.attempt.attemptId)

    expect(publishHabitProjection(state.bundleRoot, projection)).toEqual({
      sessionProjected: false,
      runtimeStateRecorded: true,
    })
    expect(JSON.parse(fs.readFileSync(path.join(state.bundleRoot, "state", "habits", "daily.json"), "utf-8"))).toMatchObject({
      activeOperationId: null,
      latestRunId: claimed.occurrence.occurrenceId,
    })
  })

  it("rejects mismatched session evidence and malformed completed projection input", () => {
    const mismatch = fixture("2026-07-24T10:00:01.000Z")
    const mismatchClaim = claim(mismatch)
    const candidate = writeHabitProjectionCandidate(
      mismatch.bundleRoot,
      mismatchClaim.occurrence.occurrenceId,
      mismatchClaim.attempt.attemptId,
      { ...runReceipt(), habitName: "other-habit" },
    )
    mismatch.occurrenceStore.settle(mismatchClaim.occurrence.occurrenceId, mismatchClaim.attempt.attemptId, {
      version: 1,
      status: "completed",
      resultRef: candidate.candidateRef,
    })
    const mismatchProjection = mismatch.projectionStore.project(
      mismatchClaim.occurrence.occurrenceId,
      mismatchClaim.attempt.attemptId,
    )
    expect(() => publishHabitProjection(mismatch.bundleRoot, mismatchProjection)).toThrow(/habit.*match/i)

    const malformed = fixture("2026-07-24T10:00:01.000Z")
    const malformedClaim = claim(malformed)
    malformed.occurrenceStore.settle(malformedClaim.occurrence.occurrenceId, malformedClaim.attempt.attemptId, {
      version: 1,
      status: "completed",
      resultRef: "adapter:result",
    })
    const projection = malformed.projectionStore.project(
      malformedClaim.occurrence.occurrenceId,
      malformedClaim.attempt.attemptId,
    )
    expect(() => publishHabitProjection(malformed.bundleRoot, {
      ...projection,
      occurrence: { ...projection.occurrence, attempts: [] },
    })).toThrow(/settled latest attempt/i)
  })
})
