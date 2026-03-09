import type OpenAI from "openai";
import { tools, baseToolDefinitions } from "./tools-base";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { teamsToolDefinitions, summarizeTeamsArgs } from "./tools-teams";
import { adoSemanticToolDefinitions } from "./ado-semantic";
import { githubToolDefinitions, summarizeGithubArgs } from "./tools-github";
import type { ChannelCapabilities, ResolvedContext } from "../mind/friends/types";
import { emitNervesEvent } from "../nerves/runtime";

// Re-export types and constants used by the rest of the codebase
export { tools, finalAnswerTool } from "./tools-base";
export type { ToolContext, ToolHandler, ToolDefinition } from "./tools-base";
export { teamsTools } from "./tools-teams";

// All tool definitions in a single registry
const allDefinitions: ToolDefinition[] = [...baseToolDefinitions, ...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions];
const REMOTE_BLOCKED_LOCAL_TOOLS = new Set(["shell", "read_file", "write_file", "git_commit", "gh_cli"]);

function isRemoteChannel(capabilities?: ChannelCapabilities): boolean {
  return capabilities?.channel === "teams" || capabilities?.channel === "bluebubbles";
}

function isSharedRemoteContext(context?: Pick<ResolvedContext, "friend" | "channel">): boolean {
  if (!context?.friend) return true;
  const externalIds = context.friend.externalIds ?? [];
  return externalIds.some((externalId) =>
    externalId.externalId.startsWith("group:") || externalId.provider === "teams-conversation",
  );
}

function isTrustedRemoteContext(context?: Pick<ResolvedContext, "friend" | "channel">): boolean {
  if (!context?.friend || !isRemoteChannel(context.channel)) return false;
  const trustLevel = context.friend.trustLevel ?? "stranger";
  return trustLevel !== "stranger" && !isSharedRemoteContext(context);
}

function shouldBlockLocalTools(
  capabilities?: ChannelCapabilities,
  context?: Pick<ResolvedContext, "friend" | "channel">,
): boolean {
  if (!isRemoteChannel(capabilities)) return false;
  return !isTrustedRemoteContext(context);
}

function blockedLocalToolMessage(ctx?: ToolContext): string {
  if (isTrustedRemoteContext(ctx?.context)) {
    return "";
  }
  return "I can't do that from here because I'm talking to multiple people in a shared remote channel, and local shell/file/git/gh operations could let conversations interfere with each other. Ask me for a remote-safe alternative (Graph/ADO/web), or run that operation from CLI.";
}

function baseToolsForCapabilities(
  capabilities?: ChannelCapabilities,
  context?: Pick<ResolvedContext, "friend" | "channel">,
): OpenAI.ChatCompletionFunctionTool[] {
  if (!shouldBlockLocalTools(capabilities, context)) return tools;
  return tools.filter((tool) => !REMOTE_BLOCKED_LOCAL_TOOLS.has(tool.function.name));
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

// Return the appropriate tools list based on channel capabilities.
// Base tools (no integration) are always included.
// Teams/integration tools are included only if their integration is in availableIntegrations.
// When toolPreferences is provided, matching preferences are appended to tool descriptions.
export function getToolsForChannel(
  capabilities?: ChannelCapabilities,
  toolPreferences?: Record<string, string>,
  context?: Pick<ResolvedContext, "friend" | "channel">,
): OpenAI.ChatCompletionFunctionTool[] {
  const baseTools = baseToolsForCapabilities(capabilities, context);

  if (!capabilities || capabilities.availableIntegrations.length === 0) {
    return baseTools;
  }
  const available = new Set(capabilities.availableIntegrations);
  const integrationDefs = [...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions].filter(
    (d) => d.integration && available.has(d.integration),
  );

  if (!toolPreferences || Object.keys(toolPreferences).length === 0) {
    return [...baseTools, ...integrationDefs.map((d) => d.tool)];
  }

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

  return [...baseTools, ...enrichedIntegrationTools];
}

// Check whether a tool requires user confirmation before execution.
// Reads from ToolDefinition.confirmationRequired instead of a separate Set.
export function isConfirmationRequired(toolName: string): boolean {
  const def = allDefinitions.find((d) => d.tool.function.name === toolName);
  return def?.confirmationRequired === true;
}

export async function execTool(name: string, args: Record<string, string>, ctx?: ToolContext): Promise<string> {
  emitNervesEvent({
    event: "tool.start",
    component: "tools",
    message: "tool execution started",
    meta: { name },
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

  if (shouldBlockLocalTools(ctx?.context?.channel, ctx?.context) && REMOTE_BLOCKED_LOCAL_TOOLS.has(name)) {
    const message = blockedLocalToolMessage(ctx);
    emitNervesEvent({
      level: "warn",
      event: "tool.error",
      component: "tools",
      message: "blocked local tool in remote channel",
      meta: { name, channel: ctx?.context?.channel?.channel },
    });
    return message;
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
  if (name === "shell") return summarizeKeyValues(args, ["command"]);
  if (name === "list_directory") return summarizeKeyValues(args, ["path"]);
  if (name === "git_commit") return summarizeKeyValues(args, ["message"]);
  if (name === "gh_cli") return summarizeKeyValues(args, ["command"]);
  if (name === "load_skill") return summarizeKeyValues(args, ["name"]);
  if (name === "task_create") return summarizeKeyValues(args, ["title", "type", "category"]);
  if (name === "task_update_status") return summarizeKeyValues(args, ["name", "status"]);
  if (name === "task_board_status") return summarizeKeyValues(args, ["status"]);
  if (name === "task_board_action") return summarizeKeyValues(args, ["scope"]);
  if (name === "task_board" || name === "task_board_deps" || name === "task_board_sessions") return "";
  if (name === "coding_spawn") return summarizeKeyValues(args, ["runner", "workdir", "taskRef"]);
  if (name === "coding_status") return summarizeKeyValues(args, ["sessionId"]);
  if (name === "coding_send_input") return summarizeKeyValues(args, ["sessionId", "input"]);
  if (name === "coding_kill") return summarizeKeyValues(args, ["sessionId"]);
  if (name === "claude") return summarizeKeyValues(args, ["prompt"]);
  if (name === "web_search") return summarizeKeyValues(args, ["query"]);
  if (name === "memory_search") return summarizeKeyValues(args, ["query"]);
  if (name === "memory_save") return summarizeKeyValues(args, ["text", "about"]);
  if (name === "get_friend_note") return summarizeKeyValues(args, ["friendId"]);
  if (name === "save_friend_note") {
    return summarizeKeyValues(args, ["type", "key", "content"]);
  }
  if (name === "ado_backlog_list") return summarizeKeyValues(args, ["organization", "project"]);
  return summarizeUnknownArgs(args);
}
