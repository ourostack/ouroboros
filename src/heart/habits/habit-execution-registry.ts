import { emitNervesEvent } from "../../nerves/runtime"
import {
  parseHabitInvocationOutcomeV1,
  parseHabitReconciliationResultV1,
} from "./habit-execution"
import type {
  HabitExecutionAdapter,
  HabitExecutionEnvelopeV1,
  HabitInvocationOutcomeV1,
  HabitInvocationV1,
  HabitReconciliationInputV1,
  HabitReconciliationResultV1,
  HabitUnknownReason,
} from "./habit-execution"

const ADAPTER_ID = /^[a-z][a-z0-9-]*$/

export class HabitAdapterInvocationError extends Error {
  readonly unknownReason: HabitUnknownReason

  constructor(unknownReason: HabitUnknownReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HabitAdapterInvocationError"
    this.unknownReason = unknownReason
  }
}

export interface ResolvedHabitExecution<C = unknown> {
  adapter: HabitExecutionAdapter<C>
  config: C
}

export class HabitExecutionRegistry {
  private readonly adapters = new Map<string, HabitExecutionAdapter<unknown>>()

  register<C>(adapter: HabitExecutionAdapter<C>): void {
    if (!ADAPTER_ID.test(adapter.id)) throw new Error(`Invalid habit adapter identifier: ${adapter.id}`)
    if (adapter.version !== 1) throw new Error(`Invalid habit adapter version for ${adapter.id}: ${String(adapter.version)}`)
    const key = this.key(adapter.id, adapter.version)
    if (this.adapters.has(key)) throw new Error(`Duplicate habit adapter registration: ${adapter.id}@${adapter.version}`)
    this.adapters.set(key, adapter as HabitExecutionAdapter<unknown>)
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_adapter_registered",
      message: "registered generic habit execution adapter",
      meta: { adapterId: adapter.id, version: adapter.version },
    })
  }

  get(id: string, version: number): HabitExecutionAdapter<unknown> {
    const adapter = this.adapters.get(this.key(id, version))
    if (!adapter) throw new Error(`Unknown habit adapter: ${id}@${version}`)
    return adapter
  }

  resolve(envelope: HabitExecutionEnvelopeV1): ResolvedHabitExecution {
    const adapter = this.get(envelope.adapter, envelope.version)
    return { adapter, config: adapter.validateConfig(envelope.config) }
  }

  keys(): Array<{ id: string; version: 1 }> {
    return Array.from(this.adapters.values(), (adapter) => ({ id: adapter.id, version: adapter.version }))
  }

  private key(id: string, version: number): string {
    return `${id}\u0000${version}`
  }
}

export async function dispatchHabitExecution(input: {
  registry: HabitExecutionRegistry
  envelope: HabitExecutionEnvelopeV1
  invocation: Omit<HabitInvocationV1<Record<string, unknown>>, "config">
}): Promise<HabitInvocationOutcomeV1> {
  const resolved = input.registry.resolve(input.envelope)
  return invokeResolvedHabitExecution({ resolved, invocation: input.invocation })
}

export async function invokeResolvedHabitExecution(input: {
  resolved: ResolvedHabitExecution
  invocation: Omit<HabitInvocationV1<Record<string, unknown>>, "config">
}): Promise<HabitInvocationOutcomeV1> {
  const { resolved } = input
  try {
    const rawOutcome = await resolved.adapter.invoke({
      ...input.invocation,
      config: resolved.config,
    })
    if (rawOutcome === undefined || rawOutcome === null || (
      typeof rawOutcome === "object" &&
      !Array.isArray(rawOutcome) &&
      (rawOutcome as { disposition?: unknown }).disposition === "settled" &&
      !("result" in rawOutcome)
    )) {
      throw new HabitAdapterInvocationError("result_absent", `Habit adapter ${resolved.adapter.id}@${resolved.adapter.version} returned no result`)
    }
    let outcome: HabitInvocationOutcomeV1
    try {
      outcome = parseHabitInvocationOutcomeV1(rawOutcome)
    } catch (error) {
      throw new HabitAdapterInvocationError(
        "invalid_result",
        `Habit adapter ${resolved.adapter.id}@${resolved.adapter.version} returned an invalid result: ${(error as Error).message}`,
        { cause: error },
      )
    }
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_adapter_dispatched",
      message: "generic habit adapter returned",
      meta: { adapterId: resolved.adapter.id, disposition: outcome.disposition },
    })
    return outcome
  } catch (error) {
    if (error instanceof HabitAdapterInvocationError) throw error
    throw new HabitAdapterInvocationError(
      "adapter_exception",
      `Habit adapter ${resolved.adapter.id}@${resolved.adapter.version} threw: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export async function reconcileResolvedHabitExecution(input: {
  resolved: ResolvedHabitExecution
  input: HabitReconciliationInputV1<unknown>
}): Promise<HabitReconciliationResultV1> {
  const reconcile = input.resolved.adapter.reconcile
  if (!reconcile) return { version: 1, disposition: "unresolved" }
  let raw: unknown
  try {
    raw = await reconcile({ ...input.input, config: input.resolved.config })
  } catch (error) {
    throw new Error(
      `Habit adapter ${input.resolved.adapter.id}@${input.resolved.adapter.version} reconciliation failed: ${String(error)}`,
      { cause: error },
    )
  }
  try {
    const result = parseHabitReconciliationResultV1(raw)
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_adapter_reconciled",
      message: "generic habit adapter returned reconciliation evidence",
      meta: { adapterId: input.resolved.adapter.id, disposition: result.disposition },
    })
    return result
  } catch (error) {
    throw new Error(
      `Habit adapter ${input.resolved.adapter.id}@${input.resolved.adapter.version} reconciliation result is invalid: ${(error as Error).message}`,
      { cause: error },
    )
  }
}
