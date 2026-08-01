import OpenAI from "openai";
import {
  getContextConfig,
} from "./config";
import { loadAgentConfig } from "./identity";
import { execTool, summarizeArgs, buildToolResultSummary, settleTool, observeTool, ponderTool, restTool, speakTool, getToolsForChannel, getRestrictedReactionFeedbackTools, riskProfileForToolName, resolveToolDefinition } from "../repertoire/tools";
import type { HabitSessionToolContext, ToolContext, ToolRiskProfile } from "../repertoire/tools-base";
import { getChannelCapabilities, channelToFacing, type Facing } from "@ouro.bot/friends"
import { surfaceToolDef } from "../repertoire/tools";
import type { AssistantMessageWithReasoning, ResponseItem } from "./streaming";
import { emitNervesEvent } from "../nerves/runtime";
import type { TurnResult } from "./streaming";
import type { UsageData } from "../mind/context";
import { trimMessages } from "../mind/context";
import { applyPromptBudget } from "../mind/prompt-budget";
import { buildSystem, flattenSystemPrompt } from "../mind/prompt";
import type { SystemPrompt } from "../mind/prompt";
import type { McpManager } from "../repertoire/mcp-manager";
import type { Channel } from "../mind/prompt";
import { createKeptNotesJudge, injectKeptNotes } from "./kept-notes";
import { extractProviderErrorDetails, summarizeProviderError } from "./providers/error-classification";
import { createAnthropicProviderRuntime } from "./providers/anthropic";
import { createAzureProviderRuntime } from "./providers/azure";
import { createMinimaxProviderRuntime } from "./providers/minimax";
import { createOpenAICodexProviderRuntime } from "./providers/openai-codex";
import { createGithubCopilotProviderRuntime } from "./providers/github-copilot";
import type { SteeringFollowUpEffect } from "./turn-coordinator";
import type { ActiveWorkFrame } from "./active-work";
import {
  BACKGROUND_ONLY_INSTRUCTION,
  EXPLICIT_PRIOR_WORK_RESUME_INSTRUCTION,
  buildOrientationFrame,
  priorWorkInstruction,
  renderOrientationFrame,
  type OrientationFrame,
} from "./orientation-frame";
import type { DelegationDecision } from "./delegation";
import type { InnerJob } from "./daemon/thoughts";
import { getAgentName, getAgentRoot } from "./identity";
import { requestPrivateWake } from "./daemon/socket-client";
import { createObligation, createReturnObligation, generateObligationId, readReturnObligation } from "../arc/obligations";
import { createToolLoopState, detectToolLoop, recordToolOutcome } from "./tool-loop";
import { advancePonderPacket, createPonderPacket, findHarnessFrictionPacket, revisePonderPacket, type PonderPacket, type PonderPacketKind } from "../arc/packets";
import { createToolFrictionLedger, rewriteToolResultForModel } from "./tool-friction";
import { getDefaultModelForProvider, getProviderModelMismatchMessage } from "./provider-models";
import {
  readProviderCredentialRecord,
  refreshProviderCredentialPool,
  type ProviderCredentialRecord,
} from "./provider-credentials";
import type { ProviderLane } from "./provider-lanes";
import { resolveHabitReturnRoute } from "./habits/habit-session";
import {
  ProviderAttemptAbortError,
  runProviderAttempt,
} from "./provider-attempt";
import type { AgentProviderVisibility } from "./provider-visibility";
import { refreshOpenAICodexProviderCredentials } from "./providers/openai-codex-token";

export type ProviderId = "azure" | "anthropic" | "minimax" | "openai-codex" | "github-copilot";

export type ProviderCapability = "reasoning-effort" | "phase-annotation";

export type ProviderErrorClassification =
  | "auth-failure"
  | "usage-limit"
  | "rate-limit"
  | "server-error"
  | "network-error"
  | "unknown";

export interface CompletionMetadata {
  answer: string;
  intent: "complete" | "blocked" | "direct_reply";
}

export interface ProviderRuntime {
  id: ProviderId;
  model: string;
  client: unknown;
  capabilities: ReadonlySet<ProviderCapability>;
  supportedReasoningEfforts?: readonly string[];
  streamTurn(request: ProviderTurnRequest): Promise<TurnResult>;
  appendToolOutput(callId: string, output: string): void;
  resetTurnState(messages: OpenAI.ChatCompletionMessageParam[]): void;
  /** Minimal API call to verify credentials work. Throws on failure. */
  ping(signal?: AbortSignal): Promise<void>;
  classifyError(error: Error): ProviderErrorClassification;
}

export interface ProviderTurnRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  activeTools: OpenAI.ChatCompletionFunctionTool[];
  callbacks: ChannelCallbacks;
  signal?: AbortSignal;
  traceId?: string;
  toolChoiceRequired?: boolean;
  reasoningEffort?: string;
  eagerSettleStreaming?: boolean;
  /** Structured system prompt for providers that support cache_control (e.g. Anthropic). */
  systemPrompt?: SystemPrompt;
}

interface ProviderRegistry {
  resolve(provider: ProviderId, model: string, credential: ProviderCredentialRecord): ProviderRuntime | null;
}

const _providerRuntimes: Record<Facing, { fingerprint: string; runtime: ProviderRuntime } | null> = {
  human: null,
  agent: null,
};

interface RuntimeProviderBinding {
  lane: ProviderLane;
  provider: ProviderId;
  model: string;
}

function providerLaneForFacing(facing: Facing): ProviderLane {
  return facing === "human" ? "outward" : "inner";
}

function resolveRuntimeProviderBinding(facing: Facing): RuntimeProviderBinding {
  const lane = providerLaneForFacing(facing);
  const config = loadAgentConfig();
  const facingConfig = facing === "human" ? config.humanFacing : config.agentFacing;
  return { lane, provider: facingConfig.provider, model: facingConfig.model };
}

async function getProviderRuntimeFingerprint(facing: Facing): Promise<{ binding: RuntimeProviderBinding; fingerprint: string; credential: ProviderCredentialRecord }> {
  const agentName = getAgentName();
  const binding = resolveRuntimeProviderBinding(facing);
  const credential = await readProviderCredentialRecord(agentName, binding.provider);
  if (!credential.ok) {
    throw new Error([
      `${binding.lane} provider ${binding.provider} (${binding.model}) has no credentials for ${agentName}.`,
      credential.error,
      `Run \`ouro auth --agent ${agentName} --provider ${binding.provider}\`.`,
    ].join("\n"));
  }
  let record = credential.record;
  if (binding.provider === "openai-codex") {
    const refresh = await refreshOpenAICodexProviderCredentials(agentName, {
      record,
      reason: "runtime-init",
    });
    if (refresh.ok) {
      record = refresh.record;
    }
  }
  return {
    binding,
    fingerprint: JSON.stringify({
      lane: binding.lane,
      provider: binding.provider,
      model: binding.model,
      credentialRevision: record.revision,
    }),
    credential: record,
  };
}

export function createProviderRegistry(): ProviderRegistry {
  return {
    resolve(provider: ProviderId, model: string, credential: ProviderCredentialRecord): ProviderRuntime | null {
      const providerConfig = { ...credential.config, ...credential.credentials };
      switch (provider) {
        case "azure":
          return createAzureProviderRuntime(model, providerConfig as unknown as Parameters<typeof createAzureProviderRuntime>[1]);
        case "anthropic":
          return createAnthropicProviderRuntime(model, providerConfig as unknown as Parameters<typeof createAnthropicProviderRuntime>[1]);
        case "minimax":
          return createMinimaxProviderRuntime(model, providerConfig as unknown as Parameters<typeof createMinimaxProviderRuntime>[1]);
        case "openai-codex":
          return createOpenAICodexProviderRuntime(model, providerConfig as unknown as Parameters<typeof createOpenAICodexProviderRuntime>[1]);
        case "github-copilot":
          return createGithubCopilotProviderRuntime(model, providerConfig as unknown as Parameters<typeof createGithubCopilotProviderRuntime>[1]);
      }
    },
  };
}

async function getProviderRuntime(facing: Facing = "human"): Promise<ProviderRuntime> {
  try {
    const { binding, fingerprint, credential } = await getProviderRuntimeFingerprint(facing);
    const cached = _providerRuntimes[facing];
    if (!cached || cached.fingerprint !== fingerprint) {
      const runtime = createProviderRegistry().resolve(binding.provider, binding.model, credential);
      _providerRuntimes[facing] = runtime ? { fingerprint, runtime } : null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitNervesEvent({
      level: "error",
      event: "engine.provider_init_error",
      component: "engine",
      message: msg,
      meta: { facing },
    });
    // eslint-disable-next-line no-console -- pre-boot guard: provider init failure
    console.error(`\n[fatal] ${msg}\n`);
    throw error instanceof Error ? error : new Error(msg);
  }

  if (!_providerRuntimes[facing]) {
    const msg = "provider runtime could not be initialized.";
    emitNervesEvent({
      level: "error",
      event: "engine.provider_init_error",
      component: "engine",
      message: msg,
      meta: { facing },
    });
    // eslint-disable-next-line no-console -- pre-boot guard: provider init failure
    console.error(`\n[fatal] ${msg}\n`);
    throw new Error(msg);
  }
  return _providerRuntimes[facing]!.runtime;
}

/**
 * Clear the cached provider runtime so the next access re-creates it from
 * current config. Runtime access also auto-refreshes when the selected
 * provider fingerprint changes on disk.
 */
export function resetProviderRuntime(): void {
  _providerRuntimes.human = null;
  _providerRuntimes.agent = null;
}

export function getModel(facing: Facing = "human"): string {
  return resolveRuntimeProviderBinding(facing).model;
}

export function getProvider(facing: Facing = "human"): ProviderId {
  return resolveRuntimeProviderBinding(facing).provider;
}

export function createSummarize(facing: Facing = "human"): (transcript: string, instruction: string) => Promise<string> {
  return async (transcript: string, instruction: string): Promise<string> => {
    const runtime = await getProviderRuntime(facing)
    const client = runtime.client as OpenAI
    const response = await client.chat.completions.create({
      model: runtime.model,
      messages: [
        { role: "system", content: instruction },
        { role: "user", content: transcript },
      ],
      max_tokens: 500,
    })
    return response.choices?.[0]?.message?.content ?? transcript
  }
}

export function getProviderDisplayLabel(facing: Facing = "human"): string {
  const binding = resolveRuntimeProviderBinding(facing);
  const provider = binding.provider;
  const model = binding.model || "unknown";
  const providerLabelBuilders: Record<ProviderId, () => string> = {
    azure: () => {
      return `azure openai (model: ${model})`
    },
    anthropic: () => `anthropic (${model})`,
    minimax: () => `minimax (${model})`,
    "openai-codex": () => `openai codex (${model})`,
    /* v8 ignore next -- branch: tested via display label unit test @preserve */
    "github-copilot": () => `github copilot (${model})`,
  };
  return providerLabelBuilders[provider]();
}


export interface ChannelCallbacks {
  onModelStart(): void;
  onModelStreamStart(): void;
  onTextChunk(text: string): void;
  onReasoningChunk(text: string): void;
  onToolStart(name: string, args: Record<string, string>): void;
  onToolEnd(name: string, summary: string, success: boolean): void;
  /** Called after each tool result is pushed to messages. Use for incremental session persistence. */
  onToolResult?(messages: OpenAI.ChatCompletionMessageParam[]): void;
  onError(error: Error, severity: "transient" | "terminal"): void;
  onKick?(): void;
  // Clear any buffered text accumulated during streaming. Called before emitting
  // the settle answer so streamed noise (e.g. refusal text) is discarded.
  onClearText?(): void;
  /** Deliver any buffered output to the friend now. Called by the `speak` tool
   *  to push mid-turn messages immediately rather than waiting for the natural
   *  end-of-turn flush. Senses with no buffering (e.g. CLI) implement as noop.
   *
   *  Contract: best-effort delivery. THROWS if the message could not be delivered
   *  through any available path (e.g. Teams when both stream emit AND sendMessage
   *  fallback fail; BlueBubbles when client.sendText rejects). The engine catches
   *  these throws to mark the speak tool call as failed and tell the agent the
   *  message did NOT reach the friend — preventing the agent from assuming
   *  silent success when delivery actually failed. */
  flushNow?(): void | Promise<void>;
}

type HabitBufferedCallbackEvent =
  | { kind: "stream-start" }
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "clear" }
  | { kind: "flush" };

