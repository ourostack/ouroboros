/**
 * Nerves observation layer — shared typed readers for runtime state.
 *
 * This module re-exports domain types that multiple consumers need
 * (CLI, agent tools, native clients) so they don't maintain parallel type
 * universes.
 */

// Domain types re-exported for shared observation
export type { UsageData, SessionContinuityState } from "../mind/context"
export type { CodingSession, CodingSessionStatus, CodingRunner, CodingSessionOrigin, CodingFailureDiagnostics } from "../repertoire/coding/types"
export type { BridgeRecord, BridgeSessionRef, BridgeTaskLink } from "../heart/bridges/store"
export type { DaemonHealthState, DegradedComponent, AgentHealth, HabitHealth, SafeModeState, DaemonStatus, RollupStatus } from "../heart/daemon/daemon-health"
export type { LogEvent, LogLevel } from "./index"
export type { HabitFile, HabitStatus } from "../heart/habits/habit-parser"
export type { AttentionItem } from "../arc/attention-types"
export type { PendingMessage } from "../mind/pending"
export type { TaskStatus } from "../arc/task-lifecycle"
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
