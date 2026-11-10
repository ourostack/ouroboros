import * as fs from "node:fs"
import * as path from "node:path"
import { openDatabase, type SqliteDatabase } from "../../heart/sqlite"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Why Shepherd leaves a stopped Copilot app session alone. A session that is waiting on something
 * other than its human (a schedule, a lane it coordinates, a reply it asked for) is not stalled,
 * and one Shepherd already nudged since its human last wrote is not nudged again. Every reason
 * comes from the app's own records, so it holds across daemon restarts and across machines.
 */

/** A coordinated session that moved this recently still counts as live work. */
export const CHILD_RECENT_MS = 2 * 3_600_000

/** Tools that hand work to another session, whose answer the caller then waits for. */
export const HANDOFF_TOOLS = new Set([
  "send_session_message", "create_session", "write_agent", "open_pr_session", "open_issue_session", "fork_session", "run_dynamic_workflow",
])

/** What the agent says when it is waiting on something other than its human. */
const WAITING_WORDS = new RegExp([
  String.raw`\b(?:i'?m|i am|we'?re|still|now|currently|just)\s+(?:waiting|holding)\b`,
  String.raw`\bwaiting\s+(?:on|for|until)\b`,
  String.raw`\b(?:i'?ll|i will|will|going to)\s+(?:wait|hold|check back|report back|pick (?:it|this) up)\b`,
  String.raw`\b(?:until|once|when)\s+(?:it|they|that|those|the \w+|#\d+|\w+'s \w+)\s+(?:lands?|merges?|finish(?:es)?|repl(?:y|ies)|reports?|returns?|completes?|comes? back|is (?:in|done|merged|green))\b`,
  String.raw`\bbackground (?:agents?|tasks?|lanes?|work|shells?|jobs?)\b`,
  String.raw`\blanes? (?:is|are) (?:running|working|under ?way)\b`,
  String.raw`\bon hold\b`,
].join("|"), "i")

export interface ConversationFacts {
  /** When the human last messaged the session, in epoch ms. */
  humanAt: number | null
  /** When Shepherd last messaged the session, in epoch ms. */
  shepherdAt: number | null
  /** Top-level tools the agent called since the last message it received. */
  lastTurnTools: string[]
}

function hasTable(db: SqliteDatabase, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function columns(db: SqliteDatabase, table: string): Set<string> {
  return new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(row => row.name))
}

interface ChildRow { id: string; title: string | null; is_running: number | null; updated_at: string | null }

/** The app database's reasons to leave the session alone, or null. A database that exists but cannot be read holds. */
export function databaseHold(stateDir: string, sessionId: string, now: number): string | null {
  const file = path.join(stateDir, "data.db")
  if (!fs.existsSync(file)) return null
  let db: SqliteDatabase
  try {
    db = openDatabase(file, { readonly: true, fileMustExist: true, timeout: 3_000 })
  } catch (error) {
    return `the Copilot app database could not be read (${String(error).slice(0, 120)})`
  }
  try {
    if (hasTable(db, "session_automations")) {
      const automation = db.prepare(`SELECT name FROM session_automations
        WHERE (session_id = ? OR owner_session_id = ?) AND paused_at IS NULL LIMIT 1`).get(sessionId, sessionId) as { name: string | null } | undefined
      if (automation) return `it has a session automation${automation.name ? ` ("${automation.name}")` : ""}, which wakes it on schedule`
    }
    const children: ChildRow[] = []
    if (hasTable(db, "workspaces") && hasTable(db, "sessions")) {
      const has = columns(db, "workspaces")
      const by = ["creator_session_id", "coordinating_creator_session_id"].filter(column => has.has(column))
      if (by.length > 0) {
        children.push(...db.prepare(`SELECT s.id, s.title, s.is_running, s.updated_at FROM workspaces w JOIN sessions s ON s.id = w.session_id
          WHERE w.archived_at IS NULL AND s.id != ? AND (${by.map(column => `w.${column} = ?`).join(" OR ")})`).all(sessionId, ...by.map(() => sessionId)) as ChildRow[])
      }
    }
    if (hasTable(db, "chat_parent_links") && hasTable(db, "sessions")) {
      const has = columns(db, "chat_parent_links")
      const by = ["parent_session_id", "coordinating_creator_session_id"].filter(column => has.has(column))
      if (by.length > 0) {
        children.push(...db.prepare(`SELECT s.id, s.title, s.is_running, s.updated_at FROM chat_parent_links c JOIN sessions s ON s.id = c.session_id
          WHERE s.archived_at IS NULL AND s.id != ? AND (${by.map(column => `c.${column} = ?`).join(" OR ")})`).all(sessionId, ...by.map(() => sessionId)) as ChildRow[])
      }
    }
    const live = children.filter(child => child.is_running === 1 || now - Date.parse(child.updated_at ?? "") < CHILD_RECENT_MS)
    if (live.length > 0) {
      const named = live.slice(0, 3).map(child => child.title ? `"${child.title.slice(0, 60)}"` : child.id.slice(0, 8)).join(", ")
      return `it coordinates ${live.length} live session${live.length === 1 ? "" : "s"} (${named}${live.length > 3 ? ", …" : ""}) and waits on them`
    }
    return null
  } catch (error) {
    return `the Copilot app database could not be read (${String(error).slice(0, 120)})`
  } finally {
    db.close()
  }
}

/** Why Shepherd must not nudge this stopped session, or null when it may judge it. */
export function copilotAppHold(stateDir: string, sessionId: string, facts: ConversationFacts, lastBody: string | null, now: number): string | null {
  const reason = holdReason(stateDir, sessionId, facts, lastBody, now)
  emitNervesEvent({ component: "senses", event: "senses.shepherd_copilot_app_hold", message: reason ? "Shepherd holds off a stopped Copilot app session" : "no hold on a stopped Copilot app session",
    meta: { session: sessionId.slice(0, 8), held: reason !== null } })
  return reason
}

function holdReason(stateDir: string, sessionId: string, facts: ConversationFacts, lastBody: string | null, now: number): string | null {
  if (facts.shepherdAt !== null && (facts.humanAt === null || facts.humanAt < facts.shepherdAt)) {
    return "Shepherd already nudged it once since its human last wrote; one nudge per stall"
  }
  const handoff = facts.lastTurnTools.find(tool => HANDOFF_TOOLS.has(tool))
  if (handoff) return `its last turn handed work to another session (${handoff}), so it is waiting on that reply`
  if (lastBody && WAITING_WORDS.test(lastBody)) return "its last message says it is waiting on something other than its human"
  return databaseHold(stateDir, sessionId, now)
}
