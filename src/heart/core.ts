import OpenAI from "openai";
import {
  getAnthropicConfig,
  getAzureConfig,
  getContextConfig,
  getGithubCopilotConfig,
  getMinimaxConfig,
  getOpenAICodexConfig,
} from "./config";
import { loadAgentConfig } from "./identity";
import { execTool, summarizeArgs, buildToolResultSummary, settleTool, observeTool, ponderTool, restTool, getToolsForChannel, isConfirmationRequired } from "../repertoire/tools";
import type { ToolContext } from "../repertoire/tools";
import { getChannelCapabilities, channelToFacing, type Facing } from "../mind/friends/channel";
import { surfaceToolDef } from "../senses/surface-tool";
import type { AssistantMessageWithReasoning, ResponseItem } from "./streaming";
import { emitNervesEvent } from "../nerves/runtime";
import type { TurnResult } from "./streaming";
import type { UsageData } from "../mind/context";
import { trimMessages } from "../mind/context";
import { buildSystem } from "../mind/prompt";
import type { McpManager } from "../repertoire/mcp-manager";
import type { Channel } from "../mind/prompt";
import { injectAssociativeRecall } from "../mind/associative-recall";
import { createAnthropicProviderRuntime } from "./providers/anthropic";
import { createAzureProviderRuntime } from "./providers/azure";
import { createMinimaxProviderRuntime } from "./providers/minimax";
import { createOpenAICodexProviderRuntime } from "./providers/openai-codex";
import { createGithubCopilotProviderRuntime } from "./providers/github-copilot";
import type { SteeringFollowUpEffect } from "../senses/continuity";
import type { ActiveWorkFrame } from "./active-work";
import type { DelegationDecision, DelegationReason } from "./delegation";
import type { InnerJob } from "./daemon/thoughts";
import { getInnerDialogPendingDir, queuePendingMessage } from "../mind/pending";
import type { PendingMessage } from "../mind/pending";
import { getAgentName, getAgentRoot } from "./identity";
import { requestInnerWake } from "./daemon/socket-client";
import { createObligation } from "./obligations";
import { createToolLoopState, detectToolLoop, recordToolOutcome } from "./tool-loop";

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
}

interface ProviderRegistry {
  resolve(provider?: ProviderId, model?: string): ProviderRuntime | null;
}

const _providerRuntimes: Record<Facing, { fingerprint: string; runtime: ProviderRuntime } | null> = {
  human: null,
  agent: null,
};

function getProviderRuntimeFingerprint(facing: Facing): string {
  const config = loadAgentConfig();
  const facingConfig = facing === "human" ? config.humanFacing : config.agentFacing;
  const provider = facingConfig.provider;
  const model = facingConfig.model;
  /* v8 ignore next -- switch: not all provider branches exercised in CI @preserve */
  switch (provider) {
    case "azure": {
      const { apiKey, endpoint, deployment, apiVersion, managedIdentityClientId } = getAzureConfig();
      return JSON.stringify({ provider, model, apiKey, endpoint, deployment, apiVersion, managedIdentityClientId });
    }
    case "anthropic": {
      const { setupToken } = getAnthropicConfig();
      return JSON.stringify({ provider, model, setupToken });
    }
    case "minimax": {
      const { apiKey } = getMinimaxConfig();
      return JSON.stringify({ provider, model, apiKey });
    }
    case "openai-codex": {
      const { oauthAccessToken } = getOpenAICodexConfig();
      return JSON.stringify({ provider, model, oauthAccessToken });
    }
    /* v8 ignore start -- fingerprint: tested via provider init tests @preserve */
    case "github-copilot": {
      const { githubToken, baseUrl } = getGithubCopilotConfig();
      return JSON.stringify({ provider, model, githubToken, baseUrl });
    }
    /* v8 ignore stop */
  }
}

export function createProviderRegistry(): ProviderRegistry {
  const factories: Record<ProviderId, (model: string) => ProviderRuntime> = {
    azure: createAzureProviderRuntime,
    anthropic: createAnthropicProviderRuntime,
    minimax: createMinimaxProviderRuntime,
    "openai-codex": createOpenAICodexProviderRuntime,
    "github-copilot": createGithubCopilotProviderRuntime,
  };

  return {
    resolve(provider?: ProviderId, model?: string): ProviderRuntime | null {
      const resolvedProvider = provider ?? loadAgentConfig().humanFacing.provider;
      const resolvedModel = model ?? loadAgentConfig().humanFacing.model;
      return factories[resolvedProvider](resolvedModel);
    },
  };
}

