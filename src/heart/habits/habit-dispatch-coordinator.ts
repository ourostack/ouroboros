import { randomUUID } from "crypto"

import type { HabitRunTrigger } from "../../arc/flight-recorder"
import { emitNervesEvent } from "../../nerves/runtime"
import type { ActivationBarrierStore } from "../activation/barrier-core"
import type { ProcessIdentity } from "../runtime/process-identity"
import { scheduledSlotAtOrBefore, type ScheduleProvenanceV1, type ScheduledHabitSlotV1 } from "./habit-cadence-v1"
import type {
  HabitExecutionEnvelopeV1,
  HabitInvocationOutcomeV1,
  HabitUnknownReason,
} from "./habit-execution"
import {
  HabitAdapterInvocationError,
  HabitExecutionRegistry,
  invokeResolvedHabitExecution,
  reconcileResolvedHabitExecution,
  type ResolvedHabitExecution,
} from "./habit-execution-registry"
import type {
  HabitFenceAdmissionResult,
  HabitOccurrenceClaimInput,
  HabitOccurrenceClaimResult,
  HabitOccurrenceStore,
  HabitOwnedReconciliationInputV1,
  HabitReconciliationCandidateV1,
} from "./habit-occurrence-store"
import type { HabitScheduleStore } from "./habit-schedule-store"

export interface HabitDispatchDefinition {
  id: string
  title: string
  body: string
  tools: string[]
  continuity: { mode: "fresh" | "stateful" }
  cadence: string | null
  cadenceTimezone: string | null
  created: string | null
  execution: HabitExecutionEnvelopeV1
}

interface OccurrenceAuthority {
  checkFenceAdmission(habitId: string, execution: HabitExecutionEnvelopeV1): HabitFenceAdmissionResult
  claimNext(input: HabitOccurrenceClaimInput): HabitOccurrenceClaimResult
  claimManual(input: {
    habitId: string
    requestId: string
    execution: HabitExecutionEnvelopeV1
    trigger: { kind: string; observedAt: string; scheduleProofRef: string | null }
    deadlineAt: string
  }): HabitOccurrenceClaimResult
  settle(occurrenceId: string, attemptId: string, result: Extract<HabitInvocationOutcomeV1, { disposition: "settled" }>['result']): unknown
  markUnknown(
    occurrenceId: string,
    attemptId: string,
    reason: HabitUnknownReason,
    priorEvidence: Extract<HabitInvocationOutcomeV1, { disposition: "outcome_unknown" }>['evidence'][],
  ): unknown
  listReconciliationCandidates?(habitId: string): HabitReconciliationCandidateV1[]
  reconcileOwned?(input: HabitOwnedReconciliationInputV1):
    HabitOccurrenceClaimResult | { kind: "settled"; occurrence: unknown } | { kind: "unresolved" }
}

interface ScheduleAuthority {
  reconcile(definition: {
    habitId: string
    cadence: string
    cadenceTimezone: string | null
    created: string | null
  }): ScheduleProvenanceV1
}

interface ScheduledBarrierAuthority {
  withScheduledAdmission<T>(
    command: Parameters<ActivationBarrierStore["withScheduledAdmission"]>[0],
    claim: () => T,
  ): ReturnType<ActivationBarrierStore["withScheduledAdmission"]> & { claim?: T }
}

export type HabitDispatchResult =
  | {
      kind: "settled" | "outcome_unknown"
      occurrenceId: string
      attemptId: string
      outcome: HabitInvocationOutcomeV1
    }
  | {
      kind: "blocked"
      reason: "no_cadence" | "no_due_slot" | "activation_barrier" |
        Extract<HabitOccurrenceClaimResult, { kind: "blocked" }>['reason']
      occurrenceId: string | null
    }

export interface HabitDispatchCoordinatorOptions {
  agent: string
  bundleRoot: string
  owner: ProcessIdentity & { daemonInstanceId: string }
  now(): string
  randomUuid?: () => string
  deadlineMs: number
  registry: HabitExecutionRegistry
  scheduleStore: HabitScheduleStore | ScheduleAuthority
  occurrenceStore: HabitOccurrenceStore | OccurrenceAuthority
  barrierStore: ActivationBarrierStore | ScheduledBarrierAuthority
  slotAtOrBefore?: (schedule: ScheduleProvenanceV1, now: string) => ScheduledHabitSlotV1 | null
  invokeResolved?: typeof invokeResolvedHabitExecution
}

function scheduledTrigger(trigger: HabitRunTrigger): boolean {
  return trigger === "cron" || trigger === "launchd" || trigger === "overdue"
}

export class HabitDispatchCoordinator {
  private readonly options: HabitDispatchCoordinatorOptions

  constructor(options: HabitDispatchCoordinatorOptions) {
    this.options = options
  }

