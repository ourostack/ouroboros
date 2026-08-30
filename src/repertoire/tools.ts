import type OpenAI from "openai";
import { baseToolDefinitions, editFileReadTracker, routineActionRequester } from "./tools-base";
import type { ToolApprovalPolicy, ToolContext, ToolDefinition } from "./tools-base";
import { teamsToolDefinitions } from "./tools-teams";
import { bluebubblesToolDefinitions } from "./tools-bluebubbles";
import { adoSemanticToolDefinitions } from "./ado-semantic";
import { githubToolDefinitions } from "./tools-github";
import { bundleToolDefinitions } from "./tools-bundle";
import type { ChannelCapabilities, ResolvedContext } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime";
import type { ProviderCapability } from "../heart/core";
import { guardInvocation } from "./guardrails";
import { getAgentName, getAgentRoot } from "../heart/identity";
import { releaseReservedCommerceAuthority, reserveCommerceAuthority } from "../commerce/store";
import { surfaceToolDefinition } from "./tools-surface";
import type { McpManager } from "./mcp-manager";
import { mcpToolsAsDefinitions } from "./mcp-tools";
import { voiceToolDefinitions } from "./tools-voice";
import { detectDestructivePatterns } from "./shell-sessions";
import { unraidToolDefinitions } from "./tools-unraid";
import { ponderTool, settleTool, speakTool } from "./tools-flow";
import { stewardPolicyToolDefinition } from "./tools-steward-policy";
import type { ToolHighRiskMutationKind, ToolRiskProfile } from "./tools-base";
import { inspectRoutineActionGrant } from "../heart/steward-policy";

function safeGetAgentRoot(): string | undefined {
  try {
    return getAgentRoot()
  } catch {
    return undefined
  }
}

function isSanctuaryAgent(): boolean {
  try {
    return getAgentName() === "sanctuary"
  } catch {
    return false
  }
}

const SANCTUARY_TELEGRAM_BASE_TOOLS = new Set(["query_active_work", "save_friend_note", "query_cares", "care_manage", "await_condition", "cancel_await"])

// Re-export types and constants used by the rest of the codebase
export { tools, settleTool, observeTool, ponderTool, restTool, speakTool } from "./tools-base";
export type { ToolContext, ToolHandler, ToolDefinition } from "./tools-base";

// Re-export surface tool schema for consumers (e.g. heart/core.ts)
export { surfaceToolDef } from "./tools-surface";

// All tool definitions in a single registry
const allDefinitions: ToolDefinition[] = [...baseToolDefinitions, ...bluebubblesToolDefinitions, ...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions, ...bundleToolDefinitions, ...voiceToolDefinitions, ...unraidToolDefinitions, stewardPolicyToolDefinition, surfaceToolDefinition];
const COMMERCE_AUTHORITY_TOOLS = new Set(["stripe_create_card", "flight_hold", "flight_book"])

// MCP tool definitions — populated each time getToolsForChannel() is called with an mcpManager.
// Kept separate from allDefinitions so execTool can find them.
let mcpDefinitions: ToolDefinition[] = []

