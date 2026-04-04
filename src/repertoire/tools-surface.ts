import type OpenAI from "openai";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { handleSurface, type SurfaceRouteResult } from "../senses/surface-tool";
import { advanceReturnObligation, findPendingObligationForOrigin, fulfillObligation } from "../heart/obligations";
import { findFreshestFriendSession, listSessionActivity } from "../heart/session-activity";
import * as path from "path";
import type { AttentionItem } from "../heart/attention-types";
import type { ToolDefinition } from "./tools-base";

// Surface tool schema — canonical home. Handler lives in senses/surface-tool.ts.
export const surfaceToolDef: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "surface",
    description:
      "share a thought outward — deliver an answer, ask a follow-up, or surface progress to whoever needs to hear it. pass delegationId to address a held thought (see your attention queue above), or friendId for spontaneous outreach. does not end your turn.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "the message to deliver",
        },
        delegationId: {
          type: "string",
          description: "ID from your attention queue — addresses a specific held thought",
        },
        friendId: {
          type: "string",
          description: "friend to reach out to spontaneously (when not addressing a held thought)",
        },
      },
      required: ["content"],
    },
  },
}

// Surface tool handler: routes content to friend's freshest session
/* v8 ignore start -- surface handler wiring: core logic tested via surface-tool.test.ts; this wires identity/routing deps @preserve */
export const surfaceToolDefinition: ToolDefinition = {
  tool: surfaceToolDef,
  handler: async (args, ctx) => {
    const queue = ctx?.delegatedOrigins ?? []
    const agentName = (() => { try { return getAgentName() } catch { return "unknown" } })()

    const routeToFriend = async (friendId: string, content: string, queueItem?: AttentionItem): Promise<SurfaceRouteResult> => {
      /* v8 ignore start -- routing: integration path tested via inner-dialog routing tests @preserve */
      try {
        const agentRoot = getAgentRoot()
        const sessionsDir = path.join(agentRoot, "state", "sessions")
        const friendsDir = path.join(agentRoot, "friends")

        // Priority 1: Bridge-preferred session (if queue item has a bridgeId)
        if (queueItem?.bridgeId) {
          const { createBridgeManager } = await import("../heart/bridges/manager")
          const bridge = createBridgeManager().getBridge(queueItem.bridgeId)
          if (bridge && bridge.lifecycle !== "completed" && bridge.lifecycle !== "cancelled") {
            const allSessions = listSessionActivity({ sessionsDir, friendsDir, agentName })
            const bridgeTarget = allSessions.find((activity) =>
              activity.friendId === friendId
              && activity.channel !== "inner"
              && bridge.attachedSessions.some((s) =>
                s.friendId === activity.friendId && s.channel === activity.channel && s.key === activity.key
              ),
            )
            if (bridgeTarget) {
              // Attempt proactive BB delivery for bridge target
              if (bridgeTarget.channel === "bluebubbles") {
                const { sendProactiveBlueBubblesMessageToSession } = await import("../senses/bluebubbles")
                const proactiveResult = await sendProactiveBlueBubblesMessageToSession({
                  friendId: bridgeTarget.friendId,
                  sessionKey: bridgeTarget.key,
                  text: content,
                })
                if (proactiveResult.delivered) {
                  // Inject surfaced content into the target session so it knows what was delivered
                  const { appendSyntheticAssistantMessage } = await import("../mind/context")
                  const sessionFilePath = path.join(sessionsDir, bridgeTarget.friendId, bridgeTarget.channel, `${bridgeTarget.key}.json`)
                  appendSyntheticAssistantMessage(sessionFilePath, `[surfaced from inner dialog] ${content}`)
                  return { status: "delivered", detail: "via iMessage" }
                }
              }
              // Fall back to pending queue for bridge target
              const { queuePendingMessage, getPendingDir } = await import("../mind/pending")
              const pendingDir = getPendingDir(agentName, bridgeTarget.friendId, bridgeTarget.channel, bridgeTarget.key)
              queuePendingMessage(pendingDir, {
                from: agentName,
                friendId: bridgeTarget.friendId,
                channel: bridgeTarget.channel,
                key: bridgeTarget.key,
                content,
                timestamp: Date.now(),
              })
              return { status: "queued", detail: `for next interaction via ${bridgeTarget.channel}` }
            }
          }
        }

        // Priority 2: Freshest active friend session
        const freshest = findFreshestFriendSession({
          sessionsDir,
          friendsDir,
          agentName,
          friendId,
          activeOnly: true,
        })
        if (freshest && freshest.channel !== "inner") {
          // Attempt proactive BB delivery
          if (freshest.channel === "bluebubbles") {
            const { sendProactiveBlueBubblesMessageToSession } = await import("../senses/bluebubbles")
            const proactiveResult = await sendProactiveBlueBubblesMessageToSession({
              friendId: freshest.friendId,
              sessionKey: freshest.key,
              text: content,
            })
            if (proactiveResult.delivered) {
              // Inject surfaced content into the target session so it knows what was delivered
              const { appendSyntheticAssistantMessage } = await import("../mind/context")
              const sessionFilePath = path.join(sessionsDir, freshest.friendId, freshest.channel, `${freshest.key}.json`)
              appendSyntheticAssistantMessage(sessionFilePath, `[surfaced from inner dialog] ${content}`)
              return { status: "delivered", detail: "via iMessage" }
            }
          }
          // Queue as pending for next interaction
          const { queuePendingMessage, getPendingDir } = await import("../mind/pending")
          const pendingDir = getPendingDir(agentName, freshest.friendId, freshest.channel, freshest.key)
          queuePendingMessage(pendingDir, {
            from: agentName,
            friendId: freshest.friendId,
            channel: freshest.channel,
            key: freshest.key,
            content,
            timestamp: Date.now(),
          })
          return { status: "queued", detail: `for next interaction via ${freshest.channel}` }
        }

        // Priority 3: Deferred — no active session found
        const { getDeferredReturnDir } = await import("../mind/pending")
        const { queuePendingMessage: queueDeferred } = await import("../mind/pending")
        const deferredDir = getDeferredReturnDir(agentName, friendId)
        queueDeferred(deferredDir, {
          from: agentName,
          friendId,
          channel: "deferred",
          key: "return",
          content,
          timestamp: Date.now(),
        })
        return { status: "deferred", detail: "they'll see it next time" }
      } catch {
        return { status: "failed" }
      }
      /* v8 ignore stop */
    }

    return handleSurface({
      content: args.content ?? "",
      delegationId: args.delegationId,
      friendId: args.friendId,
      queue,
      routeToFriend,
      advanceObligation: (obligationId, update) => {
        /* v8 ignore start -- obligation advance: tested via attention-queue tests @preserve */
        try {
          const name = (() => { try { return getAgentName() } catch { return "unknown" } })()
          advanceReturnObligation(name, obligationId, {
            status: update.status as any,
            ...(update.returnedAt !== undefined ? { returnedAt: update.returnedAt } : {}),
            ...(update.returnTarget !== undefined ? { returnTarget: update.returnTarget as any } : {}),
          })
        } catch {
          // swallowed — obligation advance must never break surface delivery
        }
        /* v8 ignore stop */
      },
      fulfillHeartObligation: (origin) => {
        /* v8 ignore start -- heart obligation fulfillment: tested via surface-tool.test.ts @preserve */
        try {
          const agentRoot = getAgentRoot()
          const heartObligation = findPendingObligationForOrigin(agentRoot, origin)
          if (heartObligation) {
            fulfillObligation(agentRoot, heartObligation.id)
          }
        } catch {
          // swallowed — heart obligation fulfillment must never break surface delivery
        }
        /* v8 ignore stop */
      },
    })
  },
  summaryKeys: ["content", "delegationId"],
}
/* v8 ignore stop */
