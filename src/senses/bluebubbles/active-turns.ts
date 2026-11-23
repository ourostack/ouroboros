import * as fs from "node:fs"
import * as path from "node:path"
import { sanitizeKey } from "../../heart/config"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesNormalizedMessage } from "./model"

/** A reply waiting this long for permission to send counts as a stalled turn. */
export const BLUEBUBBLES_DELIVERY_ADMISSION_STALLED_MS = 60_000

export interface BlueBubblesActiveTurnEntry {
  turnId: string
  pid: number
  startedAt: string
  lastVisibleActivityAt?: string
  /** Set while the reply has waited over a minute for permission to send. */
  admissionWaitingSince?: string
  messageGuid: string
  sessionKey: string
  chatGuid: string | null
  chatIdentifier: string | null
}

export interface BlueBubblesActiveTurnSnapshot {
  activeTurnCount: number
  stalledTurnCount: number
  admissionStalledTurnCount: number
  oldestAdmissionWaitAgeMs?: number
  oldestActiveTurnStartedAt?: string
  oldestActiveTurnAgeMs?: number
}

function activeTurnsDir(agentName: string): string {
  return path.join(getAgentRoot(agentName), "state", "senses", "bluebubbles", "active-turns")
}

function activeTurnPath(agentName: string, turnId: string): string {
  return path.join(activeTurnsDir(agentName), `${sanitizeKey(turnId)}.json`)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseActiveTurn(raw: string): BlueBubblesActiveTurnEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BlueBubblesActiveTurnEntry>
    if (!parsed.turnId || !parsed.messageGuid || !parsed.sessionKey || !parsed.startedAt) return null
    if (typeof parsed.pid !== "number") return null
    return {
      turnId: parsed.turnId,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      lastVisibleActivityAt: typeof parsed.lastVisibleActivityAt === "string"
        ? parsed.lastVisibleActivityAt
        : undefined,
      admissionWaitingSince: typeof parsed.admissionWaitingSince === "string"
        ? parsed.admissionWaitingSince
        : undefined,
      messageGuid: parsed.messageGuid,
      sessionKey: parsed.sessionKey,
      chatGuid: parsed.chatGuid ?? null,
      chatIdentifier: parsed.chatIdentifier ?? null,
    }
  } catch {
    return null
  }
}

export function beginBlueBubblesActiveTurn(agentName: string, event: BlueBubblesNormalizedMessage): string {
  const turnId = `${event.chat.sessionKey}:${event.messageGuid}:${process.pid}`
  const entry: BlueBubblesActiveTurnEntry = {
    turnId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    messageGuid: event.messageGuid,
    sessionKey: event.chat.sessionKey,
    chatGuid: event.chat.chatGuid ?? null,
    chatIdentifier: event.chat.chatIdentifier ?? null,
  }
  const filePath = activeTurnPath(agentName, turnId)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + "\n", "utf-8")
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_active_turn_write_error",
      message: "failed to record active bluebubbles turn",
      meta: {
        agentName,
        messageGuid: event.messageGuid,
        sessionKey: event.chat.sessionKey,
        /* v8 ignore next -- filesystem writes throw Error instances; stringify guard is defensive @preserve */
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
  return turnId
}

export function noteBlueBubblesActiveTurnVisibleActivity(agentName: string, turnId: string): void {
  updateActiveTurn(agentName, turnId, (entry) => ({ ...entry, lastVisibleActivityAt: new Date().toISOString() }))
}

/** Marks (or, with null, clears) a turn whose reply is stuck waiting for permission to send. */
export function noteBlueBubblesActiveTurnAdmissionWait(
  agentName: string,
  turnId: string,
  waitingSince: string | null,
): void {
  updateActiveTurn(agentName, turnId, ({ admissionWaitingSince: _cleared, ...entry }) => (
    waitingSince ? { ...entry, admissionWaitingSince: waitingSince } : entry
  ))
}