export interface HabitCallbackBuffer {
  callbacks: ChannelCallbacks;
  flush(): Promise<void>;
  discard(): void;
}

export function createHabitCallbackBuffer(callbacks: ChannelCallbacks): HabitCallbackBuffer {
  const events: HabitBufferedCallbackEvent[] = [];
  return {
    callbacks: {
      ...callbacks,
      onModelStreamStart: () => { events.push({ kind: "stream-start" }) },
      onTextChunk: (text) => { events.push({ kind: "text", text }) },
      onReasoningChunk: (text) => { events.push({ kind: "reasoning", text }) },
      onClearText: () => { events.push({ kind: "clear" }) },
      flushNow: () => { events.push({ kind: "flush" }) },
    },
    async flush(): Promise<void> {
      for (const event of events.splice(0)) {
        switch (event.kind) {
          case "stream-start":
            callbacks.onModelStreamStart();
            break;
          case "text":
            callbacks.onTextChunk(event.text);
            break;
          case "reasoning":
            callbacks.onReasoningChunk(event.text);
            break;
          case "clear":
            callbacks.onClearText?.();
            break;
          case "flush":
            await callbacks.flushNow?.();
            break;
        }
      }
    },
    discard(): void {
      events.splice(0);
    },
  };
}

export interface RunAgentOptions {
  toolChoiceRequired?: boolean;
  toolContext?: ToolContext;
  traceId?: string;
  bridgeContext?: string;
  currentSessionKey?: string;
  currentObligation?: string;
  mustResolveBeforeHandoff?: boolean;
  hasQueuedFollowUp?: boolean;
  activeWorkFrame?: ActiveWorkFrame;
  delegationDecision?: DelegationDecision;
  drainSteeringFollowUps?: () => Array<{ text: string; effect?: SteeringFollowUpEffect }>;
  setMustResolveBeforeHandoff?: (value: boolean) => void;
  tools?: OpenAI.ChatCompletionFunctionTool[];
  execTool?: (name: string, args: Record<string, string>, ctx?: ToolContext) => Promise<string>;
  mcpManager?: McpManager;
  /** When true, the observe tool is available in 1:1 chats (normally group-only).
   *  Used for reaction/feedback signals where silence is natural even in DMs. */
  isReactionSignal?: boolean;
  /** One-inference, read-only terminal mode for trusted feedback reactions. */
  restrictedReactionFeedback?: boolean;
  /** Pending messages from other sessions/private runtime, rendered in system prompt. */
  pendingMessages?: Array<{ from: string; content: string }>;
  /** Rendered start-of-turn packet for continuity-aware prompt. */
  startOfTurnPacket?: string;
  /** Skip pre-model kept-note judging for latency-critical live senses. */
  skipKeptNotes?: boolean;
  /** Safe provider/model/readiness view for this machine. */
  providerVisibility?: AgentProviderVisibility;
  /** Structured orientation frame for the current inbound turn. */
  orientationFrame?: OrientationFrame;
  /** Structured continuity control; user text never sets this flag. */
  resumePriorWork?: boolean;
  /** Habit-session policy envelope for private habit turns. */
  habitSession?: HabitSessionToolContext;
  /** Content-free same-turn context packet ids linked to this provider run. */
  contextPacketIds?: string[];

  // ── Pre-read state from TurnContext ─────────────────────────────
  /** Whether the daemon socket is alive. When provided, skips the fs check. */
  daemonRunning?: boolean;
  /** Pre-read sense status lines. When provided, skips local derivation. */
  senseStatusLines?: string[];
  /** Pre-read bundle-meta.json. When provided, skips the fs read. */
  bundleMeta?: import("../mind/bundle-manifest").BundleMeta | null;
  /** Pre-read daemon health state. When provided, skips the health file read. */
  daemonHealth?: import("./daemon/daemon-health").DaemonHealthState | null;
  /** Pre-read Arc flight-recorder resume. When provided, renders deterministic continuation state. */
  flightRecorderResume?: import("../arc/flight-recorder").FlightRecorderResume;
}

/**
 * Strip <think>...</think> blocks for the violation-detection check at the
 * end of a streaming turn. Used to tell legitimate text-only responses
 * apart from the MiniMax-M2.7 "only thinking, no tool call" violation
 * shape. Mirrors the more thorough stripThinkBlocks helper in
 * senses/shared-turn.ts (which is for operator-facing output) — kept
 * inline here to avoid pulling senses/ into the core module's import graph.
 */
function stripThinkBlocksForViolationCheck(input: string): string {
  let out = input
  for (;;) {
    const open = out.indexOf("<think>")
    if (open === -1) break
    const close = out.indexOf("</think>", open + "<think>".length)
    if (close === -1) {
      out = out.slice(0, open)
      break
    }
    out = out.slice(0, open) + out.slice(close + "</think>".length)
  }
  return out.trim()
}

function hasFreshPendingWork(options?: RunAgentOptions): boolean {
  const pendingMessages = options?.pendingMessages
  if (!Array.isArray(pendingMessages)) return false
  return pendingMessages.some((message) =>
    typeof message?.content === "string"
    && message.content.trim().length > 0,
  )
}

const HABIT_CONTROL_TOOLS = new Set(["rest", "ponder", "observe"])

function habitToolArgs(call: { name: string; arguments: string }): { ok: true; args: Record<string, string> } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(call.arguments)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `habit tool '${call.name}' arguments must be a JSON object` }
    }
    return { ok: true, args: parsed as Record<string, string> }
  } catch {
    return { ok: false, reason: `habit tool '${call.name}' has malformed JSON arguments` }
  }
}

function highRiskExternalMutation(profile: ToolRiskProfile): string | null {
  if (profile.risk !== "high") return null
  const mutates = typeof profile.mutates === "string" ? [profile.mutates] : [...profile.mutates]
  return mutates.includes("external_side_effect") ? mutates.join(", ") : null
}

function recordBlockedHabitSurfaceAttempts(
  habitSession: HabitSessionToolContext | undefined,
  toolCalls: Array<{ name: string; arguments: string }>,
  reason: string,
): void {
  if (toolCalls.some((call) => call.name !== "send_message" && call.name !== "surface")) {
    habitSession?.recordError?.(`blocked habit tool batch: ${reason}`)
  }
  if (!habitSession?.recordSurfaceAttempt) return
  for (const call of toolCalls) {
    if (call.name !== "send_message" && call.name !== "surface") continue
    const parsed = habitToolArgs(call)
    const args = parsed.ok ? parsed.args : {}
    habitSession.recordSurfaceAttempt({
      recipient: String(args.friendId ?? args.delegationId ?? "unknown"),
      channel: String(args.channel ?? call.name),
      reason: "blocked",
      result: "blocked",
      rawStatus: "blocked",
      error: reason,
    })
  }
}

async function habitToolBatchBlockReason(
  habitSession: HabitSessionToolContext | undefined,
  toolCalls: Array<{ name: string; arguments: string }>,
  delegatedOrigins: ToolContext["delegatedOrigins"] | undefined,
  activeToolNames: ReadonlySet<string>,
): Promise<string | null> {
  if (!habitSession) return null
  const granted = new Set(habitSession.toolPolicy.grantedTools)
  const denied = new Set(habitSession.toolPolicy.deniedTools)
  for (const call of toolCalls) {
    if (denied.has(call.name)) return `habit tool '${call.name}' is denied by this habit session`
    if (!activeToolNames.has(call.name)) return `habit tool '${call.name}' was not advertised to this model turn`
    if (HABIT_CONTROL_TOOLS.has(call.name)) continue
    if (!granted.has(call.name)) return `habit tool '${call.name}' was not granted to this habit session`
    const parsed = habitToolArgs(call)
    if (!parsed.ok) return parsed.reason
    const riskProfile = riskProfileForToolName(call.name, parsed.args)
    if (!riskProfile) return `habit tool '${call.name}' does not have a known executable risk profile`
    const externalMutation = highRiskExternalMutation(riskProfile)
    if (externalMutation && call.name !== "send_message" && call.name !== "surface") {
      return `habit tool '${call.name}' has high-risk executable mutation ${externalMutation}: ${riskProfile.reason}`
    }
    if (call.name === "send_message" || call.name === "surface") {
      const route = await resolveHabitReturnRoute({
        agentRoot: getAgentRoot(),
        envelope: habitSession.permissionEnvelope,
        toolName: call.name,
        args: parsed.args,
        friendStore: habitSession.friendStore,
        delegatedOrigins,
      })
      if (!route.allowed) return route.reason
    }
  }
  return null
}

export type RunAgentOutcome =
  | "settled"
  | "blocked"
  | "superseded"
  | "aborted"
  | "errored"
  | "observed"
  | "rested";

/** Chat-style channels expose the `speak` tool — outer human-conversation channels
 *  where mid-turn delivery is meaningful. The private runtime has `ponder`. MCP returns
 *  synchronously. Mail is batch. Anything else (unknown channel) treats as non-chat. */
export function isChatStyleChannel(channel: string): boolean {
  return channel === "cli" || channel === "teams" || channel === "bluebubbles" || channel === "voice";
}

function bindCurrentIngressEvidenceLocator(
  toolList: OpenAI.ChatCompletionFunctionTool[],
  evidence: ToolContext["currentIngressEvidence"],
): OpenAI.ChatCompletionFunctionTool[] {
  if (
    !evidence
    || evidence.schemaVersion !== 1
    || evidence.provider !== "bluebubbles"
    || !/^[a-f0-9]{64}$/.test(evidence.captureKeyHash)
  ) return toolList
  const locator = `capture:${evidence.captureKeyHash}`
  return toolList.map((tool) => {
    if (tool.function.name !== "habit_cancel") return tool
    const parameters = tool.function.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, Record<string, unknown>>
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            evidence: {
              ...properties.evidence,
              enum: [locator],
            },
          },
        },
      },
    }
  })
}

// Sole-call tools must be the only tool call in a turn. When they appear
// alongside other tools, the sole-call tool is rejected with this message.
const SOLE_CALL_REJECTION: Record<string, string> = {
  settle: "rejected: settle must be the only tool call. finish your work first, then call settle alone.",
  observe: "rejected: observe must be the only tool call. call observe alone when you want to stay silent.",
  rest: "rejected: rest must be the only tool call. finish your work first, then call rest alone.",
};

