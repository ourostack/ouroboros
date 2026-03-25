import type OpenAI from "openai";
import { baseToolDefinitions, editFileReadTracker } from "./tools-base";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { teamsToolDefinitions } from "./tools-teams";
import { bluebubblesToolDefinitions } from "./tools-bluebubbles";
import { adoSemanticToolDefinitions } from "./ado-semantic";
import { githubToolDefinitions } from "./tools-github";
import type { ChannelCapabilities, ResolvedContext } from "../mind/friends/types";
import { emitNervesEvent } from "../nerves/runtime";
import type { ProviderCapability } from "../heart/core";
import { guardInvocation } from "./guardrails";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { surfaceToolDef, handleSurface, type SurfaceRouteResult } from "../senses/surface-tool";
import { advanceObligation as advanceInnerObligation } from "../mind/obligations";
import { findFreshestFriendSession, listSessionActivity } from "../heart/session-activity";
import * as path from "path";
import type { AttentionItem } from "../senses/attention-queue";

function safeGetAgentRoot(): string | undefined {
  try {
    return getAgentRoot()
  } catch {
    return undefined
  }
}

// Re-export types and constants used by the rest of the codebase
export { tools, settleTool, observeTool, descendTool } from "./tools-base";
export type { ToolContext, ToolHandler, ToolDefinition } from "./tools-base";

// Surface tool handler: routes content to friend's freshest session
/* v8 ignore start -- surface handler wiring: core logic tested via surface-tool.test.ts; this wires identity/routing deps @preserve */
const surfaceToolDefinition: ToolDefinition = {
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
          advanceInnerObligation(name, obligationId, {
            status: update.status as any,
            ...(update.returnedAt !== undefined ? { returnedAt: update.returnedAt } : {}),
            ...(update.returnTarget !== undefined ? { returnTarget: update.returnTarget as any } : {}),
          })
        } catch {
          // swallowed — obligation advance must never break surface delivery
        }
        /* v8 ignore stop */
      },
    })
  },
  summaryKeys: ["content", "delegationId"],
}
/* v8 ignore stop */

// All tool definitions in a single registry
const allDefinitions: ToolDefinition[] = [...baseToolDefinitions, ...bluebubblesToolDefinitions, ...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions, surfaceToolDefinition];

function baseToolsForCapabilities(): OpenAI.ChatCompletionFunctionTool[] {
  // Use baseToolDefinitions at call time so dynamically-added tools are included
  return baseToolDefinitions.map((d) => d.tool);
}

// Apply a single tool preference to a tool schema, returning a new object.
function applyPreference(tool: OpenAI.ChatCompletionFunctionTool, pref: string): OpenAI.ChatCompletionFunctionTool {
  return {
    ...tool,
    function: {
      ...tool.function,
      description: `${tool.function.description}\n\nfriend preference: ${pref}`,
    },
  };
}

// Filter out tools whose requiredCapability is not in the provider's capability set.
// Uses baseToolDefinitions at call time so dynamically-added tools are included.
// Only base tools can have requiredCapability (integration tools do not).
function filterByCapability(
  toolList: OpenAI.ChatCompletionFunctionTool[],
  providerCapabilities?: ReadonlySet<ProviderCapability>,
): OpenAI.ChatCompletionFunctionTool[] {
  return toolList.filter((tool) => {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === tool.function.name);
    if (!def?.requiredCapability) return true;
    return providerCapabilities?.has(def.requiredCapability) === true;
  });
}

