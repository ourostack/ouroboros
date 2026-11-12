import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { OUTBOUND_ORIGINS, type OutboundOrigin } from "../heart/session-events"
import type { ProactiveTeamsSessionSendResult } from "./teams"
import { writeFileAtomicSync } from "../heart/atomic-file"

/**
 * Teams sends that a presence without the Teams sense hands to the machine that runs it. A non-owner writes one file
 * per message into `presence/outbox/` in the bundle, which git sync carries to the owner; the owner's Teams sense sends
 * each one and deletes it, and the next sync carries the deletion back. Only non-owners create files and only the owner
 * deletes them, so two machines never edit the same file.
 */
export const TEAMS_OUTBOX_VERSION = 1
/** Files sent per drain, so a backlog never holds the Teams sense for long. */
export const TEAMS_OUTBOX_MAX_PER_DRAIN = 20
export const TEAMS_OUTBOX_DRAIN_INTERVAL_MS = 30_000
/** A file that does not parse may still be arriving through a pull; it is quarantined only once it is this old. */
export const TEAMS_OUTBOX_SETTLE_MS = 60_000

export interface TeamsOutboxEntry {
  version: typeof TEAMS_OUTBOX_VERSION
  friendId: string
  key: string
  text: string
  intent?: "generic_outreach" | "explicit_cross_chat"
  origin: OutboundOrigin
  authorizingSession?: { friendId: string; channel: string; key: string; trustLevel?: string }
  fromMachineId: string
  createdAt: string
}

export type TeamsOutboxNewEntry = Omit<TeamsOutboxEntry, "version" | "createdAt">

export function teamsOutboxDir(agentRoot: string): string {
  return path.join(agentRoot, "presence", "outbox")
}

export function teamsOutboxFailedDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "outbox-failed")
}

/** Writes one forwarded send; the temp file lives under the ignored `state/`, so a crash never leaves one for sync. */
export function writeTeamsOutboxEntry(agentRoot: string, entry: TeamsOutboxNewEntry, nowMs: number): string {
  const record: TeamsOutboxEntry = { version: TEAMS_OUTBOX_VERSION, ...entry, createdAt: new Date(nowMs).toISOString() }
  const body = `${JSON.stringify(record, null, 2)}\n`
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8)
  const name = `${nowMs}-${entry.fromMachineId.replace(/[^\w.-]/g, "_")}-${hash}.json`
  const dir = teamsOutboxDir(agentRoot)
  const target = path.join(dir, name)
  writeFileAtomicSync(target, body, { temporaryDirectory: path.join(agentRoot, "state", "outbox-tmp") })
  return target
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function parseTeamsOutboxEntry(value: unknown): TeamsOutboxEntry | null {
  if (!isRecord(value) || value.version !== TEAMS_OUTBOX_VERSION) return null
  const { friendId, key, text, intent, origin, authorizingSession, fromMachineId, createdAt } = value
  if (!nonEmpty(friendId) || !nonEmpty(key) || !nonEmpty(text) || !nonEmpty(fromMachineId) || !nonEmpty(createdAt)) return null
  if (!OUTBOUND_ORIGINS.includes(origin as OutboundOrigin)) return null
  if (intent !== undefined && intent !== "generic_outreach" && intent !== "explicit_cross_chat") return null
  const entry: TeamsOutboxEntry = { version: TEAMS_OUTBOX_VERSION, friendId, key, text, origin: origin as OutboundOrigin, fromMachineId, createdAt }
  if (intent) entry.intent = intent
  if (authorizingSession !== undefined) {
    if (!isRecord(authorizingSession) || !nonEmpty(authorizingSession.friendId) || !nonEmpty(authorizingSession.channel) || !nonEmpty(authorizingSession.key)) return null
    const { trustLevel } = authorizingSession
    if (trustLevel !== undefined && typeof trustLevel !== "string") return null
    entry.authorizingSession = {
      friendId: authorizingSession.friendId,
      channel: authorizingSession.channel,
      key: authorizingSession.key,
      ...(trustLevel !== undefined ? { trustLevel } : {}),
    }
  }
  return entry
}

export interface TeamsOutboxSendRequest {
  friendId: string
  key: string
  text: string
  origin: OutboundOrigin
  intent?: "generic_outreach" | "explicit_cross_chat"
  authorizingSession?: TeamsOutboxEntry["authorizingSession"]
}

/** Sends one entry from this machine; null when this machine has no Teams client right now. */
export type TeamsOutboxSend = (request: TeamsOutboxSendRequest) => Promise<ProactiveTeamsSessionSendResult | null>

