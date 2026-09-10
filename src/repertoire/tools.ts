import type OpenAI from "openai";
import { isDeepStrictEqual } from "node:util";
import { baseToolDefinitions, editFileReadTracker, routineActionRequester } from "./tools-base";
import type { ToolApprovalPolicy, ToolContext, ToolDefinition, ToolExecutionOutcome, ToolSelection } from "./tools-base";
import { teamsToolDefinitions } from "./tools-teams";
import { bluebubblesToolDefinitions } from "./tools-bluebubbles";
import { adoSemanticToolDefinitions } from "./ado-semantic";
import { githubToolDefinitions } from "./tools-github";
import { bundleToolDefinitions } from "./tools-bundle";
import type { ChannelCapabilities, ResolvedContext } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime";
import type { ProviderCapability } from "../heart/core";
import { guardInvocation } from "./guardrails";
import { getAgentRoot } from "../heart/identity";
import { releaseReservedCommerceAuthority, reserveCommerceAuthority } from "../commerce/store";
import { surfaceToolDefinition } from "./tools-surface";
import type { McpTurnView } from "./mcp-manager";
import { McpCallRejectedError, McpToolExecutionError, mcpToolsAsDefinitions } from "./mcp-tools";
import { assertRelationshipToolOwner, freezeToolValue, validateAdvertisedToolArguments } from "./tool-arguments";
import { voiceToolDefinitions } from "./tools-voice";
import { detectDestructivePatterns } from "./shell-sessions";
import { unraidToolDefinitions } from "./tools-unraid";
import { observeTool, ponderTool, restTool, settleTool, speakTool } from "./tools-flow";
import { stewardPolicyToolDefinition } from "./tools-steward-policy";
import type { ToolHighRiskMutationKind, ToolRiskProfile } from "./tools-base";
import { inspectRoutineActionGrant } from "../heart/steward-policy";
import { ApprovalExecutionFailedError } from "../heart/tool-approval";

function safeGetAgentRoot(): string | undefined {
  try {
    return getAgentRoot()
  } catch {
    return undefined
  }
}

const SANCTUARY_RELATIONSHIP_BASE_TOOLS = new Set([
  "external_event_disposition",
  "query_active_work",
  "save_friend_note",
  "telegram_contact_manage",
  "query_cares",
  "care_manage",
  "await_condition",
  "resolve_await",
  "cancel_await",
  "list_recent_attachments",
  "materialize_attachment",
  "describe_image",
  "send_message",
])
export const SANCTUARY_OWNER_ADDITIONS: ReadonlySet<string> = new Set([
  "shell", "shell_status", "shell_tail", "read_file", "write_file", "edit_file", "glob", "grep",
  "web_search", "search_facts", "consult_diary", "consult_notes", "get_friend_note",
  "session_summary", "query_session", "set_reasoning_effort", "restart_runtime", "revive_sense",
])

// Re-export types and constants used by the rest of the codebase
export { tools, settleTool, observeTool, ponderTool, restTool, speakTool } from "./tools-base";
export type { ToolContext, ToolHandler, ToolDefinition, ToolExecutionOutcome, ToolSelection } from "./tools-base";

// Re-export surface tool schema for consumers (e.g. heart/core.ts)
export { surfaceToolDef } from "./tools-surface";

// All tool definitions in a single registry
const additionalDefinitions: ToolDefinition[] = [...bluebubblesToolDefinitions, ...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions, ...bundleToolDefinitions, ...voiceToolDefinitions, ...unraidToolDefinitions, stewardPolicyToolDefinition, surfaceToolDefinition];
const COMMERCE_AUTHORITY_TOOLS = new Set(["stripe_create_card", "flight_hold", "flight_book"])

export class ToolSelectionError extends Error {}

function assertUniqueToolSchemas(tools: readonly OpenAI.ChatCompletionFunctionTool[]): void {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.function.name)) {
      emitNervesEvent({
        level: "error", component: "tools", event: "tool.selection_collision",
        message: "tool selection contains an ambiguous name", meta: { name: tool.function.name },
      })
      throw new ToolSelectionError(`tool selection collision: ${tool.function.name}`)
    }
    seen.add(tool.function.name)
  }
}