// Return the appropriate tools list based on channel capabilities.
// Base tools (no integration) are always included.
// Teams/integration tools are included only if their integration is in availableIntegrations.
// When toolPreferences is provided, matching preferences are appended to tool descriptions.
// When providerCapabilities is provided, tools with requiredCapability are filtered.
export function getToolsForChannel(
  capabilities?: ChannelCapabilities,
  toolPreferences?: Record<string, string>,
  _context?: Pick<ResolvedContext, "friend" | "channel">,
  providerCapabilities?: ReadonlySet<ProviderCapability>,
): OpenAI.ChatCompletionFunctionTool[] {
  const baseTools = baseToolsForCapabilities();
  const bluebubblesTools = capabilities?.channel === "bluebubbles"
    ? bluebubblesToolDefinitions.map((d) => d.tool)
    : [];

  let result: OpenAI.ChatCompletionFunctionTool[];

  if (!capabilities || capabilities.availableIntegrations.length === 0) {
    result = [...baseTools, ...bluebubblesTools];
  } else {
    const available = new Set(capabilities.availableIntegrations);
    const channelDefs = [...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions];
    // Include tools whose integration is available, plus channel tools with no integration gate (e.g. teams_send_message)
    const integrationDefs = channelDefs.filter(
      (d) => d.integration ? available.has(d.integration) : capabilities.channel === "teams",
    );

    if (!toolPreferences || Object.keys(toolPreferences).length === 0) {
      result = [...baseTools, ...bluebubblesTools, ...integrationDefs.map((d) => d.tool)];
    } else {
      // Build a map of integration -> preference text for fast lookup
      const prefMap = new Map<string, string>();
      for (const [key, value] of Object.entries(toolPreferences)) {
        prefMap.set(key, value);
      }

      // Apply preferences to matching integration tools (new objects, no mutation)
      // d.integration is guaranteed truthy -- integrationDefs are pre-filtered above
      const enrichedIntegrationTools = integrationDefs.map((d) => {
        const pref = prefMap.get(d.integration!);
        return pref ? applyPreference(d.tool, pref) : d.tool;
      });

      result = [...baseTools, ...bluebubblesTools, ...enrichedIntegrationTools];
    }
  }

  return filterByCapability(result, providerCapabilities);
}

// Check whether a tool requires user confirmation before execution.
// Reads from ToolDefinition.confirmationRequired instead of a separate Set.
export function isConfirmationRequired(toolName: string): boolean {
  const def = allDefinitions.find((d) => d.tool.function.name === toolName);
  return def?.confirmationRequired === true;
}

function normalizeGuardArgs(_name: string, args: Record<string, string>): Record<string, string> {
  return args
}

export async function execTool(name: string, args: Record<string, string>, ctx?: ToolContext): Promise<string> {
  emitNervesEvent({
    event: "tool.start",
    component: "tools",
    message: "tool execution started",
    meta: { name, ...(name === "shell" && args.command ? { command: args.command } : {}) },
  });

  // Look up from combined registry
  const def = allDefinitions.find((d) => d.tool.function.name === name);
  if (!def) {
    emitNervesEvent({
      level: "error",
      event: "tool.error",
      component: "tools",
      message: "unknown tool requested",
      meta: { name },
    });
    return `unknown: ${name}`;
  }

  // Guardrail check: structural + trust-level
  const guardContext = {
    readPaths: editFileReadTracker,
    trustLevel: ctx?.context?.friend?.trustLevel,
    agentRoot: safeGetAgentRoot(),
  }
  const guardArgs = normalizeGuardArgs(name, args)
  const guardResult = guardInvocation(name, guardArgs, guardContext)
  if (!guardResult.allowed) {
    emitNervesEvent({
      level: "warn",
      event: "tool.guardrail_block",
      component: "tools",
      message: "guardrail blocked tool execution",
      meta: { name, reason: guardResult.reason },
    });
    return guardResult.reason
  }

  try {
    const result = await def.handler(args, ctx);
    emitNervesEvent({
      event: "tool.end",
      component: "tools",
      message: "tool execution finished",
      meta: { name, success: true },
    });
    return result;
  } catch (error) {
    emitNervesEvent({
      level: "error",
      event: "tool.error",
      component: "tools",
      message: error instanceof Error ? error.message : String(error),
      meta: { name },
    });
    throw error;
  }
}

function summarizeKeyValues(args: Record<string, string>, keys: string[], maxValueLength = 60): string {
  const parts: string[] = []
  for (const key of keys) {
    const raw = args[key]
    if (raw === undefined || raw === null) continue
    const compact = String(raw).replace(/\s+/g, " ").trim()
    if (!compact) continue
    const clipped = compact.length > maxValueLength ? compact.slice(0, maxValueLength) + "..." : compact
    parts.push(`${key}=${clipped}`)
  }
  return parts.join(" ")
}

function summarizeUnknownArgs(args: Record<string, string>): string {
  const keys = Object.keys(args)
  if (keys.length === 0) return ""
  return summarizeKeyValues(args, keys)
}

export function summarizeArgs(name: string, args: Record<string, string>): string {
  const def = allDefinitions.find((d) => d.tool.function.name === name);
  if (def && def.summaryKeys !== undefined) {
    return summarizeKeyValues(args, def.summaryKeys);
  }
  return summarizeUnknownArgs(args);
}
