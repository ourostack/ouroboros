import { emitNervesEvent } from "../nerves/runtime"
import { UnraidClient, UnraidClientError, type UnraidErrorCode } from "./unraid-client"
import type { ToolDefinition } from "./tools-base"

export const SANCTUARY_CONTAINERS_QUERY = `query SanctuaryContainers {
  docker { containers(skipCache: true) { id names state status autoStart } }
}`
export const SANCTUARY_CONTAINER_LOGS_QUERY = `query SanctuaryContainerLogs($id: PrefixedID!, $tail: Int!) {
  docker { logs(id: $id, tail: $tail) { containerId lines { timestamp message } cursor } }
}`
export const SANCTUARY_STORAGE_QUERY = `query SanctuaryStorage {
  array { state capacity { kilobytes { used free total } } }
  shares { id name used free size }
}`
export const SANCTUARY_DISKS_QUERY = `query SanctuaryDisks {
  disks { id name smartStatus temperature }
  array { parityCheckStatus { status date duration errors progress correcting paused running } }
}`
export const SANCTUARY_NOTIFICATIONS_QUERY = `query SanctuaryNotifications {
  notifications { list(filter: {type: UNREAD, offset: 0, limit: 100}) { id timestamp importance title subject description type } }
}`
export const SANCTUARY_SYSTEM_QUERY = `query SanctuarySystem {
  vars { name version }
  info { time os { uptime } versions { core { unraid api } } }
  array { state }
}`

type ToolErrorCode = UnraidErrorCode | "not_found" | "ambiguous" | "stale_target"
type ToolResult<T> = { ok: true; data: T } | { ok: false; error: { code: ToolErrorCode; message: string; degraded: true } }
type ReadClient = Pick<UnraidClient, "read">

function utf8Bytes(value: string): number { return Buffer.byteLength(value, "utf8") }

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > 128 || value.includes("\uFFFD")) {
    throw new UnraidClientError("invalid_response", `${label} is invalid`)
  }
  return value
}

function display(value: unknown, maxBytes: number): { value: string; truncated: boolean } {
  if (typeof value !== "string") return { value: "", truncated: true }
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= maxBytes) return { value, truncated: false }
  let prefix = bytes.subarray(0, maxBytes - 3).toString("utf8")
  while (prefix.endsWith("\uFFFD")) prefix = prefix.slice(0, -1)
  return { value: `${prefix}...`, truncated: true }
}

const DURATION = "(?:Less than a second|About a (?:minute|hour)|(?:[1-9][0-9]*) (?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))"
const RUNNING = new RegExp(`^Up ${DURATION}(?: \\(healthy\\)| \\(unhealthy\\))?$`, "u")
const EXITED = new RegExp(`^Exited \\((0|[1-9][0-9]*)\\) ${DURATION} ago$`, "u")
const RESTARTING = new RegExp(`^Restarting \\((0|[1-9][0-9]*)\\) ${DURATION} ago$`, "u")

function exitCode(match: RegExpMatchArray | null): number | null {
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295 ? value : null
}

export function normalizeDockerStatus(structuredState: unknown, status: unknown): {
  state: "running" | "exited" | "restarting" | "unknown"
  exitCode: number | null
  degraded: boolean
} {
  if (typeof status !== "string") return { state: "unknown", exitCode: null, degraded: true }
  if (structuredState === "RUNNING" && RUNNING.test(status)) return { state: "running", exitCode: null, degraded: false }
  const exited = status.match(EXITED)
  if (structuredState === "EXITED" && exited) {
    const code = exitCode(exited)
    return code === null ? { state: "unknown", exitCode: null, degraded: true } : { state: "exited", exitCode: code, degraded: false }
  }
  const restarting = status.match(RESTARTING)
  if ((structuredState === "RUNNING" || structuredState === "EXITED") && restarting) {
    const code = exitCode(restarting)
    return code === null ? { state: "unknown", exitCode: null, degraded: true } : { state: "restarting", exitCode: code, degraded: false }
  }
  return { state: "unknown", exitCode: null, degraded: true }
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "string" && /^-?[0-9]+$/u.test(value) ? Number(value) : value
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null
}

