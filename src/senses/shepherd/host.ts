import type { ShepherdConnection } from "../../heart/shepherd-config"
import { emitNervesEvent } from "../../nerves/runtime"
import { createCmuxClient } from "./client"
import { createCmuxHost } from "./cmux"
import { createHerdrHost } from "./herdr"

/**
 * The seam between Shepherd and a terminal host (cmux, Herdr). A host lists and reads terminal
 * sessions, types into them, shows a status line, and tells Shepherd when a coding agent handed
 * control back. Detection is the host's own knowledge (its hook events, its agent states, or a
 * quiet screen); judging the return is Shepherd's.
 */
export interface HostSession {
  /** The host's stable id for the terminal (cmux surface UUID, Herdr pane id). */
  id: string
  /** A short handle the agent can pass back (cmux `surface:12`, Herdr `w1:p2`). */
  ref: string
  workspace: string | null
  workspaceTitle?: string | null
  title: string
  tty?: string | null
  cwd?: string | null
  /** The coding agent running there, when the host knows it. */
  agent: string | null
  /** The human's current terminal: Shepherd never types into it. */
  focused: boolean
}

/** A coding agent stopped and is waiting for the human. `transitionId` is the host's own id for that stop. */
export interface ReturnedControl {
  sessionId: string
  transitionId: string
  agent: string | null
  cwd: string | null
  workspaceTitle?: string | null
  title?: string
  /** The host's own summary of the agent's last message, when it keeps one. */
  lastBody: string | null
  /** True when the host itself says the agent still has background work running (subagents, shells, watchers); null when it cannot tell. */
  backgroundWork: boolean | null
}

export interface HostWatchHandlers {
  returned: (event: ReturnedControl) => void
  /** The human focused this session. */
  focused: (sessionId: string) => void
}

/**
 * A key Shepherd may press in a menu. Text never goes into a menu, and keys never go anywhere else. Shepherd's own
 * judge never presses `ctrl-c`; only the human can, through `shepherd_send`.
 */
export type ShepherdKey = "enter" | "escape" | "up" | "down" | "tab" | "ctrl-c" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "y" | "n"

export interface ShepherdHost {
  name: string
  list(): Promise<HostSession[]>
  /** The screen tail with scrollback, plain text. */
  read(sessionId: string, lines: number): Promise<string>
  /** Types one line and submits it, so it cannot be mistaken for a paste or a keystroke. */
  prompt(sessionId: string, line: string): Promise<void>
  key(sessionId: string, key: ShepherdKey): Promise<void>
  /** Sets or clears (null) Shepherd's one-line status for the session, and optionally posts a notification. */
  signal(sessionId: string, status: string | null, notification?: { title: string; body: string }): Promise<void>
  /**
   * After a judgment, a host that found the return by watching for a quiet screen may check that terminal less often (slower)
   * or return to its normal pace. Hosts with their own stop signal ignore it.
   */
  pace?(sessionId: string, slower: boolean): void
  watch(handlers: HostWatchHandlers): { close(): void }
}

/** The host for this machine's connection. */
export function createShepherdHost(connection: ShepherdConnection, options: { agentName: string; now?: () => number; schedule?: (fn: () => void, ms: number) => () => void }): ShepherdHost {
  emitNervesEvent({ component: "senses", event: "senses.shepherd_host_created", message: "opened the Shepherd terminal host", meta: { host: connection.host } })
  return connection.host === "herdr"
    ? createHerdrHost(connection, { schedule: options.schedule })
    : createCmuxHost(createCmuxClient(connection, { agentName: options.agentName }), { now: options.now, schedule: options.schedule })
}
