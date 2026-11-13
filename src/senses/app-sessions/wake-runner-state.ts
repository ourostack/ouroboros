import * as path from "node:path"
import type { WakeRunnerConfig } from "../../heart/identity"
import { appSessionsStateDir, readJson } from "./store"

// What a wake runner leaves on disk and how `ouro status` shows it. Kept apart from the runner so the daemon can read it
// without loading the app client and its WebSocket library.

export interface WakeRunnerState {
  lastRunAt?: string
  lastWakes?: number
  lastDelivered?: number
  lastError?: string
  /** The command's own status lines from its last good run. */
  status?: string[]
}

export const wakeRunnerStateFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "wake-runners.json")
export const readWakeRunnerStates = (agentRoot: string): Record<string, WakeRunnerState> => readJson<Record<string, WakeRunnerState>>(wakeRunnerStateFile(agentRoot), {})

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return minutes < 1 ? "just now" : minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

/** One `ouro status` line per runner (last run, wakes delivered, last error), then the lines its command reported. */
export function wakeRunnerStatusLines(runners: WakeRunnerConfig[], states: Record<string, WakeRunnerState>, now: number): string[] {
  return runners.flatMap(runner => {
    const state = states[runner.name]
    if (!state?.lastRunAt) return [`wake runner ${runner.name}: not run yet`]
    const delivered = state.lastWakes === undefined ? "" : `, ${state.lastDelivered}/${state.lastWakes} wake${state.lastWakes === 1 ? "" : "s"} delivered`
    return [`wake runner ${runner.name}: ran ${ago(state.lastRunAt, now)}${delivered}${state.lastError ? `, last error: ${state.lastError}` : ""}`, ...(state.status ?? [])]
  })
}
