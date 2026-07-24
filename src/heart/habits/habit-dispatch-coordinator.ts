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
} from "./habit-execution-registry"
import type {
  HabitFenceAdmissionResult,
  HabitOccurrenceClaimInput,
  HabitOccurrenceClaimResult,
  HabitOccurrenceStore,
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

  async dispatch(input: {
    habit: HabitDispatchDefinition
    trigger: HabitRunTrigger
  }): Promise<HabitDispatchResult> {
    const observedAt = this.options.now()
    const deadlineAt = new Date(Date.parse(observedAt) + this.options.deadlineMs).toISOString()
    const resolved = this.options.registry.resolve(input.habit.execution)
    const occurrenceStore = this.options.occurrenceStore as OccurrenceAuthority

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
    const occurrenceId = claim.occurrence.occurrenceId
    const attemptId = claim.attempt.attemptId
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_dispatch_claim_admitted",
      message: "admitted durable habit claim to the generic adapter boundary",
      meta: { agent: this.options.agent, habitId: input.habit.id, occurrenceId, attemptId },
    })

    let outcome: HabitInvocationOutcomeV1
    try {
      outcome = await (this.options.invokeResolved ?? invokeResolvedHabitExecution)({
        resolved,
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
          trigger: claim.attempt.trigger,
          owner: this.options.owner,
          deadlineAt,
          signal: AbortSignal.timeout(this.options.deadlineMs),
        },
      })
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
}
