import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it } from "vitest"

import type { HabitExecutionEnvelopeV1, HabitEvidenceV1 } from "../../../heart/habits/habit-execution"
import { occurrenceIdentityForScheduledSlot } from "../../../heart/habits/habit-cadence-v1"
import { HabitOccurrenceStore, type HabitOccurrenceClaimInput } from "../../../heart/habits/habit-occurrence-store"
import { HabitProjectionStore } from "../../../heart/habits/habit-projection-store"
import { canonicalizeJson, sha256CanonicalJson } from "../../../heart/runtime/canonical-json"
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
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "habit-projection-"))
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

describe("habit projection receipt store", () => {
  it("binds a deterministic running receipt to the freshly read occurrence authority", () => {
    const { occurrenceStore, projectionStore } = fixture()
    const claim = occurrenceStore.claimNext(claimInput())
    if (claim.kind !== "claimed") throw new Error("expected claim")

    const first = projectionStore.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)
    const replay = projectionStore.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)

    expect(first).toEqual(replay)
    expect(first.receipt).toEqual({
      schemaVersion: 1,
      receiptId: expect.stringMatching(/^hpr_[A-Za-z0-9_-]{43}$/),
      agent: "slugger",
      habitId: "daily",
      occurrenceId: claim.occurrence.occurrenceId,
      attemptId: claim.attempt.attemptId,
      recordVersion: 1,
      state: "running",
      authorityRef: `state/habits/occurrences/${claim.occurrence.occurrenceId}.json`,
      authoritySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultRef: null,
      projectedAt: claim.occurrence.updatedAt,
    })
    expect(first.receiptSha256).toMatch(/^[0-9a-f]{64}$/)
    const authoritySha256 = sha256CanonicalJson(claim.occurrence)
    expect(first.receipt.authoritySha256).toBe(authoritySha256)
    expect(first.receipt.receiptId).toBe(`hpr_${createHash("sha256").update(Buffer.from(canonicalizeJson({
      agent: "slugger",
      habitId: "daily",
      occurrenceId: claim.occurrence.occurrenceId,
      attemptId: claim.attempt.attemptId,
      recordVersion: claim.occurrence.recordVersion,
      state: claim.occurrence.state,
      authoritySha256,
    }), "utf8")).digest("base64url")}`)
  })

  it("reconstructs exact completed, retryable, terminal, and unknown projections", () => {
    const cases = [
      {
        expected: { state: "completed", resultRef: "result:completed" },
        mutate(store: HabitOccurrenceStore, occurrenceId: string, attemptId: string) {
          store.settle(occurrenceId, attemptId, { version: 1, status: "completed", resultRef: "result:completed" })
        },
      },
      {
        expected: { state: "failed_retryable", resultRef: null },
        mutate(store: HabitOccurrenceStore, occurrenceId: string, attemptId: string) {
          store.settle(occurrenceId, attemptId, {
            version: 1,
            status: "failed_retryable",
            error: { code: "later", message: "later", retryable: true },
            safeRetryEvidence: retryEvidence,
            notBefore: "2026-07-24T11:00:00.000Z",
          })
        },
      },
      {
        expected: { state: "failed_terminal", resultRef: null },
        mutate(store: HabitOccurrenceStore, occurrenceId: string, attemptId: string) {
          store.settle(occurrenceId, attemptId, {
            version: 1,
            status: "failed_terminal",
            error: { code: "terminal", message: "terminal", retryable: false },
          })
        },
      },
      {
        expected: { state: "outcome_unknown", resultRef: null },
        mutate(store: HabitOccurrenceStore, occurrenceId: string, attemptId: string) {
          store.markUnknown(occurrenceId, attemptId, "adapter_reported_unknown", [{
            ...retryEvidence,
            ref: "evidence:unknown",
          }])
        },
      },
    ]

    for (const scenario of cases) {
      const { bundleRoot, occurrenceStore, projectionStore } = fixture()
      const claim = occurrenceStore.claimNext(claimInput())
      if (claim.kind !== "claimed") throw new Error("expected claim")
      scenario.mutate(occurrenceStore, claim.occurrence.occurrenceId, claim.attempt.attemptId)
      const projected = projectionStore.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)
      expect(projected.receipt).toMatchObject(scenario.expected)
      fs.rmSync(projected.receiptPath)

      const restarted = new HabitProjectionStore({
        ...projectionStore.options,
        occurrenceStore: new HabitOccurrenceStore(occurrenceStore.options),
      })
      expect(restarted.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)).toEqual(projected)
      expect(fs.existsSync(path.join(bundleRoot, projected.receiptRef))).toBe(true)
    }
  })

  it("rejects stale attempts, corrupt receipts, conflicting receipts, and foreign occurrence authority", () => {
    const { occurrenceStore, projectionStore } = fixture()
    const claim = occurrenceStore.claimNext(claimInput())
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => projectionStore.project(claim.occurrence.occurrenceId, "hat_stale")).toThrow(/latest attempt/i)

    const projected = projectionStore.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)
    fs.writeFileSync(projected.receiptPath, "{not-json", { mode: 0o600 })
    expect(() => projectionStore.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)).toThrow(/corrupt/i)

    fs.rmSync(projected.receiptPath)
    const conflicting = { ...projected.receipt, projectedAt: "2026-07-24T10:00:01.000Z" }
    fs.writeFileSync(projected.receiptPath, canonicalizeJson(conflicting), { mode: 0o600 })
    expect(() => projectionStore.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)).toThrow(/conflict/i)

    const foreign = new HabitProjectionStore({ ...projectionStore.options, agent: "other-agent" })
    expect(() => foreign.project(claim.occurrence.occurrenceId, claim.attempt.attemptId)).toThrow(/agent/i)
  })

  it("fails closed for every malformed projection receipt field", () => {
    const mutations: Array<(receipt: Record<string, unknown>) => unknown> = [
      () => null,
      (receipt) => ({ ...receipt, extra: true }),
      (receipt) => ({ ...receipt, schemaVersion: 2 }),
      (receipt) => ({ ...receipt, recordVersion: 0 }),
      (receipt) => ({ ...receipt, state: "not-a-state" }),
      (receipt) => ({ ...receipt, authoritySha256: "bad" }),
      (receipt) => ({ ...receipt, resultRef: "" }),
      (receipt) => ({ ...receipt, receiptId: "" }),
      (receipt) => ({ ...receipt, projectedAt: "not-a-time" }),
      (receipt) => ({ ...receipt, receiptId: `hpr_${"a".repeat(43)}` }),
    ]

    for (const mutate of mutations) {
      const { occurrenceStore, projectionStore } = fixture()
      const claimed = occurrenceStore.claimNext(claimInput())
      if (claimed.kind !== "claimed") throw new Error("expected claim")
      const projection = projectionStore.project(claimed.occurrence.occurrenceId, claimed.attempt.attemptId)
      fs.writeFileSync(
        projection.receiptPath,
        canonicalizeJson(mutate(projection.receipt as unknown as Record<string, unknown>)),
        { mode: 0o600 },
      )
      expect(() => projectionStore.project(claimed.occurrence.occurrenceId, claimed.attempt.attemptId)).toThrow()
    }
  })

  it("rejects a schema-valid receipt whose deterministic identity does not match authority", () => {
    const { occurrenceStore, projectionStore } = fixture()
    const claimed = occurrenceStore.claimNext(claimInput())
    if (claimed.kind !== "claimed") throw new Error("expected claim")
    const projection = projectionStore.project(claimed.occurrence.occurrenceId, claimed.attempt.attemptId)
    fs.writeFileSync(projection.receiptPath, canonicalizeJson({
      ...projection.receipt,
      receiptId: `hpr_${"a".repeat(43)}`,
    }), { mode: 0o600 })

    expect(() => projectionStore.project(claimed.occurrence.occurrenceId, claimed.attempt.attemptId))
      .toThrow(/protected JSON record is corrupt/)
  })
})