function updateActiveTurn(
  agentName: string,
  turnId: string,
  update: (entry: BlueBubblesActiveTurnEntry) => BlueBubblesActiveTurnEntry,
): void {
  const filePath = activeTurnPath(agentName, turnId)
  let entry: BlueBubblesActiveTurnEntry | null = null
  try {
    entry = parseActiveTurn(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return
  }
  if (!entry) return
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify(update(entry), null, 2) + "\n",
      "utf-8",
    )
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_active_turn_write_error",
      message: "failed to update active bluebubbles turn",
      meta: {
        agentName,
        turnId,
        /* v8 ignore next -- filesystem writes throw Error instances; stringify guard is defensive @preserve */
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

export function finishBlueBubblesActiveTurn(agentName: string, turnId: string): void {
  try {
    fs.unlinkSync(activeTurnPath(agentName, turnId))
  } catch {
    // Missing active-turn files are harmless: this is best-effort telemetry.
  }
}

export function listBlueBubblesActiveTurns(agentName: string): BlueBubblesActiveTurnEntry[] {
  let files: string[]
  try {
    files = fs.readdirSync(activeTurnsDir(agentName)).filter((name) => name.endsWith(".json")).sort()
  } catch {
    return []
  }

  const entries: BlueBubblesActiveTurnEntry[] = []
  for (const file of files) {
    const filePath = path.join(activeTurnsDir(agentName), file)
    let entry: BlueBubblesActiveTurnEntry | null = null
    try {
      entry = parseActiveTurn(fs.readFileSync(filePath, "utf-8"))
    } catch {
      entry = null
    }
    if (!entry) {
      try { fs.unlinkSync(filePath) } catch { /* ignore corrupt cleanup races */ }
      continue
    }
    if (!isPidAlive(entry.pid)) {
      try { fs.unlinkSync(filePath) } catch { /* ignore stale cleanup races */ }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_active_turn_pruned",
        message: "pruned stale bluebubbles active-turn marker",
        meta: {
          agentName,
          messageGuid: entry.messageGuid,
          sessionKey: entry.sessionKey,
          pid: entry.pid,
        },
      })
      continue
    }
    entries.push(entry)
  }
  return entries
}

export function snapshotBlueBubblesActiveTurns(
  agentName: string,
  stalledAfterMs: number,
  nowMs = Date.now(),
): BlueBubblesActiveTurnSnapshot {
  const entries = listBlueBubblesActiveTurns(agentName)
  const started = entries
    .map((entry) => ({ value: entry.startedAt, ms: Date.parse(entry.startedAt) }))
    .filter((entry): entry is { value: string; ms: number } => Number.isFinite(entry.ms))
    .sort((left, right) => left.ms - right.ms)
  const oldest = started[0]
  const admissionWaitAges = entries
    .map((entry) => nowMs - Date.parse(entry.admissionWaitingSince ?? ""))
    .filter((ageMs) => Number.isFinite(ageMs) && ageMs >= BLUEBUBBLES_DELIVERY_ADMISSION_STALLED_MS)
  const stalledTurns = entries.filter((entry) => {
    const startedMs = Date.parse(entry.startedAt)
    const waitingMs = Date.parse(entry.admissionWaitingSince ?? "")
    return (Number.isFinite(startedMs) && nowMs - startedMs >= stalledAfterMs)
      || (Number.isFinite(waitingMs) && nowMs - waitingMs >= BLUEBUBBLES_DELIVERY_ADMISSION_STALLED_MS)
  })
  return {
    activeTurnCount: entries.length,
    stalledTurnCount: stalledTurns.length,
    admissionStalledTurnCount: admissionWaitAges.length,
    ...(admissionWaitAges.length > 0 ? { oldestAdmissionWaitAgeMs: Math.max(...admissionWaitAges) } : {}),
    oldestActiveTurnStartedAt: oldest?.value,
    oldestActiveTurnAgeMs: oldest ? Math.max(0, nowMs - oldest.ms) : undefined,
  }
}
