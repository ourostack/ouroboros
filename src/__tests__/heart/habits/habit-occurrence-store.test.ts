import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import type { HabitExecutionEnvelopeV1, HabitEvidenceV1 } from "../../../heart/habits/habit-execution"
import { occurrenceIdentityForScheduledSlot } from "../../../heart/habits/habit-cadence-v1"
import {
  HabitOccurrenceCorruptError,
  HabitOccurrenceStore,
  type HabitOccurrenceClaimInput,
} from "../../../heart/habits/habit-occurrence-store"
import type { ExactProcessState, ProcessIdentity } from "../../../heart/runtime/process-identity"
import { acquireProtectedLock, ProtectedStoreLockedError } from "../../../heart/runtime/protected-json-store"
import { canonicalizeJson } from "../../../heart/runtime/canonical-json"

const roots: string[] = []
const owner: ProcessIdentity & { daemonInstanceId: string } = {
  uid: 501,
  pid: 1234,
  startIdentity: "start-1",
  bootId: "boot-1",
  daemonInstanceId: "daemon-1",
}
const execution = (unknownSlotFence: "none" | "habit" = "none", maxOccurrenceAttempts = 3): HabitExecutionEnvelopeV1 => ({
  version: 1,
  adapter: "fake",
  config: {},
  policy: { maxOccurrenceAttempts, unknownSlotFence },
})
const evidence = (ref = "evidence/one.json"): HabitEvidenceV1 => ({
  kind: "adapter-owned",
  ref,
  sha256: "a".repeat(64),
  observedAt: "2026-07-24T10:00:01.000Z",
})
const revisionOne = "a".repeat(43)
const revisionTwo = "b".repeat(43)

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function store(fault?: string): HabitOccurrenceStore {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "habit-occurrence-"))
  roots.push(bundleRoot)
  return new HabitOccurrenceStore({
    bundleRoot,
    agent: "slugger",
    owner,
    now: () => "2026-07-24T10:00:00.000Z",
    proveOwnerState: (candidate): ExactProcessState => candidate.pid === owner.pid
      ? { state: "alive", observed: candidate }
      : { state: "dead", reason: "process-absent" },
    fault: fault ? (point) => { if (point === fault) throw new Error(`fault:${point}`) } : undefined,
  })
}

function scheduledInput(overrides: Partial<HabitOccurrenceClaimInput> = {}): HabitOccurrenceClaimInput {
  const scheduledAtUtc = "2026-07-24T10:00:00.000Z"
  const identity = occurrenceIdentityForScheduledSlot("slugger", "daily", {
    scheduleRevision: revisionOne,
    scheduledAtUtc,
  })
  return {
    habitId: "daily",
    slot: {
      kind: "scheduled",
      slotKey: identity.slotKey,
      scheduleRevision: revisionOne,
      scheduledAtUtc,
    },
    execution: execution(),
    trigger: { kind: "cron", observedAt: "2026-07-24T10:00:00.000Z", scheduleProofRef: "proof/one.json" },
    deadlineAt: "2026-07-24T10:05:00.000Z",
    ...overrides,
  }
}

function scheduledSlot(scheduledAtUtc: string, scheduleRevision = revisionOne): HabitOccurrenceClaimInput["slot"] {
  const { slotKey } = occurrenceIdentityForScheduledSlot("slugger", "daily", { scheduleRevision, scheduledAtUtc })
  return {
    kind: "scheduled",
    slotKey,
    scheduleRevision,
    scheduledAtUtc,
  }
}

function mutateProtectedRecord(
  filePath: string,
  mutate: (value: Record<string, any>) => unknown,
  read: () => unknown,
): void {
  const original = fs.readFileSync(filePath)
  const parsed = JSON.parse(original.toString("utf8")) as Record<string, any>
  const mutated = mutate(parsed)
  fs.writeFileSync(filePath, canonicalizeJson(mutated), { mode: 0o600 })
  try {
    expect(read).toThrow()
  } finally {
    fs.writeFileSync(filePath, original, { mode: 0o600 })
  }
}

function occurrenceFile(authority: HabitOccurrenceStore, occurrenceId: string): string {
  return path.join(authority.options.bundleRoot, "state", "habits", "occurrences", `${occurrenceId}.json`)
}