/** Exported for testing — reset the MCP definitions cache. */
export function resetMcpDefinitions(): void {
  mcpDefinitions = []
}

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
  mcpManager?: McpManager,
  _chatModel?: string,
): OpenAI.ChatCompletionFunctionTool[] {
  if (capabilities?.channel === "telegram" && isSanctuaryAgent()) {
    return [
      ...baseToolDefinitions.filter((definition) => SANCTUARY_TELEGRAM_BASE_TOOLS.has(definition.tool.function.name)).map((definition) => definition.tool),
      ...unraidToolDefinitions.map((definition) => definition.tool),
      stewardPolicyToolDefinition.tool,
      ponderTool,
      settleTool,
      speakTool,
    ]
  }
  const baseTools = baseToolsForCapabilities();
  const bluebubblesTools = capabilities?.channel === "bluebubbles"
    ? bluebubblesToolDefinitions.map((d) => d.tool)
    : [];
  const voiceTools = capabilities?.channel === "voice"
    ? voiceToolDefinitions.map((d) => d.tool)
    : [];

  let result: OpenAI.ChatCompletionFunctionTool[];

  if (!capabilities || capabilities.availableIntegrations.length === 0) {
    result = [...baseTools, ...bluebubblesTools, ...voiceTools];
  } else {
    const available = new Set(capabilities.availableIntegrations);
    const channelDefs = [...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions];
    // Include tools whose integration is available, plus channel tools with no integration gate (e.g. teams_send_message)
    const integrationDefs = channelDefs.filter(
      (d) => d.integration ? available.has(d.integration) : capabilities.channel === "teams",
    );

    if (!toolPreferences || Object.keys(toolPreferences).length === 0) {
      result = [...baseTools, ...bluebubblesTools, ...voiceTools, ...integrationDefs.map((d) => d.tool)];
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

      result = [...baseTools, ...bluebubblesTools, ...voiceTools, ...enrichedIntegrationTools];
    }
  }

  // Append first-class MCP tools when mcpManager is provided
  if (mcpManager) {
    mcpDefinitions = mcpToolsAsDefinitions(mcpManager)
    const mcpSchemas = mcpDefinitions.map((d) => d.tool)
    result = [...result, ...mcpSchemas]
  }

  return filterByCapability(result, providerCapabilities);
}

// Look up a tool definition from the live combined registry (native + MCP).
// The base registry is intentionally consulted at call time so tests and
// runtime extensions cannot leave execution metadata behind a stale snapshot.
export function resolveToolDefinition(toolName: string): ToolDefinition | undefined {
  return baseToolDefinitions.find((d) => d.tool.function.name === toolName)
    ?? allDefinitions.find((d) => d.tool.function.name === toolName)
    ?? mcpDefinitions.find((d) => d.tool.function.name === toolName)
}

export function approvalPolicyForToolName(name: string, args: Record<string, unknown>): ToolApprovalPolicy {
  return resolveToolDefinition(name)?.approvalPolicy?.(args) ?? { kind: "not_required" }
}

