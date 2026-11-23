// Claude Code stop hook — checks the agent's pending queue and returns
// any messages as additionalContext for injection into the next turn.
//
// This is how the agent answers back into a dev tool session: a held return
// surfaced to the MCP session that asked (or a send_message to it) lands in
// that session's pending queue, and the stop hook injects it as context. An
// unprompted surface never lands here: it goes to a chat the person reads.

import { drainPending, getPendingDir } from "../mind/pending"
import { emitNervesEvent } from "../nerves/runtime"

export interface StopHookInput {
  agentName: string
  friendId: string
  sessionId: string
}

export interface StopHookResult {
  /** If non-empty, inject this as additionalContext in the Claude Code session. */
  additionalContext: string
}

/**
 * Check the pending queue for messages from the agent to this dev tool session.
 * Returns accumulated message text as additionalContext.
 */
export async function handleStopHook(input: StopHookInput): Promise<StopHookResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.stop_hook_check_start",
    message: "checking pending queue for stop hook",
    meta: { agentName: input.agentName, friendId: input.friendId, sessionId: input.sessionId },
  })

  try {
    const pendingDir = getPendingDir(input.agentName, input.friendId, "mcp", input.sessionId)
    const pending = drainPending(pendingDir)

    if (pending.length === 0) {
      return { additionalContext: "" }
    }

    const text = pending.map((m) => m.content).join("\n\n---\n\n")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.stop_hook_check_end",
      message: "pending messages found for stop hook",
      meta: { agentName: input.agentName, count: pending.length },
    })

    return { additionalContext: text }
  } catch {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.stop_hook_check_error",
      message: "error checking pending queue in stop hook",
      meta: { agentName: input.agentName },
    })
    return { additionalContext: "" }
  }
}
