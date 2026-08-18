import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import type { ToolContext } from "../repertoire/tools-base"
import { emitNervesEvent } from "../nerves/runtime"

const ENDPOINTS = [
  "https://media.mendelow.cloud/",
  "https://books.mendelow.cloud/",
  "https://requests.mendelow.cloud/",
  "https://readarr.mendelow.cloud/",
]

interface Incident { id: string; summary: string }
interface HealthState { incidents: Record<string, Incident>; lastDigestDay: string | null; updatedAt: string }

function load(filePath: string): HealthState {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as HealthState }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { incidents: {}, lastDigestDay: null, updatedAt: new Date(0).toISOString() }
    throw new Error("Sanctuary health state is corrupt", { cause: error })
  }
}

function save(filePath: string, state: HealthState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null
}

export async function probeSanctuaryEndpoint(url: string, fetchImpl: typeof fetch = fetch): Promise<{
  url: string
  ok: boolean
  status: number
}> {
  const configured = new URL(url)
  if (configured.protocol !== "https:" || configured.username || configured.password) return { url, ok: false, status: 0 }
  let current = configured
  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetchImpl(current.href, { signal: AbortSignal.timeout(10_000), redirect: "manual" })
      const redirect = response.status >= 300 && response.status < 400
      if (!redirect) {
        await response.body?.cancel().catch(() => undefined)
        return { url, ok: response.status >= 200 && response.status < 400, status: response.status }
      }
      const location = response.headers.get("location")
      await response.body?.cancel().catch(() => undefined)
      if (!location || redirects === 5) return { url, ok: false, status: 0 }
      const target = new URL(location, current)
      if (target.protocol !== "https:" || target.origin !== configured.origin || target.username || target.password) {
        return { url, ok: false, status: 0 }
      }
      current = target
    }
  } catch {
    return { url, ok: false, status: 0 }
  }
  return { url, ok: false, status: 0 }
}

export function createSanctuaryHealthSweep(options: {
  toolContext: Pick<ToolContext, "sanctuary">
  statePath: string
  fetch?: typeof fetch
  now?: () => Date
}) {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  return async (): Promise<{ message: string | null; incidents: Incident[] }> => {
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_start", message: "Sanctuary deterministic health sweep started", meta: { statePath: options.statePath } })
    const runtime = options.toolContext.sanctuary
    if (!runtime) throw new Error("Sanctuary health runtime is unavailable")
    const [containersResult, storageResult, disksResult, notificationsResult, endpoints] = await Promise.all([
      runtime.listContainers(), runtime.getStorage(), runtime.getDisks(), runtime.getNotifications(),
      Promise.all(ENDPOINTS.map((url) => probeSanctuaryEndpoint(url, fetchImpl))),
    ])
    const incidents = new Map<string, Incident>()
    const add = (id: string, summary: string) => incidents.set(id, { id, summary })
    const containers = record(containersResult)?.ok ? record(record(containersResult)?.data)?.containers : null
    if (!Array.isArray(containers)) add("containers:unavailable", "container status is unavailable")
    else for (const container of containers) {
      if (container.autostart === true && container.state !== "running") add(`container:${container.id}:${container.state}:${container.exitCode ?? "none"}`, `${container.name} is ${container.state}`)
      if (container.state === "unknown" || container.degraded === true) add(`container:${container.id}:degraded`, `${container.name} status is degraded`)
    }
    const storage = record(storageResult)?.ok ? record(record(storageResult)?.data) : null
    const array = record(storage?.array)
    if (!array || array.degraded || typeof array.usedPercent !== "number") add("storage:array:degraded", "array capacity is unavailable")
    else if (array.usedPercent >= 90) add("storage:array:90", `array usage is ${array.usedPercent}%`)
    for (const share of Array.isArray(storage?.shares) ? storage.shares : []) if (share.degraded || typeof share.usedPercent !== "number") add(`storage:share:${share.name}:degraded`, `${share.name} capacity is unavailable`); else if (share.usedPercent >= 90) add(`storage:share:${share.name}:90`, `${share.name} usage is ${share.usedPercent}%`)
    const disks = record(disksResult)?.ok ? record(record(disksResult)?.data) : null
    if (!disks) add("disks:unavailable", "disk health is unavailable")
    else {
      for (const disk of Array.isArray(disks.disks) ? disks.disks : []) {
        if (disk.smart !== "passed") add(`disk:${disk.id}:smart:${disk.smart}`, `${disk.name} SMART is ${disk.smart}`)
        if (typeof disk.temperatureC !== "number") add(`disk:${disk.id}:temperature:unknown`, `${disk.name} temperature is unavailable`)
        else if (disk.temperatureC >= 50) add(`disk:${disk.id}:temperature:50`, `${disk.name} is ${disk.temperatureC}°C`)
      }
      const parity = record(disks.parity)
      if (!parity || parity.result !== "success" || typeof parity.ageHours !== "number" || parity.ageHours >= 45 * 24) add("parity:stale-or-failed", "parity check is unsuccessful, unknown, or older than 45 days")
    }
    const notifications = record(notificationsResult)?.ok ? record(record(notificationsResult)?.data)?.unacknowledged : null
    if (!Array.isArray(notifications)) add("notifications:unavailable", "notification status is unavailable")
    else for (const item of notifications) add(`notification:${item.id}`, `unacknowledged notification: ${item.title || item.id}`)
    for (const endpoint of endpoints) if (!endpoint.ok) add(`endpoint:${endpoint.url}`, `${endpoint.url} returned ${endpoint.status || "no response"}`)

    const previous = load(options.statePath)
    const current = Object.fromEntries([...incidents.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const opened = Object.values(current).filter((incident) => !previous.incidents[incident.id])
    const recovered = Object.values(previous.incidents).filter((incident) => !current[incident.id])
    const localParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now())
    const part = (type: string) => localParts.find((item) => item.type === type)?.value ?? ""
    const day = `${part("year")}-${part("month")}-${part("day")}`
    const digestDue = Number(part("hour")) >= 9 && Object.keys(current).length > 0 && previous.lastDigestDay !== day
    const next: HealthState = { incidents: current, lastDigestDay: digestDue ? day : previous.lastDigestDay, updatedAt: now().toISOString() }
    save(options.statePath, next)
    const lines = [
      ...opened.map((incident) => `🚨 ${incident.summary}`),
      ...recovered.map((incident) => `✅ recovered: ${incident.summary}`),
      ...(digestDue ? [`📋 still broken: ${Object.values(current).map((incident) => incident.summary).join("; ")}`] : []),
    ]
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_end", message: "Sanctuary deterministic health sweep completed", meta: { incidentCount: incidents.size, opened: opened.length, recovered: recovered.length, digestDue } })
    return { message: lines.length ? lines.join("\n") : null, incidents: Object.values(current) }
  }
}
