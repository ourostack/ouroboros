import type { ShepherdConnection } from "../../heart/shepherd-config"
import { emitNervesEvent } from "../../nerves/runtime"
import { createCmuxClient } from "./client"
import { createCmuxHost } from "./cmux"
import { createHerdrHost } from "./herdr"
import type { ShepherdInputReceipt, ShepherdManagedIdentity, ShepherdManagedInputReceipt } from "../../heart/shepherd/custody-types"

/**
 * The seam between Shepherd and a terminal host (cmux, Herdr). A host lists and reads terminal
 * sessions, types into them, shows a status line, and tells Shepherd when a coding agent handed
 * control back. Detection is the host's own knowledge (its hook events, its agent states, or a
 * quiet screen); judging the return is Shepherd's.
 */
export interface HostSession {
  kind?: "terminal" | "agent_session"
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
  instance?: string | null
  /** The human's current terminal: Shepherd never types into it. */
  focused: boolean
  /** Advisory selection hint from the key window, never a permission to write. */
  selected?: boolean
}

export interface ShepherdInspection {
  session: HostSession
  instance: string | null
  screen: string
  /** Exact raw-screen digest; distinct from the judged-text custody key and human-send proof. */
  screenFingerprint: string
  activity: "idle" | "working" | "unknown"
  composer: "empty" | "draft" | "unknown"
  backgroundWork: boolean | null
  /** Native evidence is optional on observation-only and older hosts, never inferred. */
  guarded?: ShepherdGuardedObservation
  managed?: ShepherdManagedObservation
}

export const SHEPHERD_NATIVE_CAUSALITY_BLOCKER = "claude_native_input_attribution_unavailable"

export type ShepherdManagedCapabilities =
  | { state: "unqualified" | "qualified"; protocolVersion: 1; providers: ShepherdManagedIdentity["provider"][]; profiles: string[]; reason?: string }

export type ShepherdHostCapabilities = (
  | { state: "unsupported"; reason: string }
  | { state: "unqualified"; protocolVersion: 1; agents: string[]; reason?: string }
  | { state: "qualified"; protocolVersion: 1; agents: string[] }
) & { managed?: ShepherdManagedCapabilities }

export interface ShepherdManagedObservation {
  identity: ShepherdManagedIdentity
  eventRevision: string
  activityRevision: string
  renderFingerprint: string
  token: string | null
  expiresAtUnixMs: number | null
}

export interface ShepherdManagedInspection extends ShepherdInspection {
  session: HostSession & { kind: "agent_session"; cwd: string; tty: null }
  instance: string
  managed: ShepherdManagedObservation
  guarded?: never
}

/** Native UTC projection is advisory; the host enforces its own monotonic deadline. */
export interface ShepherdGuardedObservation {
  workspaceId: string
  hostInstance: string
  surfaceGeneration: number
  inputRevision: number
  focusRevision: number
  token: string | null
  expiresAtUnixMs: number | null
}

/** Ambiguous input throws; not_sent guarantees zero attempted terminal input. */
export interface GuardedPromptResult {
  state: "sent" | "not_sent"
  reason?: string
}

export interface ShepherdNativeInputReceipt extends ShepherdInputReceipt {
  hostInstance: string
  state: "accepted" | "not_sent" | "unknown"
  reason: string
}

export interface ShepherdManagedNativeInputReceipt extends ShepherdManagedInputReceipt {
  state: "accepted" | "not_sent" | "unknown"
  reason: string
}

export interface ShepherdContinuationRequest {
  requestId: string
  text: string
  expected: ShepherdInspection
}

export type ShepherdContinuationResult =
  | { state: "not_sent"; reason: string; receipt?: never }
  | { state: "sent" | "not_sent" | "unknown"; receipt: ShepherdNativeInputReceipt | ShepherdManagedNativeInputReceipt; reason?: string }

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
  /** Read-only inventory from the existing watcher, independent of the judgment queue. No screen payloads. */
  observed?: (observation: ShepherdHostObservation) => void
}

export interface ShepherdHostObservation {
  at: number
  sessions: Array<{
    session: HostSession
    activity: "working" | "idle" | "shell" | "unknown"
    observedAt: number | null
    error?: "read_failed"
  }>
  error?: "host_unavailable" | "sense_stopped"
}

/**
 * A key an explicit owner request may press through `shepherd_send`.
 * Automatic judgments never dispatch menu, navigation or control keys.
 */
export type ShepherdKey = "enter" | "escape" | "up" | "down" | "tab" | "ctrl-c" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "y" | "n"

export interface ShepherdHost {
  name: string
  list(): Promise<HostSession[]>
  /** Strict complete stable-terminal inventory. Sparse/malformed replies throw, never mean absence. */
  retirementInventory?(): Promise<string[]>
  /** The screen tail with scrollback, plain text. */
  read(sessionId: string, lines: number): Promise<string>
  inspect?(sessionId: string): Promise<ShepherdInspection>
  capabilities?(): Promise<ShepherdHostCapabilities>
  /** Native guarded operation only; no paste/key fallback. canSend runs after adapter awaits. */
  continueInput?(request: ShepherdContinuationRequest, canSend: () => boolean): Promise<ShepherdContinuationResult>
  /** Read-only retained receipt lookup; uses persisted identity, never a fresh input or inspection. */
  managedReceipt?(requestId: string, identity: ShepherdManagedIdentity): Promise<ShepherdManagedNativeInputReceipt>
  /** canSend is checked synchronously after adapter I/O, immediately before attempting input. */
  promptIfUnchanged?(sessionId: string, line: string, expected: ShepherdInspection, canSend?: () => boolean): Promise<GuardedPromptResult>
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
