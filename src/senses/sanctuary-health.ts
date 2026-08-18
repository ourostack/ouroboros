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
const REQUIRED_CONTAINERS = new Set(["calibre", "calibre-web", "Cloudflare-DDNS"])

interface Incident { id: string; summary: string }
interface HealthDelivery {
  id: string
  message: string
  status: "pending" | "attempting"
  createdAt: string
}
interface HealthState {
  incidents: Record<string, Incident>
  lastDigestDay: string | null
  updatedAt: string
  outbox: HealthDelivery | null
  indeterminateDeliveries: HealthDelivery[]
  deliveredReceipts: Array<{ deliveryId: string; messageIds: number[]; deliveredAt: string }>
}

export interface SanctuaryHealthSweepResult {
  message: string | null
  incidents: Incident[]
  deliveryId?: string
}

export interface SanctuaryHealthSweep {
  (): Promise<SanctuaryHealthSweepResult>
  markDeliveryAttempting(deliveryId: string): Promise<void>
  markDelivered(deliveryId: string, messageIds: number[]): Promise<void>
}

const healthLockTails = new Map<string, Promise<void>>()

async function withHealthLock<T>(statePath: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = healthLockTails.get(statePath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  healthLockTails.set(statePath, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (healthLockTails.get(statePath) === current) healthLockTails.delete(statePath)
  }
}

function load(filePath: string): HealthState {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<HealthState>
    const validDelivery = (delivery: unknown): delivery is HealthDelivery => Boolean(
      delivery && typeof delivery === "object"
      && typeof (delivery as HealthDelivery).id === "string"
      && typeof (delivery as HealthDelivery).message === "string"
      && ["pending", "attempting"].includes((delivery as HealthDelivery).status)
      && typeof (delivery as HealthDelivery).createdAt === "string",
    )
    if (!value.incidents || typeof value.incidents !== "object" || Array.isArray(value.incidents)) throw new Error("invalid incidents")
    if (value.lastDigestDay !== null && typeof value.lastDigestDay !== "string") throw new Error("invalid digest day")
    if (typeof value.updatedAt !== "string") throw new Error("invalid update time")
    if (value.outbox !== undefined && value.outbox !== null && !validDelivery(value.outbox)) throw new Error("invalid health outbox")
    if (value.indeterminateDeliveries !== undefined && (
      !Array.isArray(value.indeterminateDeliveries) || !value.indeterminateDeliveries.every(validDelivery)
    )) throw new Error("invalid indeterminate deliveries")
    if (value.deliveredReceipts !== undefined && (!Array.isArray(value.deliveredReceipts) || !value.deliveredReceipts.every((receipt) => (
      receipt && typeof receipt.deliveryId === "string" && typeof receipt.deliveredAt === "string"
      && Array.isArray(receipt.messageIds) && receipt.messageIds.length > 0
      && receipt.messageIds.every((id) => Number.isSafeInteger(id) && id > 0)
    )))) throw new Error("invalid delivered receipts")
    return {
      incidents: value.incidents as Record<string, Incident>,
      lastDigestDay: value.lastDigestDay,
      updatedAt: value.updatedAt,
      outbox: value.outbox ?? null,
      indeterminateDeliveries: value.indeterminateDeliveries ?? [],
      deliveredReceipts: value.deliveredReceipts ?? [],
    }
  }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { incidents: {}, lastDigestDay: null, updatedAt: new Date(0).toISOString(), outbox: null, indeterminateDeliveries: [], deliveredReceipts: [] }
    throw new Error("Sanctuary health state is corrupt", { cause: error })
  }
}

