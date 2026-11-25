import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonHealthResult } from "./daemon"
import type { DaemonSenseRow } from "./sense-manager"

/**
 * Tells the owner when the channel they hear their agent on has been down for a while, over a channel that still works.
 *
 * On 2026-11-25 Slugger's iMessage (the BlueBubbles sense) was in error for 13 hours and nobody heard: the health alert
 * only logged and restarted the sense, and the owner notice either went to Telegram (off for Slugger) or was queued for
 * Slugger to relay over iMessage, the channel that was down. This watcher runs in the daemon after every health check.
 * When an enabled owner channel has been in error for longer than `OWNER_OUTAGE_THRESHOLD_MS`, it sends one alert over
 * the agent's other healthy owner channels, then its mail sense, and one "back" message when the channel recovers. Its
 * state is kept in the bundle's `state/`, so a daemon restart neither re-sends nor forgets an outage.
 */

/** Senses the owner hears their agent on, in the order a fallback alert tries them. */
export const OWNER_CHANNEL_SENSES = ["bluebubbles", "telegram", "teams"] as const
export type OwnerChannelSense = typeof OWNER_CHANNEL_SENSES[number]
export type OwnerAlertRoute = OwnerChannelSense | "mail"

/**
 * How long a channel must stay down before the owner hears about it: 15 minutes, the same bar the Telegram sense uses
 * before telling the owner its owner route is down (`OWNER_ROUTE_WATCH_FAILURES` x `OWNER_ROUTE_WATCH_INTERVAL_MS`).
 * It is long enough that the daemon's own restart (the next 60-second health check) and the BlueBubbles proof watch's
 * first restart (10 minutes of stale proof) get their chance first, and short enough that the owner hears within the
 * quarter hour, not after 13 hours.
 */
export const OWNER_OUTAGE_THRESHOLD_MS = 15 * 60_000
/** At most one outage alert per channel an hour, so a flapping channel never floods the fallback channel. */
export const OWNER_OUTAGE_ALERT_MIN_INTERVAL_MS = 60 * 60_000
/** After every route failed, wait this long before trying again. */
export const OWNER_OUTAGE_RETRY_MS = 5 * 60_000
/**
 * A channel must read healthy this long before its outage ends, so a sense that crash-loops or flaps between health
 * checks is still one outage, and the owner hears "back" only once it has stayed up (two more 60-second checks).
 */
export const OWNER_OUTAGE_RECOVERY_CONFIRM_MS = 2 * 60_000
/**
 * A gap this long between two sightings of an outage that hasn't been told yet means the daemon couldn't see (the Mac
 * slept or the daemon was stopped), so the outage's clock starts again rather than counting time nobody watched.
 */
export const OWNER_OUTAGE_SIGHTING_GAP_MS = 10 * 60_000
/** One route's send that takes longer than this counts as failed, so a hung network call never stops the watcher. */
export const OWNER_OUTAGE_SEND_TIMEOUT_MS = 60_000

/** Statuses a channel can carry an alert on. */
const HEALTHY_STATUSES = new Set(["running", "interactive", "ready"])
/** Statuses that mean the channel itself is back (a process is running), so the owner hears "back". */
const RECOVERED_STATUSES = new Set(["running", "interactive"])
const DETAIL_MAX = 300

const CHANNEL_LABEL: Record<OwnerChannelSense, string> = { bluebubbles: "iMessage", telegram: "Telegram", teams: "Teams" }

export interface OwnerAlertMessage {
  /** Stable per outage and kind, so a route that dedupes by id sends it once. */
  noticeId: string
  subject: string
  text: string
}

/** Sends one message to the owner on its route; throws when it was not sent. */
export type OwnerAlertSend = (message: OwnerAlertMessage) => Promise<void>

interface ChannelOutage {
  downSince: string
  detail: string
  alertedAt?: string
  alertedVia?: OwnerAlertRoute
  lastAttemptAt?: string
  /** The last pass that saw it down. */
  lastSeenDownAt?: string
  /** Since when it has read healthy, while the outage waits for `OWNER_OUTAGE_RECOVERY_CONFIRM_MS`. */
  healthySince?: string
}