type SettleIntent = "complete" | "blocked" | "direct_reply";

type PonderAction = "create" | "revise";

interface ParsedPonderArgs {
  action?: PonderAction
  kind?: PonderPacketKind
  packet_id?: string
  follows_packet_id?: string
  objective?: string
  summary?: string
  success_criteria?: string
  payload_json?: string
  thought?: string
  say?: string
}

function parseSettlePayload(argumentsText: string): { answer?: string; intent?: SettleIntent } {
  try {
    const parsed = JSON.parse(argumentsText);
    if (typeof parsed === "string") {
      return { answer: parsed };
    }
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const answer = typeof parsed.answer === "string" ? parsed.answer : undefined;
    const rawIntent = parsed.intent;
    const intent = rawIntent === "complete" || rawIntent === "blocked" || rawIntent === "direct_reply"
      ? rawIntent
      : undefined;
    return { answer, intent };
  } catch {
    return {};
  }
}

function matchesRegisteredToolArgumentSchema(
  tool: OpenAI.ChatCompletionFunctionTool,
  args: Record<string, unknown>,
): boolean {
  const parameters = tool.function.parameters as {
    required?: string[]
    properties: Record<string, { type?: string; enum?: unknown[] }>
  }
  for (const requiredKey of parameters.required ?? []) {
    if (!(requiredKey in args)) return false
  }
  for (const [key, property] of Object.entries(parameters.properties)) {
    const value = args[key]
    if (value === undefined) continue
    if (property.type === "string" && typeof value !== "string") return false
    if (property.enum && !property.enum.includes(value)) return false
  }
  return true
}

function parsePonderPayload(argumentsText: string): ParsedPonderArgs {
  try {
    const parsed = JSON.parse(argumentsText)
    return parsed && typeof parsed === "object" ? parsed as ParsedPonderArgs : {}
  } catch {
    return {}
  }
}

function parseSuccessCriteria(raw: string | undefined): string[] | null {
  if (typeof raw !== "string") return null
  const criteria = raw
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => line.length > 0)
  return criteria.length > 0 ? criteria : null
}

function parsePacketPayload(raw: string | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function normalizeLegacyPonderArgs(parsed: ParsedPonderArgs): ParsedPonderArgs {
  if (typeof parsed.thought !== "string" || parsed.thought.trim().length === 0) {
    return parsed
  }

  return {
    action: "create",
    kind: "reflection",
    objective: parsed.thought.trim(),
    summary: typeof parsed.say === "string" ? parsed.say.trim() : "",
    success_criteria: "- preserve the thread for later work",
    payload_json: "{}",
  }
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      const maybeText = (part as { text?: unknown }).text
      return typeof maybeText === "string" ? maybeText : ""
    })
    .filter(Boolean)
    .join("\n")
}

function isHarnessCorrectiveUserText(text: string): boolean {
  return text.startsWith("no tool was called this turn. you must end every turn")
    || text.startsWith("private-return acknowledgement claimed work was queued, but no ponder packet was created this turn.")
}

function latestUserMessageText(messages: OpenAI.ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== "user") continue
    const text = messageContentText(message.content).trim()
    if (isHarnessCorrectiveUserText(text)) continue
    if (text.length > 0) return text
  }
  return ""
}

function truncatePonderDelegatedContent(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function buildPonderDelegatedContent(input: {
  objective: string
  summary: string
  sourceRequest: string
}): string {
  const primary = (input.summary || input.objective).trim()
  const sourceRequest = input.sourceRequest.trim()
  if (!sourceRequest || sourceRequest === primary || sourceRequest === input.objective.trim()) {
    return truncatePonderDelegatedContent(primary)
  }
  return truncatePonderDelegatedContent(`${primary}\nsource request: ${sourceRequest}`)
}

function looksLikePrivateReturnRequest(text: string): boolean {
  const normalized = text.toLowerCase()
  return /\b(private|privately|private-attention|think|reflect|reflection)\b/.test(normalized)
    && /\b(return|bring back|come back|surface|report back)\b/.test(normalized)
}

function extractPrivateReturnHeldTokens(text: string): string[] {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g)) {
    const token = match[0]
    if (token.length >= 8) tokens.add(token)
  }
  return [...tokens]
}

function privateReturnAckLeakError(answer: string | undefined, heldTokens: ReadonlySet<string>): string | null {
  if (!answer || heldTokens.size === 0) return null
  for (const token of heldTokens) {
    if (answer.includes(token)) {
      return "private return is queued; do not repeat private markers or requested private-return content in the outward acknowledgement. Say only that the private pass is queued and will return when ready."
    }
  }
  return null
}

function claimsPrivateReturnQueued(answer: string | undefined): boolean {
  if (!answer) return false
  const normalized = answer.toLowerCase()
  return /\b(queued|queue|will return|return when|when .*complete|when .*completes|private pass|private runtime completes|inner dialog completes|later)\b/.test(normalized)
    && /\b(private|inner|return|queued|later)\b/.test(normalized)
}

function privateReturnMissingPonderError(input: {
  latestUserRequest: string
  answer: string | undefined
  sawPonder: boolean
}): string | null {
  if (input.sawPonder) return null
  if (!looksLikePrivateReturnRequest(input.latestUserRequest)) return null
  if (!claimsPrivateReturnQueued(input.answer)) return null
  return "private-return acknowledgement claimed work was queued, but no ponder packet was created this turn. Call ponder(action=create, ...) first so the return has a packet, return obligation, and private-runtime wake; then settle with only a queued acknowledgement. If you cannot create the packet, ask a blocking clarification without saying it is queued."
}

function activeReturnObligationId(agentName: string, obligationId: string | undefined): string | null {
  if (!obligationId) return null
  const obligation = readReturnObligation(agentName, obligationId)
  return obligation?.status === "queued" || obligation?.status === "running" ? obligationId : null
}

function ponderReturnSessionId(packet: PonderPacket): string {
  const origin = packet.origin
  if (!origin) return "unknown/unknown/unknown"
  return `${origin.friendId}/${origin.channel}/${origin.key}`
}

function buildPonderReturnPrivateWakeOptions(input: {
  agentName: string
  packet: PonderPacket
  returnObligationId: string
}) {
  const sessionId = ponderReturnSessionId(input.packet)
  return {
    reason: "ponder return obligation private attention",
    triggerSource: "ponder-return-obligation",
    budgetClass: "interactive",
    idempotencyKey: `ponder-return:${input.agentName}:${input.returnObligationId}:${input.packet.id}:${sessionId}`,
    originRefs: [
      { kind: "tool", id: "ponder" },
      { kind: "ponder-packet", id: input.packet.id },
      { kind: "return-obligation", id: input.returnObligationId },
      { kind: "session", id: sessionId },
    ],
  }
}

export function buildPonderResult(
  packet: PonderPacket,
  action: "created" | "revised",
  returnObligationId: string | null,
): string {
  return JSON.stringify({
    ok: true,
    packet_id: packet.id,
    action,
    status: packet.status,
    return_obligation_id: returnObligationId,
    private_return_contract: returnObligationId
      ? "queued for private-runtime attention; do not present the requested private answer as complete in this same outward turn. if you answer now, only say the private pass is queued and will return when ready."
      : null,
  }, null, 2)
}

/** Returns true when a tool call queries external state (GitHub, npm registry). */
export function isExternalStateQuery(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== "shell") return false;
  const cmd = String(args.command ?? "");
  return /\bgh\s+(pr|run|api|issue)\b/.test(cmd) || /\bnpm\s+(view|info|show)\b/.test(cmd);
}

export function getSettleRetryError(
  mustResolveBeforeHandoff: boolean,
  intent: SettleIntent | undefined,
  sawSteeringFollowUp: boolean,
  _delegationDecision?: DelegationDecision,
  sawSendMessageSelf?: boolean,
  sawPonder?: boolean,
  _sawQuerySession?: boolean,
  currentObligation?: string | null,
  innerJob?: InnerJob,
  _sawExternalStateQuery?: boolean,
): string | null {
  // Delegation adherence removed: the delegation decision is surfaced in the
  // system prompt as a suggestion. Hard-gating settle caused infinite
  // rejection loops where the agent couldn't respond to the user at all.
  // The agent is free to follow or ignore the delegation hint.
  // 2. Pending obligation not addressed
  if (innerJob?.obligationStatus === "pending" && !sawSendMessageSelf && !sawPonder) {
    return "you're still holding something from an earlier conversation -- someone is waiting for your answer. finish the thought first, or ponder to keep working on it privately.";
  }
  // 3. mustResolveBeforeHandoff + missing intent
  if (mustResolveBeforeHandoff && !intent) {
    return "your settle is missing required intent. when you must keep going until done or blocked, call settle again with answer plus intent=complete, blocked, or direct_reply.";
  }
  // 4. mustResolveBeforeHandoff + direct_reply without follow-up
  if (mustResolveBeforeHandoff && intent === "direct_reply" && !sawSteeringFollowUp) {
    return "your settle used intent=direct_reply without a newer steering follow-up. continue the unresolved work, or call settle again with intent=complete or blocked when appropriate.";
  }
  // 5. mustResolveBeforeHandoff + complete while a live return loop is still active
  if (mustResolveBeforeHandoff && intent === "complete" && currentObligation && !sawSteeringFollowUp) {
    return "you still owe the live session a visible return on this work. don't end the turn yet — continue until you've brought back the external-state update, or use intent=blocked with the concrete blocker.";
  }
  return null;
}


function upsertSystemPrompt(
  messages: OpenAI.ChatCompletionMessageParam[],
  systemText: string,
): void {
  const systemMessage: OpenAI.ChatCompletionSystemMessageParam = { role: "system", content: systemText };
  if (messages[0]?.role === "system") {
    messages[0] = systemMessage;
  } else {
    messages.unshift(systemMessage);
  }
}

const CURRENT_TRIGGER_HEADING = "## Current trigger (authoritative)";
const FALLBACK_ORIENTATION_HEADINGS = new Set([
  CURRENT_TRIGGER_HEADING,
  "## orientation frame",
]);

function isFallbackPromptSectionBoundary(line: string): boolean {
  return line.startsWith("# ")
    || line.startsWith("## ")
    || /^\*\*[^*]+:\*\*(?:\s.*)?$/.test(line);
}

/**
 * A prompt refresh failure must not turn the previous turn's trigger back into
 * authority. Preserve the usable prompt around it, remove every stale trigger
 * section, normalise prior-work labels to the current structured resume flag,
 * and put the freshly derived trigger first.
 */
function repairFallbackSystemPrompt(
  existingSystemText: string | undefined,
  orientationFrame: OrientationFrame,
  resumePriorWork: boolean,
): string {
  const fallbackBase = existingSystemText ?? "You are a helpful assistant.";
  const retainedLines: string[] = [];
  let skippingCurrentTrigger = false;

  for (const line of fallbackBase.split("\n")) {
    if (FALLBACK_ORIENTATION_HEADINGS.has(line)) {
      skippingCurrentTrigger = true;
      continue;
    }
    if (skippingCurrentTrigger) {
      if (!isFallbackPromptSectionBoundary(line)) continue;
      skippingCurrentTrigger = false;
    }
    retainedLines.push(line);
  }

  const currentPriorWorkInstruction = priorWorkInstruction(resumePriorWork);
  const repairedBase = retainedLines
    .map((line) => (
      line === BACKGROUND_ONLY_INSTRUCTION || line === EXPLICIT_PRIOR_WORK_RESUME_INSTRUCTION
        ? currentPriorWorkInstruction
        : line
    ))
    .join("\n")
    .trim();

  return `${renderOrientationFrame(orientationFrame)}\n\n${repairedBase}`;
}

