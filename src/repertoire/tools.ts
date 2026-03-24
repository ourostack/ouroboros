import type OpenAI from "openai";
import { baseToolDefinitions, editFileReadTracker } from "./tools-base";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { teamsToolDefinitions, summarizeTeamsArgs } from "./tools-teams";
import { bluebubblesToolDefinitions } from "./tools-bluebubbles";
import { adoSemanticToolDefinitions } from "./ado-semantic";
import { githubToolDefinitions, summarizeGithubArgs } from "./tools-github";
import type { ChannelCapabilities, ResolvedContext } from "../mind/friends/types";
import { emitNervesEvent } from "../nerves/runtime";
import type { ProviderCapability } from "../heart/core";
import { guardInvocation } from "./guardrails";
import { getAgentRoot } from "../heart/identity";
import { resolveSafeRepoPath } from "../heart/safe-workspace";
import { surfaceToolDef, handleSurface, type SurfaceRouteResult } from "../senses/surface-tool";
import { advanceObligation as advanceInnerObligation } from "../mind/obligations";
import { findFreshestFriendSession } from "../heart/session-activity";
import * as path from "path";

function safeGetAgentRoot(): string | undefined {
  try {
    return getAgentRoot()
  } catch {
    return undefined
  }
}

// Re-export types and constants used by the rest of the codebase
export { tools, settleTool, observeTool, goInwardTool } from "./tools-base";
export type { ToolContext, ToolHandler, ToolDefinition } from "./tools-base";

// Surface tool handler: routes content to friend's freshest session
/* v8 ignore start -- surface handler wiring: core logic tested via surface-tool.test.ts; this wires identity/routing deps @preserve */
const surfaceToolDefinition: ToolDefinition = {
  tool: surfaceToolDef,
  handler: async (args, ctx) => {
    const queue = ctx?.delegatedOrigins ?? []
    const agentName = safeGetAgentRoot() ? getAgentRoot().split("/").pop() ?? "unknown" : "unknown"

    const routeToFriend = async (friendId: string, content: string): Promise<SurfaceRouteResult> => {
      /* v8 ignore start -- routing: integration path tested via inner-dialog routing tests @preserve */
      try {
        const agentRoot = getAgentRoot()
        const freshest = findFreshestFriendSession({
          sessionsDir: path.join(agentRoot, "state", "sessions"),
          friendsDir: path.join(agentRoot, "friends"),
          agentName,
          friendId,
          activeOnly: true,
        })
        if (freshest && freshest.channel !== "inner") {
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
        // Deferred — no active session found
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
          const name = safeGetAgentRoot() ? getAgentRoot().split("/").pop() ?? "unknown" : "unknown"
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

function normalizeGuardArgs(name: string, args: Record<string, string>): Record<string, string> {
  if ((name === "read_file" || name === "write_file" || name === "edit_file") && args.path) {
    return {
      ...args,
      path: resolveSafeRepoPath({ requestedPath: args.path }).resolvedPath,
    }
  }
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
  // Check teams tools first
  const teamsSummary = summarizeTeamsArgs(name, args);
  if (teamsSummary !== undefined) return teamsSummary;

  // Check github tools
  const githubSummary = summarizeGithubArgs(name, args);
  if (githubSummary !== undefined) return githubSummary;

  // Base tools
  if (name === "read_file" || name === "write_file") return summarizeKeyValues(args, ["path"]);
  if (name === "edit_file") return summarizeKeyValues(args, ["path"]);
  if (name === "glob") return summarizeKeyValues(args, ["pattern", "cwd"]);
  if (name === "grep") return summarizeKeyValues(args, ["pattern", "path", "include"]);
  if (name === "shell") return summarizeKeyValues(args, ["command"]);
  if (name === "load_skill") return summarizeKeyValues(args, ["name"]);
  if (name === "coding_spawn") return summarizeKeyValues(args, ["runner", "workdir", "taskRef"]);
  if (name === "coding_status") return summarizeKeyValues(args, ["sessionId"]);
  if (name === "coding_tail") return summarizeKeyValues(args, ["sessionId"]);
  if (name === "coding_send_input") return summarizeKeyValues(args, ["sessionId", "input"]);
  if (name === "coding_kill") return summarizeKeyValues(args, ["sessionId"]);
  if (name === "bluebubbles_set_reply_target") return summarizeKeyValues(args, ["target", "threadOriginatorGuid"]);
  if (name === "set_reasoning_effort") return summarizeKeyValues(args, ["level"]);
  if (name === "claude") return summarizeKeyValues(args, ["prompt"]);
  if (name === "web_search") return summarizeKeyValues(args, ["query"]);
  if (name === "memory_search") return summarizeKeyValues(args, ["query"]);
  if (name === "memory_save") return summarizeKeyValues(args, ["text", "about"]);
  if (name === "get_friend_note") return summarizeKeyValues(args, ["friendId"]);
  if (name === "save_friend_note") {
    return summarizeKeyValues(args, ["type", "key", "content"]);
  }
  if (name === "bridge_manage") return summarizeKeyValues(args, ["action", "bridgeId", "objective", "friendId", "channel", "key"]);
  if (name === "ado_backlog_list") return summarizeKeyValues(args, ["organization", "project"]);
  if (name === "ado_batch_update") return summarizeKeyValues(args, ["organization", "project"]);
  if (name === "ado_create_epic" || name === "ado_create_issue") return summarizeKeyValues(args, ["organization", "project", "title"]);
  if (name === "ado_move_items") return summarizeKeyValues(args, ["organization", "project", "workItemIds"]);
  if (name === "ado_restructure_backlog") return summarizeKeyValues(args, ["organization", "project"]);
  return summarizeUnknownArgs(args);
}
