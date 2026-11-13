import * as path from "node:path"
import type { IssueDrainConfig } from "../../heart/identity"
import { appSessionsStateDir, readJson } from "./store"

export interface IssueEvent {
  number: number
  title: string
  /** The issue's `updated_at` when the event was recorded. */
  updatedAt: string
}

/** The revision of an issue the drain was last told about, or last chose to ignore. */
export interface SeenIssue {
  /** The issue's `updated_at` when it was recorded: the watermark for comments and events that happened after. */
  updatedAt: string
  /** Digest of the title and body, so an edit shows even when the poll missed the comment or event around it. */
  digest?: string
  /** The trailer keys left out of `digest` (comma-joined). A digest made with other keys is not comparable. */
  ignored?: string
  /** Epoch ms when the issue left the open list. Its record stays, so a closed issue that comes back unchanged is not new. */
  goneAt?: number
}

export interface DrainState {
  /** False until the first successful poll, which records what is already open without waking anyone. */
  seeded: boolean
  /** Issue number → the revision already recorded as seen. A bare string is the `updated_at` an older version stored. */
  seen: Record<string, SeenIssue | string>
  /** Recorded events the drain has not yet been told about. */
  pending: IssueEvent[]
  lastPollAt?: string
  openCount?: number
  lastWakeAt?: string
  lastWakeCount?: number
  lastError?: string
}

export const seenIssue = (entry: SeenIssue | string | undefined): SeenIssue | undefined => typeof entry === "string" ? { updatedAt: entry } : entry

export const drainStateFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "issue-drains.json")

export function readDrainStates(agentRoot: string): Record<string, DrainState> {
  return readJson<Record<string, DrainState>>(drainStateFile(agentRoot), {})
}

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return minutes < 1 ? "just now" : minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

/** One `ouro status` line per drain: its last poll, open issues, events waiting, last wake and last error. */
export function drainStatusLines(drains: IssueDrainConfig[], states: Record<string, DrainState>, now: number): string[] {
  return drains.map(drain => {
    const state = states[drain.repo]
    const head = `issue drain ${drain.repo} -> ${drain.session.slice(0, 8)}`
    if (!state?.lastPollAt) return `${head}: not polled yet`
    const wake = state.lastWakeAt ? `${ago(state.lastWakeAt, now)} (${state.lastWakeCount} issue${state.lastWakeCount === 1 ? "" : "s"})` : "never"
    return `${head}: polled ${ago(state.lastPollAt, now)}, ${state.openCount ?? "?"} open, ${state.pending.length} waiting, last wake ${wake}${state.lastError ? `, last error: ${state.lastError}` : ""}`
  })
}