function percent(used: number | null, free: number | null): number | null {
  if (used === null || free === null || used + free === 0) return null
  return Number(((used / (used + free)) * 100).toFixed(2))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnraidClientError("invalid_response", `${label} is invalid`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new UnraidClientError("invalid_response", `${label} is invalid`)
  return value
}

function fail(error: unknown): { ok: false; error: { code: ToolErrorCode; message: string; degraded: true } } {
  const normalized = error instanceof UnraidClientError
    ? error
    : new UnraidClientError("invalid_response", error instanceof Error ? error.message : String(error))
  return { ok: false, error: { code: normalized.code, message: normalized.message, degraded: true } }
}

function containerName(names: unknown): string {
  const values = array(names, "container names")
  if (values.length !== 1) throw new UnraidClientError("invalid_response", "container names are ambiguous")
  return identifier(values[0], "container name").replace(/^\//u, "")
}

function mapContainers(data: Record<string, unknown>) {
  const docker = record(data.docker, "docker response")
  const raw = array(docker.containers, "container list")
  const truncated = raw.length > 200
  const containers = raw.slice(0, 200).map((entry) => {
    const item = record(entry, "container")
    const id = UnraidClient.assertPrefixedId(identifier(item.id, "container id"))
    const name = containerName(item.names)
    const shownStatus = display(item.status, 256)
    const normalized = normalizeDockerStatus(item.state, shownStatus.value)
    return {
      id,
      name,
      autostart: typeof item.autoStart === "boolean" ? item.autoStart : false,
      ...normalized,
      degraded: normalized.degraded || shownStatus.truncated || typeof item.autoStart !== "boolean",
      status: shownStatus.value,
    }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { containers, truncated }
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || utf8Bytes(value) > 64 || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function createUnraidReadTools(client: ReadClient) {
  const listContainers = async (): Promise<ToolResult<ReturnType<typeof mapContainers>>> => {
    try {
      const data = await client.read<Record<string, unknown>>(SANCTUARY_CONTAINERS_QUERY, {})
      return { ok: true, data: mapContainers(data) }
    } catch (error) { return fail(error) }
  }

  return {
    listContainers,
    async getContainerLogs(args: { container: string; tailLines: number }): Promise<ToolResult<Record<string, unknown>>> {
      try {
        const wanted = identifier(args.container, "container argument")
        if (!Number.isInteger(args.tailLines) || args.tailLines < 1 || args.tailLines > 200) throw new UnraidClientError("invalid_response", "tailLines must be an integer from 1 to 200")
        const listed = await listContainers()
        if (!listed.ok) return listed
        const matches = listed.data.containers.filter((container) => container.name === wanted)
        if (matches.length === 0) return { ok: false, error: { code: "not_found", message: `container '${wanted}' was not found`, degraded: true } }
        if (matches.length !== 1) return { ok: false, error: { code: "ambiguous", message: `container '${wanted}' is ambiguous`, degraded: true } }
        const target = matches[0]!
        const data = await client.read<Record<string, unknown>>(SANCTUARY_CONTAINER_LOGS_QUERY, { id: target.id, tail: args.tailLines })
        const logs = record(record(data.docker, "docker response").logs, "container logs")
        if (logs.containerId !== target.id) throw new UnraidClientError("invalid_response", "container log identity drifted")
        const text = array(logs.lines, "container log lines").map((line) => display(record(line, "log line").message, 1_000_000).value).join("\n")
        const originalBytes = utf8Bytes(text)
        const suffix = Buffer.from(text, "utf8").subarray(Math.max(0, originalBytes - 65_536)).toString("utf8").replace(/^\uFFFD/u, "")
        const returnedBytes = utf8Bytes(suffix)
        return { ok: true, data: { container: { id: target.id, name: target.name }, text: suffix, originalBytes, returnedBytes, truncated: returnedBytes < originalBytes } }
      } catch (error) {
        return fail(error)
      }
    },
    async getStorage(): Promise<ToolResult<Record<string, unknown>>> {
      try {
        const data = await client.read<Record<string, unknown>>(SANCTUARY_STORAGE_QUERY, {})
        const arrayRecord = record(data.array, "array")
        const kb = record(record(arrayRecord.capacity, "array capacity").kilobytes, "array capacity kilobytes")
        const usedKb = numberOrNull(kb.used); const freeKb = numberOrNull(kb.free)
        const usedBytes = usedKb === null ? null : usedKb * 1024; const freeBytes = freeKb === null ? null : freeKb * 1024
        const state = display(arrayRecord.state, 128)
        const rawShares = array(data.shares, "shares"); const truncated = rawShares.length > 256
        const shares = rawShares.slice(0, 256).map((entry) => {
          const item = record(entry, "share"); const name = identifier(item.name, "share name")
          const used = numberOrNull(item.used); const free = numberOrNull(item.free)
          return { name, usedBytes: used, freeBytes: free, usedPercent: percent(used, free), degraded: used === null || free === null }
        }).sort((a, b) => a.name.localeCompare(b.name))
        return { ok: true, data: { array: { state: state.value, usedBytes, freeBytes, usedPercent: percent(usedBytes, freeBytes), degraded: state.truncated || usedBytes === null || freeBytes === null }, shares, truncated } }
      } catch (error) { return fail(error) }
    },
    async getDisks(): Promise<ToolResult<Record<string, unknown>>> {
      try {
        const data = await client.read<Record<string, unknown>>(SANCTUARY_DISKS_QUERY, {})
        const rawDisks = array(data.disks, "disks"); const truncated = rawDisks.length > 64
        const disks = rawDisks.slice(0, 64).map((entry) => {
          const item = record(entry, "disk"); const id = identifier(item.id, "disk id"); const name = identifier(item.name, "disk name")
          const smartRaw = typeof item.smartStatus === "string" ? item.smartStatus.toLowerCase() : ""
          const smart = smartRaw === "passed" ? "passed" : smartRaw === "failed" ? "failed" : "unknown"
          const temperatureC = typeof item.temperature === "number" && Number.isFinite(item.temperature) ? item.temperature : null
          return { id, name, smart, temperatureC, degraded: smart === "unknown" || temperatureC === null }
        }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        const parityRaw = record(record(data.array, "array").parityCheckStatus, "parity status")
        const completedAt = validTimestamp(parityRaw.date)
        const errors = numberOrNull(parityRaw.errors)
        const result = errors === 0 && typeof parityRaw.status === "string" && /complete|success/i.test(parityRaw.status) ? "success" : errors !== null && errors > 0 ? "failed" : "unknown"
        const ageHours = completedAt ? Math.max(0, (Date.now() - Date.parse(completedAt)) / 3_600_000) : null
        return { ok: true, data: { disks, parity: { result, completedAt, ageHours, degraded: result === "unknown" || completedAt === null }, truncated } }
      } catch (error) { return fail(error) }
    },
    async getNotifications(): Promise<ToolResult<Record<string, unknown>>> {
      try {
        const data = await client.read<Record<string, unknown>>(SANCTUARY_NOTIFICATIONS_QUERY, {})
        const raw = array(record(data.notifications, "notifications").list, "notification list")
        const truncated = raw.length > 100
        const unacknowledged = raw.slice(0, 100).map((entry) => {
          const item = record(entry, "notification"); const id = identifier(item.id, "notification id")
          const createdAt = validTimestamp(item.timestamp)
          const importance = typeof item.importance === "string" ? item.importance.toLowerCase() : ""
          const severity = importance === "info" || importance === "warning" || importance === "error" ? importance : "unknown"
          const title = display(item.title, 160); const subject = display(item.subject, 250); const description = display(item.description, 250)
          const summary = display([subject.value, description.value].filter(Boolean).join("\n"), 500)
          return { id, createdAt, severity, title: title.value, summary: summary.value, degraded: !createdAt || severity === "unknown" || title.truncated || subject.truncated || description.truncated || summary.truncated }
        }).sort((a, b) => b.createdAt?.localeCompare(a.createdAt ?? "") ?? (a.createdAt ? -1 : b.createdAt ? 1 : a.id.localeCompare(b.id)))
        return { ok: true, data: { unacknowledged, truncated } }
      } catch (error) { return fail(error) }
    },
    async getSystem(): Promise<ToolResult<Record<string, unknown>>> {
      try {
        const data = await client.read<Record<string, unknown>>(SANCTUARY_SYSTEM_QUERY, {})
        const vars = record(data.vars, "vars"); const info = record(data.info, "info"); const versions = record(record(info.versions, "versions").core, "core versions")
        const name = display(vars.name, 128); const unraid = display(versions.unraid ?? vars.version, 128); const api = display(versions.api, 128); const state = display(record(data.array, "array").state, 128)
        const uptimeSeconds = numberOrNull(record(info.os, "os").uptime)
        return { ok: true, data: { serverName: name.value, unraidVersion: unraid.value, apiVersion: api.value, arrayState: state.value, uptimeSeconds, degraded: name.truncated || unraid.truncated || api.truncated || state.truncated || uptimeSeconds === null } }
      } catch (error) { return fail(error) }
    },
  }
}

const emptyParameters = { type: "object", properties: {}, additionalProperties: false }

function missingRuntime(): string {
  return JSON.stringify({ ok: false, error: { code: "invalid_response", message: "Sanctuary runtime is unavailable", degraded: true } })
}

function readDefinition(name: string, description: string, method: "listContainers" | "getStorage" | "getDisks" | "getNotifications" | "getSystem"): ToolDefinition {
  return {
    tool: { type: "function", function: { name, description, parameters: emptyParameters } },
    handler: async (_args, ctx) => JSON.stringify(ctx?.sanctuary ? await ctx.sanctuary[method]() : JSON.parse(missingRuntime())),
    riskProfile: { mutates: "none", risk: "low" },
  }
}

export const unraidToolDefinitions: ToolDefinition[] = [
  readDefinition("unraid_list_containers", "List bounded Sanctuary Docker container status.", "listContainers"),
  {
    tool: {
      type: "function",
      function: {
        name: "unraid_get_container_logs",
        description: "Read the recent bounded log suffix for one exact Sanctuary container name.",
        parameters: {
          type: "object",
          properties: {
            container: { type: "string" },
            tailLines: { type: "integer", minimum: 1, maximum: 200 },
          },
          required: ["container", "tailLines"],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, ctx) => JSON.stringify(ctx?.sanctuary
      ? await ctx.sanctuary.getContainerLogs({ container: String(args.container), tailLines: Number(args.tailLines) })
      : JSON.parse(missingRuntime())),
    riskProfile: { mutates: "none", risk: "low" },
  },
  readDefinition("unraid_get_storage", "Read bounded Sanctuary array and share capacity health.", "getStorage"),
  readDefinition("unraid_get_disks", "Read bounded Sanctuary disk SMART, temperature, and parity health.", "getDisks"),
  readDefinition("unraid_get_notifications", "Read bounded unacknowledged Sanctuary notifications.", "getNotifications"),
  readDefinition("unraid_get_system", "Read bounded Sanctuary system and version health.", "getSystem"),
  {
    tool: {
      type: "function",
      function: {
        name: "unraid_restart_container",
        description: "Propose restarting one exact existing allowlisted Sanctuary container. Execution requires human approval.",
        parameters: {
          type: "object",
          properties: { container: { type: "string" } },
          required: ["container"],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, ctx) => JSON.stringify(ctx?.sanctuary
      ? await ctx.sanctuary.restartContainer({ container: String(args.container) })
      : JSON.parse(missingRuntime())),
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "restarts one existing allowlisted Docker container" },
    approvalPolicy: () => ({
      kind: "required",
      policyId: "sanctuary.unraid.restart.v1",
      actionClass: "unraid.container.restart",
      requiresSoleCall: true,
    }),
  },
]

emitNervesEvent({
  component: "repertoire",
  event: "repertoire.unraid_tools_loaded",
  message: "typed Unraid tools loaded",
  meta: { operations: 6 },
})
