import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { plain } from "../shepherd/owner-notice"
import { deliverMessage, type Asked } from "./app-interface"
import { eventLogSize, type AppSessionRow, type AppSessionsOptions } from "./client"
import { appSessionsStateDir, readJson, writeJson } from "./store"
import type { NotifyOwner } from "./waiting-prompts"

/**
 * A session's event log is loaded whole into memory when the app resumes it, and a log of several GB (almost all of it
 * inline images) has frozen the machine. The snapshot already lists every session each minute, so this is deterministic
 * and costs no model turn: a session whose `events.jsonl` passes the limit is flagged never-resume, and its coordinator
 * (or the session itself when it has none) is asked once to hand it off to a fresh successor. A session that is not running
 * and has no smaller coordinator is not messaged, because the message would reload it; the owner is told instead.
 */
export const OVERSIZE_BYTES = 500 * 1024 * 1024

export interface OversizeEntry {
  bytes: number
  name: string
  /** When the nudge went out (or the owner was told). Never repeated for the same session. */
  nudgedAt?: string
  to?: string
}
interface OversizeState { sessions: Record<string, OversizeEntry> }

const stateFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "oversize.json")
export const readOversize = (agentRoot: string): Record<string, OversizeEntry> => readJson<OversizeState>(stateFile(agentRoot), { sessions: {} }).sessions

/** The ids of sessions flagged never-resume: a resume path asks this before it wakes one. */
export const neverResume = (agentRoot: string): string[] => Object.keys(readOversize(agentRoot))

const mb = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`

export function handoffNudge(name: string, bytes: number): string {
  return `The session "${plain(name, 60)}" has a ${mb(bytes)} history, over the ${mb(OVERSIZE_BYTES)} limit: the app loads all of it into memory every time that session resumes, and a few like it froze this Mac. Please hand it off before it grows: write a checkpoint of its purpose and open work, start a fresh successor session that reads that checkpoint plus the tail of the old log, then archive the old one. Keep images out of chat (save screenshots and art as files and link the path): inline images are nearly all of the size.`
}

export interface SizeWatchDeps {
  notify: NotifyOwner
  now: number
  size?: (id: string) => number
  send?: (id: string, text: string) => Promise<Asked>
  client?: AppSessionsOptions
}

/** Flag every over-limit session and nudge each once. Returns the number nudged (or owner-told) this run. */
export async function noticeOversizedSessions(agentRoot: string, rows: AppSessionRow[], deps: SizeWatchDeps): Promise<number> {
  const size = deps.size ?? ((id: string) => eventLogSize(id, deps.client))
  const send = deps.send ?? ((id: string, text: string) => deliverMessage(id, text, "enqueue", deps.client))
  const before = readOversize(agentRoot)
  const sizes = new Map(rows.filter(row => !row.remote).map(row => [row.id, size(row.id)]))
  const big = rows.filter(row => (sizes.get(row.id) ?? 0) > OVERSIZE_BYTES)
  const bigIds = new Set(big.map(row => row.id))
  const next: Record<string, OversizeEntry> = {}
  let nudged = 0
  const ownerLines: string[] = []
  for (const row of big) {
    const bytes = sizes.get(row.id)!
    const entry: OversizeEntry = { ...before[row.id], bytes, name: row.name }
    next[row.id] = entry
    if (entry.nudgedAt) continue
    const parent = rows.find(other => other.id === row.coordinatingCreatorSessionId)
    const recipient = parent && !bigIds.has(parent.id) ? parent.id : row.isRunning ? row.id : null
    if (recipient) {
      const sent = await send(recipient, handoffNudge(row.name, bytes)).catch((error: Error): Asked => ({ ok: false, frame: null, error: error.message }))
      if (!sent.ok) continue
      entry.nudgedAt = new Date(deps.now).toISOString()
      entry.to = recipient
      nudged += 1
    } else {
      // Not in memory and no smaller coordinator: any message would reload gigabytes, so the owner is told instead.
      ownerLines.push(`- "${plain(row.name, 60)}" (${mb(bytes)})`)
      entry.to = "owner"
    }
  }
  if (ownerLines.length) {
    const outcome = await deps.notify(`These sessions have histories over ${mb(OVERSIZE_BYTES)} and cannot be nudged without reloading them. They need a hand-off to a fresh successor session (checkpoint, tail, archive); keep images out of chat:\n${ownerLines.join("\n")}`, big.filter(row => next[row.id]!.to === "owner").map(row => `oversize:${row.id}`))
    if (outcome !== "pending") for (const row of big) if (next[row.id]!.to === "owner") { next[row.id]!.nudgedAt = new Date(deps.now).toISOString(); nudged += 1 }
  }
  writeJson(stateFile(agentRoot), { sessions: next } satisfies OversizeState)
  if (nudged) emitNervesEvent({ component: "senses", event: "senses.app_sessions_oversize_nudge", message: "asked for a hand-off of Copilot app sessions whose history is over the limit", meta: { sessions: nudged } })
  return nudged
}
