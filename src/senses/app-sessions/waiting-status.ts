import type { SenseSnapshot } from "./store"
import { SNAPSHOT_STALE_MS } from "./store"

/** The daemon reads this to print `ouro status`, so it stays free of the sense process's heavier imports. */
const STATUS_LIST_MAX = 8

export function ageLabel(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`
}

const flat = (value: string, max: number): string => {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** `ouro status` lines for the open prompts, oldest first. A stale or failed snapshot shows none: its summary already says so. */
export function waitingStatusLines(snapshot: SenseSnapshot | null, now: number): string[] {
  if (!snapshot || snapshot.error || now - Date.parse(snapshot.at) > SNAPSHOT_STALE_MS) return []
  const open = [...(snapshot.waitingPrompts ?? [])].sort((a, b) => a.since - b.since)
  const lines = open.slice(0, STATUS_LIST_MAX).map(prompt => `waiting on you: ${prompt.session.slice(0, 8)} (${flat(prompt.name, 60)}) for ${ageLabel(now - prompt.since)}: ${flat(prompt.what, 120)}`)
  return open.length > STATUS_LIST_MAX ? [...lines, `waiting on you: and ${open.length - STATUS_LIST_MAX} more`] : lines
}

