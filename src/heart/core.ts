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
import { execTool, summarizeArgs, finalAnswerTool, noResponseTool, goInwardTool, getToolsForChannel, isConfirmationRequired } from "../repertoire/tools";
import type { ToolContext } from "../repertoire/tools";
import { getChannelCapabilities } from "../mind/friends/channel";
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

export type ProviderId = "azure" | "anthropic" | "minimax" | "openai-codex" | "github-copilot";

export type ProviderCapability = "reasoning-effort" | "phase-annotation";

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
}

export interface ProviderTurnRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  activeTools: OpenAI.ChatCompletionFunctionTool[];
  callbacks: ChannelCallbacks;
  signal?: AbortSignal;
  traceId?: string;
  toolChoiceRequired?: boolean;
  reasoningEffort?: string;
}

interface ProviderRegistry {
  resolve(): ProviderRuntime | null;
}

let _providerRuntime: { fingerprint: string; runtime: ProviderRuntime } | null = null;

function getProviderRuntimeFingerprint(): string {
  const provider = loadAgentConfig().provider;
  /* v8 ignore next -- switch: not all provider branches exercised in CI @preserve */
  switch (provider) {
    case "azure": {
      const { apiKey, endpoint, deployment, modelName, apiVersion, managedIdentityClientId } = getAzureConfig();
      return JSON.stringify({ provider, apiKey, endpoint, deployment, modelName, apiVersion, managedIdentityClientId });
    }
    case "anthropic": {
      const { model, setupToken } = getAnthropicConfig();
      return JSON.stringify({ provider, model, setupToken });
    }
    case "minimax": {
      const { apiKey, model } = getMinimaxConfig();
      return JSON.stringify({ provider, apiKey, model });
    }
    case "openai-codex": {
      const { model, oauthAccessToken } = getOpenAICodexConfig();
      return JSON.stringify({ provider, model, oauthAccessToken });
    }
    /* v8 ignore start -- fingerprint: tested via provider init tests @preserve */
    case "github-copilot": {
      const { model, githubToken, baseUrl } = getGithubCopilotConfig();
      return JSON.stringify({ provider, model, githubToken, baseUrl });
    }
    /* v8 ignore stop */
  }
}

export function createProviderRegistry(): ProviderRegistry {
  const factories: Record<ProviderId, () => ProviderRuntime> = {
    azure: createAzureProviderRuntime,
    anthropic: createAnthropicProviderRuntime,
    minimax: createMinimaxProviderRuntime,
    "openai-codex": createOpenAICodexProviderRuntime,
    "github-copilot": createGithubCopilotProviderRuntime,
  };

  return {
    resolve(): ProviderRuntime | null {
      const provider = loadAgentConfig().provider;
      return factories[provider]();
    },
  };
}

