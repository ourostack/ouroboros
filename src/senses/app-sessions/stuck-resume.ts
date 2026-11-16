import { emitNervesEvent } from "../../nerves/runtime"
import { deliverMessage, type Asked } from "./app-interface"
import { eventLogSize, type AppSessionRow, type AppSessionsOptions } from "./client"
import type { DigestState } from "./digest"

/**
 * A session whose loop stopped (not running, its last turn called tools and no next turn started) is something an
 * agent can fix, so the sense fixes it rather than asking the owner: it sends the session one message to carry on, once
 * per stop, and the digest shows it under what was fixed. A session asleep for over a day, one whose history is over
 * 500 MB (the app loads all of it on resume) or a remote one is left alone, and a session that keeps stopping is resumed
 * at most three times a day; past that it stays under "Broken" in the digest.
 */
export const RESUME_MAX_IDLE_MS = 24 * 3_600_000
export const RESUME_MAX_LOG_BYTES = 500 * 1024 * 1024
export const RESUMES_PER_DAY = 3
export const RESUME_TEXT = "Your loop stopped: your last turn ended without finishing and no next turn started. Carry on where you left off. Re-check anything that was in flight (a shell command, a subagent, a send or a push) before relying on it."

export interface ResumeEntry {
  name: string
  /** The stop this resume answered: the session's last activity then. */
  lastActivity: string | null
  at: string
  ok: boolean
  /** When each resume of the last day went out. */
  times: string[]
}

export type SendResume = (id: string, text: string) => Promise<Asked>

/** Whether the app lists this session as stopped mid-loop, rather than hung while running. */
const loopStopped = (row: AppSessionRow): boolean => row.state === "stuck" && !row.isRunning && !row.remote && !row.awaiting

/** Resumes every session whose loop stopped since it was last resumed. Returns how many it resumed. */
export async function resumeStuck(rows: AppSessionRow[], state: DigestState, now: number, deps: { client?: AppSessionsOptions; send?: SendResume } = {}): Promise<number> {
  const send = deps.send ?? ((id: string, text: string) => deliverMessage(id, text, "immediate", deps.client))
  const resumed = (state.resumed ??= {})
  for (const [id, entry] of Object.entries(resumed)) {
    entry.times = entry.times.filter(at => now - Date.parse(at) < 24 * 3_600_000)
    if (!entry.times.length) delete resumed[id]
  }
  let count = 0
  for (const row of rows) {
    if (!loopStopped(row)) continue
    const last = Date.parse(row.lastActivity ?? "")
    if (Number.isNaN(last) || now - last > RESUME_MAX_IDLE_MS) continue
    if (eventLogSize(row.id, deps.client) > RESUME_MAX_LOG_BYTES) continue
    const before = resumed[row.id]
    if (before?.lastActivity === row.lastActivity) continue
    if ((before?.times.length ?? 0) >= RESUMES_PER_DAY) continue
    const asked = await send(row.id, RESUME_TEXT).catch((error: Error): Asked => ({ ok: false, frame: null, error: error.message }))
    const at = new Date(now).toISOString()
    resumed[row.id] = { name: row.name, lastActivity: row.lastActivity, at, ok: asked.ok, times: [...(before?.times ?? []), at] }
    if (asked.ok) count += 1
    emitNervesEvent({ level: asked.ok ? "info" : "warn", component: "senses", event: "senses.app_sessions_stuck_resumed", message: asked.ok ? "resumed a session whose loop had stopped" : "could not resume a session whose loop had stopped", meta: { session: row.id, ok: asked.ok, ...(asked.error ? { error: asked.error } : {}) } })
  }
  return count
}
