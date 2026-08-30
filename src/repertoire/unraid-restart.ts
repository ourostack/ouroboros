import { createHash, randomUUID } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { UnraidClient } from "./unraid-client"

export const SANCTUARY_RESTART_MUTATION = `mutation SanctuaryRestart($id: PrefixedID!) {
  docker { restart(id: $id) { id names state status autoStart } }
}`

type Container = {
  id: string
  name: string
  state: "running" | "exited" | "restarting" | "unknown"
  status: string
  degraded: boolean
}

type ContainerListResult =
  | { ok: true; data: { containers: Container[]; truncated: boolean } }
  | { ok: false; error: { code: string; message: string; degraded: true } }

type RestartResult =
  | { ok: true; data: { container: { id: string; name: string }; beforeState: string; afterState: string; observedRestart: true; degraded: false } }
  | { ok: false; error: { code: "invalid_response" | "not_found" | "ambiguous" | "stale_target"; message: string; degraded: true } }

export interface UnraidRestartAttempt {
  state: "attempt_not_started" | "attempting" | "succeeded" | "attempted_or_indeterminate"
  container: { id: string; name: string }
  beforeState: string
  observedAt: string
  actionDigest: string
  argumentDigest: string
  scenarioHandleDigest?: string
  approvalId?: string
  attemptId: string
  mutationAcknowledged: boolean
  afterState: string | null
}

interface RestartClient {
  mutate<T extends Record<string, unknown>>(document: string, variables: Record<string, unknown>): Promise<T>
}

export interface ApprovedUnraidRestartOptions {
  endpoint: string
  listContainers(): Promise<ContainerListResult>
  loadWriteApiKey(): Promise<string>
  createClient?: (options: { endpoint: string; apiKey: string }) => RestartClient
  persistAttempt?: (attempt: UnraidRestartAttempt) => void | Promise<void>
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
  observationTimeoutMs?: number
  acceptanceScenarioHandleDigest?: () => string | undefined
  acceptanceApproval?: () => { approvalId: string; argumentDigest: string } | null
  reserveRoutineAction?: (input: {
    key: string
    action: "unraid.container.restart"
    target: string
    expectedPolicyVersion: number
    authorizationReceiptId: string
    authorizationVersion: number
    attemptId: string
    expectedBeforeState: string
    resolvedTarget: { id: string; name: string }
    effect: { operation: "restart"; targetId: string }
  }) => { id: string }
  transitionRoutineAction?: (input: {
    id: string
    expectedState: "reserved" | "attempting" | "effect_acknowledged"
    state: "attempting" | "effect_acknowledged" | "verified" | "failed" | "indeterminate"
    effectReceipt?: string
    verifiedAfterState?: string
    recoveryState?: { state: "not_needed" | "manual_inspection_required" | "completed" | "failed"; compensation: "none" | "required" | "completed" }
  }) => unknown
}

export interface RoutineRestartAuthority {
  key: string
  expectedPolicyVersion: number
  reauthorize(): Promise<
    | { allowed: true; receiptId: string; profileVersion: number }
    | { allowed: false; reason: string }
  >
}

class RoutineActionReceiptError extends Error {
  constructor(cause: unknown) {
    super("routine action receipt persistence failed", { cause })
    this.name = "RoutineActionReceiptError"
  }
}

function failure(code: "invalid_response" | "not_found" | "ambiguous" | "stale_target", message: string): RestartResult {
  return { ok: false, error: { code, message, degraded: true } }
}

function exactTarget(result: ContainerListResult, name: string): Container | RestartResult {
  if (!result.ok) return failure("invalid_response", result.error.message)
  const matches = result.data.containers.filter((container) => container.name === name)
  if (matches.length === 0) return failure("not_found", `container '${name}' was not found`)
  if (matches.length !== 1) return failure("ambiguous", `container '${name}' is ambiguous`)
  return matches[0]!
}

function validArgument(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 128 && !value.includes("\uFFFD")
}