function getProviderRuntime(facing: Facing = "human"): ProviderRuntime {
  try {
    const fingerprint = getProviderRuntimeFingerprint(facing);
    const cached = _providerRuntimes[facing];
    if (!cached || cached.fingerprint !== fingerprint) {
      const config = loadAgentConfig();
      const facingConfig = facing === "human" ? config.humanFacing : config.agentFacing;
      const runtime = createProviderRegistry().resolve(facingConfig.provider, facingConfig.model);
      _providerRuntimes[facing] = runtime ? { fingerprint, runtime } : null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitNervesEvent({
      level: "error",
      event: "engine.provider_init_error",
      component: "engine",
      message: msg,
      meta: {},
    });
    // eslint-disable-next-line no-console -- pre-boot guard: provider init failure
    console.error(`\n[fatal] ${msg}\n`);
    process.exit(1);
    throw new Error("unreachable");
  }

  if (!_providerRuntimes[facing]) {
    emitNervesEvent({
      level: "error",
      event: "engine.provider_init_error",
      component: "engine",
      message: "provider runtime could not be initialized.",
      meta: {},
    });
    process.exit(1);
    throw new Error("unreachable");
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
  return getProviderRuntime(facing).model;
}

export function getProvider(facing: Facing = "human"): ProviderId {
  return getProviderRuntime(facing).id;
}

export function createSummarize(facing: Facing = "human"): (transcript: string, instruction: string) => Promise<string> {
  return async (transcript: string, instruction: string): Promise<string> => {
    const runtime = getProviderRuntime(facing)
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
  const config = loadAgentConfig();
  const facingConfig = facing === "human" ? config.humanFacing : config.agentFacing;
  const provider = facingConfig.provider;
  const model = facingConfig.model || "unknown";
  const providerLabelBuilders: Record<ProviderId, () => string> = {
    azure: () => {
      const azureCfg = getAzureConfig();
      return `azure openai (${azureCfg.deployment || "default"}, model: ${model})`
    },
    anthropic: () => `anthropic (${model})`,
    minimax: () => `minimax (${model})`,
    "openai-codex": () => `openai codex (${model})`,
    /* v8 ignore next -- branch: tested via display label unit test @preserve */
    "github-copilot": () => `github copilot (${model})`,
  };
  return providerLabelBuilders[provider]();
}

// Re-export tools, execTool, summarizeArgs from ./tools for backward compat
export { tools, execTool, summarizeArgs, getToolsForChannel } from "../repertoire/tools";
export type { ToolContext } from "../repertoire/tools";
// Re-export streaming functions for backward compat
export { streamChatCompletion, streamResponsesApi, toResponsesInput, toResponsesTools } from "./streaming";
export type { TurnResult } from "./streaming";

// Re-export prompt functions for backward compat
export { buildSystem } from "../mind/prompt";
export type { Channel } from "../mind/prompt";

export interface ChannelCallbacks {
  onModelStart(): void;
  onModelStreamStart(): void;
  onTextChunk(text: string): void;
  onReasoningChunk(text: string): void;
  onToolStart(name: string, args: Record<string, string>): void;
  onToolEnd(name: string, summary: string, success: boolean): void;
  onError(error: Error, severity: "transient" | "terminal"): void;
  onKick?(): void;
  onConfirmAction?(name: string, args: Record<string, string>): Promise<"confirmed" | "denied">;
  // Clear any buffered text accumulated during streaming. Called before emitting
  // the settle answer so streamed noise (e.g. refusal text) is discarded.
  onClearText?(): void;
}

export interface RunAgentOptions {
  toolChoiceRequired?: boolean;
  skipConfirmation?: boolean;
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
  /** Pending messages from other sessions/inner dialog, rendered in system prompt. */
  pendingMessages?: Array<{ from: string; content: string }>;
}

export type RunAgentOutcome =
  | "settled"
  | "blocked"
  | "superseded"
  | "aborted"
  | "errored"
  | "observed"
  | "pondered"
  | "rested";

// Sole-call tools must be the only tool call in a turn. When they appear
// alongside other tools, the sole-call tool is rejected with this message.
const SOLE_CALL_REJECTION: Record<string, string> = {
  settle: "rejected: settle must be the only tool call. finish your work first, then call settle alone.",
  observe: "rejected: observe must be the only tool call. call observe alone when you want to stay silent.",
  ponder: "rejected: ponder must be the only tool call. finish your other work first, then call ponder alone.",
  rest: "rejected: rest must be the only tool call. finish your work first, then call rest alone.",
};

const DELEGATION_REASON_PROSE_HANDOFF: Record<DelegationReason, string> = {
  explicit_reflection: "something in the conversation called for reflection",
  cross_session: "this touches other conversations",
  bridge_state: "there's shared work spanning sessions",
  task_state: "there are active tasks that relate to this",
  non_fast_path_tool: "this needs tools beyond a simple reply",
  unresolved_obligation: "there's an unresolved commitment from an earlier conversation",
};

function buildPonderHandoffPacket(params: {
  topic: string
  mode: "reflect" | "plan" | "relay"
  delegationDecision?: DelegationDecision
  currentSession?: { friendId: string; channel: string; key: string } | null
  currentObligation?: string | null
  outwardClosureRequired: boolean
}): string {
  const reasons = params.delegationDecision?.reasons ?? []
  const reasonProse = reasons.length > 0
    ? reasons.map((r) => DELEGATION_REASON_PROSE_HANDOFF[r]).join("; ")
    : "this felt like it needed more thought"

  const whoAsked = params.currentSession
    ? params.currentSession.friendId
    : "no one -- just thinking"

  let holdingLine: string
  if (params.outwardClosureRequired && params.currentSession) {
    holdingLine = `i'm holding something for ${params.currentSession.friendId}`
  } else {
    holdingLine = "nothing -- just thinking"
  }

  return [
    "## what i need to think about",
    params.topic,
    "",
    "## why this came up",
    reasonProse,
    "",
    "## who asked",
    whoAsked,
    "",
    "## what i'm holding",
    holdingLine,
    "",
    "## thinking mode",
    params.mode,
  ].join("\n")
}

type SettleIntent = "complete" | "blocked" | "direct_reply";

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
  sawExternalStateQuery?: boolean,
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
  // 6. External-state grounding: obligation + complete requires fresh external verification
  if (intent === "complete" && currentObligation && !sawExternalStateQuery && !sawSteeringFollowUp) {
    return "you're claiming this work is complete, but the external state hasn't been verified this turn. ground your claim with a fresh check (gh pr view, npm view, gh run view, etc.) before calling settle.";
  }
  return null;
}

// Re-export kick utilities for backward compat
export { hasToolIntent } from "./kicks";

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
export function repairOrphanedToolCalls(
  messages: OpenAI.ChatCompletionMessageParam[],
): void {
  // Pass 1: collect all valid tool_call IDs from assistant messages
  const validCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const asst = msg as OpenAI.ChatCompletionAssistantMessageParam;
      if (asst.tool_calls) {
        for (const tc of asst.tool_calls) validCallIds.add(tc.id);
      }
    }
  }

  // Pass 2: remove orphaned tool results (tool_call_id not in any assistant's tool_calls)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      const toolMsg = messages[i] as OpenAI.ChatCompletionToolMessageParam;
      if (!validCallIds.has(toolMsg.tool_call_id)) {
        messages.splice(i, 1);
      }
    }
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
      const syntheticResults: OpenAI.ChatCompletionToolMessageParam[] = missing.map((tc) => ({
        role: "tool" as const,
        tool_call_id: tc.id,
        content: "error: tool call was interrupted (previous turn timed out or was aborted)",
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

// HTTP error with optional status code (OpenAI SDK errors)
interface HttpError extends Error { status?: number }

// Detect transient network errors worth retrying
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  const code = (err as NodeJS.ErrnoException).code || "";
  // Node.js network error codes
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
       "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"].includes(code)) return true;
  // OpenAI SDK / fetch errors
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("network") && !msg.includes("context")) return true;
  if (msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("getaddrinfo")) return true;
  // HTTP 429 / 500 / 502 / 503 / 504
  const status = (err as HttpError).status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return false;
}