interface OwnerOutageState {
  schemaVersion: 1
  outages: Partial<Record<OwnerChannelSense, ChannelOutage>>
  /** When each channel's last outage alert went out; kept after recovery for the rate limit. */
  lastAlertAt: Partial<Record<OwnerChannelSense, string>>
}

export interface OwnerChannelOutageWatcherOptions {
  agents: () => string[]
  listSenseRows: () => DaemonSenseRow[]
  /** Where an agent's watcher state is kept. */
  statePath: (agent: string) => string
  /** The routes this daemon can send an agent's alert on. A route without a sender is skipped. */
  routes: (agent: string) => Partial<Record<OwnerAlertRoute, OwnerAlertSend>>
  /** The name the owner knows the agent by. */
  displayName?: (agent: string) => string
  now?: () => number
  thresholdMs?: number
  minIntervalMs?: number
  retryMs?: number
  recoveryConfirmMs?: number
  sightingGapMs?: number
  sendTimeoutMs?: number
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyState(): OwnerOutageState {
  return { schemaVersion: 1, outages: {}, lastAlertAt: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readState(file: string): OwnerOutageState {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {
    return emptyState()
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.outages) || !isRecord(parsed.lastAlertAt)) return emptyState()
  return parsed as unknown as OwnerOutageState
}

function writeState(agent: string, file: string, state: OwnerOutageState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
    fs.renameSync(temp, file)
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.owner_outage_state_write_failed",
      message: "could not save the owner-channel outage state; a restart may repeat an alert",
      meta: { agent, error: errorText(error) },
    })
  }
}

/** "4 min", "2 h 14 min", "13 h". */
export function formatOutageDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function plainDetail(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim()
  return flat.length <= DETAIL_MAX ? flat : `${flat.slice(0, DETAIL_MAX - 1).trimEnd()}…`
}

export function outageAlertMessage(input: { agent: string; name: string; sense: OwnerChannelSense; downSince: string; detail: string; nowMs: number }): OwnerAlertMessage {
  const channel = CHANNEL_LABEL[input.sense]
  const duration = formatOutageDuration(input.nowMs - Date.parse(input.downSince))
  const detail = plainDetail(input.detail)
  return {
    noticeId: `owner-channel-outage:${input.agent}:${input.sense}:${input.downSince}:down`,
    subject: `${input.name}: ${channel} has been down for ${duration}`,
    text: [
      `${input.name} can't reach you on ${channel}: it has been down for ${duration}.`,
      ...(detail ? [`What the daemon sees: ${detail}`] : []),
      `It keeps trying to bring ${channel} back, and you'll get one more message here when it is.`,
      `Messages you send ${input.name} on ${channel} may not arrive until then.`,
    ].join("\n"),
  }
}

/** `nowMs` is when it first read healthy again. */
export function outageRecoveredMessage(input: { agent: string; name: string; sense: OwnerChannelSense; downSince: string; nowMs: number }): OwnerAlertMessage {
  const channel = CHANNEL_LABEL[input.sense]
  const duration = formatOutageDuration(input.nowMs - Date.parse(input.downSince))
  return {
    noticeId: `owner-channel-outage:${input.agent}:${input.sense}:${input.downSince}:back`,
    subject: `${input.name}: ${channel} is back`,
    text: `${input.name} can reach you on ${channel} again, after ${duration} down.`,
  }
}

export class OwnerChannelOutageWatcher {
  private readonly options: OwnerChannelOutageWatcherOptions
  private readonly now: () => number
  private readonly thresholdMs: number
  private readonly minIntervalMs: number
  private readonly retryMs: number
  private readonly recoveryConfirmMs: number
  private readonly sightingGapMs: number
  private readonly sendTimeoutMs: number
  private running: Promise<void> | null = null
  /** Each agent's state, read from disk once; memory stays the authority when a write fails. */
  private readonly states = new Map<string, OwnerOutageState>()

  constructor(options: OwnerChannelOutageWatcherOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.thresholdMs = options.thresholdMs ?? OWNER_OUTAGE_THRESHOLD_MS
    this.minIntervalMs = options.minIntervalMs ?? OWNER_OUTAGE_ALERT_MIN_INTERVAL_MS
    this.retryMs = options.retryMs ?? OWNER_OUTAGE_RETRY_MS
    this.recoveryConfirmMs = options.recoveryConfirmMs ?? OWNER_OUTAGE_RECOVERY_CONFIRM_MS
    this.sightingGapMs = options.sightingGapMs ?? OWNER_OUTAGE_SIGHTING_GAP_MS
    this.sendTimeoutMs = options.sendTimeoutMs ?? OWNER_OUTAGE_SEND_TIMEOUT_MS
  }