export function toolSelectionSchemas(selection: ToolSelection): OpenAI.ChatCompletionFunctionTool[] {
  return [...selection.ordinary.map((definition) => definition.tool), ...selection.engine]
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

type SelectionContext = Pick<ToolContext, "agentName" | "noSend" | "habitSession"> & {
  relationshipAuthorization?: Pick<NonNullable<ToolContext["relationshipAuthorization"]>, "profileId" | "advertisedToolNames">
}

export function selectToolsForChannel(
  capabilities?: ChannelCapabilities,
  toolPreferences?: Record<string, string>,
  _context?: Pick<ResolvedContext, "friend" | "channel">,
  providerCapabilities?: ReadonlySet<ProviderCapability>,
  mcpManager?: McpTurnView,
  _chatModel?: string,
  context?: SelectionContext,
): ToolSelection {
  const relationship = context?.relationshipAuthorization
  const profileId = relationship?.profileId
  const sanctuary = (context?.agentName === "sanctuary" && (relationship !== undefined || capabilities?.channel === "telegram"))
    || profileId?.startsWith("sanctuary-") === true
  const owner = profileId === "sanctuary-owner"
  const knownSanctuaryProfile = relationship !== undefined && (owner || profileId === "sanctuary-household" || profileId === "sanctuary-event")
  const mcp = mcpManager ? mcpToolsAsDefinitions(mcpManager) : []
  const native = [...baseToolDefinitions, ...additionalDefinitions]
  assertUniqueToolSchemas([
    ...native.map((definition) => definition.tool), ...mcp.map((definition) => definition.tool),
    ponderTool, restTool, observeTool, settleTool, speakTool,
  ])
  let ordinary: ToolDefinition[]
  if (sanctuary) {
    ordinary = knownSanctuaryProfile
      ? [
        ...baseToolDefinitions.filter((definition) =>
          SANCTUARY_RELATIONSHIP_BASE_TOOLS.has(definition.tool.function.name)
          || (owner && SANCTUARY_OWNER_ADDITIONS.has(definition.tool.function.name))),
        ...unraidToolDefinitions, stewardPolicyToolDefinition, ...(owner ? mcp : []),
      ]
      : []
  } else {
    const available = new Set(capabilities?.availableIntegrations ?? [])
    const integrations = available.size === 0 ? [] : [...teamsToolDefinitions, ...adoSemanticToolDefinitions, ...githubToolDefinitions]
      .filter((definition) => definition.integration ? available.has(definition.integration) : capabilities?.channel === "teams")
      .map((definition) => {
        const preference = definition.integration ? toolPreferences?.[definition.integration] : undefined
        return preference ? { ...definition, tool: applyPreference(definition.tool, preference) } : definition
      })
    ordinary = [
      ...baseToolDefinitions,
      ...(capabilities?.channel === "bluebubbles" ? bluebubblesToolDefinitions : []),
      ...(capabilities?.channel === "voice" ? voiceToolDefinitions : []),
      ...integrations, ...mcp,
    ]
  }
  const inner = capabilities?.channel === "inner"
  const habit = context?.habitSession
  if (inner) {
    const canSend = habit?.toolPolicy.outwardMessagingAllowed === true && habit.toolPolicy.grantedTools.includes("send_message")
    ordinary = ordinary.filter((definition) => canSend || definition.tool.function.name !== "send_message")
    if (!habit || (habit.toolPolicy.outwardMessagingAllowed && habit.toolPolicy.grantedTools.includes("surface"))) {
      ordinary.push(surfaceToolDefinition)
    }
  }
  ordinary = ordinary.filter((definition) =>
    (!relationship || relationship.advertisedToolNames.includes(definition.tool.function.name))
    && (!definition.requiredCapability || providerCapabilities?.has(definition.requiredCapability) === true))
  const engine = [
    ...(context?.noSend ? [] : [ponderTool]),
    ...(inner ? [restTool] : [observeTool, settleTool]),
    ...(capabilities?.chatStyle ? [speakTool] : []),
  ].filter((tool) => (!sanctuary || (knownSanctuaryProfile && tool.function.name !== "observe"))
    && (!relationship || relationship.advertisedToolNames.includes(tool.function.name)))
  return Object.freeze({
    ordinary: Object.freeze(ordinary.map((definition) => Object.freeze({
      ...definition,
      tool: freezeToolValue(structuredClone(definition.tool)),
      ...(definition.riskProfile && typeof definition.riskProfile !== "function"
        ? { riskProfile: freezeToolValue(structuredClone(definition.riskProfile)) } : {}),
      ...(definition.terminalProjection ? { terminalProjection: freezeToolValue(structuredClone(definition.terminalProjection)) } : {}),
    }))),
    engine: Object.freeze(engine.map((tool) => freezeToolValue(tool))),
  })
}

export function getToolsForChannel(...args: Parameters<typeof selectToolsForChannel>): OpenAI.ChatCompletionFunctionTool[] {
  return toolSelectionSchemas(selectToolsForChannel(...args))
}

export function reduceToolSelection(selection: ToolSelection, requested: readonly OpenAI.ChatCompletionFunctionTool[]): ToolSelection {
  assertUniqueToolSchemas(requested)
  const canonical = toolSelectionSchemas(selection)
  for (const tool of requested) {
    const match = canonical.find((candidate) => candidate.function.name === tool.function.name)
    if (!match || !isDeepStrictEqual(match, tool)) {
      emitNervesEvent({
        level: "warn", component: "tools", event: "tool.selection_rejected",
        message: "tool override is not an exact canonical reduction", meta: { name: tool.function.name },
      })
      throw new ToolSelectionError(`tool selection is not a canonical reduction: ${tool.function.name}`)
    }
  }
  const names = new Set(requested.map((tool) => tool.function.name))
  return Object.freeze({ ordinary: Object.freeze(selection.ordinary.filter((definition) => names.has(definition.tool.function.name))), engine: selection.engine })
}

export function resolveToolDefinition(toolName: string, selection?: ToolSelection): ToolDefinition | undefined {
  return (selection?.ordinary ?? [...baseToolDefinitions, ...additionalDefinitions]).find((definition) => definition.tool.function.name === toolName)
}

export function approvalPolicyForToolName(name: string, args: Record<string, unknown>, selection?: ToolSelection): ToolApprovalPolicy {
  return resolveToolDefinition(name, selection)?.approvalPolicy?.(args) ?? { kind: "not_required" }
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
  const fallback = approvalPolicyForToolName(name, args, ctx?.toolSelection)
  if (name !== "unraid_restart_container" || fallback.kind !== "required") return { policy: fallback }
  const routineActionSelection = await routineActionInvocation(name, args, ctx)
  return routineActionSelection ? { policy: { kind: "not_required" }, routineActionSelection } : { policy: fallback }
}

export async function approvalPolicyForInvocation(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolApprovalPolicy> {
  return (await classifyApprovalForInvocation(name, args, ctx)).policy
}

const findDefinition = resolveToolDefinition

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

export function riskProfileForToolName(name: string, args: Record<string, string>, selection?: ToolSelection): ToolRiskProfile | null {
  const def = findDefinition(name, selection)
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

export async function preflightToolCall(name: string, args: Record<string, string>, ctx?: ToolContext): Promise<
  | { kind: "ready"; definition?: ToolDefinition; agentRoot?: string; friendId?: string }
  | { kind: "rejected_before_handler"; text: string; error?: unknown }
> {
  try {
    const selection = ctx?.toolSelection
    const def = findDefinition(name, selection)
    const schema = def?.tool ?? selection?.engine.find((tool) => tool.function.name === name)
    if (!schema) {
      emitNervesEvent({ level: "error", event: "tool.error", component: "tools", message: "unknown or unselected tool requested", meta: { name } })
      return { kind: "rejected_before_handler", text: `unknown: ${name}` }
    }
    if (selection || ctx?.relationshipAuthorization) {
      const validation = validateAdvertisedToolArguments(JSON.stringify(args), schema.function.parameters ?? {})
      if (!validation.ok) return { kind: "rejected_before_handler", text: `invalid tool arguments: ${validation.reason}` }
    }

    assertRelationshipToolOwner(ctx)
    const relationship = ctx?.relationshipAuthorization
    const decision = await relationship?.authorizeTool(name, args)
    if (decision && (!decision.allowed || !relationship!.advertisedToolNames.includes(name)
      || (decision.profileId !== undefined && decision.profileId !== relationship!.profileId))) {
      const reason = decision.allowed ? "current relationship selection changed" : decision.reason
      emitNervesEvent({
        level: "warn", event: "tool.relationship_authorization_block", component: "tools",
        message: "relationship authorization blocked tool execution", meta: { name, reason },
      })
      return { kind: "rejected_before_handler", text: `relationship authorization required: ${reason}` }
    }

    const currentSelection = ctx?.selectCurrentTools?.()
      ?? (relationship?.profileId?.startsWith("sanctuary-") || (relationship && ctx?.agentName === "sanctuary")
        ? selectToolsForChannel(undefined, undefined, undefined, undefined, undefined, undefined, ctx)
        : undefined)
    const current = currentSelection ? findDefinition(name, currentSelection) : def?.mcpBinding ? def : findDefinition(name)
    const currentSchema = current?.tool ?? currentSelection?.engine.find((tool) => tool.function.name === name)
      ?? (!currentSelection ? selection?.engine.find((tool) => tool.function.name === name) : undefined)
    if (!currentSchema || !isDeepStrictEqual(schema, currentSchema)
      || (def && (!current || (def.mcpBinding
        ? !current.mcpBinding || current.mcpBinding.manager !== def.mcpBinding.manager || !isDeepStrictEqual(current.mcpBinding, def.mcpBinding)
        : current.handler !== def.handler)))) {
      emitNervesEvent({
        level: "warn", event: "tool.selection_rejected", component: "tools",
        message: "selected tool is no longer current", meta: { name },
      })
      return { kind: "rejected_before_handler", text: `rejected: ${name} changed or is no longer available in the current tool selection` }
    }
    if (def?.mcpBinding) {
      if (!ctx?.agentName || !ctx.agentRoot) throw new McpCallRejectedError("MCP requires an explicit owner")
      await def.mcpBinding.manager.validateToolBinding(def.mcpBinding, { agentName: ctx.agentName, agentRoot: ctx.agentRoot })
    }
    if (!def) return { kind: "ready" }

    const risk = riskProfileForTool(def, name, args)
    const orientationPolicy = ctx?.orientationFrame?.actionPolicy
    if (orientationPolicy?.mode === "correction_hold" && orientationPolicyBlocks(risk, orientationPolicy.blockedMutationKinds)) {
      emitNervesEvent({
        level: "warn", event: "tool.orientation_hold_block", component: "tools",
        message: "orientation hold blocked high-risk tool execution",
        meta: { name, mutates: mutationKindsFor(risk), reason: orientationPolicy.reason },
      })
      return { kind: "rejected_before_handler", text: orientationHoldMessage(name, risk, orientationPolicy.reason) }
    }
    const group = ctx?.context && "isGroupChat" in ctx.context ? ctx.context.isGroupChat : undefined
    const guardContext = {
      readPaths: editFileReadTracker, trustLevel: ctx?.context?.friend?.trustLevel,
      agentRoot: ctx?.agentRoot ?? safeGetAgentRoot(), friendId: ctx?.context?.friend?.id,
      ...(def?.mcpServer ? { mcpServerName: def.mcpServer } : {}),
      ...(typeof group === "boolean" ? { isGroupChat: group } : {}),
    }
    const guard = guardInvocation(name, args, guardContext)
    if (!guard.allowed) {
      emitNervesEvent({
        level: "warn", event: "tool.guardrail_block", component: "tools",
        message: "guardrail blocked tool execution", meta: { name, reason: guard.reason },
      })
      return { kind: "rejected_before_handler", text: guard.reason }
    }
    return { kind: "ready", definition: def, agentRoot: guardContext.agentRoot, friendId: guardContext.friendId }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "warn", event: "tool.selection_rejected", component: "tools",
      message: "tool preflight failed before execution", meta: { name, reason: text.slice(0, 2000) },
    })
    return { kind: "rejected_before_handler", text: `rejected: ${text.slice(0, 2000)}`, error }
  }
}

export async function executeTool(
  name: string,
  args: Record<string, string>,
  ctx?: ToolContext,
  executor?: (name: string, args: Record<string, string>, ctx?: ToolContext) => Promise<string>,
): Promise<ToolExecutionOutcome> {
  emitNervesEvent({
    event: "tool.start", component: "tools", message: "tool execution started",
    meta: { name, ...(name === "shell" && args.command ? { command: args.command } : {}) },
  })
  const prepared = await preflightToolCall(name, args, ctx)
  if (prepared.kind !== "ready") return prepared
  const def = prepared.definition
  if (!def) return { kind: "rejected_before_handler", text: `rejected: ${name} is owned by the engine` }
  const guardContext = prepared
  const guardArgs = args

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
    return { kind: "rejected_before_handler", text: `commerce authority required: ${commerceReservation.reason}` }
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
    const result = await (executor ? executor(name, args, toolContext) : def.handler(args, toolContext));
    emitNervesEvent({
      event: "tool.end",
      component: "tools",
      message: "tool execution finished",
      meta: { name, success: true },
    });
    return { kind: "handler_succeeded", text: result };
  } catch (error) {
    emitNervesEvent({
      level: "error",
      event: "tool.error",
      component: "tools",
      message: error instanceof Error ? error.message : String(error),
      meta: { name },
    });
    const text = error instanceof Error ? error.message : String(error)
    return {
      kind: error instanceof McpCallRejectedError ? "rejected_before_handler"
        : error instanceof McpToolExecutionError ? error.kind
        : error instanceof ApprovalExecutionFailedError ? "handler_failed"
        : riskProfileForTool(def, name, args).risk === "high" ? "handler_indeterminate" : "handler_failed",
      text: text.slice(0, 2000), error,
    };
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

export async function execTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
  executor?: (name: string, args: Record<string, string>, ctx?: ToolContext) => Promise<string>,
): Promise<string> {
  // Keep the legacy handler type without coercing schema-validated JSON values.
  const result = await executeTool(name, args as Record<string, string>, ctx, executor)
  if ("error" in result && !(result.error instanceof McpToolExecutionError)) throw result.error
  return result.text
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

export function summarizeArgs(name: string, args: Record<string, string>, selection?: ToolSelection): string {
  const def = findDefinition(name, selection);
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
  selection?: ToolSelection,
): string {
  switch (name) {
    case "edit_file": {
      if (!success) return summarizeArgs(name, args, selection)
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
      return summarizeArgs(name, args, selection)
  }
}