describe("habit occurrence store", () => {
  it("preflights an open fence and preserves an existing blocked fence across policy downgrade", () => {
    const authority = store()
    expect(authority.checkFenceAdmission("daily", execution("habit"))).toEqual({ kind: "admitted" })
    const claim = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    expect(claim.kind).toBe("claimed")
    if (claim.kind !== "claimed") throw new Error("expected claim")
    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])
    expect(authority.checkFenceAdmission("daily", execution("none"))).toEqual({
      kind: "blocked",
      reason: "unknown_slot_fence",
      occurrenceId: claim.occurrence.occurrenceId,
    })
  })

  it("claims one deterministic attempt and suppresses duplicate triggers", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput())
    expect(first.kind).toBe("claimed")
    if (first.kind !== "claimed") throw new Error("expected claim")
    expect(first.occurrence.occurrenceId).toMatch(/^occ_[A-Za-z0-9_-]{43}$/)
    expect(first.attempt.attemptId).toMatch(/^hat_[A-Za-z0-9_-]{43}$/)
    expect(first.attempt.ordinal).toBe(1)
    expect(first.occurrence.maxAttempts).toBe(3)
    expect(authority.claimNext(scheduledInput({ trigger: { kind: "overdue", observedAt: "2026-07-24T10:00:01.000Z", scheduleProofRef: null } }))).toEqual({
      kind: "blocked",
      reason: "active_attempt",
      occurrenceId: first.occurrence.occurrenceId,
    })
  })

  it("prioritizes due retry while allowing a newer slot ahead of a future retry when unfenced", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput())
    if (first.kind !== "claimed") throw new Error("expected claim")
    authority.settle(first.occurrence.occurrenceId, first.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "later", message: "later", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T11:00:00.000Z",
    })
    const newer = authority.claimNext(scheduledInput({
      slot: scheduledSlot("2026-07-24T10:30:00.000Z"),
    }))
    expect(newer.kind).toBe("claimed")
    if (newer.kind !== "claimed") throw new Error("expected claim")
    authority.settle(newer.occurrence.occurrenceId, newer.attempt.attemptId, { version: 1, status: "completed", resultRef: "result/two.json" })

    const dueStore = new HabitOccurrenceStore({ ...authority.options, now: () => "2026-07-24T11:00:00.000Z" })
    const retry = dueStore.claimNext(scheduledInput({
      slot: scheduledSlot("2026-07-24T11:00:00.000Z"),
    }))
    expect(retry.kind).toBe("claimed")
    if (retry.kind !== "claimed") throw new Error("expected claim")
    expect(retry.occurrence.occurrenceId).toBe(first.occurrence.occurrenceId)
    expect(retry.attempt.ordinal).toBe(2)
  })

  it("blocks later scheduled and manual work behind an unknown habit fence", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    authority.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_reported_unknown", [evidence()])
    expect(authority.claimNext(scheduledInput({
      execution: execution("habit"),
      slot: scheduledSlot("2026-07-24T10:30:00.000Z"),
    }))).toMatchObject({ kind: "blocked", reason: "unknown_slot_fence", occurrenceId: first.occurrence.occurrenceId })
    expect(authority.claimManual({
      habitId: "daily",
      requestId: "manual-one",
      execution: execution("habit"),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:01:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:06:00.000Z",
    })).toMatchObject({ kind: "blocked", reason: "unknown_slot_fence" })
  })

  it("allows a later slot after an unfenced unknown without replaying the unknown slot", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput())
    if (first.kind !== "claimed") throw new Error("expected claim")
    authority.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_exception", [])

    const later = authority.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    expect(later.kind).toBe("claimed")
    if (later.kind !== "claimed") throw new Error("expected later claim")
    expect(later.occurrence.occurrenceId).not.toBe(first.occurrence.occurrenceId)
    expect(authority.claimNext(scheduledInput())).toMatchObject({
      kind: "blocked",
      occurrenceId: later.occurrence.occurrenceId,
    })
  })

  it("keeps a safe reconciliation retry on the same occurrence before opening the fence", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    const priorEvidence = [evidence()]
    authority.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_reported_unknown", priorEvidence)
    const reconciled = authority.reconcile(first.occurrence.occurrenceId, first.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "safe_retry",
      error: { code: "retry", message: "retry", retryable: true },
      notBefore: "2026-07-24T10:00:00.000Z",
      evidence: evidence("evidence/reconcile.json"),
    })
    expect(reconciled.kind).toBe("claimed")
    if (reconciled.kind !== "claimed") throw new Error("expected retry claim")
    expect(reconciled.occurrence.occurrenceId).toBe(first.occurrence.occurrenceId)
    expect(reconciled.attempt.ordinal).toBe(2)
    expect(authority.readFence("daily")).toMatchObject({ state: "blocked", blockingAttemptId: reconciled.attempt.attemptId })
    authority.settle(reconciled.occurrence.occurrenceId, reconciled.attempt.attemptId, { version: 1, status: "completed", resultRef: "result/one.json" })
    expect(authority.readFence("daily")).toMatchObject({ state: "open", blockingOccurrenceId: null })
  })

  it("terminalizes an unfenced retry when its schedule revision is superseded", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput())
    if (first.kind !== "claimed") throw new Error("expected claim")
    authority.settle(first.occurrence.occurrenceId, first.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    const second = authority.claimNext(scheduledInput({
      slot: scheduledSlot("2026-07-24T10:30:00.000Z", revisionTwo),
      scheduleProvenanceSha256: "b".repeat(64),
    }))
    expect(second.kind).toBe("claimed")
    const superseded = authority.readOccurrence(first.occurrence.occurrenceId)
    expect(superseded).toMatchObject({
      state: "failed_terminal",
      terminalDisposition: { kind: "schedule_superseded", priorScheduleRevision: revisionOne, activeScheduleRevision: revisionTwo },
    })
  })

  it("settles completed and terminal outcomes idempotently while rejecting a conflicting replay", () => {
    const authority = store()
    const completed = authority.claimNext(scheduledInput())
    if (completed.kind !== "claimed") throw new Error("expected claim")
    const completedResult = { version: 1 as const, status: "completed" as const, resultRef: "result/completed.json" }
    const settled = authority.settle(completed.occurrence.occurrenceId, completed.attempt.attemptId, completedResult)
    expect(settled).toMatchObject({ state: "completed", activeAttemptId: null, terminalDisposition: null })
    expect(authority.claimNext(scheduledInput())).toEqual({
      kind: "blocked",
      reason: "occurrence_settled",
      occurrenceId: completed.occurrence.occurrenceId,
    })
    expect(authority.settle(completed.occurrence.occurrenceId, completed.attempt.attemptId, completedResult)).toEqual(settled)
    expect(() => authority.settle(completed.occurrence.occurrenceId, completed.attempt.attemptId, {
      ...completedResult,
      resultRef: "result/conflict.json",
    })).toThrow(/active attempt/)

    const terminal = authority.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    if (terminal.kind !== "claimed") throw new Error("expected claim")
    const terminalResult = {
      version: 1 as const,
      status: "failed_terminal" as const,
      error: { code: "terminal", message: "terminal", retryable: false },
    }
    expect(authority.settle(terminal.occurrence.occurrenceId, terminal.attempt.attemptId, terminalResult)).toMatchObject({
      state: "failed_terminal",
      terminalDisposition: { kind: "adapter_terminal" },
    })
  })

  it("copies the first claim attempt budget immutably and terminalizes retry exhaustion", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput({ execution: execution("none", 2) }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    const retryResult = {
      version: 1 as const,
      status: "failed_retryable" as const,
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:00:00.000Z",
    }
    authority.settle(first.occurrence.occurrenceId, first.attempt.attemptId, retryResult)
    const retry = authority.claimNext(scheduledInput({
      execution: execution("none", 9),
      slot: scheduledSlot("2026-07-24T10:30:00.000Z"),
    }))
    if (retry.kind !== "claimed") throw new Error("expected retry")
    expect(retry.occurrence.maxAttempts).toBe(2)
    expect(retry.attempt.ordinal).toBe(2)
    expect(authority.settle(retry.occurrence.occurrenceId, retry.attempt.attemptId, retryResult)).toMatchObject({
      state: "failed_terminal",
      maxAttempts: 2,
      terminalDisposition: { kind: "retry_exhausted", maxAttempts: 2 },
    })
  })

  it("keeps a future reconciliation retry fenced, then retries the same occurrence when due", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    const priorEvidence = [evidence()]
    authority.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_reported_unknown", priorEvidence)
    const waiting = authority.reconcile(first.occurrence.occurrenceId, first.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "safe_retry",
      error: { code: "retry", message: "retry", retryable: true },
      notBefore: "2026-07-24T11:00:00.000Z",
      evidence: evidence("evidence/future.json"),
    })
    expect(waiting).toMatchObject({ kind: "settled", occurrence: { state: "failed_retryable" } })
    expect(authority.claimNext(scheduledInput({
      execution: execution("none"),
      slot: scheduledSlot("2026-07-24T10:30:00.000Z", revisionTwo),
    }))).toMatchObject({ kind: "blocked", reason: "retry_not_due", occurrenceId: first.occurrence.occurrenceId })

    const due = new HabitOccurrenceStore({ ...authority.options, now: () => "2026-07-24T11:00:00.000Z" })
    const retry = due.claimNext(scheduledInput({
      execution: execution("none"),
      slot: scheduledSlot("2026-07-24T11:00:00.000Z", revisionTwo),
    }))
    expect(retry.kind).toBe("claimed")
    if (retry.kind !== "claimed") throw new Error("expected claim")
    expect(retry.occurrence.occurrenceId).toBe(first.occurrence.occurrenceId)
    expect(retry.attempt.ordinal).toBe(2)
  })

  it("handles unresolved, completed, and terminal reconciliation without admitting work early", () => {
    const completedStore = store()
    const completed = completedStore.claimNext(scheduledInput({ execution: execution("habit") }))
    if (completed.kind !== "claimed") throw new Error("expected claim")
    const priorEvidence = [evidence()]
    completedStore.markUnknown(completed.occurrence.occurrenceId, completed.attempt.attemptId, "adapter_reported_unknown", priorEvidence)
    expect(completedStore.reconcile(completed.occurrence.occurrenceId, completed.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "unresolved",
    })).toEqual({ kind: "unresolved" })
    expect(completedStore.readFence("daily").state).toBe("blocked")
    expect(completedStore.reconcile(completed.occurrence.occurrenceId, completed.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "completed",
      resultRef: "result/reconciled.json",
      evidence: evidence("evidence/completed.json"),
    })).toMatchObject({ kind: "settled", occurrence: { state: "completed" } })
    expect(completedStore.readFence("daily").state).toBe("open")

    const terminalStore = store()
    const terminal = terminalStore.claimNext(scheduledInput({ execution: execution("habit") }))
    if (terminal.kind !== "claimed") throw new Error("expected claim")
    terminalStore.markUnknown(terminal.occurrence.occurrenceId, terminal.attempt.attemptId, "adapter_exception", [])
    expect(terminalStore.reconcile(terminal.occurrence.occurrenceId, terminal.attempt.attemptId, [], {
      version: 1,
      disposition: "failed_terminal",
      error: { code: "terminal", message: "terminal", retryable: false },
      evidence: evidence("evidence/terminal.json"),
    })).toMatchObject({
      kind: "settled",
      occurrence: { state: "failed_terminal", terminalDisposition: { kind: "reconciliation_terminal" } },
    })
    expect(terminalStore.readFence("daily").state).toBe("open")
  })

  it("selects due retries by not-before before considering the newest absent slot", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput())
    if (first.kind !== "claimed") throw new Error("expected claim")
    authority.settle(first.occurrence.occurrenceId, first.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "late", message: "late", retryable: true },
      safeRetryEvidence: evidence("evidence/late.json"),
      notBefore: "2026-07-24T11:00:00.000Z",
    })
    const second = authority.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    if (second.kind !== "claimed") throw new Error("expected claim")
    authority.settle(second.occurrence.occurrenceId, second.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "early", message: "early", retryable: true },
      safeRetryEvidence: evidence("evidence/early.json"),
      notBefore: "2026-07-24T10:45:00.000Z",
    })
    const due = new HabitOccurrenceStore({ ...authority.options, now: () => "2026-07-24T11:00:00.000Z" })
    const selected = due.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T11:00:00.000Z") }))
    expect(selected.kind).toBe("claimed")
    if (selected.kind !== "claimed") throw new Error("expected claim")
    expect(selected.occurrence.occurrenceId).toBe(second.occurrence.occurrenceId)
  })

  it("creates unique manual occurrence identities", () => {
    const authority = store()
    const first = authority.claimManual({
      habitId: "daily",
      requestId: "request-one",
      execution: execution(),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:00:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:05:00.000Z",
    })
    if (first.kind !== "claimed") throw new Error("expected claim")
    authority.settle(first.occurrence.occurrenceId, first.attempt.attemptId, { version: 1, status: "completed", resultRef: "result/manual.json" })
    const second = authority.claimManual({
      habitId: "daily",
      requestId: "request-two",
      execution: execution(),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:01:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:06:00.000Z",
    })
    if (second.kind !== "claimed") throw new Error("expected claim")
    expect(first.occurrence.occurrenceId).not.toBe(second.occurrence.occurrenceId)
    expect(first.occurrence.occurrenceId).toMatch(/^occ_manual_/)
  })

  it.each(["after_txn_prepared", "after_occurrence_head", "after_fence_head"])(
    "recovers a prepared fence transaction after %s",
    (fault) => {
    const crashing = store(fault)
    const first = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    expect(() => crashing.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_reported_unknown", [evidence()])).toThrow(/fault/)
    const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
    recovered.recoverPreparedTransactions()
    expect(recovered.readOccurrence(first.occurrence.occurrenceId)).toMatchObject({ state: "outcome_unknown" })
    expect(recovered.readFence("daily")).toMatchObject({ state: "blocked", blockingOccurrenceId: first.occurrence.occurrenceId })
    },
  )

  it("returns the byte-identical unknown settlement after response loss", () => {
    const crashing = store("after_fence_head")
    const first = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    const priorEvidence = [evidence()]
    expect(() => crashing.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_reported_unknown", priorEvidence)).toThrow(/fault/)
    const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
    recovered.recoverPreparedTransactions()
    const beforeReplay = recovered.readOccurrence(first.occurrence.occurrenceId)
    const replay = recovered.markUnknown(first.occurrence.occurrenceId, first.attempt.attemptId, "adapter_reported_unknown", priorEvidence)
    expect(replay).toEqual(beforeReplay)
  })

  it("recreates a missing revision-zero fence before persisting an unknown pair", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    fs.rmSync(path.join(authority.options.bundleRoot, "state", "habits", "unknown-slot-fences", "daily.json"))
    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])
    expect(authority.readFence("daily")).toMatchObject({ state: "blocked", blockingOccurrenceId: claim.occurrence.occurrenceId })
  })

  it("converts an exactly dead running owner to unknown before selecting later work", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput())
    if (first.kind !== "claimed") throw new Error("expected claim")
    const recovered = new HabitOccurrenceStore({
      ...authority.options,
      proveOwnerState: (): ExactProcessState => ({ state: "dead", reason: "process-absent" }),
    })
    const later = recovered.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    expect(later.kind).toBe("claimed")
    expect(recovered.readOccurrence(first.occurrence.occurrenceId)).toMatchObject({
      state: "outcome_unknown",
      attempts: [{ unknownReason: "owner_died", unknownEvidence: [] }],
    })
  })

  it("converts an expired running attempt to unknown even while its owner remains alive", () => {
    const authority = store()
    const first = authority.claimNext(scheduledInput({ deadlineAt: "2026-07-24T09:59:59.000Z" }))
    if (first.kind !== "claimed") throw new Error("expected claim")
    const later = authority.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    expect(later.kind).toBe("claimed")
    expect(authority.readOccurrence(first.occurrence.occurrenceId)).toMatchObject({
      state: "outcome_unknown",
      attempts: [{ unknownReason: "execution_timeout" }],
    })
  })

  it("fails without a claim while another live owner holds scheduler authority", () => {
    const authority = store()
    const lockTarget = path.join(authority.options.bundleRoot, "state", "habits", "scheduler-authority.json")
    const { uid, pid, startIdentity, bootId } = owner
    const lock = acquireProtectedLock(lockTarget, { uid, pid, startIdentity, bootId }, authority.options.proveOwnerState)
    try {
      expect(() => authority.claimNext(scheduledInput())).toThrow(ProtectedStoreLockedError)
      expect(fs.readdirSync(path.join(authority.options.bundleRoot, "state", "habits", "occurrences"))).toEqual([])
    } finally {
      lock.release()
    }
  })

  it("fails closed on corrupt occurrence bytes", () => {
    const authority = store()
    const occurrenceDir = path.join(authority.options.bundleRoot, "state", "habits", "occurrences")
    fs.mkdirSync(occurrenceDir, { recursive: true })
    fs.writeFileSync(path.join(occurrenceDir, "occ_bad.json"), "{}", { mode: 0o600 })
    expect(() => authority.readOccurrence("occ_bad")).toThrow(HabitOccurrenceCorruptError)
  })

  it("fails closed across malformed aggregate, slot, attempt, owner, result, and timing fields", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput())
    if (claim.kind !== "claimed") throw new Error("expected claim")
    const occurrencePath = path.join(
      authority.options.bundleRoot,
      "state",
      "habits",
      "occurrences",
      `${claim.occurrence.occurrenceId}.json`,
    )
    const mutations: Array<(value: Record<string, any>) => unknown> = [
      () => null,
      (value) => ({ ...value, unexpected: true }),
      (value) => ({ ...value, schemaVersion: 2 }),
      (value) => ({ ...value, recordVersion: 0 }),
      (value) => ({ ...value, occurrenceId: "" }),
      (value) => ({ ...value, agent: "" }),
      (value) => ({ ...value, habitId: "" }),
      (value) => ({ ...value, slot: { ...value.slot, kind: "other" } }),
      (value) => ({ ...value, slot: { ...value.slot, unexpected: true } }),
      (value) => ({ ...value, slot: { ...value.slot, slotKey: "bad" } }),
      (value) => ({ ...value, slot: { ...value.slot, scheduleRevision: "bad" } }),
      (value) => ({ ...value, slot: { ...value.slot, scheduledAtUtc: "not-a-time" } }),
      (value) => ({ ...value, attempts: {} }),
      (value) => ({ ...value, attempts: [] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], unexpected: true }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], ordinal: 2 }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], attemptId: "bad" }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], state: "bad" }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], trigger: { ...value.attempts[0].trigger, unexpected: true } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], trigger: { ...value.attempts[0].trigger, kind: "" } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], trigger: { ...value.attempts[0].trigger, observedAt: "bad" } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], trigger: { ...value.attempts[0].trigger, scheduleProofRef: "" } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], owner: { ...value.attempts[0].owner, unexpected: true } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], owner: { ...value.attempts[0].owner, uid: -1 } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], owner: { ...value.attempts[0].owner, daemonInstanceId: "" } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], claimedAt: "bad" }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], deadlineAt: "bad" }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], unknownReason: "bad" }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], unknownEvidence: {} }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], settledAt: value.updatedAt }] }),
      (value) => ({ ...value, latestAttemptId: "bad" }),
      (value) => ({ ...value, activeAttemptId: null }),
      (value) => ({ ...value, maxAttempts: 0 }),
      (value) => ({ ...value, maxAttempts: 2 }),
      (value) => ({ ...value, updatedAt: "2026-07-24T09:59:59.000Z" }),
    ]
    for (const mutation of mutations) {
      mutateProtectedRecord(occurrencePath, mutation, () => authority.readOccurrence(claim.occurrence.occurrenceId))
    }
  })

  it("fails closed across malformed fence records and mismatched blocked authority", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    const fencePath = path.join(authority.options.bundleRoot, "state", "habits", "unknown-slot-fences", "daily.json")
    const openMutations: Array<(value: Record<string, any>) => unknown> = [
      () => [],
      (value) => ({ ...value, unexpected: true }),
      (value) => ({ ...value, schemaVersion: 2 }),
      (value) => ({ ...value, state: "bad" }),
      (value) => ({ ...value, revision: -1 }),
      (value) => ({ ...value, priorFenceSha256: "a".repeat(64) }),
      (value) => ({ ...value, blockingOccurrenceId: "unexpected" }),
      (value) => ({ ...value, updatedAt: "bad" }),
    ]
    for (const mutation of openMutations) mutateProtectedRecord(fencePath, mutation, () => authority.readFence("daily"))

    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])
    const blockedMutations: Array<(value: Record<string, any>) => unknown> = [
      (value) => ({ ...value, priorFenceSha256: "bad" }),
      (value) => ({ ...value, blockingOccurrenceSha256: "bad" }),
      (value) => ({ ...value, blockingAttemptId: null }),
      (value) => ({ ...value, blockingOccurrenceRef: "state/habits/occurrences/wrong.json" }),
    ]
    for (const mutation of blockedMutations) {
      mutateProtectedRecord(fencePath, mutation, () => {
        authority.readFence("daily")
        authority.claimNext(scheduledInput({ execution: execution("habit"), slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
      })
    }
  })

  it("rejects a fence belonging to another agent through the admission path", () => {
    const authority = store()
    authority.claimNext(scheduledInput({ execution: execution("habit") }))
    const fencePath = path.join(authority.options.bundleRoot, "state", "habits", "unknown-slot-fences", "daily.json")
    mutateProtectedRecord(fencePath, (value) => ({ ...value, agent: "other-agent" }), () => {
      authority.claimNext(scheduledInput({ execution: execution("habit"), slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    })
    expect(() => authority.readOccurrence("../escape")).toThrow(HabitOccurrenceCorruptError)
    expect(() => authority.readFence("../escape")).toThrow(HabitOccurrenceCorruptError)
  })

  it("fails closed on a missing or escaping prepared transaction payload", () => {
    for (const mode of ["missing", "escape", "absolute"] as const) {
      const crashing = store("after_txn_prepared")
      const claim = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
      if (claim.kind !== "claimed") throw new Error("expected claim")
      expect(() => crashing.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
      const txnDir = path.join(crashing.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
      const txnName = fs.readdirSync(txnDir).find((name) => name.endsWith("txn-r0.json"))!
      const txnPath = path.join(txnDir, txnName)
      const txn = JSON.parse(fs.readFileSync(txnPath, "utf8")) as Record<string, any>
      if (mode === "missing") {
        fs.rmSync(path.join(crashing.options.bundleRoot, txn.nextOccurrenceRef))
      } else {
        txn.nextOccurrenceRef = mode === "absolute" ? "/tmp/outside.json" : "../../outside.json"
        fs.writeFileSync(txnPath, canonicalizeJson(txn), { mode: 0o600 })
      }
      const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
      expect(() => recovered.recoverPreparedTransactions()).toThrow()
    }
  })

  it("rejects invalid public transition inputs without mutating authority", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput())
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => authority.settle(claim.occurrence.occurrenceId, claim.attempt.attemptId, {
      version: 1,
      status: "failed_terminal",
      error: { code: "bad", message: "bad", retryable: true },
    })).toThrow(/cannot be retryable/)
    expect(() => authority.settle(claim.occurrence.occurrenceId, claim.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "bad", message: "bad", retryable: false },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:01:00.000Z",
    })).toThrow(/must be retryable/)
    expect(() => authority.settle(claim.occurrence.occurrenceId, claim.attempt.attemptId, {
      version: 1,
      status: "unknown",
    } as never)).toThrow(/status/)
    expect(() => authority.settle(claim.occurrence.occurrenceId, claim.attempt.attemptId, {
      version: 2,
      status: "completed",
      resultRef: "bad",
    } as never)).toThrow(/version/)
    expect(() => authority.settle(claim.occurrence.occurrenceId, claim.attempt.attemptId, {
      version: 1,
      status: "failed_terminal",
      error: { code: "bad", message: "bad", retryable: "yes" },
    } as never)).toThrow(/retryable is invalid/)
    expect(() => authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [evidence()])).toThrow(/does not match/)
    expect(() => authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_reported_unknown", [])).toThrow(/does not match/)
    expect(authority.readOccurrence(claim.occurrence.occurrenceId).state).toBe("running")

    expect(() => authority.claimNext(scheduledInput({ scheduleProvenanceSha256: "bad" }))).toThrow(/provenance/)
    expect(() => authority.claimManual({
      habitId: "../bad",
      requestId: "",
      execution: execution(),
      trigger: { kind: "", observedAt: "bad", scheduleProofRef: "" },
      deadlineAt: "bad",
    })).toThrow()
  })

  it("rejects stale reconciliation and non-byte-identical evidence", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, [], {
      version: 1,
      disposition: "unresolved",
    })).toThrow(/does not own/)
    const priorEvidence = [evidence()]
    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_reported_unknown", priorEvidence)
    expect(() => authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, [evidence("different.json")], {
      version: 1,
      disposition: "unresolved",
    })).toThrow(/differs/)
    expect(() => authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "other",
    } as never)).toThrow(/disposition/)
    expect(() => authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "safe_retry",
      error: { code: "bad", message: "bad", retryable: false },
      notBefore: "2026-07-24T10:00:00.000Z",
      evidence: evidence(),
    })).toThrow(/must be retryable/)
    expect(() => authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, priorEvidence, {
      version: 1,
      disposition: "failed_terminal",
      error: { code: "bad", message: "bad", retryable: true },
      evidence: evidence(),
    })).toThrow(/cannot be retryable/)
    expect(() => authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, priorEvidence, {
      version: 2,
      disposition: "unresolved",
    } as never)).toThrow(/version/)
  })

  it("reconciles an unfenced unknown into an immediate same-occurrence retry", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput())
    if (claim.kind !== "claimed") throw new Error("expected claim")
    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])
    const retry = authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, [], {
      version: 1,
      disposition: "safe_retry",
      error: { code: "retry", message: "retry", retryable: true },
      notBefore: "2026-07-24T10:00:00.000Z",
      evidence: evidence(),
    })
    expect(retry.kind).toBe("claimed")
    if (retry.kind !== "claimed") throw new Error("expected retry")
    expect(retry.occurrence.occurrenceId).toBe(claim.occurrence.occurrenceId)
    expect(retry.attempt.ordinal).toBe(2)
  })

  it("terminalizes safe reconciliation at the immutable attempt limit", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput({ execution: execution("habit", 1) }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])
    expect(authority.reconcile(claim.occurrence.occurrenceId, claim.attempt.attemptId, [], {
      version: 1,
      disposition: "safe_retry",
      error: { code: "retry", message: "retry", retryable: true },
      notBefore: "2026-07-24T10:00:00.000Z",
      evidence: evidence(),
    })).toMatchObject({
      kind: "settled",
      occurrence: { state: "failed_terminal", terminalDisposition: { kind: "retry_exhausted", maxAttempts: 1 } },
    })
  })

  it("blocks a manual claim behind a running attempt and permits due manual retries", () => {
    const authority = store()
    const scheduled = authority.claimNext(scheduledInput())
    if (scheduled.kind !== "claimed") throw new Error("expected claim")
    expect(authority.claimManual({
      habitId: "daily",
      requestId: "manual-blocked",
      execution: execution(),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:00:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:05:00.000Z",
    })).toMatchObject({ kind: "blocked", reason: "active_attempt" })
    authority.settle(scheduled.occurrence.occurrenceId, scheduled.attempt.attemptId, { version: 1, status: "completed", resultRef: "result/scheduled.json" })
    const manualAuthority = new HabitOccurrenceStore({ ...authority.options, now: () => "2026-07-24T10:01:00.000Z" })
    const manual = manualAuthority.claimManual({
      habitId: "daily",
      requestId: "manual-retry",
      execution: execution(),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:00:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:05:00.000Z",
    })
    if (manual.kind !== "claimed") throw new Error("expected claim")
    manualAuthority.settle(manual.occurrence.occurrenceId, manual.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    const selected = manualAuthority.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    expect(selected.kind).toBe("claimed")
    if (selected.kind !== "claimed") throw new Error("expected manual retry")
    expect(selected.occurrence.occurrenceId).toBe(manual.occurrence.occurrenceId)
  })

  it("leaves a live running claim alone when owner observation throws", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput())
    if (claim.kind !== "claimed") throw new Error("expected claim")
    const unobservable = new HabitOccurrenceStore({
      ...authority.options,
      proveOwnerState: () => { throw new Error("unobservable") },
    })
    expect(unobservable.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))).toMatchObject({
      kind: "blocked",
      reason: "active_attempt",
      occurrenceId: claim.occurrence.occurrenceId,
    })
  })

  it("fails closed on illegal settled-state and terminal-disposition cross-products", () => {
    const completedStore = store()
    const completedClaim = completedStore.claimNext(scheduledInput())
    if (completedClaim.kind !== "claimed") throw new Error("expected claim")
    completedStore.settle(completedClaim.occurrence.occurrenceId, completedClaim.attempt.attemptId, {
      version: 1,
      status: "completed",
      resultRef: "result/completed.json",
    })
    const completedPath = occurrenceFile(completedStore, completedClaim.occurrence.occurrenceId)
    const completedMutations: Array<(value: Record<string, any>) => unknown> = [
      (value) => ({ ...value, state: "bad" }),
      (value) => ({ ...value, activeAttemptId: value.latestAttemptId }),
      (value) => ({ ...value, terminalDisposition: { kind: "adapter_terminal", resultSha256: "a".repeat(64) } }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], settledAt: null }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], result: null }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], result: {
        version: 1,
        status: "failed_terminal",
        error: { code: "terminal", message: "terminal", retryable: false },
      } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], terminalDisposition: {
        kind: "adapter_terminal",
        resultSha256: "a".repeat(64),
      } }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], unknownEvidence: [evidence(), evidence("evidence/two.json")] }] }),
      (value) => ({ ...value, attempts: [{ ...value.attempts[0], unknownReason: "adapter_exception" }] }),
      (value) => ({ ...value, occurrenceId: `occ_${"z".repeat(43)}` }),
    ]
    for (const mutation of completedMutations) {
      mutateProtectedRecord(completedPath, mutation, () => completedStore.readOccurrence(completedClaim.occurrence.occurrenceId))
    }

    const retryStore = store()
    const retryClaim = retryStore.claimNext(scheduledInput())
    if (retryClaim.kind !== "claimed") throw new Error("expected claim")
    retryStore.settle(retryClaim.occurrence.occurrenceId, retryClaim.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T11:00:00.000Z",
    })
    mutateProtectedRecord(occurrenceFile(retryStore, retryClaim.occurrence.occurrenceId), (value) => ({
      ...value,
      attempts: [{ ...value.attempts[0], result: { version: 1, status: "completed", resultRef: "wrong.json" } }],
    }), () => retryStore.readOccurrence(retryClaim.occurrence.occurrenceId))
    mutateProtectedRecord(occurrenceFile(retryStore, retryClaim.occurrence.occurrenceId), (value) => ({
      ...value,
      attempts: [{ ...value.attempts[0], result: { ...value.attempts[0].result, safeRetryEvidence: { ...value.attempts[0].result.safeRetryEvidence, kind: "bad" } } }],
    }), () => retryStore.readOccurrence(retryClaim.occurrence.occurrenceId))
    mutateProtectedRecord(occurrenceFile(retryStore, retryClaim.occurrence.occurrenceId), (value) => ({
      ...value,
      maxAttempts: 1,
      execution: { ...value.execution, policy: { ...value.execution.policy, maxOccurrenceAttempts: 1 } },
    }), () => retryStore.readOccurrence(retryClaim.occurrence.occurrenceId))

    const retriedStore = store()
    const retriedFirst = retriedStore.claimNext(scheduledInput())
    if (retriedFirst.kind !== "claimed") throw new Error("expected claim")
    retriedStore.settle(retriedFirst.occurrence.occurrenceId, retriedFirst.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    const retried = retriedStore.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    if (retried.kind !== "claimed") throw new Error("expected retry")
    mutateProtectedRecord(occurrenceFile(retriedStore, retried.occurrence.occurrenceId), (value) => ({
      ...value,
      attempts: [
        {
          ...value.attempts[0],
          state: "running",
          settledAt: null,
          result: null,
          unknownReason: null,
          unknownEvidence: [],
          reconciliation: null,
          terminalDisposition: null,
        },
        value.attempts[1],
      ],
    }), () => retriedStore.readOccurrence(retried.occurrence.occurrenceId))

    const exhaustedStore = store()
    const exhaustedClaim = exhaustedStore.claimNext(scheduledInput({ execution: execution("none", 1) }))
    if (exhaustedClaim.kind !== "claimed") throw new Error("expected claim")
    exhaustedStore.settle(exhaustedClaim.occurrence.occurrenceId, exhaustedClaim.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    const exhaustedPath = occurrenceFile(exhaustedStore, exhaustedClaim.occurrence.occurrenceId)
    const exhaustedMutations: Array<(value: Record<string, any>) => unknown> = [
      (value) => ({ ...value, terminalDisposition: { ...value.terminalDisposition, maxAttempts: 0 }, attempts: [{ ...value.attempts[0], terminalDisposition: { ...value.attempts[0].terminalDisposition, maxAttempts: 0 } }] }),
      (value) => ({ ...value, terminalDisposition: { ...value.terminalDisposition, sourceResultSha256: "bad" }, attempts: [{ ...value.attempts[0], terminalDisposition: { ...value.attempts[0].terminalDisposition, sourceResultSha256: "bad" } }] }),
      (value) => ({ ...value, terminalDisposition: { ...value.terminalDisposition, sourceResultSha256: "b".repeat(64) }, attempts: [{ ...value.attempts[0], terminalDisposition: { ...value.attempts[0].terminalDisposition, sourceResultSha256: "b".repeat(64) } }] }),
      (value) => ({ ...value, maxAttempts: 2, execution: { ...value.execution, policy: { ...value.execution.policy, maxOccurrenceAttempts: 2 } } }),
      (value) => ({ ...value, terminalDisposition: { kind: "bad" }, attempts: [{ ...value.attempts[0], terminalDisposition: { kind: "bad" } }] }),
    ]
    for (const mutation of exhaustedMutations) {
      mutateProtectedRecord(exhaustedPath, mutation, () => exhaustedStore.readOccurrence(exhaustedClaim.occurrence.occurrenceId))
    }

    const terminalStore = store()
    const terminalClaim = terminalStore.claimNext(scheduledInput())
    if (terminalClaim.kind !== "claimed") throw new Error("expected claim")
    terminalStore.settle(terminalClaim.occurrence.occurrenceId, terminalClaim.attempt.attemptId, {
      version: 1,
      status: "failed_terminal",
      error: { code: "terminal", message: "terminal", retryable: false },
    })
    const terminalPath = occurrenceFile(terminalStore, terminalClaim.occurrence.occurrenceId)
    for (const hash of ["bad", "b".repeat(64)]) {
      mutateProtectedRecord(terminalPath, (value) => ({
        ...value,
        terminalDisposition: { ...value.terminalDisposition, resultSha256: hash },
        attempts: [{ ...value.attempts[0], terminalDisposition: { ...value.attempts[0].terminalDisposition, resultSha256: hash } }],
      }), () => terminalStore.readOccurrence(terminalClaim.occurrence.occurrenceId))
    }
    mutateProtectedRecord(terminalPath, (value) => ({
      ...value,
      terminalDisposition: { ...value.terminalDisposition, resultSha256: "c".repeat(64) },
    }), () => terminalStore.readOccurrence(terminalClaim.occurrence.occurrenceId))
  })

  it("rejects malformed reconciled and superseded terminal authorities", () => {
    const reconciledStore = store()
    const reconciledClaim = reconciledStore.claimNext(scheduledInput({ execution: execution("habit") }))
    if (reconciledClaim.kind !== "claimed") throw new Error("expected claim")
    reconciledStore.markUnknown(reconciledClaim.occurrence.occurrenceId, reconciledClaim.attempt.attemptId, "adapter_exception", [])
    reconciledStore.reconcile(reconciledClaim.occurrence.occurrenceId, reconciledClaim.attempt.attemptId, [], {
      version: 1,
      disposition: "failed_terminal",
      error: { code: "terminal", message: "terminal", retryable: false },
      evidence: evidence(),
    })
    const reconciledPath = occurrenceFile(reconciledStore, reconciledClaim.occurrence.occurrenceId)
    mutateProtectedRecord(reconciledPath, (value) => ({
      ...value,
      terminalDisposition: { ...value.terminalDisposition, evidenceSha256: "b".repeat(64) },
      attempts: [{ ...value.attempts[0], terminalDisposition: { ...value.attempts[0].terminalDisposition, evidenceSha256: "b".repeat(64) } }],
    }), () => reconciledStore.readOccurrence(reconciledClaim.occurrence.occurrenceId))
    mutateProtectedRecord(reconciledPath, (value) => ({
      ...value,
      attempts: [{ ...value.attempts[0], result: { version: 1, status: "completed", resultRef: "wrong.json" } }],
    }), () => reconciledStore.readOccurrence(reconciledClaim.occurrence.occurrenceId))

    const supersededStore = store()
    const old = supersededStore.claimNext(scheduledInput())
    if (old.kind !== "claimed") throw new Error("expected claim")
    supersededStore.settle(old.occurrence.occurrenceId, old.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "retry", message: "retry", retryable: true },
      safeRetryEvidence: evidence(),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    supersededStore.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z", revisionTwo) }))
    const supersededPath = occurrenceFile(supersededStore, old.occurrence.occurrenceId)
    mutateProtectedRecord(supersededPath, (value) => ({
      ...value,
      terminalDisposition: { ...value.terminalDisposition, scheduleProvenanceSha256: "bad" },
      attempts: [{ ...value.attempts[0], terminalDisposition: { ...value.attempts[0].terminalDisposition, scheduleProvenanceSha256: "bad" } }],
    }), () => supersededStore.readOccurrence(old.occurrence.occurrenceId))
    mutateProtectedRecord(supersededPath, (value) => ({
      ...value,
      attempts: [{ ...value.attempts[0], result: { version: 1, status: "completed", resultRef: "wrong.json" } }],
    }), () => supersededStore.readOccurrence(old.occurrence.occurrenceId))
  })

  it("rejects malformed unknown evidence and manual occurrence identity", () => {
    const unknownStore = store()
    const genericUnknown = unknownStore.claimNext(scheduledInput())
    if (genericUnknown.kind !== "claimed") throw new Error("expected claim")
    unknownStore.markUnknown(genericUnknown.occurrence.occurrenceId, genericUnknown.attempt.attemptId, "adapter_exception", [])
    mutateProtectedRecord(occurrenceFile(unknownStore, genericUnknown.occurrence.occurrenceId), (value) => ({
      ...value,
      attempts: [{ ...value.attempts[0], result: { version: 1, status: "completed", resultRef: "wrong.json" } }],
    }), () => unknownStore.readOccurrence(genericUnknown.occurrence.occurrenceId))

    const explicitStore = store()
    const explicitUnknown = explicitStore.claimNext(scheduledInput())
    if (explicitUnknown.kind !== "claimed") throw new Error("expected claim")
    explicitStore.markUnknown(explicitUnknown.occurrence.occurrenceId, explicitUnknown.attempt.attemptId, "adapter_reported_unknown", [evidence()])
    mutateProtectedRecord(occurrenceFile(explicitStore, explicitUnknown.occurrence.occurrenceId), (value) => ({
      ...value,
      attempts: [{ ...value.attempts[0], unknownEvidence: [] }],
    }), () => explicitStore.readOccurrence(explicitUnknown.occurrence.occurrenceId))

    const manualStore = store()
    const manual = manualStore.claimManual({
      habitId: "daily",
      requestId: "manual",
      execution: execution(),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:00:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:05:00.000Z",
    })
    if (manual.kind !== "claimed") throw new Error("expected claim")
    mutateProtectedRecord(occurrenceFile(manualStore, manual.occurrence.occurrenceId), (value) => ({
      ...value,
      occurrenceId: "occ_manual_bad",
    }), () => manualStore.readOccurrence(manual.occurrence.occurrenceId))
  })

  it("sorts scheduled and manual due retries on their canonical timestamps", () => {
    const authority = store()
    const scheduled = authority.claimNext(scheduledInput())
    if (scheduled.kind !== "claimed") throw new Error("expected claim")
    authority.settle(scheduled.occurrence.occurrenceId, scheduled.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "scheduled", message: "scheduled", retryable: true },
      safeRetryEvidence: evidence("evidence/scheduled.json"),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    const manual = authority.claimManual({
      habitId: "daily",
      requestId: "manual",
      execution: execution(),
      trigger: { kind: "manual", observedAt: "2026-07-24T10:01:00.000Z", scheduleProofRef: null },
      deadlineAt: "2026-07-24T10:06:00.000Z",
    })
    if (manual.kind !== "claimed") throw new Error("expected claim")
    authority.settle(manual.occurrence.occurrenceId, manual.attempt.attemptId, {
      version: 1,
      status: "failed_retryable",
      error: { code: "manual", message: "manual", retryable: true },
      safeRetryEvidence: evidence("evidence/manual.json"),
      notBefore: "2026-07-24T10:00:00.000Z",
    })
    const selected = authority.claimNext(scheduledInput({ slot: scheduledSlot("2026-07-24T10:30:00.000Z") }))
    expect(selected.kind).toBe("claimed")
    if (selected.kind !== "claimed") throw new Error("expected claim")
    expect([scheduled.occurrence.occurrenceId, manual.occurrence.occurrenceId]).toContain(selected.occurrence.occurrenceId)
  })

  it("rejects malformed prepared transaction schemas and filename disagreement", () => {
    const crashing = store("after_txn_prepared")
    const claim = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => crashing.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
    const txnDir = path.join(crashing.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
    const txnName = fs.readdirSync(txnDir).find((name) => name.endsWith("txn-r0.json"))!
    const txnPath = path.join(txnDir, txnName)
    const mutations: Array<(value: Record<string, any>) => unknown> = [
      (value) => ({ ...value, schemaVersion: 2 }),
      (value) => ({ ...value, revision: -1 }),
      (value) => ({ ...value, priorTxnSha256: "a".repeat(64) }),
      (value) => ({ ...value, priorOccurrenceSha256: "bad" }),
      (value) => ({ ...value, occurrenceHeadApplied: "yes" }),
      (value) => ({ ...value, fenceHeadApplied: true }),
      (value) => ({ ...value, state: "committed" }),
      (value) => ({ ...value, transactionId: "bad" }),
    ]
    const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
    for (const mutation of mutations) mutateProtectedRecord(txnPath, mutation, () => recovered.recoverPreparedTransactions())

    const mismatchedName = `${"huft_"}${"z".repeat(43)}.txn-r0.json`
    fs.renameSync(txnPath, path.join(txnDir, mismatchedName))
    try {
      expect(() => recovered.recoverPreparedTransactions()).toThrow(/filename/)
    } finally {
      fs.renameSync(path.join(txnDir, mismatchedName), txnPath)
    }
  })

  it("rejects an inconsistent committed transaction revision chain", () => {
    const authority = store()
    const claim = authority.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    authority.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])
    const txnDir = path.join(authority.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
    const revisionOne = fs.readdirSync(txnDir).find((name) => name.endsWith("txn-r1.json"))!
    mutateProtectedRecord(path.join(txnDir, revisionOne), (value) => ({ ...value, agent: "other-agent" }), () => authority.recoverPreparedTransactions())
  })

  it("rejects a transaction revision gap and cross-agent prepared ownership", () => {
    const gapStore = store("after_txn_prepared")
    const gapClaim = gapStore.claimNext(scheduledInput({ execution: execution("habit") }))
    if (gapClaim.kind !== "claimed") throw new Error("expected claim")
    expect(() => gapStore.markUnknown(gapClaim.occurrence.occurrenceId, gapClaim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
    const gapDir = path.join(gapStore.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
    const r0Name = fs.readdirSync(gapDir).find((name) => name.endsWith("txn-r0.json"))!
    const r0 = JSON.parse(fs.readFileSync(path.join(gapDir, r0Name), "utf8")) as Record<string, any>
    const r2Name = r0Name.replace("txn-r0.json", "txn-r2.json")
    fs.writeFileSync(path.join(gapDir, r2Name), canonicalizeJson({ ...r0, revision: 2, priorTxnSha256: "a".repeat(64) }), { mode: 0o600 })
    const gapRecovery = new HabitOccurrenceStore({ ...gapStore.options, fault: undefined })
    expect(() => gapRecovery.recoverPreparedTransactions()).toThrow(/gap/)

    const ownerStore = store("after_txn_prepared")
    const ownerClaim = ownerStore.claimNext(scheduledInput({ execution: execution("habit") }))
    if (ownerClaim.kind !== "claimed") throw new Error("expected claim")
    expect(() => ownerStore.markUnknown(ownerClaim.occurrence.occurrenceId, ownerClaim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
    const ownerDir = path.join(ownerStore.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
    const ownerR0 = path.join(ownerDir, fs.readdirSync(ownerDir).find((name) => name.endsWith("txn-r0.json"))!)
    const ownerValue = JSON.parse(fs.readFileSync(ownerR0, "utf8")) as Record<string, any>
    ownerValue.agent = "other-agent"
    fs.writeFileSync(ownerR0, canonicalizeJson(ownerValue), { mode: 0o600 })
    const ownerRecovery = new HabitOccurrenceStore({ ...ownerStore.options, fault: undefined })
    expect(() => ownerRecovery.recoverPreparedTransactions()).toThrow(/another agent/)
  })

  it("accepts schema-valid null prior-fence refs only to fail closed against the actual fence head", () => {
    const crashing = store("after_txn_prepared")
    const claim = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => crashing.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
    const txnDir = path.join(crashing.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
    const r0Path = path.join(txnDir, fs.readdirSync(txnDir).find((name) => name.endsWith("txn-r0.json"))!)
    const value = JSON.parse(fs.readFileSync(r0Path, "utf8")) as Record<string, any>
    value.priorFenceRef = null
    value.priorFenceSha256 = null
    fs.writeFileSync(r0Path, canonicalizeJson(value), { mode: 0o600 })
    const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
    expect(() => recovered.recoverPreparedTransactions()).toThrow(/third value/)
  })

  it.each([
    ["after_occurrence_head", 1],
    ["after_fence_head", 2],
  ] as const)("recovers when the r%s progress receipt was lost after its head write", (fault, revision) => {
    const crashing = store(fault)
    const claim = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => crashing.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
    const txnDir = path.join(crashing.options.bundleRoot, "state", "habits", "unknown-fence-transactions")
    const receipt = fs.readdirSync(txnDir).find((name) => name.endsWith(`txn-r${revision}.json`))!
    fs.rmSync(path.join(txnDir, receipt))
    const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
    recovered.recoverPreparedTransactions()
    expect(recovered.readOccurrence(claim.occurrence.occurrenceId).state).toBe("outcome_unknown")
    expect(recovered.readFence("daily").state).toBe("blocked")
  })

  it.each([
    ["after_txn_prepared", "payload-hash"],
    ["after_txn_prepared", "occurrence-third"],
    ["after_occurrence_head", "occurrence-regressed"],
    ["after_occurrence_head", "fence-third"],
    ["after_fence_head", "fence-regressed"],
  ] as const)("rejects %s recovery corruption at %s", (fault, mode) => {
    const crashing = store(fault)
    const claim = crashing.claimNext(scheduledInput({ execution: execution("habit") }))
    if (claim.kind !== "claimed") throw new Error("expected claim")
    expect(() => crashing.markUnknown(claim.occurrence.occurrenceId, claim.attempt.attemptId, "adapter_exception", [])).toThrow(/fault/)
    const root = crashing.options.bundleRoot
    const txnDir = path.join(root, "state", "habits", "unknown-fence-transactions")
    const latestTxnName = fs.readdirSync(txnDir)
      .filter((name) => name.includes("txn-r"))
      .sort((left, right) => Number(right.match(/r([0-9]+)/)?.[1]) - Number(left.match(/r([0-9]+)/)?.[1]))[0]!
    const txn = JSON.parse(fs.readFileSync(path.join(txnDir, latestTxnName), "utf8")) as Record<string, any>
    let target: string
    if (mode === "payload-hash") {
      target = path.join(root, txn.nextOccurrenceRef)
    } else if (mode.startsWith("occurrence")) {
      target = occurrenceFile(crashing, claim.occurrence.occurrenceId)
    } else {
      target = path.join(root, "state", "habits", "unknown-slot-fences", "daily.json")
    }
    const value = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, any>
    value.updatedAt = "2026-07-24T10:00:01.000Z"
    fs.writeFileSync(target, canonicalizeJson(value), { mode: 0o600 })
    const recovered = new HabitOccurrenceStore({ ...crashing.options, fault: undefined })
    expect(() => recovered.recoverPreparedTransactions()).toThrow()
  })

  it("rejects a scheduled slot key that is not derived from its complete identity", () => {
    const authority = store()
    expect(() => authority.claimNext(scheduledInput({
      slot: { ...scheduledSlot("2026-07-24T10:00:00.000Z"), slotKey: "z".repeat(43) },
    }))).toThrow(HabitOccurrenceCorruptError)
  })
})
