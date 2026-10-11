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
  title: string
  /** The coding agent running there, when the host knows it. */
  agent: string | null
}

/** A coding agent stopped and is waiting for the human. `transitionId` is the host's own id for that stop. */
export interface ReturnedControl {
  sessionId: string
  transitionId: string
  agent: string | null
  cwd: string | null
  /** The host's own summary of the agent's last message, when it keeps one. */
  lastBody: string | null
}

export interface HostWatchHandlers {
  returned: (event: ReturnedControl) => void
  /** The human focused this session. */
  focused: (sessionId: string) => void
}

/** A key Shepherd may press in a menu. Text never goes into a menu, and keys never go anywhere else. */
export type ShepherdKey = "enter" | "escape" | "up" | "down" | "tab" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "y" | "n"

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
  watch(handlers: HostWatchHandlers): { close(): void }
}
