import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"

import type { ToolContext } from "../repertoire/tools-base"
import { emitNervesEvent } from "../nerves/runtime"
import { sanctuaryAcceptanceEventMeta } from "../heart/daemon/sanctuary-acceptance-marker"

const ENDPOINTS = [
  "https://media.mendelow.cloud/",
  "https://books.mendelow.cloud/",
  "https://requests.mendelow.cloud/",
  "https://readarr.mendelow.cloud/",
]
const REQUIRED_CONTAINERS = new Set(["calibre", "calibre-web", "Cloudflare-DDNS"])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_HEALTH_STATE_BYTES = 4 * 1024 * 1024
const MAX_HEALTH_TEXT_BYTES = 50_000
const MAX_HEALTH_INCIDENT_BYTES = 4_096

function boundedIncidentText(value: string): string {
  if (Buffer.byteLength(value) <= MAX_HEALTH_INCIDENT_BYTES) return value
  let output = ""
  for (const character of value) {
    if (Buffer.byteLength(output) + Buffer.byteLength(character) > MAX_HEALTH_INCIDENT_BYTES - 3) break
    output += character
  }
  return `${output}…`
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 30) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

interface Incident { id: string; summary: string; observationRevision?: string; transition?: "opened" | "unchanged" | "changed" }
interface HealthDelivery {
  id: string
  message: string
  status: "pending" | "attempting"
  createdAt: string
  kind: "transition" | "digest" | "transition_and_digest" | "legacy_unknown"
  summarizedMessage?: string
}
interface HealthState {
  incidents: Record<string, Incident>
  lastDigestDay: string | null
  updatedAt: string
  outbox: HealthDelivery | null
  indeterminateDeliveries: HealthDelivery[]
  deliveredReceipts: Array<{ deliveryId: string; kind: HealthDelivery["kind"]; messageIds: number[]; deliveredAt: string }>
  sweepReceipts: Array<{
    sweepId: string
    startedAt: string
    completedAt: string
    incidentDigest: string
    opened: number
    recovered: number
    digestDue: boolean
    deliveryId?: string
    scenarioHandleDigest?: string
  }>
}

export interface SanctuaryHealthSweepResult {
  message: string | null
  incidents: Incident[]
  recovered?: Incident[]
  observationRevision?: string
  transition?: "opened" | "unchanged" | "changed" | "recovered"
  deliveryId?: string
  cachedMessage?: string
}

export interface SanctuaryHealthSweep {
  (): Promise<SanctuaryHealthSweepResult>
}

const healthLockTails = new Map<string, Promise<void>>()
const healthLeaseBrand = Symbol("sanctuary-health-state-lease")
const activeHealthLeases = new Set<SanctuaryHealthStateLease>()

export interface SanctuaryHealthStateLease {
  readonly statePath: string
  readonly nonce: string
  readonly [healthLeaseBrand]: true
}

interface HealthLeaseOwner {
  schemaVersion: 1
  pid: number
  nonce: string
}

function healthLeaseOwner(value: unknown): HealthLeaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sanctuary health lease ownership is invalid")
  const owner = value as Partial<HealthLeaseOwner>
  if (JSON.stringify(Object.keys(owner).sort()) !== JSON.stringify(["nonce", "pid", "schemaVersion"])
    || owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1
    || typeof owner.nonce !== "string" || !/^[0-9a-f]{64}$/u.test(owner.nonce)) {
    throw new Error("Sanctuary health lease ownership is invalid")
  }
  return owner as HealthLeaseOwner
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

function removeHealthLeaseDirectory(leasePath: string): void {
  const entries = fs.readdirSync(leasePath, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || entry.name !== "owner.json")) throw new Error("Sanctuary health lease contains unexpected entries")
  if (entries.length === 1) fs.unlinkSync(path.join(leasePath, "owner.json"))
  fs.rmdirSync(leasePath)
}