function save(filePath: string, state: HealthState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  const temporaryHandle = fs.openSync(temporary, "r")
  try { fs.fsyncSync(temporaryHandle) } finally { fs.closeSync(temporaryHandle) }
  fs.renameSync(temporary, filePath)
  const directoryHandle = fs.openSync(path.dirname(filePath), "r")
  try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
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
}): SanctuaryHealthSweep {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const runSweep = async (): Promise<SanctuaryHealthSweepResult> => {
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_start", message: "Sanctuary deterministic health sweep started", meta: { statePath: options.statePath } })
    const pendingState = load(options.statePath)
    if (pendingState.outbox?.status === "pending") {
      emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_end", message: "Sanctuary health delivery recovered from durable outbox", meta: { incidentCount: Object.keys(pendingState.incidents).length, deliveryId: pendingState.outbox.id, deliveryStatus: pendingState.outbox.status } })
      return { message: pendingState.outbox.message, incidents: Object.values(pendingState.incidents), deliveryId: pendingState.outbox.id }
    }
    if (pendingState.outbox?.status === "attempting") {
      pendingState.indeterminateDeliveries.push(pendingState.outbox)
      pendingState.outbox = null
      pendingState.updatedAt = now().toISOString()
      save(options.statePath, pendingState)
    }
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
      if ((container.autostart === true || REQUIRED_CONTAINERS.has(container.name)) && container.state !== "running") add(`container:${container.id}:${container.state}:${container.exitCode ?? "none"}`, `${container.name} is ${container.state}`)
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
    const digestDue = Number(part("hour")) >= 9
      && (Object.keys(current).length > 0 || previous.indeterminateDeliveries.length > 0)
      && previous.lastDigestDay !== day
    const lines = [
      ...opened.map((incident) => `🚨 ${incident.summary}`),
      ...recovered.map((incident) => `✅ recovered: ${incident.summary}`),
      ...(digestDue && Object.keys(current).length > 0 ? [`📋 still broken: ${Object.values(current).map((incident) => incident.summary).join("; ")}`] : []),
      ...(digestDue && previous.indeterminateDeliveries.length > 0
        ? previous.indeterminateDeliveries.map((delivery) => `⚠️ prior Telegram delivery was indeterminate: ${delivery.message}`)
        : []),
    ]
    const message = lines.length ? lines.join("\n") : null
    const delivery = message ? { id: randomUUID(), message, status: "pending" as const, createdAt: now().toISOString() } : null
    const next: HealthState = {
      incidents: current,
      lastDigestDay: digestDue ? day : previous.lastDigestDay,
      updatedAt: now().toISOString(),
      outbox: delivery,
      indeterminateDeliveries: digestDue ? [] : previous.indeterminateDeliveries,
      deliveredReceipts: previous.deliveredReceipts,
    }
    save(options.statePath, next)
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_end", message: "Sanctuary deterministic health sweep completed", meta: { incidentCount: incidents.size, opened: opened.length, recovered: recovered.length, digestDue } })
    return { message, incidents: Object.values(current), ...(delivery ? { deliveryId: delivery.id } : {}) }
  }

  const sweep = (() => withHealthLock(options.statePath, runSweep)) as SanctuaryHealthSweep

  sweep.markDeliveryAttempting = (deliveryId: string): Promise<void> => withHealthLock(options.statePath, () => {
    const state = load(options.statePath)
    if (!state.outbox || state.outbox.id !== deliveryId || state.outbox.status !== "pending") throw new Error(`Sanctuary health delivery ${deliveryId} is not pending`)
    state.outbox.status = "attempting"
    state.updatedAt = now().toISOString()
    save(options.statePath, state)
  })

  sweep.markDelivered = (deliveryId: string, messageIds: number[]): Promise<void> => withHealthLock(options.statePath, () => {
    if (!Array.isArray(messageIds) || messageIds.length < 1 || !messageIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new Error("Sanctuary health delivery receipt requires canonical Telegram message ids")
    }
    const state = load(options.statePath)
    if (!state.outbox || state.outbox.id !== deliveryId || state.outbox.status !== "attempting") throw new Error(`Sanctuary health delivery ${deliveryId} is not attempting`)
    state.deliveredReceipts = [...state.deliveredReceipts, { deliveryId, messageIds: [...messageIds], deliveredAt: now().toISOString() }].slice(-100)
    state.outbox = null
    state.updatedAt = now().toISOString()
    save(options.statePath, state)
  })

  return sweep
}
