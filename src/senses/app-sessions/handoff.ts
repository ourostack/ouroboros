import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { eventLogPath, readNewAppEvents, type AppSessionRow, type AppSessionsOptions } from "./client"
import { appSessionsStateDir, readJson, writeJson } from "./store"

/**
 * Who succeeds whom. A session that takes over another's job says so in its first message: the contract is a line of its
 * own, `Succeeds: <predecessor session id>`, within the message's first 16 KB. Kickoffs written before that line existed
 * are read too, when "successor to" or "successor of" opens the message and is followed closely by a session id, for
 * example `the successor to "desk epoch 3" (cfb84353-…)` or `the fresh successor to session 2fa5297c`.
 *
 * The first message sits after the start-up hooks' events, tens of KB into the history, so each history is read forward
 * at most 1 MB until its first message, once; after that only for the successor's first finished turn.
 */
export const SUCCEEDS_LINE = "Succeeds:"
const STRUCTURED = /^[ \t>*_`]*Succeeds:[ \t*_`]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/im
const FREE_TEXT = /\bsuccessor (?:to|of)\b/gi
const SESSION_ID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/i
/** How much of the first message is read for the line. */
export const MESSAGE_HEAD_CHARS = 16_384
/** The free-text wording counts only where the message opens, and the id only close after it. */
const FREE_TEXT_OPENING_CHARS = 2_000
const FREE_TEXT_ID_WINDOW = 240
/** How far into a history the first message is looked for, and the most read per pass while waiting for the first turn. */
export const FIRST_MESSAGE_SCAN_BYTES = 1024 * 1024
/** Histories untouched this long are not read for a first message (an old one cannot hand off a live session). */
const RECENT_MS = 7 * 86_400_000

export interface Succession {
  /** The session this one succeeds, or null when its first message names none. */
  predecessor: string | null
  marker?: "structured" | "free-text"
  /** When the first message was sent. */
  at?: string
  /** The successor has finished a turn since its first message. */
  turned?: true
  /** How far its history has been read. */
  offset: number
  /** Still looking for the first message. */
  pending?: true
}
type Successions = Record<string, Succession>

const stateFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "successions.json")
export const readSuccessions = (agentRoot: string): Successions => readJson<{ sessions: Successions }>(stateFile(agentRoot), { sessions: {} }).sessions

/** The session a first message says it succeeds: the `Succeeds:` line, else the older wording. `known` resolves a short id. */
export function namedPredecessor(message: string, self: string, known: (idOrPrefix: string) => string | null): { predecessor: string; marker: "structured" | "free-text" } | null {
  const head = message.slice(0, MESSAGE_HEAD_CHARS)
  const line = STRUCTURED.exec(head)?.[1]?.toLowerCase()
  if (line && line !== self) return { predecessor: line, marker: "structured" }
  const opening = head.slice(0, FREE_TEXT_OPENING_CHARS)
  for (const phrase of opening.matchAll(FREE_TEXT)) {
    const after = head.slice(phrase.index + phrase[0].length, phrase.index + phrase[0].length + FREE_TEXT_ID_WINDOW)
    const id = SESSION_ID.exec(after)?.[0]?.toLowerCase()
    const resolved = id ? known(id) : null
    if (resolved && resolved !== self) return { predecessor: resolved, marker: "free-text" }
  }
  return null
}

const sessionsRoot = (client: AppSessionsOptions): string => path.dirname(path.dirname(eventLogPath("x", client)))

function historyIds(client: AppSessionsOptions): string[] {
  try {
    return fs.readdirSync(sessionsRoot(client)).filter(name => /^[0-9a-f-]{36}$/i.test(name))
  } catch {
    return []
  }
}

/** Read what is new in each recent history, as far as succession needs, and remember it. Returns every succession known. */
export function refreshSuccessions(agentRoot: string, client: AppSessionsOptions, now: number = Date.now()): Successions {
  const before = readSuccessions(agentRoot)
  const ids = historyIds(client)
  const known = (value: string): string | null => {
    const matches = ids.filter(id => id.toLowerCase().startsWith(value))
    return matches.length === 1 ? matches[0]! : null
  }
  const next: Successions = {}
  for (const id of ids) {
    const was = before[id]
    if (was && !was.pending && (!was.predecessor || was.turned)) {
      next[id] = was
      continue
    }
    let modified: number
    try {
      modified = fs.statSync(eventLogPath(id, client)).mtimeMs
    } catch {
      continue
    }
    if (!was && now - modified > RECENT_MS) continue
    const entry: Succession = was ? { ...was } : { predecessor: null, offset: 0, pending: true }
    let message: { text: string; at?: string } | null = null
    let turned = false
    const read = readNewAppEvents(id, entry.offset, FIRST_MESSAGE_SCAN_BYTES, event => {
      if (event.agentId !== undefined) return
      const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {}
      if (entry.pending && !message && event.type === "user.message" && typeof data.content === "string") message = { text: data.content, ...(typeof event.timestamp === "string" ? { at: event.timestamp } : {}) }
      else if ((message || !entry.pending) && event.type === "assistant.turn_end") turned = true
    }, client)
    entry.offset = read.offset
    if (entry.pending) {
      const first = message as { text: string; at?: string } | null
      if (first) {
        delete entry.pending
        const named = namedPredecessor(first.text, id, known)
        Object.assign(entry, named ?? {}, first.at ? { at: first.at } : {})
      } else if (entry.offset >= FIRST_MESSAGE_SCAN_BYTES) delete entry.pending
    }
    if (entry.predecessor && turned) entry.turned = true
    next[id] = entry
  }
  writeJson(stateFile(agentRoot), { sessions: next })
  return next
}

/** The newest session that took over `id`'s job, following the chain of hand-offs to the live end; null when none did. */
export function successorOf(id: string, successions: Successions): string | null {
  // The newest claim wins when two sessions name the same predecessor.
  const direct = (of: string): string | null => {
    let newest: { id: string; at: number } | null = null
    for (const [claimant, entry] of Object.entries(successions)) {
      const at = Date.parse(String(entry.at)) || 0
      if (entry.predecessor === of && (!newest || at > newest.at)) newest = { id: claimant, at }
    }
    return newest?.id ?? null
  }
  let current = id
  const seen = new Set([id])
  for (let later = direct(current); later; later = direct(current)) {
    // Sessions that claim to succeed each other own nothing for certain, so none of them is retired.
    if (seen.has(later)) return null
    seen.add(later)
    current = later
  }
  return current === id ? null : current
}

/**
 * Whether an oversize session has been handed off: it is in the oversize list, and a newer session's first message
 * names it as the session it succeeds.
 */
export function isHandedOff(agentRoot: string, row: Pick<AppSessionRow, "id">, options: AppSessionsOptions = {}): boolean {
  const flagged = readJson<{ sessions?: Record<string, unknown> }>(path.join(appSessionsStateDir(agentRoot), "oversize.json"), {}).sessions ?? {}
  if (!flagged[row.id]) return false
  const successor = successorOf(row.id, refreshSuccessions(agentRoot, options))
  if (successor) emitNervesEvent({ component: "senses", event: "senses.app_sessions_handoff_found", message: "found the successor that a session was handed off to", meta: { session: row.id, successor } })
  return successor !== null
}