export interface TeamsOutboxDrainOptions {
  max?: number
  now?: () => number
}

export interface TeamsOutboxDrainResult {
  delivered: number
  quarantined: number
  kept: number
}

/** Teams refused these for good: sending again would fail the same way. */
const PERMANENT_REASONS = new Set<ProactiveTeamsSessionSendResult["reason"]>(["missing_target", "friend_not_found", "trust_skip", "internal_content_blocked"])

function quarantine(agentRoot: string, name: string, reason: string, friendId?: string): void {
  const failedDir = teamsOutboxFailedDir(agentRoot)
  fs.mkdirSync(failedDir, { recursive: true })
  fs.renameSync(path.join(teamsOutboxDir(agentRoot), name), path.join(failedDir, name))
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.teams_outbox_quarantined",
    message: "a forwarded Teams message cannot be sent; moved it out of the outbox",
    meta: { file: name, reason, ...(friendId ? { friendId } : {}) },
  })
}

async function drainOnce(agentRoot: string, send: TeamsOutboxSend, options: TeamsOutboxDrainOptions): Promise<TeamsOutboxDrainResult> {
  const result: TeamsOutboxDrainResult = { delivered: 0, quarantined: 0, kept: 0 }
  const dir = teamsOutboxDir(agentRoot)
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
  } catch {
    return result
  }
  const max = options.max ?? TEAMS_OUTBOX_MAX_PER_DRAIN
  const now = options.now ?? Date.now
  result.kept = Math.max(0, names.length - max)
  for (const [index, name] of names.slice(0, max).entries()) {
    const file = path.join(dir, name)
    let entry: TeamsOutboxEntry | null
    try {
      entry = parseTeamsOutboxEntry(JSON.parse(fs.readFileSync(file, "utf-8")))
    } catch {
      entry = null
    }
    if (!entry) {
      if (now() - fs.statSync(file).mtimeMs < TEAMS_OUTBOX_SETTLE_MS) {
        result.kept++
        continue
      }
      quarantine(agentRoot, name, "unreadable")
      result.quarantined++
      continue
    }
    let sent: ProactiveTeamsSessionSendResult | null
    try {
      sent = await send({
        friendId: entry.friendId,
        key: entry.key,
        text: entry.text,
        origin: entry.origin,
        ...(entry.intent ? { intent: entry.intent } : {}),
        ...(entry.authorizingSession ? { authorizingSession: entry.authorizingSession } : {}),
      })
    } catch (error) {
      // One message that throws must not hold back the rest.
      result.kept++
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.teams_outbox_send_error",
        message: "sending a forwarded Teams message threw; keeping it for the next drain",
        meta: { file: name, friendId: entry.friendId, error: errorText(error) },
      })
      continue
    }
    if (!sent) {
      // No Teams client here now; every remaining file would wait for the same reason.
      result.kept += Math.min(max, names.length) - index
      break
    }
    if (sent.delivered) {
      fs.rmSync(file, { force: true })
      result.delivered++
      emitNervesEvent({
        component: "senses",
        event: "senses.teams_outbox_delivered",
        message: "sent a Teams message another presence forwarded here",
        meta: { friendId: entry.friendId, fromMachineId: entry.fromMachineId },
      })
      continue
    }
    if (PERMANENT_REASONS.has(sent.reason)) {
      quarantine(agentRoot, name, sent.reason!, entry.friendId)
      result.quarantined++
      continue
    }
    result.kept++
  }
  return result
}

/** Sends what other presences forwarded, oldest first. Never throws: whatever is left waits for the next drain. */
export async function drainTeamsOutbox(agentRoot: string, send: TeamsOutboxSend, options: TeamsOutboxDrainOptions = {}): Promise<TeamsOutboxDrainResult | null> {
  try {
    return await drainOnce(agentRoot, send, options)
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.teams_outbox_drain_error",
      message: "draining the forwarded Teams messages failed; retrying on the next drain",
      meta: { error: errorText(error) },
    })
    return null
  }
}

/** Drains now and then on an interval, one drain at a time. Returns a stop function. */
export function startTeamsOutboxDrain(agentRoot: string, send: TeamsOutboxSend, intervalMs: number = TEAMS_OUTBOX_DRAIN_INTERVAL_MS): () => void {
  let running = false
  const run = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await drainTeamsOutbox(agentRoot, send)
    } finally {
      running = false
    }
  }
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