async function routineActionInvocation(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<NonNullable<ToolContext["routineActionSelection"]> | null> {
  const target = typeof args.container === "string" ? args.container : ""
  if (name !== "unraid_restart_container" || !ctx?.agentRoot || !routineActionRequester(ctx) || !target) return null
  const relationshipAuthorization = ctx.relationshipAuthorization
  if (!relationshipAuthorization) return null
  let authorization: Awaited<ReturnType<NonNullable<ToolContext["relationshipAuthorization"]>["authorizeTool"]>>
  try {
    authorization = await relationshipAuthorization.authorizeTool(name, args as Record<string, string>)
  } catch {
    return null
  }
  if (!authorization.allowed || !Number.isInteger(authorization.profileVersion) || Number(authorization.profileVersion) < 1) return null
  const key = `unraid.restart:${target}`
  const decision = inspectRoutineActionGrant(ctx.agentRoot, { key, action: "unraid.container.restart", target })
  return decision.allowed ? { key, target, expectedPolicyVersion: decision.policyVersion } : null
}

export async function classifyApprovalForInvocation(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<{
  policy: ToolApprovalPolicy
  routineActionSelection?: NonNullable<ToolContext["routineActionSelection"]>
}> {
  const fallback = approvalPolicyForToolName(name, args)
  if (name !== "unraid_restart_container" || fallback.kind !== "required") return { policy: fallback }
  const routineActionSelection = await routineActionInvocation(name, args, ctx)
  return routineActionSelection ? { policy: { kind: "not_required" }, routineActionSelection } : { policy: fallback }
}

export async function approvalPolicyForInvocation(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolApprovalPolicy> {
  return (await classifyApprovalForInvocation(name, args, ctx)).policy
}

const findDefinition = resolveToolDefinition

function normalizeGuardArgs(_name: string, args: Record<string, string>): Record<string, string> {
  return args
}

const READ_ONLY_OURO_SHELL_COMMANDS = new Set([
  "help",
  "-h",
  "--help",
  "-v",
  "--version",
  "status",
  "whoami",
  "versions",
  "changelog",
  "mailbox",
  "inner",
  "thoughts",
  "check",
  "session list",
  "mcp list",
  "config models",
  "auth verify",
  "vault status",
  "vault config status",
  "vault item status",
  "vault item list",
])

function shellTokens(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

function ouroShellRiskReason(command: string): string | null {
  const tokens = shellTokens(command)
  if (tokens[0] !== "ouro") return null

  const first = tokens[1] ?? ""
  const second = tokens[2] ?? ""
  const third = tokens[3] ?? ""
  const twoWord = second ? `${first} ${second}` : first
  const threeWord = third ? `${twoWord} ${third}` : twoWord
  if (READ_ONLY_OURO_SHELL_COMMANDS.has(threeWord)
    || READ_ONLY_OURO_SHELL_COMMANDS.has(twoWord)
    || READ_ONLY_OURO_SHELL_COMMANDS.has(first)) {
    return null
  }

  const hint = first === "restart_runtime"
    ? " Hint: use the restart_runtime tool instead of shell."
    : ""
  return `ouro CLI command may mutate runtime/config state or be unavailable from shell.${hint}`
}

export function shellRiskProfile(args: Record<string, string>): ToolRiskProfile {
  const command = String(args.command)
  const destructive = detectDestructivePatterns(command)
  if (destructive.length > 0) {
    return { mutates: "external_side_effect", risk: "high", reason: `destructive shell pattern: ${destructive.join(", ")}` }
  }
  const ouroRiskReason = ouroShellRiskReason(command)
  if (ouroRiskReason) {
    return { mutates: "external_side_effect", risk: "high", reason: ouroRiskReason }
  }
  if (/(^|\s)(rm|mv|cp|touch|mkdir|rmdir)\b/.test(command)
    || /(^|\s)(npm|pnpm|yarn)\s+(install|add|remove|update|upgrade)\b/.test(command)
    || /(^|\s)git\s+(add|apply|checkout|clean|commit|merge|pull|push|rebase|reset|restore|switch)\b/.test(command)
    || /(^|\s)(sed\s+-i|perl\s+-pi)\b/.test(command)
    || /(^|\s)(tee|truncate)\b/.test(command)
    || /(^|[^<])>>?\s*\S+/.test(command)) {
    return { mutates: "external_side_effect", risk: "high", reason: "shell command appears to mutate files, packages, git state, or external state" }
  }
  return { mutates: "none", risk: "low" }
}

export function riskProfileForTool(def: ToolDefinition, name: string, args: Record<string, string>): ToolRiskProfile {
  if (name === "shell") return shellRiskProfile(args)
  if (typeof def.riskProfile === "function") return def.riskProfile(args)
  return def.riskProfile ?? { mutates: "none", risk: "low" }
}

export function riskProfileForToolName(name: string, args: Record<string, string>): ToolRiskProfile | null {
  const def = findDefinition(name)
  return def ? riskProfileForTool(def, name, args) : null
}

function orientationHoldMessage(name: string, profile: Extract<ToolRiskProfile, { risk: "high" }>, reason: string): string {
  return `orientation hold: ${reason} Available: orientation_get plus read-only inspection tools like trip_status, query_session, read_config, read_file, grep, search_facts, consult_diary, and consult_notes. Resolve the referent/correction, then retry ${name} if the action is still correct. Blocked ${mutationKindsFor(profile).join(", ")}. ${profile.reason}.`
}

function mutationKindsFor(profile: Extract<ToolRiskProfile, { risk: "high" }>): ToolHighRiskMutationKind[] {
  const mutates = profile.mutates
  return typeof mutates === "string" ? [mutates] : [...mutates]
}

function orientationPolicyBlocks(
  profile: ToolRiskProfile,
  blockedMutationKinds: readonly string[],
): profile is Extract<ToolRiskProfile, { risk: "high" }> {
  if (profile.risk !== "high") return false
  return mutationKindsFor(profile).some((kind) => blockedMutationKinds.includes(kind))
}

export async function execTool(name: string, args: Record<string, string>, ctx?: ToolContext): Promise<string> {
  emitNervesEvent({
    event: "tool.start",
    component: "tools",
    message: "tool execution started",
    meta: { name, ...(name === "shell" && args.command ? { command: args.command } : {}) },
  });

  // Look up from combined registry (native + MCP)
  const def = findDefinition(name);
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

  const relationshipDecision = await ctx?.relationshipAuthorization?.authorizeTool(name, args)
  if (relationshipDecision && !relationshipDecision.allowed) {
    emitNervesEvent({
      level: "warn",
      event: "tool.relationship_authorization_block",
      component: "tools",
      message: "relationship authorization blocked tool execution",
      meta: { name, reason: relationshipDecision.reason },
    })
    return `relationship authorization required: ${relationshipDecision.reason}`
  }

  const riskProfile = riskProfileForTool(def, name, args)
  const orientationPolicy = ctx?.orientationFrame?.actionPolicy
  if (orientationPolicy?.mode === "correction_hold"
    && orientationPolicyBlocks(riskProfile, orientationPolicy.blockedMutationKinds)) {
    const reason = orientationPolicy.reason
    const message = orientationHoldMessage(name, riskProfile, reason)
    emitNervesEvent({
      level: "warn",
      event: "tool.orientation_hold_block",
      component: "tools",
      message: "orientation hold blocked high-risk tool execution",
      meta: { name, mutates: mutationKindsFor(riskProfile), reason },
    });
    return message
  }

  // Guardrail check: structural + trust-level
  const mcpDef = mcpDefinitions.find((d) => d.tool.function.name === name)
  const guardContext = {
    readPaths: editFileReadTracker,
    trustLevel: ctx?.context?.friend?.trustLevel,
    agentRoot: ctx?.agentRoot ?? safeGetAgentRoot(),
    friendId: ctx?.context?.friend?.id,
    ...(mcpDef?.mcpServer ? { mcpServerName: mcpDef.mcpServer } : {}),
    ...((ctx?.context as any)?.isGroupChat !== undefined ? { isGroupChat: (ctx?.context as any).isGroupChat } : {}),
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

  const commerceReservation = COMMERCE_AUTHORITY_TOOLS.has(name) && guardContext.agentRoot
    ? reserveCommerceAuthority({
      agentRoot: guardContext.agentRoot,
      token: guardArgs.commerce_authority,
      toolName: name,
      args: guardArgs,
      friendId: guardContext.friendId,
    })
    : null
  if (commerceReservation && !commerceReservation.ok) {
    emitNervesEvent({
      level: "warn",
      event: "tool.guardrail_block",
      component: "tools",
      message: "guardrail blocked tool execution",
      meta: { name, reason: commerceReservation.reason },
    });
    return `commerce authority required: ${commerceReservation.reason}`
  }
  const authorizedContext = ctx
  const toolContext: ToolContext | undefined = commerceReservation?.ok
    ? {
      ...authorizedContext,
      agentRoot: guardContext.agentRoot,
      commerceAuthority: {
        checkoutId: commerceReservation.checkoutId,
        reservationToken: commerceReservation.reservationToken,
      },
    } as ToolContext
    : authorizedContext

  try {
    const result = await def.handler(args, toolContext);
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
  } finally {
    if (commerceReservation?.ok && guardContext.agentRoot) {
      try {
        releaseReservedCommerceAuthority({
          agentRoot: guardContext.agentRoot,
          checkoutId: commerceReservation.checkoutId,
          reservationToken: commerceReservation.reservationToken,
          toolName: name,
          friendId: guardContext.friendId,
        })
      } catch {
        /* v8 ignore next -- external tool result/error should not be masked by best-effort reservation cleanup @preserve */
      }
    }
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
  const def = findDefinition(name);
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