  private persistSettlement(write: () => void, occurrenceId: string, attemptId: string): void {
    try {
      write()
      return
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "heart",
        event: "heart.habit_dispatch_settlement_write_retry",
        message: "retrying an idempotent habit settlement write under the same live owner",
        meta: {
          agent: this.options.agent,
          occurrenceId,
          attemptId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
    write()
  }

  private async invokeWithDeadline(
    input: Parameters<typeof invokeResolvedHabitExecution>[0],
    externalSignal?: AbortSignal,
  ): Promise<HabitInvocationOutcomeV1> {
    const controller = new AbortController()
    let rejectBoundary!: (reason: Error) => void
    const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject })
    const rejectInvocation = (error: HabitAdapterInvocationError) => {
      rejectBoundary(error)
      controller.abort()
    }
    const timer = setTimeout(() => {
      rejectInvocation(new HabitAdapterInvocationError("execution_timeout", "habit adapter exceeded its execution deadline"))
    }, this.options.deadlineMs)
    const onExternalAbort = () => {
      rejectInvocation(new HabitAdapterInvocationError("aborted_after_invoke", "habit adapter invocation was aborted after dispatch"))
    }
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
    if (externalSignal?.aborted) onExternalAbort()
    try {
      return await Promise.race([
        (this.options.invokeResolved ?? invokeResolvedHabitExecution)({
          ...input,
          invocation: { ...input.invocation, signal: controller.signal },
        }),
        boundary,
      ])
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener("abort", onExternalAbort)
    }
  }

