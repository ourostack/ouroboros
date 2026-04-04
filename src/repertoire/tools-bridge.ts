import { resolveSessionPath } from "../heart/config";
import { createBridgeManager, formatBridgeStatus } from "../heart/bridges/manager";
import { emitNervesEvent } from "../nerves/runtime";
import {
  recallSession,
  type SessionRecallOptions,
  type SessionRecallResult,
} from "../heart/session-recall";
import type { ToolDefinition } from "./tools-base";

const NO_SESSION_FOUND_MESSAGE = "no session found for that friend/channel/key combination."
const EMPTY_SESSION_MESSAGE = "session exists but has no non-system messages."

async function recallSessionSafely(options: SessionRecallOptions): Promise<SessionRecallResult | { kind: "missing" }> {
  try {
    return await recallSession(options)
  } catch (error) {
    if (options.summarize) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.session_recall_summary_fallback",
        message: "session recall summarization failed; using raw transcript",
        meta: {
          friendId: options.friendId,
          channel: options.channel,
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      try {
        return await recallSession({
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
          return "bridge_manage begin requires an active session context."
        }
        const objective = (args.objective || "").trim()
        if (!objective) return "objective is required for bridge begin."

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
        return "bridgeId is required for this bridge action."
      }

      if (action === "attach") {
        const friendId = (args.friendId || "").trim()
        const channel = (args.channel || "").trim()
        const key = (args.key || "session").trim()
        if (!friendId || !channel) {
          return "friendId and channel are required for bridge attach."
        }

        const sessionPath = resolveSessionPath(friendId, channel, key)
        const recall = await recallSessionSafely({
          sessionPath,
          friendId,
          channel,
          key,
          messageCount: 20,
          trustLevel: ctx?.context?.friend?.trustLevel,
          summarize: ctx?.summarize,
        })
        if (recall.kind === "missing") {
          return NO_SESSION_FOUND_MESSAGE
        }

        return formatBridgeStatus(
          manager.attachSession(bridgeId, {
            friendId,
            channel,
            key,
            sessionPath,
            snapshot: recall.kind === "ok" ? recall.snapshot : EMPTY_SESSION_MESSAGE,
          }),
        )
      }

      if (action === "status") {
        const bridge = manager.getBridge(bridgeId)
        if (!bridge) return `bridge not found: ${bridgeId}`
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
    summaryKeys: ["action", "bridgeId", "objective", "friendId", "channel", "key"],
  },
]
