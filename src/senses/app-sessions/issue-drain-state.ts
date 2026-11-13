import * as path from "node:path"
import type { IssueDrainConfig } from "../../heart/identity"
import { appSessionsStateDir, readJson } from "./store"

export interface IssueEvent {
  number: number
  title: string
  /** The issue's `updated_at` when the event was recorded. */
  updatedAt: string
}

export interface DrainState {
  /** False until the first successful poll, which records what is already open without waking anyone. */
  seeded: boolean
  /** Issue number → the `updated_at` already recorded as seen. */
  seen: Record<string, string>
  /** Recorded events the drain has not yet been told about. */
  pending: IssueEvent[]
  lastPollAt?: string
  openCount?: number
  lastWakeAt?: string
  lastWakeCount?: number
  lastError?: string
}


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
