import { resolveSessionPath } from "../heart/config";
import { createBridgeManager, formatBridgeStatus } from "../heart/bridges/manager";
import { emitNervesEvent } from "../nerves/runtime";
import {
  summarizeSessionTail,
  type SessionTailOptions,
  type SessionTailResult,
} from "../heart/session-transcript";
import { withCode, type ToolDefinition } from "./tools-base";

const NO_SESSION_FOUND_MESSAGE = "no session found for that friend/channel/key combination."
const EMPTY_SESSION_MESSAGE = "session exists but has no non-system messages."

async function summarizeSessionTailSafely(options: SessionTailOptions): Promise<SessionTailResult | { kind: "missing" }> {
  try {
    return await summarizeSessionTail(options)
  } catch (error) {
    if (options.summarize) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.session_tail_summary_summary_fallback",
        message: "session tail summarization failed; using raw transcript",
        meta: {
          friendId: options.friendId,
          channel: options.channel,
          key: options.key,
          /* v8 ignore next -- branch: String(error) fallback only for non-Error throws @preserve */
          error: error instanceof Error ? error.message : String(error),
        },
      })
      try {
        return await summarizeSessionTail({
          ...options,
          summarize: undefined,
        })
      } catch {
        return { kind: "missing" }
      }
    }
    return { kind: "missing" }
  }
}

export const bridgeToolDefinitions: ToolDefinition[] = [
  // -- cross-session awareness --
  {
    tool: {
      type: "function",
      function: {
        name: "bridge_manage",
        description: "create and manage shared live-work bridges across already-active sessions.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["begin", "attach", "status", "promote_task", "complete", "cancel"],
            },
            bridgeId: { type: "string", description: "bridge id for all actions except begin" },
            objective: { type: "string", description: "objective for begin" },
            summary: { type: "string", description: "optional concise shared-work summary" },
            friendId: { type: "string", description: "target friend id for attach" },
            channel: { type: "string", description: "target channel for attach" },
            key: { type: "string", description: "target session key for attach (defaults to 'session')" },
            title: { type: "string", description: "task title override for promote_task" },
            category: { type: "string", description: "task category override for promote_task" },
            body: { type: "string", description: "task body override for promote_task" },
          },
          required: ["action"],
        },
      },
    },
    handler: async (args, ctx) => {
      const manager = createBridgeManager()
      const action = (args.action || "").trim()

      if (action === "begin") {
        if (!ctx?.currentSession) {
          return withCode("bridge_manage begin requires an active session context.", "no-active-session")
        }
        const objective = (args.objective || "").trim()
        if (!objective) return withCode("objective is required for bridge begin.", "missing-objective")

        return formatBridgeStatus(
          manager.beginBridge({
            objective,
            summary: (args.summary || objective).trim(),
            session: ctx.currentSession,
          }),
        )
      }

      const bridgeId = (args.bridgeId || "").trim()
      if (!bridgeId) {
        return withCode("bridgeId is required for this bridge action.", "missing-bridge-id")
      }

      if (action === "attach") {
        const friendId = (args.friendId || "").trim()
        const channel = (args.channel || "").trim()
        const key = (args.key || "session").trim()
        if (!friendId || !channel) {
          return withCode("friendId and channel are required for bridge attach.", "missing-attach-target")
        }

        const sessionPath = resolveSessionPath(friendId, channel, key)
        const sessionTail = await summarizeSessionTailSafely({
          sessionPath,
          friendId,
          channel,
          key,
          messageCount: 20,
          trustLevel: ctx?.context?.friend?.trustLevel,
          summarize: ctx?.summarize,
        })
        if (sessionTail.kind === "missing") {
          return withCode(NO_SESSION_FOUND_MESSAGE, "session-not-found")
        }

        return formatBridgeStatus(
          manager.attachSession(bridgeId, {
            friendId,
            channel,
            key,
            sessionPath,
            snapshot: sessionTail.kind === "ok" ? sessionTail.snapshot : EMPTY_SESSION_MESSAGE,
          }),
        )
      }

      if (action === "status") {
        const bridge = manager.getBridge(bridgeId)
        if (!bridge) return withCode(`bridge not found: ${bridgeId}`, "bridge-not-found")
        return formatBridgeStatus(bridge)
      }

      if (action === "promote_task") {
        return formatBridgeStatus(
          manager.promoteBridgeToTask(bridgeId, {
            title: args.title,
            category: args.category,
            body: args.body,
          }),
        )
      }

      if (action === "complete") {
        return formatBridgeStatus(manager.completeBridge(bridgeId))
      }

      if (action === "cancel") {
        return formatBridgeStatus(manager.cancelBridge(bridgeId))
      }

      return `unknown bridge action: ${action}`
    },
    ax: { id: "tool:bridge_manage", group: "turn-sessions", when: "Pick this when one piece of work spans conversations already under way, such as two friends' chats, so each can share its status and progress.", effect: "write", errors: [
      { code: "no-active-session", means: "begin needs the conversation you're in, and this turn has none.", fix: "Start the bridge from a turn inside one of the conversations it should join." },
      { code: "missing-objective", means: "begin came without an objective.", fix: "Call begin again with objective set to the shared goal in one line." },
      { code: "missing-bridge-id", means: "Every action but begin needs bridgeId.", fix: "Pass the bridge id that begin returned." },
      { code: "missing-attach-target", means: "attach needs both friendId and channel.", fix: "Call attach again with the friend's id and the channel of their session, plus key if it isn't 'session'." },
      { code: "session-not-found", means: "No saved session matches that friendId, channel and key.", fix: "Check the friend, channel and key with query_session, then attach again." },
      { code: "bridge-not-found", means: "No bridge has that bridgeId.", fix: "Check the id from begin's reply, or begin a new bridge." },
    ] },
    summaryKeys: ["action", "bridgeId", "objective", "friendId", "channel", "key"],
    riskProfile: (args) => args.action === "status"
      ? { mutates: "none", risk: "low", reason: "bridge status is read-only" }
      : { mutates: "durable_state_write", risk: "high", reason: "creates or updates live-work bridge state" },
  },
]
