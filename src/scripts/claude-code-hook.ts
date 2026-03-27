// Claude Code lifecycle hook handler.
// Receives events from Claude Code's hooks system (SessionStart, Stop, PostToolUse)
// and forwards them to the Ouroboros daemon for agent awareness.
//
// This module exports handleHookEvent for testability.
// The actual hook scripts (scripts/claude-code-hook.js) read stdin and call this.

import { sendDaemonCommand, DEFAULT_DAEMON_SOCKET_PATH } from "../heart/daemon/socket-client"
import { emitNervesEvent } from "../nerves/runtime"

export interface HookEvent {
  event: string
  sessionId?: string
  toolName?: string
  [key: string]: unknown
}

export interface HookResult {
  exitCode: number
}

/**
 * Handle a Claude Code lifecycle hook event.
 * Sends the event to the daemon and always exits 0 (hooks must not block the IDE).
 */
export async function handleHookEvent(hookEvent: HookEvent): Promise<HookResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.hook_event_received",
    message: "claude code hook event received",
    meta: { hookEvent: hookEvent.event, sessionId: hookEvent.sessionId },
  })

  try {
    await sendDaemonCommand(DEFAULT_DAEMON_SOCKET_PATH, {
      kind: "hook.event",
      event: hookEvent.event,
      sessionId: hookEvent.sessionId,
      toolName: hookEvent.toolName,
    } as any)
  } catch {
    // Daemon unavailable — silently ignore. Hooks must not block.
    emitNervesEvent({
      component: "daemon",
      event: "daemon.hook_event_daemon_unavailable",
      message: "daemon unavailable for hook event",
      meta: { hookEvent: hookEvent.event },
    })
  }

  return { exitCode: 0 }
}