function getProviderRuntime(): ProviderRuntime {
  try {
    const fingerprint = getProviderRuntimeFingerprint();
    if (!_providerRuntime || _providerRuntime.fingerprint !== fingerprint) {
      const runtime = createProviderRegistry().resolve();
      _providerRuntime = runtime ? { fingerprint, runtime } : null;
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

  if (!_providerRuntime) {
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
  return _providerRuntime.runtime;
}

/**
 * Clear the cached provider runtime so the next access re-creates it from
 * current config. Runtime access also auto-refreshes when the selected
 * provider fingerprint changes on disk.
 */
export function resetProviderRuntime(): void {
  _providerRuntime = null;
}

export function getModel(): string {
  return getProviderRuntime().model;
}

export function getProvider(): ProviderId {
  return getProviderRuntime().id;
}

export function createSummarize(): (transcript: string, instruction: string) => Promise<string> {
  return async (transcript: string, instruction: string): Promise<string> => {
    const runtime = getProviderRuntime()
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

export function getProviderDisplayLabel(): string {
  const provider = loadAgentConfig().provider;
  const providerLabelBuilders: Record<ProviderId, () => string> = {
    azure: () => {
      const config = getAzureConfig();
      return `azure openai (${config.deployment || "default"}, model: ${config.modelName || "unknown"})`
    },
    anthropic: () => `anthropic (${getAnthropicConfig().model || "unknown"})`,
    minimax: () => `minimax (${getMinimaxConfig().model || "unknown"})`,
    "openai-codex": () => `openai codex (${getOpenAICodexConfig().model || "unknown"})`,
    /* v8 ignore next -- branch: tested via display label unit test @preserve */
    "github-copilot": () => `github copilot (${getGithubCopilotConfig().model || "unknown"})`,
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
  // the final_answer so streamed noise (e.g. refusal text) is discarded.
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
}

export type RunAgentOutcome =
  | "complete"
  | "blocked"
  | "superseded"
  | "aborted"
  | "errored"
  | "no_response"
  | "go_inward";

const DELEGATION_REASON_PROSE_HANDOFF: Record<DelegationReason, string> = {
  explicit_reflection: "something in the conversation called for reflection",
  cross_session: "this touches other conversations",
  bridge_state: "there's shared work spanning sessions",
  task_state: "there are active tasks that relate to this",
  non_fast_path_tool: "this needs tools beyond a simple reply",
  unresolved_obligation: "there's an unresolved commitment from an earlier conversation",
};

function buildGoInwardHandoffPacket(params: {
  content: string
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

  const returnAddress = params.currentSession
    ? `${params.currentSession.friendId}/${params.currentSession.channel}/${params.currentSession.key}`
    : "no specific return -- just thinking"

  let obligationLine: string
  if (params.outwardClosureRequired && params.currentSession) {
    obligationLine = `i need to come back to ${params.currentSession.friendId} with something`
  } else {
    obligationLine = "no obligation -- just thinking"
  }

  return [
    "## what i need to think about",
    params.content,
    "",
    "## why this came up",
    reasonProse,
    "",
    "## where to bring it back",
    returnAddress,
    "",
    "## what i owe",
    obligationLine,
    "",
    "## thinking mode",
    params.mode,
  ].join("\n")
}

type FinalAnswerIntent = "complete" | "blocked" | "direct_reply";

function parseFinalAnswerPayload(argumentsText: string): { answer?: string; intent?: FinalAnswerIntent } {
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

export function getFinalAnswerRetryError(
  mustResolveBeforeHandoff: boolean,
  intent: FinalAnswerIntent | undefined,
  sawSteeringFollowUp: boolean,
  delegationDecision?: DelegationDecision,
  sawSendMessageSelf?: boolean,
  sawGoInward?: boolean,
  sawQuerySession?: boolean,
  currentObligation?: string | null,
  innerJob?: InnerJob,
  sawExternalStateQuery?: boolean,
): string | null {
  // 1. Delegation adherence: delegate-inward without evidence of inward action
  if (delegationDecision?.target === "delegate-inward" && !sawSendMessageSelf && !sawGoInward && !sawQuerySession) {
    emitNervesEvent({
      event: "engine.delegation_adherence_rejected",
      component: "engine",
      message: "delegation adherence check rejected final_answer",
      meta: {
        target: delegationDecision.target,
        reasons: delegationDecision.reasons,
      },
    });
    return "you're reaching for a final answer, but part of you knows this needs more thought. take it inward -- go_inward will let you think privately, or send_message(self) if you just want to leave yourself a note.";
  }
  // 2. Pending obligation not addressed
  if (innerJob?.obligationStatus === "pending" && !sawSendMessageSelf && !sawGoInward) {
    return "you're still holding something from an earlier conversation -- someone is waiting for your answer. finish the thought first, or go_inward to keep working on it privately.";
  }
  // 3. mustResolveBeforeHandoff + missing intent
  if (mustResolveBeforeHandoff && !intent) {
    return "your final_answer is missing required intent. when you must keep going until done or blocked, call final_answer again with answer plus intent=complete, blocked, or direct_reply.";
  }
  // 4. mustResolveBeforeHandoff + direct_reply without follow-up
  if (mustResolveBeforeHandoff && intent === "direct_reply" && !sawSteeringFollowUp) {
    return "your final_answer used intent=direct_reply without a newer steering follow-up. continue the unresolved work, or call final_answer again with intent=complete or blocked when appropriate.";
  }
  // 5. mustResolveBeforeHandoff + complete while a live return loop is still active
  if (mustResolveBeforeHandoff && intent === "complete" && currentObligation && !sawSteeringFollowUp) {
    return "you still owe the live session a visible return on this work. don't end the turn yet — continue until you've brought back the external-state update, or use intent=blocked with the concrete blocker.";
  }
  // 6. External-state grounding: obligation + complete requires fresh external verification
  if (intent === "complete" && currentObligation && !sawExternalStateQuery && !sawSteeringFollowUp) {
    return "you're claiming this work is complete, but the external state hasn't been verified this turn. ground your claim with a fresh check (gh pr view, npm view, gh run view, etc.) before calling final_answer.";
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

export async function runAgent(
  messages: OpenAI.ChatCompletionMessageParam[],
  callbacks: ChannelCallbacks,
  channel?: Channel,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<{ usage?: UsageData; outcome: RunAgentOutcome; completion?: CompletionMetadata }> {
  const providerRuntime = getProviderRuntime();
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
  let outcome: RunAgentOutcome = "complete";
  let completion: CompletionMetadata | undefined;
  let sawSteeringFollowUp = false;
  let mustResolveBeforeHandoffActive = options?.mustResolveBeforeHandoff === true;
  let currentReasoningEffort = "medium";
  let sawSendMessageSelf = false;
  let sawGoInward = false;
  let sawQuerySession = false;
  let sawBridgeManage = false;
  let sawExternalStateQuery = false;

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
      }
    : undefined;

  // Rebase provider-owned turn state from canonical messages at user-turn start.
  // This prevents stale provider caches from replaying prior-turn context.
  providerRuntime.resetTurnState(messages);

  while (!done) {
    // When toolChoiceRequired is true (the default), include final_answer
    // so the model can signal completion. With tool_choice: required, the
    // model must call a tool every turn — final_answer is how it exits.
    // Overridable via options.toolChoiceRequired = false (e.g. CLI).
    const activeTools = toolChoiceRequired
      ? [...baseTools, goInwardTool, ...(currentContext?.isGroupChat ? [noResponseTool] : []), finalAnswerTool]
      : baseTools;
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
      const isSoleFinalAnswer = result.toolCalls.length === 1 && result.toolCalls[0].name === "final_answer";

      if (hasPhaseAnnotation) {
        (msg as AssistantMessageWithReasoning).phase = isSoleFinalAnswer ? "final_answer" : "commentary";
      }

      if (!result.toolCalls.length) {
        // No tool calls — accept response as-is.
        // (Kick detection disabled; tool_choice: required + final_answer
        // is the primary loop control. See src/heart/kicks.ts to re-enable.)
        messages.push(msg);
        done = true;
      } else {
        // Check for final_answer sole call: intercept before tool execution
        if (isSoleFinalAnswer) {
          // Extract answer from the tool call arguments.
          // Supports: {"answer":"text","intent":"..."} or "text" (JSON string).
          const { answer, intent } = parseFinalAnswerPayload(result.toolCalls[0].arguments);
          const retryError = getFinalAnswerRetryError(
            mustResolveBeforeHandoffActive,
            intent,
            sawSteeringFollowUp,
            options?.delegationDecision,
            sawSendMessageSelf,
            sawGoInward,
            sawQuerySession,
            options?.currentObligation ?? null,
            options?.activeWorkFrame?.inner?.job,
            sawExternalStateQuery,
          )
          const validDirectReply = mustResolveBeforeHandoffActive && intent === "direct_reply" && sawSteeringFollowUp;
          const validTerminalIntent = intent === "complete" || intent === "blocked";
          const validClosure = answer != null
            && !retryError
            && (!mustResolveBeforeHandoffActive || validDirectReply || validTerminalIntent);

          if (validClosure) {
            completion = {
              answer,
              intent: validDirectReply ? "direct_reply" : intent === "blocked" ? "blocked" : "complete",
            };
            if (result.finalAnswerStreamed) {
              // The streaming layer already parsed and emitted the answer
              // progressively via FinalAnswerParser. Skip clearing and
              // re-emitting to avoid double-delivery.
            } else {
              // Clear any streamed noise (e.g. refusal text) before emitting.
              callbacks.onClearText?.();
              // Emit the answer through the callback pipeline so channels receive it.
              // Never truncate -- channel adapters handle splitting long messages.
              callbacks.onTextChunk(answer);
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
              outcome = intent === "blocked" ? "blocked" : "complete";
              done = true;
            }
          } else {
            // Answer is undefined -- the model's final_answer was incomplete or
            // malformed. Clear any partial streamed text or noise, then push the
            // assistant msg + error tool result and let the model try again.
            callbacks.onClearText?.();
            messages.push(msg);
            messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: retryError ?? "your final_answer was incomplete or malformed. call final_answer again with your complete response." });
            providerRuntime.appendToolOutput(result.toolCalls[0].id, retryError ?? "your final_answer was incomplete or malformed. call final_answer again with your complete response.");
          }
          continue;
        }

        // Check for no_response sole call: intercept before tool execution
        const isSoleNoResponse = result.toolCalls.length === 1 && result.toolCalls[0].name === "no_response";
        if (isSoleNoResponse) {
          let reason: string | undefined;
          try {
            const parsed = JSON.parse(result.toolCalls[0].arguments);
            if (typeof parsed?.reason === "string") reason = parsed.reason;
          } catch { /* ignore */ }
          emitNervesEvent({
            component: "engine",
            event: "engine.no_response",
            message: "agent declined to respond in group chat",
            meta: { ...(reason ? { reason } : {}) },
          });
          messages.push(msg);
          const silenced = "(silenced)";
          messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: silenced });
          providerRuntime.appendToolOutput(result.toolCalls[0].id, silenced);
          outcome = "no_response";
          done = true;
          continue;
        }

        // Check for go_inward sole call: intercept before tool execution
        const isSoleGoInward = result.toolCalls.length === 1 && result.toolCalls[0].name === "go_inward";
        if (isSoleGoInward) {
          let parsedArgs: { content?: string; answer?: string; mode?: string } = {};
          try {
            parsedArgs = JSON.parse(result.toolCalls[0].arguments);
          } catch { /* ignore */ }
          /* v8 ignore next -- defensive: content always string from model @preserve */
          const content = typeof parsedArgs.content === "string" ? parsedArgs.content : "";
          const answer = typeof parsedArgs.answer === "string" ? parsedArgs.answer : undefined;
          const parsedMode = parsedArgs.mode === "reflect" || parsedArgs.mode === "plan" || parsedArgs.mode === "relay"
            ? parsedArgs.mode
            : undefined;
          const mode = parsedMode || "reflect";

          // Emit outward answer if provided
          if (answer) {
            callbacks.onClearText?.();
            callbacks.onTextChunk(answer);
          }

          // Build handoff packet and enqueue
          const handoffContent = buildGoInwardHandoffPacket({
            content,
            mode,
            delegationDecision: options?.delegationDecision,
            currentSession: (options?.toolContext as ToolContext | undefined)?.currentSession ?? null,
            currentObligation: options?.currentObligation ?? null,
            outwardClosureRequired: options?.delegationDecision?.outwardClosureRequired ?? false,
          });
          const pendingDir = getInnerDialogPendingDir(getAgentName());
          const currentSession = (options?.toolContext as ToolContext | undefined)?.currentSession;
          const isInnerChannel = currentSession?.friendId === "self" && currentSession?.channel === "inner";
          const envelope: PendingMessage = {
            from: getAgentName(),
            friendId: "self",
            channel: "inner",
            key: "dialog",
            content: handoffContent,
            timestamp: Date.now(),
            mode,
            ...(currentSession && !isInnerChannel ? {
              delegatedFrom: {
                friendId: currentSession.friendId,
                channel: currentSession.channel,
                key: currentSession.key,
              },
              obligationStatus: "pending" as const,
            } : {}),
          };
          queuePendingMessage(pendingDir, envelope);
          if (currentSession && !isInnerChannel) {
            try {
              createObligation(getAgentRoot(), {
                origin: {
                  friendId: currentSession.friendId,
                  channel: currentSession.channel,
                  key: currentSession.key,
                },
                content,
              })
            } catch {
              /* v8 ignore next -- defensive: obligation store write failure should not break go_inward @preserve */
            }
          }
          try { await requestInnerWake(getAgentName()); } catch { /* daemon may not be running */ }

          sawGoInward = true;
          messages.push(msg);
          const ack = "(going inward)";
          messages.push({ role: "tool", tool_call_id: result.toolCalls[0].id, content: ack });
          providerRuntime.appendToolOutput(result.toolCalls[0].id, ack);

          emitNervesEvent({
            component: "engine",
            event: "engine.go_inward",
            message: "taking thread inward",
            meta: { mode, hasAnswer: answer !== undefined, contentSnippet: content.slice(0, 80) },
          });

          outcome = "go_inward";
          done = true;
          continue;
        }

        messages.push(msg);
        // SHARED: execute tools (final_answer, no_response, go_inward in mixed calls are rejected inline)
        for (const tc of result.toolCalls) {
          if (signal?.aborted) break;
          // Intercept final_answer in mixed call: reject it
          if (tc.name === "final_answer") {
            const rejection = "rejected: final_answer must be the only tool call. Finish your work first, then call final_answer alone.";
            messages.push({ role: "tool", tool_call_id: tc.id, content: rejection });
            providerRuntime.appendToolOutput(tc.id, rejection);
            continue;
          }
          // Intercept no_response in mixed call: reject it
          if (tc.name === "no_response") {
            const rejection = "rejected: no_response must be the only tool call. call no_response alone when you want to stay silent.";
            messages.push({ role: "tool", tool_call_id: tc.id, content: rejection });
            providerRuntime.appendToolOutput(tc.id, rejection);
            continue;
          }
          // Intercept go_inward in mixed call: reject it
          if (tc.name === "go_inward") {
            const rejection = "rejected: go_inward must be the only tool call. finish your other work first, then call go_inward alone.";
            messages.push({ role: "tool", tool_call_id: tc.id, content: rejection });
            providerRuntime.appendToolOutput(tc.id, rejection);
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
          callbacks.onToolEnd(tc.name, argSummary, success);
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
        const cause = classifyTransientError(e);
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
      callbacks.onError(e instanceof Error ? e : new Error(String(e)), "terminal");
      emitNervesEvent({
        level: "error",
        event: "engine.error",
        trace_id: traceId,
        component: "engine",
        message: e instanceof Error ? e.message : String(e),
        meta: {},
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
    meta: { done, sawGoInward, sawQuerySession, sawBridgeManage },
  });
  return { usage: lastUsage, outcome, completion };
}