  /** One pass over every agent's owner channels. A pass still sending makes this one a no-op. */
  check(results: DaemonHealthResult[]): Promise<void> {
    if (this.running) return this.running
    this.running = this.checkAll(results).finally(() => { this.running = null })
    return this.running
  }

  private async checkAll(results: DaemonHealthResult[]): Promise<void> {
    const rows = this.options.listSenseRows()
    for (const agent of this.options.agents()) {
      try {
        await this.checkAgent(agent, rows.filter((row) => row.agent === agent), results)
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.owner_outage_check_failed",
          message: "could not check this agent's owner channels",
          meta: { agent, error: errorText(error) },
        })
      }
    }
  }

  private down(agent: string, row: DaemonSenseRow, results: DaemonHealthResult[]): string | null {
    if (row.status === "error") return row.detail || row.lastFailure || "the sense is in error"
    // The BlueBubbles proof watch: the listener is alive but its sync loop has stopped.
    if (row.sense === "bluebubbles") {
      const probe = results.find((result) => result.name === `sense-probe:bluebubbles-proof:${agent}` && result.status === "critical")
      if (probe) return probe.message
      // A listener that has never written proof never trips the proof watch's staleness check, so it reads "running".
      if (row.status === "running" && !row.lastProofAt) return "the iMessage listener is running but has never shown that it is connected to BlueBubbles"
    }
    return null
  }

  private async checkAgent(agent: string, rows: DaemonSenseRow[], results: DaemonHealthResult[]): Promise<void> {
    const file = this.options.statePath(agent)
    let state = this.states.get(agent)
    if (!state) {
      state = readState(file)
      this.states.set(agent, state)
    }
    const nowMs = this.now()
    const nowIso = new Date(nowMs).toISOString()
    const name = (): string => this.options.displayName?.(agent) ?? agent
    let changed = false

    const rowFor = (sense: string): DaemonSenseRow | undefined => rows.find((row) => row.sense === sense && row.enabled)
    const downNow = new Map<OwnerChannelSense, string>()
    for (const sense of OWNER_CHANNEL_SENSES) {
      const row = rowFor(sense)
      const detail = row ? this.down(agent, row, results) : null
      if (detail !== null) downNow.set(sense, detail)
    }
    // Routes that work now: another owner channel that is up, then mail.
    const senders = this.options.routes(agent)
    const workingRoutes = (except: OwnerChannelSense): Array<[OwnerAlertRoute, OwnerAlertSend]> => {
      const list: Array<[OwnerAlertRoute, OwnerAlertSend]> = []
      for (const sense of OWNER_CHANNEL_SENSES) {
        const row = rowFor(sense)
        const send = senders[sense]
        if (sense !== except && send && row && HEALTHY_STATUSES.has(row.status) && !downNow.has(sense)) list.push([sense, send])
      }
      if (senders.mail && rowFor("mail")) list.push(["mail", senders.mail])
      return list
    }

    for (const sense of OWNER_CHANNEL_SENSES) {
      const detail = downNow.get(sense)
      const outage = state.outages[sense]
      if (detail !== undefined) {
        const current: ChannelOutage = outage ?? { downSince: nowIso, detail }
        if (!outage) {
          state.outages[sense] = current
          changed = true
          emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.owner_outage_started", message: "an owner channel is down; the owner hears if it stays down", meta: { agent, sense, thresholdMs: this.thresholdMs } })
        }
        if (current.detail !== detail) current.detail = detail
        // Unseen time is not counted: the clock of an outage not yet told restarts after a gap in sightings.
        if (!current.alertedAt && current.lastSeenDownAt && nowMs - Date.parse(current.lastSeenDownAt) > this.sightingGapMs) current.downSince = nowIso
        current.lastSeenDownAt = nowIso
        delete current.healthySince
        changed = true
        if (current.alertedAt) continue
        if (nowMs - Date.parse(current.downSince) < this.thresholdMs) continue
        const lastAlert = state.lastAlertAt[sense]
        if (lastAlert && nowMs - Date.parse(lastAlert) < this.minIntervalMs) continue
        if (current.lastAttemptAt && nowMs - Date.parse(current.lastAttemptAt) < this.retryMs) continue
        current.lastAttemptAt = nowIso
        changed = true
        const via = await this.deliver(agent, sense, "down", workingRoutes(sense), outageAlertMessage({ agent, name: name(), sense, downSince: current.downSince, detail, nowMs }))
        if (via) {
          current.alertedAt = nowIso
          current.alertedVia = via
          state.lastAlertAt[sense] = nowIso
        }
        continue
      }
      if (!outage) continue
      const row = rowFor(sense)
      const status = row?.status ?? "disabled"
      // Turned off, moved to another machine, or waiting on setup rather than recovered: nothing to wait for.
      const gone = !row || !HEALTHY_STATUSES.has(status)
      if (!gone && (outage.alertedAt ? RECOVERED_STATUSES.has(status) : true)) {
        if (!outage.healthySince) {
          outage.healthySince = nowIso
          changed = true
        }
        if (nowMs - Date.parse(outage.healthySince) < this.recoveryConfirmMs) continue
      } else if (!gone) {
        // Told, and configured but with no process yet: "back" waits until it is running.
        continue
      }
      if (!outage.alertedAt || gone) {
        delete state.outages[sense]
        changed = true
        emitNervesEvent({
          level: outage.alertedAt ? "warn" : "info",
          component: "daemon",
          event: "daemon.owner_outage_cleared",
          message: outage.alertedAt ? "an owner channel the owner was told is down stopped being watched before it came back" : "an owner channel outage ended before the owner needed to hear",
          meta: { agent, sense, alerted: Boolean(outage.alertedAt), status },
        })
        continue
      }
      // The alert's own attempt time no longer applies; the retry wait now spaces "back" attempts.
      if (outage.lastAttemptAt && Date.parse(outage.lastAttemptAt) > Date.parse(outage.alertedAt) && nowMs - Date.parse(outage.lastAttemptAt) < this.retryMs) continue
      outage.lastAttemptAt = nowIso
      changed = true
      // Where the owner heard about the outage goes first, so the alert and its close sit together; the recovered
      // channel itself is the last resort.
      const routes = workingRoutes(sense)
      const own = senders[sense]
      if (own) routes.push([sense, own])
      routes.sort(([a], [b]) => Number(b === outage.alertedVia) - Number(a === outage.alertedVia))
      // Kept until "back" is sent, so a failed send is tried again.
      if (await this.deliver(agent, sense, "back", routes, outageRecoveredMessage({ agent, name: name(), sense, downSince: outage.downSince, nowMs: Date.parse(outage.healthySince!) }))) delete state.outages[sense]
    }

    if (changed) writeState(agent, file, state)
  }

  /** Tries each route in order; the route that sent it, or null. */
  private async deliver(agent: string, sense: OwnerChannelSense, kind: "down" | "back", routes: Array<[OwnerAlertRoute, OwnerAlertSend]>, message: OwnerAlertMessage): Promise<OwnerAlertRoute | null> {
    const failures: string[] = []
    for (const [route, send] of routes) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${this.sendTimeoutMs} ms`)), this.sendTimeoutMs) })
        try {
          await Promise.race([send(message), timeout])
        } finally {
          clearTimeout(timer)
        }
        emitNervesEvent({ level: kind === "down" ? "warn" : "info", component: "daemon", event: "daemon.owner_outage_alert_sent", message: kind === "down" ? "told the owner an owner channel is down" : "told the owner an owner channel is back", meta: { agent, sense, kind, route, failedRoutes: failures } })
        return route
      } catch (error) {
        failures.push(`${route}: ${errorText(error)}`)
      }
    }
    emitNervesEvent({ level: "error", component: "daemon", event: "daemon.owner_outage_alert_undelivered", message: routes.length === 0 ? "no working route to tell the owner an owner channel changed" : "every route failed to tell the owner an owner channel changed", meta: { agent, sense, kind, failures } })
    return null
  }
}