async function acquireHealthFileLease(statePath: string, timeoutMs: number): Promise<SanctuaryHealthStateLease> {
  const leasePath = `${statePath}.lease`
  const ownerPath = path.join(leasePath, "owner.json")
  const deadline = Date.now() + timeoutMs
  const nonce = createHash("sha256").update(randomUUID()).digest("hex")
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  for (;;) {
    try {
      fs.mkdirSync(leasePath, { recursive: false, mode: 0o700 })
      fs.writeFileSync(ownerPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce })}\n`, { flag: "wx", mode: 0o600 })
      return { statePath, nonce, [healthLeaseBrand]: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try { if (fs.existsSync(leasePath) && !fs.existsSync(ownerPath)) fs.rmdirSync(leasePath) } catch { /* preserve the original failure */ }
        throw error
      }
      let owner: HealthLeaseOwner
      try { owner = healthLeaseOwner(JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown) }
      catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "ENOENT" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        if (ownerError instanceof Error && ownerError.message.includes("ownership is invalid")) throw ownerError
        throw new Error("Sanctuary health lease ownership is invalid", { cause: ownerError })
      }
      if (!processIsAlive(owner.pid)) {
        removeHealthLeaseDirectory(leasePath)
        continue
      }
      if (Date.now() >= deadline) throw new Error("Sanctuary health state lease timed out")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

function releaseHealthFileLease(lease: SanctuaryHealthStateLease): void {
  const leasePath = `${lease.statePath}.lease`
  const owner = healthLeaseOwner(JSON.parse(fs.readFileSync(path.join(leasePath, "owner.json"), "utf8")) as unknown)
  if (owner.nonce !== lease.nonce || owner.pid !== process.pid) throw new Error("Sanctuary health lease ownership changed")
  removeHealthLeaseDirectory(leasePath)
}

export async function withSanctuaryHealthStateLease<T>(
  statePath: string,
  operation: (lease: SanctuaryHealthStateLease) => Promise<T> | T,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const previous = healthLockTails.get(statePath) ?? Promise.resolve()
  let releaseProcess!: () => void
  const current = new Promise<void>((resolve) => { releaseProcess = resolve })
  healthLockTails.set(statePath, current)
  await previous
  let lease: SanctuaryHealthStateLease | undefined
  try {
    lease = await acquireHealthFileLease(statePath, options.timeoutMs ?? 30_000)
    activeHealthLeases.add(lease)
    return await operation(lease)
  } finally {
    if (lease) {
      activeHealthLeases.delete(lease)
      releaseHealthFileLease(lease)
    }
    releaseProcess()
    if (healthLockTails.get(statePath) === current) healthLockTails.delete(statePath)
  }
}

async function withHealthLock<T>(statePath: string, operation: () => Promise<T> | T, lease?: SanctuaryHealthStateLease): Promise<T> {
  if (lease) {
    if (lease.statePath !== statePath || !activeHealthLeases.has(lease) || lease[healthLeaseBrand] !== true) {
      throw new Error("Sanctuary health state lease is invalid")
    }
    return await operation()
  }
  return withSanctuaryHealthStateLease(statePath, async () => operation())
}

function load(filePath: string): HealthState {
  try {
    if (fs.statSync(filePath).size > MAX_HEALTH_STATE_BYTES) throw new Error("health state exceeds its bound")
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<HealthState>
    const validDelivery = (delivery: unknown): delivery is HealthDelivery => Boolean(
      delivery && typeof delivery === "object"
      && typeof (delivery as HealthDelivery).id === "string" && (delivery as HealthDelivery).id.length > 0 && (delivery as HealthDelivery).id.length <= 128
      && typeof (delivery as HealthDelivery).message === "string" && Buffer.byteLength((delivery as HealthDelivery).message) <= MAX_HEALTH_TEXT_BYTES
      && ["pending", "attempting"].includes((delivery as HealthDelivery).status)
      && canonicalIsoTimestamp((delivery as HealthDelivery).createdAt)
      && ((delivery as Partial<HealthDelivery>).kind === undefined || ["transition", "digest", "transition_and_digest", "legacy_unknown"].includes((delivery as HealthDelivery).kind))
      && ((delivery as HealthDelivery).summarizedMessage === undefined || (typeof (delivery as HealthDelivery).summarizedMessage === "string" && Buffer.byteLength((delivery as HealthDelivery).summarizedMessage!) <= MAX_HEALTH_TEXT_BYTES)),
    )
    if (!value.incidents || typeof value.incidents !== "object" || Array.isArray(value.incidents)) throw new Error("invalid incidents")
    if (value.lastDigestDay !== null && typeof value.lastDigestDay !== "string") throw new Error("invalid digest day")
    if (typeof value.updatedAt !== "string") throw new Error("invalid update time")
    if (value.outbox !== undefined && value.outbox !== null && !validDelivery(value.outbox)) throw new Error("invalid health outbox")
    if (value.indeterminateDeliveries !== undefined && (
      !Array.isArray(value.indeterminateDeliveries) || !value.indeterminateDeliveries.every(validDelivery)
    )) throw new Error("invalid indeterminate deliveries")
    if (value.deliveredReceipts !== undefined && (!Array.isArray(value.deliveredReceipts) || value.deliveredReceipts.length > 100 || !value.deliveredReceipts.every((receipt) => (
      receipt && typeof receipt.deliveryId === "string" && receipt.deliveryId.length > 0 && receipt.deliveryId.length <= 128 && canonicalIsoTimestamp(receipt.deliveredAt)
      && (receipt.kind === undefined || ["transition", "digest", "transition_and_digest", "legacy_unknown"].includes(receipt.kind))
      && Array.isArray(receipt.messageIds) && receipt.messageIds.length > 0 && receipt.messageIds.length <= 100
      && receipt.messageIds.every((id) => Number.isSafeInteger(id) && id > 0)
    )))) throw new Error("invalid delivered receipts")
    if (value.sweepReceipts !== undefined && (!Array.isArray(value.sweepReceipts) || value.sweepReceipts.length > 500 || !value.sweepReceipts.every((receipt) => (
      receipt && typeof receipt.sweepId === "string" && UUID_V4.test(receipt.sweepId)
      && canonicalIsoTimestamp(receipt.startedAt)
      && canonicalIsoTimestamp(receipt.completedAt)
      && /^[0-9a-f]{64}$/u.test(receipt.incidentDigest) && Number.isSafeInteger(receipt.opened) && receipt.opened >= 0
      && Number.isSafeInteger(receipt.recovered) && receipt.recovered >= 0 && typeof receipt.digestDue === "boolean"
      && (receipt.deliveryId === undefined || (typeof receipt.deliveryId === "string" && receipt.deliveryId.length > 0 && receipt.deliveryId.length <= 128))
      && (receipt.scenarioHandleDigest === undefined || /^[0-9a-f]{64}$/u.test(receipt.scenarioHandleDigest))
    )))) throw new Error("invalid sweep receipts")
    return {
      incidents: value.incidents as Record<string, Incident>,
      lastDigestDay: value.lastDigestDay,
      updatedAt: value.updatedAt,
      outbox: value.outbox ? { ...value.outbox, kind: value.outbox.kind ?? "legacy_unknown" } : null,
      indeterminateDeliveries: (value.indeterminateDeliveries ?? []).map((delivery) => ({ ...delivery, kind: delivery.kind ?? "legacy_unknown" })),
      deliveredReceipts: (value.deliveredReceipts ?? []).map((receipt) => ({ ...receipt, kind: receipt.kind ?? "legacy_unknown" })),
      sweepReceipts: value.sweepReceipts ?? [],
    }
  }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { incidents: {}, lastDigestDay: null, updatedAt: new Date(0).toISOString(), outbox: null, indeterminateDeliveries: [], deliveredReceipts: [], sweepReceipts: [] }
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
    for (let redirects = 0; ; redirects += 1) {
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
}

export function createSanctuaryHealthSweep(options: {
  toolContext: Pick<ToolContext, "sanctuary">
  statePath: string
  fetch?: typeof fetch
  now?: () => Date
  acceptanceEventMeta?: () => Record<string, string>
  lease?: SanctuaryHealthStateLease
}): SanctuaryHealthSweep {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const acceptanceEventMeta = options.acceptanceEventMeta ?? (() => sanctuaryAcceptanceEventMeta("sanctuary"))
  const runSweep = async (): Promise<SanctuaryHealthSweepResult> => {
    const sweepId = randomUUID()
    const startedAt = now().toISOString()
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_start", message: "Sanctuary deterministic health sweep started", meta: { statePath: options.statePath, ...acceptanceEventMeta() } })
    const pendingState = load(options.statePath)
    if (pendingState.outbox) {
      pendingState.outbox = null
      pendingState.indeterminateDeliveries = []
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
    const add = (id: string, rawSummary: string) => {
      const summary = boundedIncidentText(rawSummary)
      incidents.set(id, {
      id,
      summary,
      observationRevision: createHash("sha256").update(`${id}\0${summary}`).digest("hex"),
      })
    }
    const containers = record(containersResult)?.ok ? record(record(containersResult)?.data)?.containers : null
    if (!Array.isArray(containers)) add("containers:unavailable", "container status is unavailable")
    else for (const container of containers) {
      if ((container.autostart === true || REQUIRED_CONTAINERS.has(container.name)) && container.state !== "running") add(`container:${container.id}:availability`, `${container.name} is ${container.state}`)
      if (container.state === "unknown" || container.degraded === true) add(`container:${container.id}:health`, `${container.name} status is degraded`)
    }
    const storage = record(storageResult)?.ok ? record(record(storageResult)?.data) : null
    const array = record(storage?.array)
    if (!array || array.degraded || typeof array.usedPercent !== "number") add("storage:array:capacity", "array capacity is unavailable")
    else if (array.usedPercent >= 90) add("storage:array:capacity", `array usage is ${array.usedPercent}%`)
    for (const share of Array.isArray(storage?.shares) ? storage.shares : []) if (share.degraded || typeof share.usedPercent !== "number") add(`storage:share:${share.name}:capacity`, `${share.name} capacity is unavailable`); else if (share.usedPercent >= 90) add(`storage:share:${share.name}:capacity`, `${share.name} usage is ${share.usedPercent}%`)
    const disks = record(disksResult)?.ok ? record(record(disksResult)?.data) : null
    if (!disks) add("disks:unavailable", "disk health is unavailable")
    else {
      for (const disk of Array.isArray(disks.disks) ? disks.disks : []) {
        if (disk.smart !== "passed") add(`disk:${disk.id}:smart`, `${disk.name} SMART is ${disk.smart}`)
        if (typeof disk.temperatureC !== "number") add(`disk:${disk.id}:temperature`, `${disk.name} temperature is unavailable`)
        else if (disk.temperatureC >= 50) add(`disk:${disk.id}:temperature`, `${disk.name} is ${disk.temperatureC}°C`)
      }
      const parity = record(disks.parity)
      if (!parity || parity.result !== "success" || typeof parity.ageHours !== "number" || parity.ageHours >= 45 * 24) add("parity:stale-or-failed", "parity check is unsuccessful, unknown, or older than 45 days")
    }
    const notifications = record(notificationsResult)?.ok ? record(record(notificationsResult)?.data)?.unacknowledged : null
    if (!Array.isArray(notifications)) add("notifications:unavailable", "notification status is unavailable")
    else for (const item of notifications) add(`notification:${item.id}`, `unacknowledged notification: ${item.title || item.id}`)
    for (const endpoint of endpoints) if (!endpoint.ok) add(`endpoint:${endpoint.url}`, `${endpoint.url} returned ${endpoint.status || "no response"}`)

    const previous = load(options.statePath)
    const current = Object.fromEntries([...incidents.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, incident]) => {
      const prior = previous.incidents[id]
      const transition: NonNullable<Incident["transition"]> = !prior ? "opened" : prior.observationRevision === incident.observationRevision ? "unchanged" : "changed"
      return [id, { ...incident, transition }]
    }))
    const opened = Object.values(current).filter((incident) => !previous.incidents[incident.id])
    const changed = Object.values(current).filter((incident) => incident.transition === "changed")
    const recovered = Object.values(previous.incidents).filter((incident) => !current[incident.id])
    const acceptanceMeta = acceptanceEventMeta()
    const completedAt = now().toISOString()
    const incidentDigest = createHash("sha256").update(JSON.stringify(current)).digest("hex")
    const sweepReceipt = {
      sweepId,
      startedAt,
      completedAt,
      incidentDigest,
      opened: opened.length,
      recovered: recovered.length,
      digestDue: false,
      ...(acceptanceMeta.scenarioHandleDigest ? { scenarioHandleDigest: acceptanceMeta.scenarioHandleDigest } : {}),
    }
    const next: HealthState = {
      incidents: current,
      lastDigestDay: null,
      updatedAt: now().toISOString(),
      outbox: null,
      indeterminateDeliveries: [],
      deliveredReceipts: previous.deliveredReceipts,
      sweepReceipts: [...previous.sweepReceipts, sweepReceipt].slice(-500),
    }
    save(options.statePath, next)
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_end", message: "Sanctuary deterministic health sweep completed", meta: { incidentCount: incidents.size, opened: opened.length, recovered: recovered.length, digestDue: false, ...acceptanceEventMeta() } })
    const transition = changed.length > 0 || (opened.length > 0 && recovered.length > 0) ? "changed" : opened.length > 0 ? "opened" : recovered.length > 0 ? "recovered" : "unchanged"
    return { message: null, incidents: Object.values(current), recovered, observationRevision: incidentDigest, transition }
  }

  const sweep = (() => withHealthLock(options.statePath, runSweep, options.lease)) as SanctuaryHealthSweep

  return sweep
}
