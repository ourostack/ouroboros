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

  return async (args: { container: string }): Promise<RestartResult> => {
    if (!validArgument(args.container)) return failure("invalid_response", "container must be one bounded exact name")
    const resolved = exactTarget(await options.listContainers(), args.container)
    if ("ok" in resolved) return resolved
    const fresh = exactTarget(await options.listContainers(), args.container)
    if ("ok" in fresh) return fresh
    if (fresh.id !== resolved.id) return failure("stale_target", "container identity changed before restart")

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
    if (approval && approval.argumentDigest !== attempt.argumentDigest) return failure("stale_target", "approval arguments changed before restart")
    await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "attempt_not_started" })
    const apiKey = await options.loadWriteApiKey()
    if (!apiKey.trim()) return failure("invalid_response", "Unraid write credential is unavailable")
    const client = createClient({ endpoint: options.endpoint, apiKey })
    await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "attempting" })
    emitNervesEvent({ component: "repertoire", event: "repertoire.unraid_restart_start", message: "approved Unraid restart started", meta: { containerId: fresh.id, containerName: fresh.name } })

    let acknowledged = false
    try {
      const mutation = await client.mutate<Record<string, unknown>>(SANCTUARY_RESTART_MUTATION, { id: fresh.id })
      acknowledged = acknowledgedIdentity(mutation, fresh)
      if (!acknowledged) throw new Error("restart response identity was invalid")
    } catch {
      acknowledged = false
    }

    const startedAt = now().getTime()
    let sawRestarting = false
    do {
      const observed = exactTarget(await options.listContainers(), args.container)
      if (!("ok" in observed)) {
        if (observed.id !== fresh.id) {
          await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "attempted_or_indeterminate", mutationAcknowledged: acknowledged })
          return failure("ambiguous", "container identity changed after restart attempt")
        }
        sawRestarting ||= observed.state === "restarting"
        if (observed.state === "running" && !observed.degraded && (acknowledged || sawRestarting)) {
          await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "succeeded", mutationAcknowledged: acknowledged, afterState: observed.state })
          emitNervesEvent({ component: "repertoire", event: "repertoire.unraid_restart_end", message: "approved Unraid restart completed", meta: { containerId: fresh.id, observedRestart: true } })
          return { ok: true, data: { container: { id: fresh.id, name: fresh.name }, beforeState: fresh.state, afterState: observed.state, observedRestart: true, degraded: false } }
        }
      }
      if (now().getTime() - startedAt >= observationTimeoutMs) break
      await sleep(1_000)
    } while (true)

    await options.persistAttempt?.({ ...attempt, observedAt: now().toISOString(), state: "attempted_or_indeterminate", mutationAcknowledged: acknowledged })
    emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.unraid_restart_error", message: "approved Unraid restart outcome was ambiguous", meta: { containerId: fresh.id, acknowledged } })
    return failure("ambiguous", "restart was attempted but could not be proven; it was not retried")
  }
}