export function classifyTransientError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const status = (err as HttpError).status;
  if (status === 429) return "rate limited";
  if (status === 401 || status === 403) return "auth error";
  if (status && status >= 500) return "server error";
  return "network error";
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

const TRANSIENT_RETRY_LABELS: Record<string, string> = {
  "auth-failure": "auth error",
  "usage-limit": "usage limit",
  "rate-limit": "rate limited",
  "server-error": "server error",
  "network-error": "network error",
  "unknown": "error",
};

export async function runAgent(
  messages: OpenAI.ChatCompletionMessageParam[],
  callbacks: ChannelCallbacks,
  channel?: Channel,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<{ usage?: UsageData; outcome: RunAgentOutcome; completion?: CompletionMetadata; error?: Error; errorClassification?: ProviderErrorClassification }> {
  const facing = channelToFacing(channel);
  const providerRuntime = getProviderRuntime(facing);
  const provider = providerRuntime.id;
  const toolChoiceRequired = options?.toolChoiceRequired ?? true;
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

  // Refresh system prompt at start of each turn when channel is provided.
  // If refresh fails, keep existing system prompt (or inject a minimal safe fallback)
  // so turn execution remains consistent and non-fatal.
  if (channel) {
    try {
      const buildSystemOptions = {
        ...options,
        providerCapabilities: providerRuntime.capabilities,
        supportedReasoningEfforts: providerRuntime.supportedReasoningEfforts,
      };
      const refreshed = await buildSystem(channel, buildSystemOptions, currentContext);
      upsertSystemPrompt(messages, refreshed);
    } catch (error) {
      const hadExistingSystemPrompt = messages[0]?.role === "system" && typeof messages[0].content === "string";
      const existingSystemText = hadExistingSystemPrompt ? (messages[0].content as string) : undefined;
      const fallback = existingSystemText ?? "You are a helpful assistant.";
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

  await injectAssociativeRecall(messages);

  let done = false;
  let lastUsage: UsageData | undefined;
  let overflowRetried = false;
  let retryCount = 0;
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
  const toolLoopState = createToolLoopState();

  // Prevent MaxListenersExceeded warning — each iteration adds a listener
  try { require("events").setMaxListeners(50, signal); } catch { /* unsupported */ }

  const toolPreferences = currentContext?.friend?.toolPreferences;
  const baseTools = options?.tools ?? getToolsForChannel(
    channel ? getChannelCapabilities(channel) : undefined,
    toolPreferences && Object.keys(toolPreferences).length > 0 ? toolPreferences : undefined,
    currentContext,
    providerRuntime.capabilities,
  );
  // Augment tool context with reasoning effort controls from provider
  const augmentedToolContext: ToolContext | undefined = options?.toolContext
      ? {
        ...options.toolContext,
        supportedReasoningEfforts: providerRuntime.supportedReasoningEfforts,
        setReasoningEffort: (level: string) => { currentReasoningEffort = level; },
        activeWorkFrame: options?.activeWorkFrame,
      }
    : undefined;

  // Rebase provider-owned turn state from canonical messages at user-turn start.
  // This prevents stale provider caches from replaying prior-turn context.
  providerRuntime.resetTurnState(messages);

  while (!done) {
    // Channel-based tool filtering:
    // - Inner dialog: exclude send_message (delivery via surface), observe (no one to observe)
    // - 1:1 sessions: exclude observe (can't ignore someone talking directly to you)
    // - Group chats: observe available
    //
    // ponder, settle/rest, surface, and observe are always assembled based on channel context.
    // ponder is available in ALL channels (outer: think privately, inner: keep turning).
    // Inner dialog gets restTool instead of settleTool (rest = end turn, gated by attention queue).
    // toolChoiceRequired only controls whether tool_choice: "required" is set in the API call.
    const isInnerDialog = channel === "inner";
    const filteredBaseTools = isInnerDialog
      ? baseTools.filter((t) => t.function.name !== "send_message")
      : baseTools;
    const activeTools = [
      ...filteredBaseTools,
      ponderTool,
      ...(isInnerDialog ? [surfaceToolDef, restTool] : []),
      ...((currentContext?.isGroupChat || options?.isReactionSignal) && !isInnerDialog ? [observeTool] : []),
      ...(!isInnerDialog ? [settleTool] : []),
    ];
    const steeringFollowUps = options?.drainSteeringFollowUps?.() ?? [];
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
      callbacks.onModelStart();

      const result = await providerRuntime.streamTurn({
        messages,
        activeTools,
        callbacks,
        signal,
        traceId,
        toolChoiceRequired,
        reasoningEffort: currentReasoningEffort,
        eagerSettleStreaming: true,
      });

      // Track usage from the latest API call
      if (result.usage) lastUsage = result.usage;
      retryCount = 0; // reset on success

      // SHARED: build CC-format assistant message from TurnResult
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
      };
      if (result.content) msg.content = result.content;
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

      if (!result.toolCalls.length) {
        // No tool calls — accept response as-is.
        // (Kick detection disabled; tool_choice: required + settle
        // is the primary loop control. See src/heart/kicks.ts to re-enable.)
        messages.push(msg);
        done = true;
      } else {
        // Check for settle sole call: intercept before tool execution
        if (isSoleSettle) {
          /* v8 ignore next -- defensive: JSON.parse catch for malformed settle args @preserve */
          const settleArgs = (() => { try { return JSON.parse(result.toolCalls[0].arguments) } catch { return {} } })();
          callbacks.onToolStart("settle", settleArgs);
          // Inner dialog attention queue gate: reject settle if items remain
          const attentionQueue = (augmentedToolContext ?? options?.toolContext)?.delegatedOrigins;
          if (isInnerDialog && attentionQueue && attentionQueue.length > 0) {
            callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), false);
            callbacks.onClearText?.();
            messages.push(msg);
            const gateMessage = "you're holding thoughts someone is waiting for — surface them before you settle.";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: gateMessage });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, gateMessage);
            continue;
          }

          // Extract answer from the tool call arguments.
          // Supports: {"answer":"text","intent":"..."} or "text" (JSON string).
          const { answer, intent } = parseSettlePayload(result.toolCalls[0].arguments);

          // Inner dialog settle: no CompletionMetadata, "(settled)" ack
          if (isInnerDialog) {
            callbacks.onToolEnd("settle", summarizeArgs("settle", settleArgs), true);
            messages.push(msg);
            const settled = "(settled)";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: settled });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, settled);
            outcome = "settled";
            done = true;
            continue;
          }

          const retryError = getSettleRetryError(
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
          const deliveredAnswer = answer
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

        // Check for ponder sole call: intercept before tool execution
        const isSolePonder = result.toolCalls.length === 1 && result.toolCalls[0].name === "ponder";
        if (isSolePonder) {
          let parsedArgs: { thought?: string; say?: string } = {};
          try {
            parsedArgs = JSON.parse(result.toolCalls[0].arguments);
          } catch { /* ignore */ }
          callbacks.onToolStart("ponder", parsedArgs as Record<string, string>);

          const currentSession = (options?.toolContext as ToolContext | undefined)?.currentSession;
          const isInnerChannel = currentSession?.friendId === "self" && currentSession?.channel === "inner";

          if (!isInnerChannel) {
            // Outer session: thought and say are required
            const thought = typeof parsedArgs.thought === "string" ? parsedArgs.thought : undefined;
            const say = typeof parsedArgs.say === "string" ? parsedArgs.say : undefined;
            if (!thought || !say) {
              callbacks.onToolEnd("ponder", summarizeArgs("ponder", parsedArgs as Record<string, string>), false);
              messages.push(msg);
              const errorMsg = "ponder requires both thought and say when called from a conversation. thought is what needs more thinking; say is what you tell them before going quiet.";
              messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: errorMsg });
              providerRuntime.appendToolOutput(result.toolCalls[0].id, errorMsg);
              continue;
            }

            // Emit outward say text
            callbacks.onClearText?.();
            callbacks.onTextChunk(say);

            // Build handoff packet and enqueue
            const handoffContent = buildPonderHandoffPacket({
              topic: thought,
              mode: "reflect",
              delegationDecision: options?.delegationDecision,
              currentSession: currentSession ?? null,
              currentObligation: options?.currentObligation ?? null,
              outwardClosureRequired: options?.delegationDecision?.outwardClosureRequired ?? false,
            });
            const pendingDir = getInnerDialogPendingDir(getAgentName());
            // Create obligation FIRST so we can attach its ID to the pending message
            let createdObligationId: string | undefined;
            if (currentSession) {
              try {
                const obligation = createObligation(getAgentRoot(), {
                  origin: {
                    friendId: currentSession.friendId,
                    channel: currentSession.channel,
                    key: currentSession.key,
                  },
                  content: thought,
                })
                createdObligationId = obligation.id;
              } catch {
                /* v8 ignore next -- defensive: obligation store write failure should not break ponder @preserve */
              }
            }
            const envelope: PendingMessage = {
              from: getAgentName(),
              friendId: "self",
              channel: "inner",
              key: "dialog",
              content: handoffContent,
              timestamp: Date.now(),
              ...(currentSession ? {
                delegatedFrom: {
                  friendId: currentSession.friendId,
                  channel: currentSession.channel,
                  key: currentSession.key,
                },
                obligationStatus: "pending" as const,
                /* v8 ignore next -- defensive: createdObligationId is undefined only when obligation store write fails @preserve */
                ...(createdObligationId ? { obligationId: createdObligationId } : {}),
              } : {}),
            };
            queuePendingMessage(pendingDir, envelope);
            try { await requestInnerWake(getAgentName()); } catch { /* daemon may not be running */ }

            callbacks.onToolEnd("ponder", summarizeArgs("ponder", parsedArgs as Record<string, string>), true);
            sawPonder = true;
            messages.push(msg);
            const ack = "(pondering)";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: ack });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, ack);

            emitNervesEvent({
              component: "engine",
              event: "engine.pondered",
              message: "pondering",
              meta: { hasThought: true, hasSay: true, contentSnippet: thought.slice(0, 80) },
            });
          } else {
            // Inner dialog: parameterless, enqueue synthetic pending WITHOUT delegatedFrom
            const pendingDir = getInnerDialogPendingDir(getAgentName());
            const envelope: PendingMessage = {
              from: getAgentName(),
              friendId: "self",
              channel: "inner",
              key: "dialog",
              content: "continuing to think...",
              timestamp: Date.now(),
            };
            queuePendingMessage(pendingDir, envelope);

            callbacks.onToolEnd("ponder", summarizeArgs("ponder", parsedArgs as Record<string, string>), true);
            sawPonder = true;
            messages.push(msg);
            const ack = "(pondering)";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: ack });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, ack);

            emitNervesEvent({
              component: "engine",
              event: "engine.pondered",
              message: "pondering from inner dialog",
              meta: { inner: true },
            });
          }

          outcome = "pondered";
          done = true;
          continue;
        }

        // Check for rest sole call: intercept before tool execution
        const isSoleRest = result.toolCalls.length === 1 && result.toolCalls[0].name === "rest";
        if (isSoleRest) {
          const restArgs = (() => { try { return JSON.parse(result.toolCalls[0].arguments) } catch { return {} } })();
          callbacks.onToolStart("rest", restArgs);

          // Attention queue gate: reject rest if items remain
          const attentionQueue = (augmentedToolContext ?? options?.toolContext)?.delegatedOrigins;
          if (attentionQueue && attentionQueue.length > 0) {
            callbacks.onToolEnd("rest", summarizeArgs("rest", restArgs), false);
            messages.push(msg);
            const gateMessage = "you're holding thoughts someone is waiting for — surface them before you rest.";
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: gateMessage });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, gateMessage);
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
            meta: {},
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
          const soleCallRejection = SOLE_CALL_REJECTION[tc.name];
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
            sawSendMessageSelf = true;
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
          // Confirmation check for mutate tools
          if (isConfirmationRequired(tc.name) && !options?.skipConfirmation) {
            let decision: "confirmed" | "denied" = "denied";
            if (callbacks.onConfirmAction) {
              decision = await callbacks.onConfirmAction(tc.name, args);
            }
            if (decision !== "confirmed") {
              const cancelled = "Action cancelled by user.";
              callbacks.onToolStart(tc.name, args);
              callbacks.onToolEnd(tc.name, argSummary, false);
              messages.push({ role: "tool", tool_call_id: tc.id, content: cancelled });
              providerRuntime.appendToolOutput(tc.id, cancelled);
              continue;
            }
          }
          callbacks.onToolStart(tc.name, args);
          let toolResult: string;
          let success: boolean;
          try {
            const execToolFn = options?.execTool ?? execTool;
            toolResult = await execToolFn(tc.name, args, augmentedToolContext ?? options?.toolContext);
            success = true;
          } catch (e) {
            toolResult = `error: ${e}`;
            success = false;
          }
          recordToolOutcome(toolLoopState, tc.name, args, toolResult, success);
          callbacks.onToolEnd(tc.name, buildToolResultSummary(tc.name, args, toolResult, success), success);
          messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          providerRuntime.appendToolOutput(tc.id, toolResult);
        }
      }
    } catch (e) {
      // Abort is not an error — just stop cleanly
      if (signal?.aborted) {
        stripLastToolCalls(messages);
        outcome = "aborted";
        break;
      }
      // Context overflow: trim aggressively and retry once
      if (isContextOverflow(e) && !overflowRetried) {
        overflowRetried = true;
        stripLastToolCalls(messages);
        const { maxTokens, contextMargin } = getContextConfig();
        const trimmed = trimMessages(messages, maxTokens, contextMargin, maxTokens * 2);
        messages.splice(0, messages.length, ...trimmed);
        providerRuntime.resetTurnState(messages);
        callbacks.onError(new Error("context trimmed, retrying..."), "transient");
        continue;
      }
      // Transient errors: retry with exponential backoff
      if (isTransientError(e) && retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = RETRY_BASE_MS * Math.pow(2, retryCount - 1);
        let classification: string
        try {
          classification = providerRuntime.classifyError(e instanceof Error ? e : /* v8 ignore next -- defensive: errors are always Error instances @preserve */ new Error(String(e)))
        } catch {
          /* v8 ignore next -- defensive: classifyError should not throw @preserve */
          classification = classifyTransientError(e)
        }
        /* v8 ignore next -- defensive: all classifications have labels @preserve */
        const cause = TRANSIENT_RETRY_LABELS[classification] ?? classification
        callbacks.onError(new Error(`${cause}, retrying in ${delay / 1000}s (${retryCount}/${MAX_RETRIES})...`), "transient");
        // Wait with abort support
        const aborted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), delay);
          if (signal) {
            const onAbort = () => { clearTimeout(timer); resolve(true); };
            if (signal.aborted) { clearTimeout(timer); resolve(true); return; }
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        if (aborted) {
          stripLastToolCalls(messages);
          outcome = "aborted";
          break;
        }
        providerRuntime.resetTurnState(messages);
        continue;
      }
      terminalError = e instanceof Error ? e : new Error(String(e));
      try {
        terminalErrorClassification = providerRuntime.classifyError(terminalError);
      } catch {
        /* v8 ignore next -- defensive: classifyError should not throw @preserve */
        terminalErrorClassification = "unknown";
      }

      /* v8 ignore start — auth-failure guidance: tested via provider error classification tests @preserve */
      if (terminalErrorClassification === "auth-failure") {
        const agentName = getAgentName()
        const currentProvider = providerRuntime.id
        callbacks.onError(new Error(
          `${currentProvider} (${providerRuntime.model}) encountered an error. ` +
          `Run \`ouro auth --agent ${agentName} --provider ${currentProvider}\` to refresh credentials, ` +
          `or \`ouro auth switch --agent ${agentName} --provider <other>\` to switch providers.`
        ), "terminal")
      } else {
        callbacks.onError(terminalError, "terminal");
      }
      /* v8 ignore stop */

      emitNervesEvent({
        level: "error",
        event: "engine.error",
        trace_id: traceId,
        component: "engine",
        message: terminalError.message,
        meta: { errorClassification: terminalErrorClassification },
      });
      stripLastToolCalls(messages);
      outcome = "errored";
      done = true;
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
