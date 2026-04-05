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
import { getAgentRoot } from "../heart/identity";
import { surfaceToolDefinition } from "./tools-surface";

function safeGetAgentRoot(): string | undefined {
  try {
    return getAgentRoot()
  } catch {
    return undefined
  }
}

// Re-export types and constants used by the rest of the codebase
export { tools, settleTool, observeTool, ponderTool, restTool } from "./tools-base";
export type { ToolContext, ToolHandler, ToolDefinition } from "./tools-base";

// Re-export surface tool schema for consumers (e.g. heart/core.ts)
export { surfaceToolDef } from "./tools-surface";

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

/**
 * Build an enriched tool result summary for display on remote channels.
 * For recognized tools, includes result-derived info (diff stats, exit codes, etc.).
 * Falls back to arg-based summary for unrecognized tools.
 */
export function buildToolResultSummary(
  name: string,
  args: Record<string, string>,
  _result: string,
  success: boolean,
): string {
  /* v8 ignore start -- branches: ?? fallbacks and ternaries in tool summary formatting @preserve */
  switch (name) {
    case "edit_file": {
      if (!success) return summarizeArgs(name, args)
      const addedLines = (args.new_string ?? "").split("\n").length
      const removedLines = (args.old_string ?? "").split("\n").length
      return `+${addedLines} -${removedLines} lines in ${args.path ?? "unknown"}`
    }
    case "shell": {
      const cmd = args.command ?? "?"
      const exitCode = success ? 0 : 1
      return `$ ${cmd} (exit ${exitCode})`
    }
    case "read_file":
      return `path=${args.path ?? "unknown"}`
    case "write_file":
      return `path=${args.path ?? "unknown"}`
    case "glob":
      return `pattern=${args.pattern ?? "?"} ${args.cwd ? `cwd=${args.cwd}` : ""}`.trim()
    case "grep":
      return `pattern=${args.pattern ?? "?"} ${args.path ? `path=${args.path}` : ""}`.trim()
    case "coding_spawn": {
      const taskRef = args.taskRef ?? "unknown"
      const status = success ? "spawned" : "failed"
      return `${taskRef} -> ${status}`
    }
    default:
      return summarizeArgs(name, args)
  }
  /* v8 ignore stop */
}
