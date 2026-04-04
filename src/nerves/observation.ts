/**
 * Nerves observation layer — shared typed readers for runtime state.
 *
 * This module re-exports domain types that multiple consumers need
 * (Outlook, CLI, agent tools) so they don't maintain parallel type universes.
 *
 * The Outlook UI consumes these through the HTTP API, but the same
 * observation functions back CLI commands and future native clients.
 */

// Domain types re-exported for shared observation
export type { UsageData, SessionContinuityState } from "../mind/context"
export type { CodingSession, CodingSessionStatus, CodingRunner, CodingSessionOrigin, CodingFailureDiagnostics } from "../repertoire/coding/types"
export type { BridgeRecord, BridgeSessionRef, BridgeTaskLink } from "../heart/bridges/store"
export type { DaemonHealthState, DegradedComponent, AgentHealth, HabitHealth, SafeModeState } from "../heart/daemon/daemon-health"
export type { LogEvent, LogLevel } from "./index"
export type { HabitFile, HabitStatus } from "../heart/daemon/habit-parser"
export type { AttentionItem } from "../heart/attention-types"
export type { PendingMessage } from "../mind/pending"
export type { TaskStatus } from "../repertoire/tasks/types"
export type { RuntimeMetadata } from "../heart/daemon/runtime-metadata"
export type { SessionActivityRecord } from "../heart/session-activity"

/* v8 ignore start — module-level observability event */
import { emitNervesEvent } from "./runtime"

emitNervesEvent({
  component: "nerves",
  event: "nerves.observation_loaded",
  message: "observation layer loaded",
  meta: {},
})
/* v8 ignore stop */