// Remove orphan tool_calls from the last assistant message and any
// trailing tool-result messages that lack a matching tool_call.
// This keeps the conversation valid after an abort or tool-loop limit.
export function stripLastToolCalls(
  messages: OpenAI.ChatCompletionMessageParam[],
): void {
  // Pop any trailing tool-result messages
  while (messages.length && messages[messages.length - 1].role === "tool") {
    messages.pop();
  }
  // Strip tool_calls from the last assistant message
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    const asst = last as OpenAI.ChatCompletionAssistantMessageParam;
    if (asst.tool_calls) {
      delete asst.tool_calls;
      // If the assistant message is now empty, remove it entirely
      if (!asst.content) messages.pop();
    }
  }
}

// Roles that end a tool-result scan. When scanning forward from an assistant
// message, stop at the next assistant or user message (tool results must be
// adjacent to their originating assistant message).
const TOOL_SCAN_BOUNDARY_ROLES: ReadonlySet<string> = new Set(["assistant", "user"])

// Repair orphaned tool_calls and tool results anywhere in the message history.
// 1. If an assistant message has tool_calls but missing tool results, inject synthetic error results.
// 2. If a tool result's tool_call_id doesn't match any tool_calls in a preceding assistant message, remove it.
// This prevents 400 errors from the API after an aborted turn.
//
// Position-aware: a tool result is orphaned when its tool_call_id hasn't been
// defined by an assistant message AT THIS POSITION yet. MiniMax-M2.7 reuses
// canonical tool_call_ids across turns, so the global-set check that this
// function used previously kept misordered tool results that MiniMax then
// rejected with error 2013 ("tool result's tool id not found"). Walking
// in order matches what MiniMax actually enforces.
export function repairOrphanedToolCalls(
  messages: OpenAI.ChatCompletionMessageParam[],
): void {
  // Pass 1: walk in order, accumulate seen tool_call_ids per-position, and
  // mark tool results for removal if their id hasn't been defined yet.
  const seenCallIds = new Set<string>();
  const removeIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const asst = msg as OpenAI.ChatCompletionAssistantMessageParam;
      if (asst.tool_calls) {
        for (const tc of asst.tool_calls) seenCallIds.add(tc.id);
      }
      continue;
    }
    if (msg.role === "tool") {
      const toolMsg = msg as OpenAI.ChatCompletionToolMessageParam;
      if (!seenCallIds.has(toolMsg.tool_call_id)) {
        removeIndices.push(i);
      }
    }
  }
  // Splice from the end so earlier indices stay valid.
  for (let i = removeIndices.length - 1; i >= 0; i--) {
    messages.splice(removeIndices[i]!, 1);
  }

  // Pass 3: inject synthetic results for tool_calls missing their tool results
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const asst = msg as OpenAI.ChatCompletionAssistantMessageParam;
    if (!asst.tool_calls || asst.tool_calls.length === 0) continue;

    // Collect tool result IDs that follow this assistant message
    const resultIds = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const following = messages[j];
      if (following.role === "tool") {
        resultIds.add((following as OpenAI.ChatCompletionToolMessageParam).tool_call_id);
      } else if (TOOL_SCAN_BOUNDARY_ROLES.has(following.role)) {
        break;
      }
    }

    const missing = asst.tool_calls.filter((tc) => !resultIds.has(tc.id));
    if (missing.length > 0) {
      // AX rule: the agent must see what happened. Don't say "interrupted"
      // — that's vague. Tell them the result was lost, possible causes,
      // and what to do next.
      const syntheticResults: OpenAI.ChatCompletionToolMessageParam[] = missing.map((tc) => ({
        role: "tool" as const,
        tool_call_id: tc.id,
        content: "error: this tool call's result was lost — the previous turn ended before the tool finished (provider rejection, daemon interrupt, or the tool itself errored). if the work needs to be done, retry the tool call now.",
      }));
      let insertAt = i + 1;
      while (insertAt < messages.length && messages[insertAt].role === "tool") insertAt++;
      messages.splice(insertAt, 0, ...syntheticResults);
    }
  }
}

// Detect context overflow errors from Azure or MiniMax
function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  const msg = err.message || "";
  if (code === "context_length_exceeded") return true;
  if (msg.includes("context_length_exceeded")) return true;
  if (msg.includes("context window exceeds limit")) return true;
  return false;
}

const RETRY_LABELS: Record<ProviderErrorClassification, string> = {
  "auth-failure": "auth error",
  "usage-limit": "usage limit",
  "rate-limit": "rate limited",
  "server-error": "server error",
  "network-error": "network error",
  "unknown": "error",
};

function waitForProviderRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs)
    })
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ProviderAttemptAbortError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)

    if (signal.aborted) {
      onAbort()
      return
    }

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function buildAuthFailureGuidance(provider: ProviderId, model: string, agentName: string, detail: string): string {
  const mismatch = getProviderModelMismatchMessage(provider, model)
  const modelLabel = model
    ? mismatch
      ? `${provider} [configured model: ${model}]`
      : `${provider} (${model})`
    : provider
  const lines = [`${modelLabel} authentication failed.`]
  const cleanDetail = detail.replace(/\s+/g, " ").trim()
  if (cleanDetail) lines.push(`provider detail: ${cleanDetail.length > 300 ? `${cleanDetail.slice(0, 297)}...` : cleanDetail}`)

  lines.push("")
  lines.push("To keep using this provider:")
  lines.push(`  1. Run \`ouro auth --agent ${agentName} --provider ${provider}\``)

  if (mismatch) {
    const defaultModel = getDefaultModelForProvider(provider)
    lines.push("")
    lines.push("Config warning:")
    lines.push(`  - ${mismatch}`)
    lines.push("  - Repair the configured model with:")
    lines.push(`    \`ouro use --agent ${agentName} --lane outward --provider ${provider} --model ${defaultModel}\``)
    lines.push(`    \`ouro use --agent ${agentName} --lane inner --provider ${provider} --model ${defaultModel}\``)
  }

  lines.push("")
  lines.push(`To use another configured provider instead, run \`ouro use --agent ${agentName} --lane <outward|inner> --provider <provider> --model <model>\`.`)
  return lines.join("\n")
}