  private async invokeClaim(input: {
    habit: HabitDispatchDefinition
    claim: Extract<HabitOccurrenceClaimResult, { kind: "claimed" }>
    resolved: ResolvedHabitExecution
    deadlineAt: string
    signal: AbortSignal | undefined
  }): Promise<HabitDispatchResult> {
    const occurrenceStore = this.options.occurrenceStore as OccurrenceAuthority
    const occurrenceId = input.claim.occurrence.occurrenceId
    const attemptId = input.claim.attempt.attemptId
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_dispatch_claim_admitted",
      message: "admitted durable habit claim to the generic adapter boundary",
      meta: { agent: this.options.agent, habitId: input.habit.id, occurrenceId, attemptId },
    })

    let outcome: HabitInvocationOutcomeV1
    try {
      outcome = await this.invokeWithDeadline({
        resolved: input.resolved,
        invocation: {
          schemaVersion: 1,
          agent: this.options.agent,
          bundleRoot: this.options.bundleRoot,
          habit: {
            id: input.habit.id,
            title: input.habit.title,
            body: input.habit.body,
            tools: input.habit.tools,
            continuity: input.habit.continuity,
          },
          occurrenceId,
          attemptId,
          trigger: input.claim.attempt.trigger,
          owner: this.options.owner,
          deadlineAt: input.deadlineAt,
          signal: new AbortController().signal,
        },
      }, input.signal)
    } catch (error) {
      const reason = error instanceof HabitAdapterInvocationError
        ? error.unknownReason
        : "adapter_exception"
      this.persistSettlement(
        () => { occurrenceStore.markUnknown(occurrenceId, attemptId, reason, []) },
        occurrenceId,
        attemptId,
      )
      throw error
    }

    if (outcome.disposition === "outcome_unknown") {
      this.persistSettlement(
        () => { occurrenceStore.markUnknown(occurrenceId, attemptId, outcome.reason, [outcome.evidence]) },
        occurrenceId,
        attemptId,
      )
      emitNervesEvent({
        component: "heart",
        event: "heart.habit_dispatch_unknown_settled",
        message: "persisted unknown habit outcome before projection",
        meta: { agent: this.options.agent, habitId: input.habit.id, occurrenceId, attemptId },
      })
      return { kind: "outcome_unknown", occurrenceId, attemptId, outcome }
    }

    this.persistSettlement(
      () => { occurrenceStore.settle(occurrenceId, attemptId, outcome.result) },
      occurrenceId,
      attemptId,
    )
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_dispatch_result_settled",
      message: "persisted habit adapter result before projection",
      meta: { agent: this.options.agent, habitId: input.habit.id, occurrenceId, attemptId },
    })
    return { kind: "settled", occurrenceId, attemptId, outcome }
  }

  private async reconcilePending(habit: HabitDispatchDefinition, signal?: AbortSignal): Promise<HabitDispatchResult | null> {
    const occurrenceStore = this.options.occurrenceStore as OccurrenceAuthority
    if (!occurrenceStore.listReconciliationCandidates || !occurrenceStore.reconcileOwned) return null
    for (const candidate of occurrenceStore.listReconciliationCandidates(habit.id)) {
      let resolved: ResolvedHabitExecution
      try {
        resolved = this.options.registry.resolve(candidate.execution)
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "heart",
          event: "heart.habit_reconciliation_adapter_unavailable",
          message: "recorded habit adapter is unavailable for reconciliation",
          meta: { agent: this.options.agent, habitId: habit.id, occurrenceId: candidate.occurrenceId, error: String(error) },
        })
        continue
      }
      let result
      try {
        result = await reconcileResolvedHabitExecution({
          resolved,
          input: {
            schemaVersion: 1,
            agent: this.options.agent,
            bundleRoot: this.options.bundleRoot,
            habitId: habit.id,
            config: resolved.config,
            occurrenceId: candidate.occurrenceId,
            attemptId: candidate.attemptId,
            unknownReason: candidate.unknownReason,
            priorEvidence: candidate.priorEvidence,
          },
        })
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "heart",
          event: "heart.habit_reconciliation_failed",
          message: "habit adapter reconciliation failed without changing occurrence authority",
          meta: { agent: this.options.agent, habitId: habit.id, occurrenceId: candidate.occurrenceId, error: String(error) },
        })
        continue
      }
      let reconciled
      try {
        reconciled = occurrenceStore.reconcileOwned({
          occurrenceId: candidate.occurrenceId,
          attemptId: candidate.attemptId,
          adapter: { id: resolved.adapter.id, version: resolved.adapter.version },
          priorEvidence: candidate.priorEvidence,
          result,
        })
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "heart",
          event: "heart.habit_reconciliation_commit_failed",
          message: "habit reconciliation evidence could not be committed",
          meta: { agent: this.options.agent, habitId: habit.id, occurrenceId: candidate.occurrenceId, error: String(error) },
        })
        continue
      }
      if (reconciled.kind === "claimed") {
        return this.invokeClaim({
          habit,
          claim: reconciled,
          resolved,
          deadlineAt: reconciled.attempt.deadlineAt,
          signal,
        })
      }
    }
    return null
  }

  async dispatch(input: {
    habit: HabitDispatchDefinition
    trigger: HabitRunTrigger
    signal?: AbortSignal
  }): Promise<HabitDispatchResult> {
    const observedAt = this.options.now()
    const deadlineAt = new Date(Date.parse(observedAt) + this.options.deadlineMs).toISOString()
    const resolved = this.options.registry.resolve(input.habit.execution)
    const occurrenceStore = this.options.occurrenceStore as OccurrenceAuthority

    const reconciled = await this.reconcilePending(input.habit, input.signal)
    if (reconciled) return reconciled

    let claim: HabitOccurrenceClaimResult
    if (scheduledTrigger(input.trigger)) {
      if (input.habit.cadence === null) {
        return { kind: "blocked", reason: "no_cadence", occurrenceId: null }
      }
      const schedule = this.options.scheduleStore.reconcile({
        habitId: input.habit.id,
        cadence: input.habit.cadence,
        cadenceTimezone: input.habit.cadenceTimezone,
        created: input.habit.created,
      })
      const slot = (this.options.slotAtOrBefore ?? scheduledSlotAtOrBefore)(schedule, observedAt)
      if (slot === null) return { kind: "blocked", reason: "no_due_slot", occurrenceId: null }
      const scheduleProofRef = `habit-schedule:${schedule.definitionSha256}:${slot.slotKey}`
      const fence = occurrenceStore.checkFenceAdmission(input.habit.id, input.habit.execution)
      if (fence.kind === "blocked") return fence
      const admitted = this.options.barrierStore.withScheduledAdmission({
        kind: "admission.scheduled",
        deferredId: `habit-deferred:${slot.slotKey}`,
        target: { agent: this.options.agent, habitId: input.habit.id },
        scheduleRevision: slot.scheduleRevision,
        slotKey: slot.slotKey,
        scheduledAtUtc: slot.scheduledAtUtc,
        writerEpoch: this.options.owner.daemonInstanceId,
        at: observedAt,
      }, () => occurrenceStore.claimNext({
        habitId: input.habit.id,
        slot,
        execution: input.habit.execution,
        trigger: { kind: input.trigger, observedAt, scheduleProofRef },
        deadlineAt,
        scheduleProvenanceSha256: schedule.definitionSha256,
      }))
      if (admitted.admission.kind !== "admitted") {
        return { kind: "blocked", reason: "activation_barrier", occurrenceId: null }
      }
      claim = admitted.claim as HabitOccurrenceClaimResult
    } else {
      const fence = occurrenceStore.checkFenceAdmission(input.habit.id, input.habit.execution)
      if (fence.kind === "blocked") return fence
      claim = occurrenceStore.claimManual({
        habitId: input.habit.id,
        requestId: (this.options.randomUuid ?? randomUUID)(),
        execution: input.habit.execution,
        trigger: { kind: input.trigger, observedAt, scheduleProofRef: null },
        deadlineAt,
      })
    }

    if (claim.kind === "blocked") return claim
    return this.invokeClaim({
      habit: input.habit,
      claim,
      resolved,
      deadlineAt,
      signal: input.signal,
    })
  }
}