function acknowledgedIdentity(data: Record<string, unknown>, target: Container): boolean {
  const docker = data.docker
  if (!docker || typeof docker !== "object" || Array.isArray(docker)) return false
  const restart = (docker as Record<string, unknown>).restart
  if (!restart || typeof restart !== "object" || Array.isArray(restart)) return false
  const record = restart as Record<string, unknown>
  return record.id === target.id && Array.isArray(record.names)
    && record.names.length === 1 && String(record.names[0]).replace(/^\//u, "") === target.name
}

export function createApprovedUnraidRestartExecutor(options: ApprovedUnraidRestartOptions) {
  const createClient = options.createClient ?? ((input) => new UnraidClient(input))
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const now = options.now ?? (() => new Date())
  const observationTimeoutMs = options.observationTimeoutMs ?? 30_000
  const transitionRoutine = (input: Parameters<NonNullable<ApprovedUnraidRestartOptions["transitionRoutineAction"]>>[0]): void => {
    try {
      options.transitionRoutineAction?.(input)
    } catch (error) {
      throw new RoutineActionReceiptError(error)
    }
  }

  return async (args: { container: string }, execution?: { routine?: RoutineRestartAuthority }): Promise<RestartResult> => {
    if (!validArgument(args.container)) return failure("invalid_response", "container must be one bounded exact name")
    const resolved = exactTarget(await options.listContainers(), args.container)
    if ("ok" in resolved) return resolved
    const fresh = exactTarget(await options.listContainers(), args.container)
    if ("ok" in fresh) return fresh
    if (fresh.id !== resolved.id) return failure("stale_target", "container identity changed before restart")

    let routineAuthorization: { receiptId: string; profileVersion: number } | null = null
    if (execution?.routine) {
      let authorization: Awaited<ReturnType<RoutineRestartAuthority["reauthorize"]>>
      try {
        authorization = await execution.routine.reauthorize()
      } catch {
        return failure("stale_target", "routine relationship authorization is unavailable")
      }
      if (!authorization.allowed) return failure("stale_target", authorization.reason)
      if (!authorization.receiptId.trim() || !Number.isInteger(authorization.profileVersion) || authorization.profileVersion < 1) {
        return failure("stale_target", "routine relationship authorization is not versioned")
      }
      routineAuthorization = { receiptId: authorization.receiptId, profileVersion: authorization.profileVersion }
    }

    const scenarioHandleDigest = options.acceptanceScenarioHandleDigest?.()
    const approval = options.acceptanceApproval?.()
    const attempt = {
      container: { id: fresh.id, name: fresh.name },
      beforeState: fresh.state,
      observedAt: now().toISOString(),
      actionDigest: createHash("sha256").update(JSON.stringify({ operation: "restart", container: { id: fresh.id, name: fresh.name } })).digest("hex"),
      argumentDigest: createHash("sha256").update(JSON.stringify({ container: args.container })).digest("hex"),
      ...(scenarioHandleDigest ? { scenarioHandleDigest } : {}),
      ...(approval ? { approvalId: approval.approvalId } : {}),
      attemptId: randomUUID(),
      mutationAcknowledged: false,
      afterState: null,
    }
    let routineReceipt: { id: string } | null = null
    let routineState: "reserved" | "attempting" | "effect_acknowledged" | null = null
    if (execution?.routine) {
      if (!options.reserveRoutineAction || !options.transitionRoutineAction) return failure("invalid_response", "routine action ledger is unavailable")
      try {
        routineReceipt = options.reserveRoutineAction({
          key: execution.routine.key,
          expectedPolicyVersion: execution.routine.expectedPolicyVersion,
          authorizationReceiptId: routineAuthorization!.receiptId,
          authorizationVersion: routineAuthorization!.profileVersion,
          action: "unraid.container.restart",
          target: fresh.name,
          attemptId: attempt.attemptId,
          expectedBeforeState: fresh.state,
          resolvedTarget: { id: fresh.id, name: fresh.name },
          effect: { operation: "restart", targetId: fresh.id },
        })
        routineState = "reserved"
      } catch (error) {
        return failure("stale_target", error instanceof Error ? error.message : "routine action authority changed")
      }
    }
    if (approval && approval.argumentDigest !== attempt.argumentDigest) return failure("stale_target", "approval arguments changed before restart")
    await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "attempt_not_started" })
    const apiKey = await options.loadWriteApiKey()
    if (!apiKey.trim()) {
      if (routineReceipt && routineState === "reserved") transitionRoutine({ id: routineReceipt.id, expectedState: "reserved", state: "failed", recoveryState: { state: "completed", compensation: "none" } })
      return failure("invalid_response", "Unraid write credential is unavailable")
    }
    const client = createClient({ endpoint: options.endpoint, apiKey })
    if (routineReceipt && routineState === "reserved") {
      transitionRoutine({ id: routineReceipt.id, expectedState: "reserved", state: "attempting" })
      routineState = "attempting"
    }
    await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "attempting" })
    emitNervesEvent({ component: "repertoire", event: "repertoire.unraid_restart_start", message: "approved Unraid restart started", meta: { containerId: fresh.id, containerName: fresh.name } })
    const persistTerminal = async (terminal: UnraidRestartAttempt): Promise<boolean> => {
      try {
        await options.persistAttempt?.(terminal)
        return true
      } catch (error) {
        emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.unraid_restart_error", message: "approved Unraid restart terminal receipt persistence failed", meta: { containerId: fresh.id, category: error instanceof Error ? error.name : "unknown" } })
        return false
      }
    }

    let acknowledged = false
    let mutation: Record<string, unknown> | null = null
    try {
      mutation = await client.mutate<Record<string, unknown>>(SANCTUARY_RESTART_MUTATION, { id: fresh.id })
      acknowledged = acknowledgedIdentity(mutation, fresh)
      if (!acknowledged) throw new Error("restart response identity was invalid")
    } catch {
      acknowledged = false
    }
    if (acknowledged && mutation && routineReceipt && routineState === "attempting") {
      transitionRoutine({ id: routineReceipt.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") })
      routineState = "effect_acknowledged"
    }

    const startedAt = now().getTime()
    let sawRestarting = false
    try {
      do {
        const observed = exactTarget(await options.listContainers(), args.container)
        if (!("ok" in observed)) {
          if (observed.id !== fresh.id) {
            await persistTerminal({ ...attempt, observedAt: now().toISOString(), state: "attempted_or_indeterminate", mutationAcknowledged: acknowledged })
            if (routineReceipt && routineState) transitionRoutine({ id: routineReceipt.id, expectedState: routineState, state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } })
            return failure("ambiguous", "container identity changed after restart attempt")
          }
          sawRestarting ||= observed.state === "restarting"
          if (observed.state === "running" && !observed.degraded && (acknowledged || sawRestarting)) {
            if (!await persistTerminal({ ...attempt, observedAt: now().toISOString(), state: "succeeded", mutationAcknowledged: acknowledged, afterState: observed.state })) {
              return failure("ambiguous", "restart succeeded but its terminal receipt could not be persisted; it was not retried")
            }
            if (routineReceipt && routineState === "attempting") {
              transitionRoutine({ id: routineReceipt.id, expectedState: "attempting", state: "effect_acknowledged", effectReceipt: createHash("sha256").update(JSON.stringify({ observation: "restarting", target: fresh.id })).digest("hex") })
              routineState = "effect_acknowledged"
            }
            if (routineReceipt && routineState === "effect_acknowledged") {
              transitionRoutine({ id: routineReceipt.id, expectedState: "effect_acknowledged", state: "verified", verifiedAfterState: observed.state, recoveryState: { state: "completed", compensation: "none" } })
              routineState = null
            }
            emitNervesEvent({ component: "repertoire", event: "repertoire.unraid_restart_end", message: "approved Unraid restart completed", meta: { containerId: fresh.id, observedRestart: true } })
            return { ok: true, data: { container: { id: fresh.id, name: fresh.name }, beforeState: fresh.state, afterState: observed.state, observedRestart: true, degraded: false } }
          }
        }
        if (now().getTime() - startedAt >= observationTimeoutMs) break
        await sleep(1_000)
      } while (true)
    } catch (error) {
      if (error instanceof RoutineActionReceiptError) throw error
      await persistTerminal({ ...attempt, observedAt: now().toISOString(), state: "attempted_or_indeterminate", mutationAcknowledged: acknowledged })
      if (routineReceipt && routineState) transitionRoutine({ id: routineReceipt.id, expectedState: routineState, state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } })
      emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.unraid_restart_error", message: "approved Unraid restart observation failed", meta: { containerId: fresh.id, acknowledged } })
      return failure("ambiguous", "restart was attempted but observation failed; it was not retried")
    }

    await persistTerminal({ ...attempt, observedAt: now().toISOString(), state: "attempted_or_indeterminate", mutationAcknowledged: acknowledged })
    if (routineReceipt && routineState) transitionRoutine({ id: routineReceipt.id, expectedState: routineState, state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } })
    emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.unraid_restart_error", message: "approved Unraid restart outcome was ambiguous", meta: { containerId: fresh.id, acknowledged } })
    return failure("ambiguous", "restart was attempted but could not be proven; it was not retried")
  }
}