export async function runAgent(
  messages: OpenAI.ChatCompletionMessageParam[],
  callbacks: ChannelCallbacks,
  channel?: Channel,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<{ usage?: UsageData; outcome: RunAgentOutcome; completion?: CompletionMetadata; error?: Error; errorClassification?: ProviderErrorClassification }> {
  const facing = channelToFacing(channel);
  let providerRuntime = await getProviderRuntime(facing);
  const provider = providerRuntime.id;
  const restrictedReactionFeedback = options?.restrictedReactionFeedback === true;
  const toolChoiceRequired = restrictedReactionFeedback ? true : options?.toolChoiceRequired ?? true;
  const traceId = options?.traceId;
  emitNervesEvent({
    event: "engine.turn_start",
    trace_id: traceId,
    component: "engine",
    message: "runAgent turn started",
    meta: { channel: channel ?? "unknown", provider },
  });

  // Per-turn friend refresh: re-read friend record from disk for fresh context
  const friendStore = options?.toolContext?.friendStore;
  const friendId = options?.toolContext?.context?.friend?.id;
  let currentContext = options?.toolContext?.context;

  if (friendStore && friendId) {
    const freshFriend = await friendStore.get(friendId);
    if (freshFriend) {
      currentContext = { ...currentContext!, friend: freshFriend };
    }
  }

  const turnOrientationFrame = options?.orientationFrame
    ?? (channel ? buildOrientationFrame({ channel, messages }) : undefined);

  // Refresh system prompt at start of each turn when channel is provided.
  // If refresh fails, keep existing system prompt (or inject a minimal safe fallback)
  // so turn execution remains consistent and non-fatal.
  let structuredSystemPrompt: SystemPrompt | undefined;
  if (channel) {
    try {
      const buildSystemOptions = {
        ...options,
        orientationFrame: turnOrientationFrame,
        resumePriorWork: options?.resumePriorWork === true,
        providerCapabilities: providerRuntime.capabilities,
        supportedReasoningEfforts: providerRuntime.supportedReasoningEfforts,
      };
      const refreshed = await buildSystem(channel, buildSystemOptions, currentContext);
      structuredSystemPrompt = refreshed;
      upsertSystemPrompt(messages, flattenSystemPrompt(refreshed));
    } catch (error) {
      const hadExistingSystemPrompt = messages[0]?.role === "system" && typeof messages[0].content === "string";
      const existingSystemText = hadExistingSystemPrompt ? (messages[0].content as string) : undefined;
      const fallback = repairFallbackSystemPrompt(
        existingSystemText,
        turnOrientationFrame!,
        options?.resumePriorWork === true,
      );
      upsertSystemPrompt(messages, fallback);
      emitNervesEvent({
        level: "warn",
        event: "mind.step_error",
        trace_id: traceId,
        component: "mind",
        message: "buildSystem refresh failed; using fallback prompt",
        meta: {
          channel,
          reason: error instanceof Error ? error.message : String(error),
          used_existing_prompt: hadExistingSystemPrompt,
        },
      });
    }
  }

  if (channel && options?.skipKeptNotes !== true) {
    await injectKeptNotes(messages, {
      channel,
      friend: currentContext?.friend,
      judge: async (input) => createKeptNotesJudge(await getProviderRuntime("agent"), signal)(input),
      signal,
      traceId,
    });
  }

  let done = false;
  let lastUsage: UsageData | undefined;
  let overflowRetried = false;
  let outcome: RunAgentOutcome = "settled";
  let completion: CompletionMetadata | undefined;
  let terminalError: Error | undefined;
  let terminalErrorClassification: ProviderErrorClassification | undefined;
  let sawSteeringFollowUp = false;
  let mustResolveBeforeHandoffActive = options?.mustResolveBeforeHandoff === true;
  let currentReasoningEffort = "medium";
  let sawSendMessageSelf = false;
  let sawPonder = false;
  let sawQuerySession = false;
  let sawBridgeManage = false;
  let sawExternalStateQuery = false;
  const privateReturnHeldTokens = new Set<string>();
  // Once-per-turn flag for the fresh-work rest gate. Without this, an agent
  // that called rest, was told "fresh work arrived", processed the items,
  // and called rest again would get the same message forever — the gate
  // condition is read from the turn-start snapshot of pendingMessages,
  // which doesn't update mid-turn. The agent only needs to be told once;
  // after that, repeated rest attempts mean they've acknowledged.
  let freshWorkGateFired = false;
  // Counter for no-tool-call violations. MiniMax reasoning models occasionally
  // emit only a <think>...</think> block and stop, without any tool call — even
  // when tool_choice is set to "required". Private-return requests also need
  // a hard no-tool guard: a text-only "queued" acknowledgement is false unless
  // a ponder packet created the return obligation in this turn.
  let noToolCallRetries = 0;
  const NO_TOOL_CALL_MAX_RETRIES = 2;
  const toolLoopState = createToolLoopState();
  const toolFrictionLedger = createToolFrictionLedger();
  const finishTerminalProviderError = (error: Error, classification: ProviderErrorClassification): void => {
    terminalError = error;
    terminalErrorClassification = classification;

    /* v8 ignore start — auth-failure guidance: tested via provider error classification tests @preserve */
    if (terminalErrorClassification === "auth-failure") {
      const agentName = getAgentName()
      const currentProvider = providerRuntime.id
      callbacks.onError(new Error(buildAuthFailureGuidance(
        currentProvider,
        providerRuntime.model,
        agentName,
        terminalError.message,
      )), "terminal")
    } else {
      callbacks.onError(terminalError, "terminal");
    }
    /* v8 ignore stop */

    const errorDetails = extractProviderErrorDetails(terminalError);
    emitNervesEvent({
      level: "error",
      event: "engine.error",
      trace_id: traceId,
      component: "engine",
      message: terminalError.message,
      meta: {
        provider: providerRuntime.id,
        model: providerRuntime.model,
        errorClassification: terminalErrorClassification,
        ...(errorDetails.status !== undefined ? { httpStatus: errorDetails.status } : {}),
        ...(errorDetails.bodyExcerpt ? { bodyExcerpt: errorDetails.bodyExcerpt } : {}),
        summary: summarizeProviderError(
          terminalError,
          terminalErrorClassification,
          providerRuntime.id,
          providerRuntime.model,
        ),
      },
    });
    stripLastToolCalls(messages);
    outcome = "errored";
    done = true;
  };
  const finishRestrictedReactionFeedbackViolation = (reason: string): void => {
    callbacks.onClearText?.();
    finishTerminalProviderError(
      new Error(`restricted reaction feedback failed closed: ${reason}`),
      "unknown",
    );
  };

  // Prevent MaxListenersExceeded warning — each iteration adds a listener
  try { require("events").setMaxListeners(50, signal); } catch { /* unsupported */ }

  const toolPreferences = currentContext?.friend?.toolPreferences;
  const unboundBaseTools = restrictedReactionFeedback
    ? getRestrictedReactionFeedbackTools()
    : options?.tools ?? getToolsForChannel(
      channel ? getChannelCapabilities(channel) : undefined,
      toolPreferences && Object.keys(toolPreferences).length > 0 ? toolPreferences : undefined,
      currentContext,
      providerRuntime.capabilities,
      options?.mcpManager,
      providerRuntime.model,
    );
  const baseTools = restrictedReactionFeedback
    ? unboundBaseTools
    : bindCurrentIngressEvidenceLocator(
      unboundBaseTools,
      options?.toolContext?.currentIngressEvidence,
    )
  // Augment tool context with reasoning effort controls from provider
  const baseToolContext: ToolContext | undefined = options?.toolContext
    ?? (turnOrientationFrame ? { signin: async () => undefined, orientationFrame: turnOrientationFrame } : undefined)
  const habitSession = options?.habitSession ?? baseToolContext?.habitSession
  const augmentedToolContext: ToolContext | undefined = baseToolContext
      ? {
        ...baseToolContext,
        supportedReasoningEfforts: providerRuntime.supportedReasoningEfforts,
        setReasoningEffort: (level: string) => { currentReasoningEffort = level; },
        activeWorkFrame: options?.activeWorkFrame,
        orientationFrame: turnOrientationFrame ?? baseToolContext.orientationFrame,
        ...(habitSession ? { habitSession } : {}),
      }
    : habitSession
      ? {
        signin: async () => undefined,
        habitSession,
        supportedReasoningEfforts: providerRuntime.supportedReasoningEfforts,
        setReasoningEffort: (level: string) => { currentReasoningEffort = level; },
      }
    : undefined;

  // Rebase provider-owned turn state from canonical messages at user-turn start.
  // This prevents stale provider caches from replaying prior-turn context.
  providerRuntime.resetTurnState(messages);

  while (!done) {
    // Channel-based tool filtering:
    // - Private runtime: exclude send_message (delivery via surface), observe (no one to observe)
    // - All outward channels (1:1, group, reaction): observe available
    //
    // ponder, settle/rest, surface, and observe are always assembled based on channel context.
    // ponder is available in ALL channels (outer: think privately, inner: keep turning).
    // Private runtime gets restTool instead of settleTool (rest = end turn, gated by attention queue).
    // toolChoiceRequired only controls whether tool_choice: "required" is set in the API call.
    const isPrivateRuntimeChannel = channel === "inner";
    const privateRuntimeHabitCanSendMessage = isPrivateRuntimeChannel
      && habitSession?.toolPolicy.outwardMessagingAllowed === true
      && habitSession.toolPolicy.grantedTools.includes("send_message");
    const privateRuntimeHabitCanSurface = isPrivateRuntimeChannel
      && (!habitSession || (habitSession.toolPolicy.outwardMessagingAllowed === true
        && habitSession.toolPolicy.grantedTools.includes("surface")));
    const filteredBaseTools = isPrivateRuntimeChannel
      ? baseTools.filter((t) => privateRuntimeHabitCanSendMessage || t.function.name !== "send_message")
      : baseTools;
    const activeTools = restrictedReactionFeedback
      ? filteredBaseTools
      : [
        ...filteredBaseTools,
        ponderTool,
        ...(isPrivateRuntimeChannel && privateRuntimeHabitCanSurface ? [surfaceToolDef] : []),
        ...(isPrivateRuntimeChannel ? [restTool] : []),
        ...(!isPrivateRuntimeChannel ? [observeTool] : []),
        ...(!isPrivateRuntimeChannel ? [settleTool] : []),
        ...(isChatStyleChannel(channel ?? "") ? [speakTool] : []),
      ];
    const activeToolNames = new Set(activeTools.map((tool) => tool.function.name));
    const steeringFollowUps = restrictedReactionFeedback
      ? []
      : options?.drainSteeringFollowUps?.() ?? [];
    if (steeringFollowUps.length > 0) {
      const hasSupersedingFollowUp = steeringFollowUps.some((followUp) => followUp.effect === "clear_and_supersede");
      if (hasSupersedingFollowUp) {
        mustResolveBeforeHandoffActive = false;
        options?.setMustResolveBeforeHandoff?.(false);
        outcome = "superseded";
        break;
      }
      if (steeringFollowUps.some((followUp) => followUp.effect === "set_no_handoff")) {
        mustResolveBeforeHandoffActive = true;
        options?.setMustResolveBeforeHandoff?.(true);
      }
      sawSteeringFollowUp = true;
      for (const followUp of steeringFollowUps) {
        messages.push({ role: "user", content: followUp.text });
      }
      providerRuntime.resetTurnState(messages);
    }
    // Yield so pending I/O (stdin Ctrl-C) can be processed between iterations
    await new Promise((r) => setImmediate(r));
    if (signal?.aborted) {
      outcome = "aborted";
      break;
    }
    try {
      const habitCallbackBufferRef: { current: HabitCallbackBuffer | null } = { current: null };
      const callProviderTurn = async (): Promise<TurnResult> => {
        callbacks.onModelStart();
        habitCallbackBufferRef.current = habitSession ? createHabitCallbackBuffer(callbacks) : null;
        try {
          const promptBudget = applyPromptBudget({
            messages,
            provider: providerRuntime.id,
            model: providerRuntime.model,
            contextWindowTokens: getContextConfig().maxTokens,
          });
          if (promptBudget.status !== "within_budget") {
            messages.splice(0, messages.length, ...promptBudget.messages);
            providerRuntime.resetTurnState(messages);
          }
          return await providerRuntime.streamTurn({
            messages,
            activeTools,
            callbacks: habitCallbackBufferRef.current?.callbacks ?? callbacks,
            signal,
            traceId,
            toolChoiceRequired,
            reasoningEffort: currentReasoningEffort,
            eagerSettleStreaming: !restrictedReactionFeedback,
            systemPrompt: structuredSystemPrompt,
          });
        } catch (error) {
          habitCallbackBufferRef.current?.discard();
          habitCallbackBufferRef.current = null;
          if (signal?.aborted) throw new ProviderAttemptAbortError()
          throw error
        }
      }

      const callProviderTurnWithOverflowRecovery = async (): Promise<TurnResult> => {
        try {
          return await callProviderTurn()
        } catch (error) {
          if (error instanceof ProviderAttemptAbortError) throw error
          if (isContextOverflow(error) && !overflowRetried) {
            overflowRetried = true;
            stripLastToolCalls(messages);
            const { maxTokens, contextMargin } = getContextConfig();
            const trimmed = trimMessages(messages, maxTokens, contextMargin, maxTokens * 2);
            messages.splice(0, messages.length, ...trimmed);
            providerRuntime.resetTurnState(messages);
            callbacks.onError(new Error("context trimmed, retrying..."), "transient");
            return callProviderTurn()
          }
          throw error
        }
      }

      const attempt = await runProviderAttempt({
        operation: "turn",
        provider: providerRuntime.id,
        model: providerRuntime.model,
        run: restrictedReactionFeedback ? callProviderTurn : callProviderTurnWithOverflowRecovery,
        classifyError: (error) => providerRuntime.classifyError(error),
        ...(restrictedReactionFeedback ? { policy: { maxAttempts: 1 } } : {}),
        onRetry: async (record, maxAttempts) => {
          const delayMs = record.delayMs as number
          const seconds = delayMs / 1000
          const cause = RETRY_LABELS[record.classification as ProviderErrorClassification]
          try {
            if (record.provider === "openai-codex" && record.classification === "auth-failure") {
              await refreshOpenAICodexProviderCredentials(getAgentName(), {
                force: true,
                reason: "turn-auth-failure",
              })
            }
            await refreshProviderCredentialPool(getAgentName(), {
              preserveCachedOnFailure: true,
              providers: [record.provider],
            })
            _providerRuntimes[facing] = null
            providerRuntime = await getProviderRuntime(facing)
            providerRuntime.resetTurnState(messages)
          } catch (refreshError) {
            emitNervesEvent({
              level: "warn",
              component: "engine",
              event: "engine.provider_retry_refresh_failed",
              message: "provider credential refresh failed during retry",
              meta: { provider: record.provider, model: record.model, reason: refreshError instanceof Error ? refreshError.message : String(refreshError) },
            })
          }
          callbacks.onError(new Error(`${cause}, retrying in ${seconds}s (${record.attempt}/${maxAttempts})...`), "transient");
        },
        sleep: async (delayMs) => {
          await waitForProviderRetry(delayMs, signal)
          providerRuntime.resetTurnState(messages);
        },
      });

      if (!attempt.ok) {
        finishTerminalProviderError(attempt.error, attempt.classification);
        continue;
      }

      const result = attempt.value;
      const streamCallbackBuffer = habitCallbackBufferRef.current;
      habitCallbackBufferRef.current = null;

      // Track usage from the latest API call
      if (result.usage) lastUsage = result.usage;

      // SHARED: build CC-format assistant message from TurnResult
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
      };
      // Persist assistant content WITHOUT inline <think>...</think> blocks.
      // Reasoning content already routed through onReasoningChunk for live
      // surfacing and persisted separately as `_reasoning_items` for
      // providers that support a reasoning channel; saving it inline AND
      // alongside tool_calls causes MiniMax to reject the replayed turn
      // with "tool result's tool id not found" (error code 2013) because
      // it can't reconcile reasoning-with-tools in the same assistant
      // message. Strip aggressively at persist so the next replay is
      // clean; preserve the original reasoning trace on the message via
      // `_inline_reasoning` so debug/audit paths can still see it.
      if (result.content) {
        const stripped = stripThinkBlocksForViolationCheck(result.content);
        if (stripped.length > 0) msg.content = stripped;
        if (stripped.length !== result.content.length) {
          (msg as unknown as Record<string, unknown>)._inline_reasoning = result.content;
          emitNervesEvent({
            level: "info",
            component: "engine",
            event: "engine.inline_reasoning_stripped",
            message: "stripped inline <think> blocks from persisted assistant message; preserved on _inline_reasoning",
            meta: {
              provider: providerRuntime.id,
              model: providerRuntime.model,
              originalLength: result.content.length,
              strippedLength: stripped.length,
            },
          });
        }
      }
      if (result.toolCalls.length)
        msg.tool_calls = result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      // Store reasoning items from the API response on the assistant message
      // so they persist through session save/load and can be restored in toResponsesInput
      const reasoningItems = result.outputItems.filter((item): item is ResponseItem & { type: "reasoning" } => "type" in item && item.type === "reasoning");
      if (reasoningItems.length > 0) {
        (msg as AssistantMessageWithReasoning)._reasoning_items = reasoningItems;
      }
      // Store thinking blocks (Anthropic) on the assistant message for round-tripping
      const thinkingItems = result.outputItems.filter((item) =>
        "type" in item && (item.type === "thinking" || item.type === "redacted_thinking"));
      if (thinkingItems.length > 0) {
        (msg as unknown as Record<string, unknown>)._thinking_blocks = thinkingItems;
      }
      // Phase annotation for Codex provider
      const hasPhaseAnnotation = providerRuntime.capabilities.has("phase-annotation");
      const isSoleSettle = result.toolCalls.length === 1 && result.toolCalls[0].name === "settle";

      if (hasPhaseAnnotation) {
        (msg as AssistantMessageWithReasoning).phase = isSoleSettle ? "settle" : "commentary";
      }

      if (restrictedReactionFeedback) {
        if (result.toolCalls.length !== 1) {
          streamCallbackBuffer?.discard();
          finishRestrictedReactionFeedbackViolation(
            result.toolCalls.length === 0
              ? "the provider returned no terminal tool"
              : "the provider returned a mixed or multiple-tool batch",
          );
          continue;
        }

        const restrictedCall = result.toolCalls[0];
        if (!activeToolNames.has(restrictedCall.name)) {
          streamCallbackBuffer?.discard();
          finishRestrictedReactionFeedbackViolation(
            `the provider returned unregistered tool ${JSON.stringify(restrictedCall.name)}`,
          );
          continue;
        }

        let restrictedArgs: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(restrictedCall.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            restrictedArgs = parsed as Record<string, unknown>;
          }
        } catch {
          restrictedArgs = null;
        }
        const registeredTool = activeTools.find(
          (tool) => tool.function.name === restrictedCall.name,
        )!;
        const argumentsMatchSchema = restrictedArgs !== null
          && matchesRegisteredToolArgumentSchema(registeredTool, restrictedArgs);
        const callbackArgs = (restrictedArgs ?? {}) as Record<string, string>;

        if (restrictedCall.name === "settle") {
          const { answer, intent } = parseSettlePayload(restrictedCall.arguments);
          callbacks.onToolStart("settle", callbackArgs);
          if (!argumentsMatchSchema || answer === undefined || intent === "direct_reply") {
            callbacks.onToolEnd("settle", summarizeArgs("settle", callbackArgs), false);
            streamCallbackBuffer?.discard();
            finishRestrictedReactionFeedbackViolation("settle arguments were malformed or requested continuation");
            continue;
          }

          await streamCallbackBuffer?.flush();
          callbacks.onToolEnd("settle", summarizeArgs("settle", callbackArgs), true);
          const completionIntent = intent === "blocked" ? "blocked" : "complete";
          completion = { answer, intent: completionIntent };
          callbacks.onClearText?.();
          callbacks.onTextChunk(answer);
          messages.push(msg);
          const delivered = "(delivered)";
          messages.push({ role: "tool", tool_call_id: restrictedCall.id, content: delivered });
          providerRuntime.appendToolOutput(restrictedCall.id, delivered);
          outcome = completionIntent === "blocked" ? "blocked" : "settled";
          done = true;
          continue;
        }

        if (!argumentsMatchSchema) {
          streamCallbackBuffer?.discard();
          finishRestrictedReactionFeedbackViolation(`${restrictedCall.name} arguments were malformed`);
          continue;
        }

        if (restrictedCall.name === "observe") {
          callbacks.onClearText?.();
          callbacks.onToolStart("observe", callbackArgs);
          const reason = typeof callbackArgs.reason === "string" ? callbackArgs.reason : undefined;
          emitNervesEvent({
            component: "engine",
            event: "engine.observe",
            message: "agent observed without responding",
            meta: { ...(reason ? { reason } : {}) },
          });
          callbacks.onToolEnd("observe", summarizeArgs("observe", callbackArgs), true);
          messages.push(msg);
          const silenced = "(silenced)";
          messages.push({ role: "tool", tool_call_id: restrictedCall.id, content: silenced });
          providerRuntime.appendToolOutput(restrictedCall.id, silenced);
          outcome = "observed";
          done = true;
          continue;
        }

        callbacks.onClearText?.();
        callbacks.onToolStart("orientation_get", callbackArgs);
        let orientationReadSucceeded = false;
        try {
          const execToolFn = options?.execTool ?? execTool;
          await execToolFn(
            "orientation_get",
            callbackArgs,
            augmentedToolContext,
          );
          orientationReadSucceeded = true;
        } catch {
          orientationReadSucceeded = false;
        }
        callbacks.onToolEnd(
          "orientation_get",
          summarizeArgs("orientation_get", callbackArgs),
          orientationReadSucceeded,
        );
        streamCallbackBuffer?.discard();
        finishRestrictedReactionFeedbackViolation(
          orientationReadSucceeded
            ? "orientation_get completed but no terminal response can follow the single invocation"
            : "orientation_get failed",
        );
        continue;
      }

      // Detect the MiniMax "only-thinking, no tool call" violation: no tool
      // calls returned, and the content is empty after stripping
      // <think>...</think> blocks. This is a narrow check — legitimate
      // content-only responses (text without think tags, or text outside
      // think tags) still flow through the original "no tool calls →
      // accept as-is" path so existing channels and tests are unaffected.
      const onlyThinkContent = !result.toolCalls.length
        && typeof result.content === "string"
        && stripThinkBlocksForViolationCheck(result.content).length === 0
        && result.content.length > 0;
      const privateReturnTextAckRetryError = !result.toolCalls.length
        ? privateReturnMissingPonderError({
            latestUserRequest: latestUserMessageText(messages),
            answer: stripThinkBlocksForViolationCheck(result.content),
            sawPonder,
          })
        : null;

      if (!result.toolCalls.length) {
        await streamCallbackBuffer?.flush();
        if (privateReturnTextAckRetryError) {
          callbacks.onClearText?.();
          if (noToolCallRetries < NO_TOOL_CALL_MAX_RETRIES) {
            noToolCallRetries++;
            emitNervesEvent({
              level: "warn",
              component: "engine",
              event: "engine.no_tool_call_retry",
              message: "model returned a text-only private-return acknowledgement without ponder; retrying with corrective nudge",
              meta: {
                attempt: noToolCallRetries,
                cap: NO_TOOL_CALL_MAX_RETRIES,
                provider: providerRuntime.id,
                model: providerRuntime.model,
                reason: "private_return_missing_ponder",
                contentLength: result.content.length,
              },
            });
            messages.push(msg);
            messages.push({
              role: "user",
              content: `${privateReturnTextAckRetryError} Emit the ponder(action=create, ...) tool call now, or ask a blocking clarification without saying the private work is queued.`,
            });
            continue;
          }

          const blockedAnswer = "I could not start the private pass. No private-attention packet was created, so no return work was queued.";
          emitNervesEvent({
            level: "error",
            component: "engine",
            event: "engine.private_return_missing_ponder_blocked",
            message: "private-return text acknowledgement skipped ponder through the retry cap; failing closed",
            meta: {
              cap: NO_TOOL_CALL_MAX_RETRIES,
              provider: providerRuntime.id,
              model: providerRuntime.model,
              contentLength: result.content.length,
            },
          });
          msg.content = blockedAnswer;
          messages.push(msg);
          callbacks.onTextChunk(blockedAnswer);
          completion = { answer: blockedAnswer, intent: "blocked" };
          outcome = "blocked";
          done = true;
          continue;
        }
        if (onlyThinkContent && toolChoiceRequired && noToolCallRetries < NO_TOOL_CALL_MAX_RETRIES) {
          // Provider-level violation: tool_choice was required, model emitted
          // only a <think>...</think> block (or empty content) with no tool
          // call. Retry with a corrective nudge up to NO_TOOL_CALL_MAX_RETRIES
          // times. After cap, accept as-is (the readback path strips think
          // tags and surfaces a clear diagnostic).
          noToolCallRetries++;
          emitNervesEvent({
            level: "warn",
            component: "engine",
            event: "engine.no_tool_call_retry",
            message: "model returned only <think> content with no tool call despite tool_choice=required; retrying with corrective nudge",
            meta: {
              attempt: noToolCallRetries,
              cap: NO_TOOL_CALL_MAX_RETRIES,
              provider: providerRuntime.id,
              model: providerRuntime.model,
              contentLength: result.content!.length,
            },
          });
          messages.push(msg);
          messages.push({
            role: "user",
            content: isPrivateRuntimeChannel
              ? "no tool was called this turn. you must end every turn by calling rest (or surface, ponder, observe). emit the tool call now."
              : "no tool was called this turn. you must end every turn by calling settle with your answer (or ponder/observe). emit the tool call now.",
          });
          continue;
        }
        // Legitimate text-only response, or cap reached — accept as-is.
        messages.push(msg);
        done = true;
      } else {
        // Reset the retry counter on any successful tool call.
        noToolCallRetries = 0;
        const habitBlockReason = await habitToolBatchBlockReason(habitSession, result.toolCalls, augmentedToolContext?.delegatedOrigins, activeToolNames)
        if (habitBlockReason) {
          streamCallbackBuffer?.discard();
          recordBlockedHabitSurfaceAttempts(habitSession, result.toolCalls, habitBlockReason)
          messages.push(msg)
          const blockedOutput = `blocked: ${habitBlockReason}. No tool side effects from this assistant message were executed.`
          for (const call of result.toolCalls) {
            messages.push({ role: "tool", tool_call_id: call.id, content: blockedOutput })
            providerRuntime.appendToolOutput(call.id, blockedOutput)
          }
          emitNervesEvent({
            level: "warn",
            component: "engine",
            event: "engine.habit_tool_batch_blocked",
            message: "habit tool batch blocked before side effects",
            meta: { reason: habitBlockReason, toolCalls: result.toolCalls.map((call) => call.name) },
          })
          continue
        }
        await streamCallbackBuffer?.flush();
        const soleTerminalCall = result.toolCalls.length === 1
          ? result.toolCalls[0]
          : null
        const soleTerminalProjection = soleTerminalCall
          ? resolveToolDefinition(soleTerminalCall.name)?.terminalProjection
          : undefined
        if (soleTerminalCall && soleTerminalProjection?.mode === "verbatim") {
          let terminalArgs: Record<string, string> = {}
          try {
            const parsed = JSON.parse(soleTerminalCall.arguments)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              terminalArgs = parsed as Record<string, string>
            }
          } catch {
            // The registered handler owns exact argument validation.
          }
          if (soleTerminalProjection.clearBufferedText) callbacks.onClearText?.()
          callbacks.onToolStart(soleTerminalCall.name, terminalArgs)
          let terminalResult: string
          try {
            const execToolFn = options?.execTool ?? execTool
            terminalResult = await execToolFn(
              soleTerminalCall.name,
              terminalArgs,
              augmentedToolContext,
            )
          } catch (error) {
            callbacks.onToolEnd(
              soleTerminalCall.name,
              summarizeArgs(soleTerminalCall.name, terminalArgs),
              false,
            )
            messages.push(msg)
            const failure = error instanceof Error ? `error: ${error.message}` : `error: ${String(error)}`
            messages.push({ role: "tool", tool_call_id: soleTerminalCall.id, content: failure })
            providerRuntime.appendToolOutput(soleTerminalCall.id, failure)
            callbacks.onTextChunk(failure)
            completion = { answer: failure, intent: "blocked" }
            outcome = "blocked"
            done = true
            continue
          }
          callbacks.onToolEnd(
            soleTerminalCall.name,
            summarizeArgs(soleTerminalCall.name, terminalArgs),
            true,
          )
          messages.push(msg)
          messages.push({ role: "tool", tool_call_id: soleTerminalCall.id, content: terminalResult })
          providerRuntime.appendToolOutput(soleTerminalCall.id, terminalResult)
          callbacks.onTextChunk(terminalResult)
          completion = { answer: terminalResult, intent: "complete" }
          outcome = "settled"
          done = true
          continue
        }
        // Check for settle sole call: intercept before tool execution
        if (isSoleSettle) {
          /* v8 ignore next -- defensive: JSON.parse catch for malformed settle args @preserve */
          const settleArgs = (() => { try { return JSON.parse(result.toolCalls[0].arguments) } catch { return {} } })();
          callbacks.onToolStart("settle", settleArgs);
          // Private-runtime attention queue gate: reject settle if items remain
          const attentionQueue = augmentedToolContext?.delegatedOrigins;
          if (isPrivateRuntimeChannel && attentionQueue && attentionQueue.length > 0) {
            callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), false);
            callbacks.onClearText?.();
            messages.push(msg);
            const gateMessage = "current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you settle. Older transcript claims are historical; only the current held-work frame is the gate.";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: gateMessage });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, gateMessage);
            continue;
          }

          // Extract answer from the tool call arguments.
          // Supports: {"answer":"text","intent":"..."} or "text" (JSON string).
          const { answer, intent } = parseSettlePayload(result.toolCalls[0].arguments);

          // Private-runtime settle: no CompletionMetadata, "(settled)" ack
          if (isPrivateRuntimeChannel) {
            callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), true);
            messages.push(msg);
            const settled = "(settled)";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: settled });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, settled);
            outcome = "settled";
            done = true;
            continue;
          }

          const deliveredAnswer = answer
          const retryError = privateReturnAckLeakError(deliveredAnswer, privateReturnHeldTokens)
            ?? privateReturnMissingPonderError({
              latestUserRequest: latestUserMessageText(messages),
              answer: deliveredAnswer,
              sawPonder,
            })
            ?? getSettleRetryError(
              mustResolveBeforeHandoffActive,
              intent,
              sawSteeringFollowUp,
              options?.delegationDecision,
              sawSendMessageSelf,
              sawPonder,
              sawQuerySession,
              options?.currentObligation ?? null,
              options?.activeWorkFrame?.inner?.job,
              sawExternalStateQuery,
            )
          const validDirectReply = mustResolveBeforeHandoffActive && intent === "direct_reply" && sawSteeringFollowUp;
          const validTerminalIntent = intent === "complete" || intent === "blocked";
          const validClosure = deliveredAnswer != null
            && !retryError
            && (!mustResolveBeforeHandoffActive || validDirectReply || validTerminalIntent);

          if (validClosure) {
            callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), true);
            completion = {
              answer: deliveredAnswer,
              intent: validDirectReply ? "direct_reply" : intent === "blocked" ? "blocked" : "complete",
            };
            if (result.settleStreamed) {
              // The streaming layer already parsed and emitted the answer
              // progressively via SettleParser. Skip clearing and
              // re-emitting to avoid double-delivery.
            } else {
              // Clear any streamed noise (e.g. refusal text) before emitting.
              callbacks.onClearText?.();
              // Emit the answer through the callback pipeline so channels receive it.
              // Never truncate -- channel adapters handle splitting long messages.
              callbacks.onTextChunk(deliveredAnswer);
            }
            messages.push(msg);
            if (validDirectReply) {
              const resumeWork = "direct reply delivered. resume the unresolved obligation now and keep working until you can finish or clearly report that you are blocked.";
              messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: resumeWork });
              providerRuntime.appendToolOutput(result.toolCalls[0].id, resumeWork);
            } else {
              const delivered = "(delivered)";
              messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: delivered });
              providerRuntime.appendToolOutput(result.toolCalls[0].id, delivered);
              outcome = intent === "blocked" ? "blocked" : "settled";
              done = true;
            }
          } else {
            // Answer is undefined -- the model's settle was incomplete or
            // malformed. Clear any partial streamed text or noise, then push the
            // assistant msg + error tool result and let the model try again.
            callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), false);
            callbacks.onClearText?.();
            messages.push(msg);
            const toolRetryMessage = retryError
              ?? "your settle was incomplete or malformed. call settle again with your complete response."
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: toolRetryMessage });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, toolRetryMessage);
          }
          continue;
        }

        // Check for observe sole call: intercept before tool execution
        const isSoleObserve = result.toolCalls.length === 1 && result.toolCalls[0].name === "observe";
        if (isSoleObserve) {
          /* v8 ignore next -- defensive: JSON.parse catch for malformed observe args @preserve */
          const observeArgs = (() => { try { return JSON.parse(result.toolCalls[0].arguments) } catch { return {} } })();
          let reason: string | undefined;
          if (typeof observeArgs?.reason === "string") reason = observeArgs.reason;
          callbacks.onToolStart("observe", observeArgs);
          emitNervesEvent({
            component: "engine",
            event: "engine.observe",
            message: "agent observed without responding",
            meta: { ...(reason ? { reason } : {}) },
          });
          callbacks.onToolEnd("observe", summarizeArgs("observe", observeArgs), true);
          messages.push(msg);
          const silenced = "(silenced)";
          messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: silenced });
          providerRuntime.appendToolOutput(result.toolCalls[0].id, silenced);
          outcome = "observed";
          done = true;
          continue;
        }

        // Check for rest sole call: intercept before tool execution
        const isSoleRest = result.toolCalls.length === 1 && result.toolCalls[0].name === "rest";
        if (isSoleRest) {
          const restArgs = (() => { try { return JSON.parse(result.toolCalls[0].arguments) } catch { return {} } })();
          callbacks.onToolStart("rest", restArgs);

          // Attention queue gate: reject rest if items remain
          const attentionQueue = augmentedToolContext?.delegatedOrigins;
          if (attentionQueue && attentionQueue.length > 0) {
            callbacks.onToolEnd("rest", summarizeArgs("rest", restArgs), false);
            messages.push(msg);
            const gateMessage = "current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you rest. Older transcript claims are historical; only the current held-work frame is the gate.";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: gateMessage });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, gateMessage);
            continue;
          }

          if (hasFreshPendingWork(options) && !freshWorkGateFired) {
            freshWorkGateFired = true;
            callbacks.onToolEnd("rest", summarizeArgs("rest", restArgs), false);
            messages.push(msg);
            const gateMessage = "fresh work arrived for me this turn — inspect the pending messages above and take the next concrete action before you rest.";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: gateMessage });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, gateMessage);
            emitNervesEvent({
              level: "info",
              component: "engine",
              event: "engine.fresh_work_gate_fired",
              message: "rest deferred once because pending work arrived this turn; agent has been notified",
              meta: { pendingCount: options!.pendingMessages!.length },
            });
            continue;
          }

          callbacks.onToolEnd("rest", summarizeArgs("rest", restArgs), true);
          messages.push(msg);
          const ack = "(resting)";
          messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: ack });
          providerRuntime.appendToolOutput(result.toolCalls[0].id, ack);

          emitNervesEvent({
            component: "engine",
            event: "engine.rested",
            message: "resting until next heartbeat",
            meta: { ...(typeof restArgs?.status === "string" ? { status: restArgs.status } : {}) },
          });

          outcome = "rested";
          done = true;
          continue;
        }

        messages.push(msg);
        // Execute tools (sole-call tools in mixed calls are rejected inline)
        for (const tc of result.toolCalls) {
          if (signal?.aborted) break;
          // Reject sole-call tools when mixed with other tool calls
          const terminalProjection = resolveToolDefinition(tc.name)?.terminalProjection
          const soleCallRejection = SOLE_CALL_REJECTION[tc.name]
            ?? (terminalProjection?.requiresSoleCall
              ? `rejected: ${tc.name} must be the only tool call.`
              : undefined);
          if (soleCallRejection) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: soleCallRejection });
            providerRuntime.appendToolOutput(tc.id, soleCallRejection);
            continue;
          }
          let args: Record<string, string> = {};
          try {
            args = JSON.parse(tc.arguments);
          } catch {
            /* ignore */
          }
          if (tc.name === "send_message" && args.friendId === "self") {
            const latestUserText = latestUserMessageText(messages)
            if (!isPrivateRuntimeChannel && looksLikePrivateReturnRequest(latestUserText)) {
              const argSummary = summarizeArgs(tc.name, args);
              const rejection = "private-return requests must use ponder, not send_message(friendId=self). Create a typed ponder packet with the marker/source request preserved, then only acknowledge that the private pass is queued.";
              callbacks.onToolStart(tc.name, args);
              callbacks.onToolEnd(tc.name, argSummary, false);
              messages.push({ role: "tool", tool_call_id: tc.id, content: rejection });
              providerRuntime.appendToolOutput(tc.id, rejection);
              continue;
            }
            sawSendMessageSelf = true;
          }
          if (tc.name === "speak") {
            let speakArgs: { message?: unknown } = {};
            try { speakArgs = JSON.parse(tc.arguments) as { message?: unknown }; } catch { /* malformed */ }
            const speakMessage = typeof speakArgs.message === "string" ? speakArgs.message : "";
            const argSummary = summarizeArgs("speak", { message: speakMessage });
            callbacks.onToolStart("speak", { message: speakMessage });
            if (speakMessage.trim().length === 0) {
              const err = "speak requires a non-empty `message` string.";
              callbacks.onToolEnd("speak", argSummary, false);
              messages.push({ role: "tool", tool_call_id: tc.id, content: err });
              providerRuntime.appendToolOutput(tc.id, err);
              emitNervesEvent({
                level: "warn",
                component: "engine",
                event: "engine.speak_invalid",
                message: "speak rejected: missing or empty message",
                meta: {},
              });
              continue;
            }
            callbacks.onTextChunk(speakMessage);
            let speakDeliveryError: Error | null = null;
            try {
              await callbacks.flushNow?.();
            } catch (err) {
              speakDeliveryError = err instanceof Error ? err : new Error(String(err));
            }
            if (speakDeliveryError) {
              callbacks.onToolEnd("speak", argSummary, false);
              const failMsg = `speak delivery failed: ${speakDeliveryError.message}. the message did not reach your friend; do not assume they saw it.`;
              messages.push({ role: "tool", tool_call_id: tc.id, content: failMsg });
              providerRuntime.appendToolOutput(tc.id, failMsg);
              emitNervesEvent({
                level: "error",
                component: "engine",
                event: "engine.speak_delivery_failed",
                message: "speak delivery failed",
                meta: { error: speakDeliveryError.message, messageLength: speakMessage.length },
              });
              continue;
            }
            callbacks.onToolEnd("speak", argSummary, true);
            const ack = "(spoken)";
            messages.push({ role: "tool", tool_call_id: tc.id, content: ack });
            providerRuntime.appendToolOutput(tc.id, ack);
            emitNervesEvent({
              component: "engine",
              event: "engine.speak",
              message: "agent spoke mid-turn",
              meta: { messageLength: speakMessage.length },
            });
            continue;
          }
          if (tc.name === "ponder") {
            const parsedArgs = normalizeLegacyPonderArgs(parsePonderPayload(tc.arguments));
            const argSummary = summarizeArgs(tc.name, parsedArgs as Record<string, string>);
            callbacks.onToolStart(tc.name, parsedArgs as Record<string, string>);
            let toolResult: string;
            let success = false;

            try {
              const action = parsedArgs.action ?? "create";
              const currentSession = augmentedToolContext?.currentSession;
              const currentOrigin = currentSession
                ? { friendId: currentSession.friendId, channel: currentSession.channel, key: currentSession.key }
                : undefined;
              const isInnerChannel = currentOrigin?.friendId === "self" && currentOrigin?.channel === "inner";
              const shouldCreateReturnObligation = !!currentOrigin && !isInnerChannel;
              const attentionQueue = augmentedToolContext?.delegatedOrigins ?? [];
              const successCriteria = parseSuccessCriteria(parsedArgs.success_criteria);
              const payload = parsePacketPayload(parsedArgs.payload_json);

              let packet: PonderPacket;
              let returnObligationId: string | null = null;
              let resultAction: "created" | "revised" = "created";
              let privateReturnSourceRequest = "";

              if (action === "create") {
                if (isInnerChannel && attentionQueue.length > 0) {
                  throw new Error("private runtime already has held return work in the attention queue; surface the existing delegationId instead of creating a replacement ponder packet.")
                }
                const kind = parsedArgs.kind;
                const objective = typeof parsedArgs.objective === "string" ? parsedArgs.objective.trim() : "";
                const summary = typeof parsedArgs.summary === "string" ? parsedArgs.summary.trim() : "";
                const sourceRequest = currentOrigin && !isInnerChannel ? latestUserMessageText(messages) : "";
                privateReturnSourceRequest = sourceRequest;

                if (!kind || !objective || !successCriteria || !payload) {
                  throw new Error("ponder create requires kind, objective, success_criteria, and valid payload_json.")
                }
                const packetPayload = sourceRequest
                  ? { ...payload, sourceRequest }
                  : payload
                const createLinkedReturnObligation = (id: string, packetId: string): void => {
                  createReturnObligation(getAgentName(), {
                    id,
                    origin: currentOrigin as NonNullable<typeof currentOrigin>,
                    status: "queued",
                    delegatedContent: buildPonderDelegatedContent({ summary, objective, sourceRequest }),
                    packetId,
                    createdAt: Date.now(),
                  });
                }

                const agentRoot = getAgentRoot();
                let relatedObligationId: string | undefined;
                if (currentOrigin && !isInnerChannel) {
                  try {
                    const obligation = createObligation(agentRoot, {
                      origin: currentOrigin,
                      content: objective,
                    });
                    relatedObligationId = obligation.id;
                  } catch {
                    relatedObligationId = undefined;
                  }
                }

                const frictionSignature = kind === "harness_friction" && typeof packetPayload.frictionSignature === "string"
                  ? packetPayload.frictionSignature
                  : null;
                const existing = frictionSignature && currentOrigin
                  ? findHarnessFrictionPacket(agentRoot, currentOrigin, frictionSignature)
                  : null;

                if (existing) {
                  resultAction = "revised";
                  const existingActiveReturnId = shouldCreateReturnObligation
                    ? activeReturnObligationId(getAgentName(), existing.relatedReturnObligationId)
                    : null;
                  returnObligationId = existingActiveReturnId
                    ?? (shouldCreateReturnObligation ? generateObligationId(Date.now()) : null);
                  packet = existing.status === "drafting"
                    ? revisePonderPacket(agentRoot, existing.id, {
                        kind,
                        objective,
                        summary,
                        successCriteria,
                        payload: packetPayload,
                      })
                    : existing;
                  if (returnObligationId && returnObligationId !== existing.relatedReturnObligationId) {
                    packet = advancePonderPacket(agentRoot, packet.id, { relatedReturnObligationId: returnObligationId })
                    createLinkedReturnObligation(returnObligationId, packet.id)
                  }
                } else {
                  returnObligationId = shouldCreateReturnObligation ? generateObligationId(Date.now()) : null;
                  packet = createPonderPacket(agentRoot, {
                    kind,
                    objective,
                    summary,
                    successCriteria,
                    ...(currentOrigin ? { origin: currentOrigin } : {}),
                    ...(relatedObligationId ? { relatedObligationId } : {}),
                    ...(returnObligationId ? { relatedReturnObligationId: returnObligationId } : {}),
                    ...(parsedArgs.follows_packet_id ? { followsPacketId: parsedArgs.follows_packet_id } : {}),
                    payload: packetPayload,
                  });

                  if (returnObligationId) {
                    createLinkedReturnObligation(returnObligationId, packet.id)
                  }
                }
              } else if (action === "revise") {
                const packetId = typeof parsedArgs.packet_id === "string" ? parsedArgs.packet_id.trim() : "";
                const kind = parsedArgs.kind;
                const objective = typeof parsedArgs.objective === "string" ? parsedArgs.objective.trim() : "";
                const summary = typeof parsedArgs.summary === "string" ? parsedArgs.summary.trim() : "";
                if (!packetId || !kind || !objective || !successCriteria || !payload) {
                  throw new Error("ponder revise requires packet_id, kind, objective, success_criteria, and valid payload_json.")
                }
                packet = revisePonderPacket(getAgentRoot(), packetId, {
                  kind,
                  objective,
                  summary,
                  successCriteria,
                  payload,
                });
                returnObligationId = packet.relatedReturnObligationId
                  && !(packet.origin?.friendId === "self" && packet.origin.channel === "inner")
                  ? packet.relatedReturnObligationId
                  : null;
                resultAction = "revised";
              } else {
                throw new Error("ponder requires action=create or revise.")
              }

              if (returnObligationId) {
                for (const token of extractPrivateReturnHeldTokens(privateReturnSourceRequest)) {
                  privateReturnHeldTokens.add(token)
                }
                const agentName = getAgentName()
                await requestPrivateWake(
                  agentName,
                  augmentedToolContext?.daemonSocketPath,
                  buildPonderReturnPrivateWakeOptions({ agentName, packet, returnObligationId }),
                ).catch(() => undefined)
              }
              sawPonder = true;
              toolResult = buildPonderResult(packet, resultAction, returnObligationId);
              success = true;

              emitNervesEvent({
                component: "engine",
                event: "engine.ponder_packet",
                message: "ponder packet touched",
                meta: {
                  action: resultAction,
                  packetId: packet.id,
                  kind: packet.kind,
                  status: packet.status,
                },
              });
            } catch (error) {
              toolResult = error instanceof Error ? error.message : String(error);
            }

            callbacks.onToolEnd(tc.name, argSummary, success);
            messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
            providerRuntime.appendToolOutput(tc.id, toolResult);
            continue;
          }
          /* v8 ignore next -- flag tested via truth-check integration tests @preserve */
          if (tc.name === "query_session") sawQuerySession = true;
          /* v8 ignore next -- flag tested via truth-check integration tests @preserve */
          if (tc.name === "bridge_manage") sawBridgeManage = true;
          /* v8 ignore next -- flag tested via truth-check integration tests @preserve */
          if (isExternalStateQuery(tc.name, args)) sawExternalStateQuery = true;
          const argSummary = summarizeArgs(tc.name, args);
          const toolLoop = detectToolLoop(toolLoopState, tc.name, args);
          if (toolLoop.stuck) {
            const rejection = `loop guard: ${toolLoop.message}`;
            callbacks.onToolStart(tc.name, args);
            callbacks.onToolEnd(tc.name, argSummary, false);
            messages.push({ role: "tool", tool_call_id: tc.id, content: rejection });
            providerRuntime.appendToolOutput(tc.id, rejection);
            continue;
          }
          callbacks.onToolStart(tc.name, args);
          let toolResult: string;
          let success: boolean;
          try {
            const execToolFn = options?.execTool ?? execTool;
            toolResult = await execToolFn(tc.name, args, augmentedToolContext);
            success = true;
          } catch (e) {
            toolResult = `error: ${e}`;
            success = false;
            augmentedToolContext?.habitSession?.recordError?.(toolResult);
          }
          toolResult = rewriteToolResultForModel(tc.name, toolResult, toolFrictionLedger);
          recordToolOutcome(toolLoopState, tc.name, args, toolResult, success);
          callbacks.onToolEnd(tc.name, buildToolResultSummary(tc.name, args, toolResult, success), success);
          messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          providerRuntime.appendToolOutput(tc.id, toolResult);
          callbacks.onToolResult?.(messages);
        }
      }
    } catch (e) {
      // Abort is not an error — just stop cleanly
      if (e instanceof ProviderAttemptAbortError || signal?.aborted) {
        stripLastToolCalls(messages);
        outcome = "aborted";
        break;
      }
      const errorForClassification = e instanceof Error ? e : /* v8 ignore next -- defensive @preserve */ new Error(String(e))
      let providerClassification: ProviderErrorClassification
      try {
        providerClassification = providerRuntime.classifyError(errorForClassification)
      } catch {
        /* v8 ignore next -- defensive: classifyError should not throw @preserve */
        providerClassification = "unknown"
      }
      finishTerminalProviderError(errorForClassification, providerClassification);
    }
  }
  emitNervesEvent({
    event: "engine.turn_end",
    trace_id: traceId,
    component: "engine",
    message: "runAgent turn completed",
    meta: { done, sawPonder, sawQuerySession, sawBridgeManage },
  });
  return {
    usage: lastUsage,
    outcome,
    completion,
    ...(terminalError ? { error: terminalError, errorClassification: terminalErrorClassification } : {}),
  };
}
