import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getAnthropicConfig } from "../config";
import { getAgentName, getAgentSecretsPath } from "../identity";
import type { UsageData } from "../../mind/context";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderRuntime, ProviderTurnRequest } from "../core";
import { FinalAnswerStreamer } from "../streaming";
import type { TurnResult } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

export type AnthropicThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
const ANTHROPIC_OAUTH_BETA_HEADER =
  "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";

interface AnthropicCredential {
  token: string;
}

interface HttpError extends Error { status?: number }

function getAnthropicSecretsPathForGuidance(): string {
  return getAgentSecretsPath();
}

function getAnthropicAgentNameForGuidance(): string {
  return getAgentName();
}

function getAnthropicSetupTokenInstructions(): string {
  const agentName = getAnthropicAgentNameForGuidance();
  return [
    "Fix:",
    `  1. Run \`ouro auth --agent ${agentName}\``,
    `  2. Open ${getAnthropicSecretsPathForGuidance()}`,
    "  3. Confirm providers.anthropic.setupToken is set",
    "  4. After reauth, retry the failed ouro command or reconnect this session.",
  ].join("\n");
}

function getAnthropicReauthGuidance(reason: string): string {
  return [
    "Anthropic configuration error.",
    reason,
    getAnthropicSetupTokenInstructions(),
  ].join("\n");
}

function resolveAnthropicSetupTokenCredential(): AnthropicCredential {
  const anthropicConfig = getAnthropicConfig();
  const token = anthropicConfig.setupToken?.trim();
  if (!token) {
    throw new Error(
      getAnthropicReauthGuidance(
        "Anthropic provider is selected but no setup-token credential was found.",
      ),
    );
  }
  if (!token.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) {
    throw new Error(
      getAnthropicReauthGuidance(
        `Anthropic credential is not a setup-token (expected prefix ${ANTHROPIC_SETUP_TOKEN_PREFIX}).`,
      ),
    );
  }
  if (token.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    throw new Error(
      getAnthropicReauthGuidance("Anthropic setup-token looks too short."),
    );
  }
  return { token };
}

function toAnthropicTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: unknown } => (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text"
    ))
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function parseToolCallInput(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsJson);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function toAnthropicMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
): { system?: string; messages: Array<Record<string, unknown>> } {
  let system: string | undefined;
  const converted: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (!system) {
        const text = toAnthropicTextContent((msg as OpenAI.ChatCompletionSystemMessageParam).content);
        system = text || undefined;
      }
      continue;
    }

    if (msg.role === "user") {
      converted.push({
        role: "user",
        content: toAnthropicTextContent((msg as OpenAI.ChatCompletionUserMessageParam).content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      const assistant = msg as OpenAI.ChatCompletionAssistantMessageParam;
      const blocks: Array<Record<string, unknown>> = [];
      // Restore thinking blocks before text/tool_use blocks
      const thinkingBlocks = (assistant as unknown as Record<string, unknown>)._thinking_blocks as AnthropicThinkingBlock[] | undefined;
      if (thinkingBlocks) {
        for (const tb of thinkingBlocks) {
          if (tb.type === "thinking") {
            blocks.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature });
          } else {
            blocks.push({ type: "redacted_thinking", data: tb.data });
          }
        }
      }
      const text = toAnthropicTextContent(assistant.content);
      if (text) {
        blocks.push({ type: "text", text });
      }
      if (assistant.tool_calls) {
        for (const toolCall of assistant.tool_calls) {
          /* v8 ignore next -- type narrowing: OpenAI SDK only emits function tool_calls @preserve */
          if (toolCall.type !== "function") continue;
          blocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolCallInput(toolCall.function.arguments),
          });
        }
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "" });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      const tool = msg as OpenAI.ChatCompletionToolMessageParam;
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: tool.tool_call_id,
            content: toAnthropicTextContent(tool.content),
          },
        ],
      });
    }
  }

  return { system, messages: converted };
}

function toAnthropicTools(tools: OpenAI.ChatCompletionFunctionTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    input_schema: (tool.function.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
  }));
}

function toAnthropicUsage(raw: Record<string, unknown>): UsageData {
  const inputTokens = Number(raw.input_tokens ?? 0) || 0;
  const cacheCreateTokens = Number(raw.cache_creation_input_tokens ?? 0) || 0;
  const cacheReadTokens = Number(raw.cache_read_input_tokens ?? 0) || 0;
  const outputTokens = Number(raw.output_tokens ?? 0) || 0;
  const totalInputTokens = inputTokens + cacheCreateTokens + cacheReadTokens;
  return {
    input_tokens: totalInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    total_tokens: totalInputTokens + outputTokens,
  };
}

function mergeAnthropicToolArguments(current: string, partial: string): string {
  if (!partial) return current

  const trimmedCurrent = current.trim()
  const trimmedPartial = partial.trim()

  // If streaming restarts with a full JSON object/array fragment, trust it.
  if (trimmedPartial.startsWith("{") || trimmedPartial.startsWith("[")) {
    return partial
  }

  // Anthropic can emit block.input as a complete object and then emit
  // additional members as ',\"k\":v' deltas; merge those safely.
  if (trimmedCurrent.startsWith("{") && trimmedCurrent.endsWith("}")) {
    const inner = trimmedCurrent.slice(1, -1).trim()
    let suffix = partial
    if (!inner && suffix.startsWith(",")) {
      suffix = suffix.slice(1)
    }
    return `{${inner}${suffix}}`
  }

  return current + partial
}

function isAnthropicAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as HttpError).status;
  if (status === 401 || status === 403) return true;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("oauth authentication") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key")
  );
}

function withAnthropicAuthGuidance(error: unknown): Error {
  const base = error instanceof Error ? error.message : String(error);
  if (isAnthropicAuthFailure(error)) {
    return new Error(getAnthropicReauthGuidance(`Anthropic authentication failed (${base}).`));
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function streamAnthropicMessages(
  client: Anthropic,
  model: string,
  request: ProviderTurnRequest,
): Promise<TurnResult> {
  const { system, messages } = toAnthropicMessages(request.messages);
  const anthropicTools = toAnthropicTools(request.activeTools);

  const modelCaps = getModelCapabilities(model);
  const maxTokens = modelCaps.maxOutputTokens ?? 16384;
  const params: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    thinking: { type: "adaptive", effort: request.reasoningEffort ?? "medium" },
  };
  if (system) params.system = system;
  if (anthropicTools.length > 0) params.tools = anthropicTools;
  if (request.toolChoiceRequired && anthropicTools.length > 0) {
    params.tool_choice = { type: "any" };
  }

  let response: AsyncIterable<Record<string, unknown>>;
  try {
    response = await client.messages.create(
      params as unknown as Anthropic.MessageCreateParamsStreaming,
      request.signal ? { signal: request.signal } : {},
    ) as AsyncIterable<Record<string, unknown>>;
  } catch (error) {
    throw withAnthropicAuthGuidance(error);
  }

  let content = "";
  let streamStarted = false;
  let usage: UsageData | undefined;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  const thinkingBlocks = new Map<number, { type: "thinking"; thinking: string; signature: string }>();
  const redactedBlocks = new Map<number, { type: "redacted_thinking"; data: string }>();
  const answerStreamer = new FinalAnswerStreamer(request.callbacks);

  try {
    for await (const event of response) {
      if (request.signal?.aborted) break;
      const eventType = String(event.type ?? "");
      if (eventType === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        const index = Number(event.index);
        if (block?.type === "thinking") {
          thinkingBlocks.set(index, { type: "thinking", thinking: "", signature: "" });
        } else if (block?.type === "redacted_thinking") {
          redactedBlocks.set(index, { type: "redacted_thinking", data: String(block.data ?? "") });
        } else if (block?.type === "tool_use") {
          const rawInput = block.input;
          const input = rawInput && typeof rawInput === "object"
            ? JSON.stringify(rawInput)
            : "";
          const name = String(block.name ?? "");
          toolCalls.set(index, {
            id: String(block.id ?? ""),
            name,
            arguments: input,
          });
          // Activate eager streaming for sole final_answer tool call
          /* v8 ignore next -- final_answer streaming activation, tested via FinalAnswerStreamer unit tests @preserve */
          if (name === "final_answer" && toolCalls.size === 1) {
            answerStreamer.activate();
          }
        }
        continue;
      }

      if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        const deltaType = String(delta?.type ?? "");
        if (deltaType === "text_delta") {
          if (!streamStarted) {
            request.callbacks.onModelStreamStart();
            streamStarted = true;
          }
          const text = String(delta?.text ?? "");
          content += text;
          request.callbacks.onTextChunk(text);
          continue;
        }
        if (deltaType === "thinking_delta") {
          if (!streamStarted) {
            request.callbacks.onModelStreamStart();
            streamStarted = true;
          }
          const thinkingText = String(delta?.thinking ?? "");
          request.callbacks.onReasoningChunk(thinkingText);
          const thinkingIndex = Number(event.index);
          const thinkingBlock = thinkingBlocks.get(thinkingIndex);
          if (thinkingBlock) thinkingBlock.thinking += thinkingText;
          continue;
        }
        if (deltaType === "signature_delta") {
          const sigIndex = Number(event.index);
          const sigBlock = thinkingBlocks.get(sigIndex);
          if (sigBlock) sigBlock.signature += String(delta?.signature ?? "");
          continue;
        }
        if (deltaType === "input_json_delta") {
          const index = Number(event.index);
          const existing = toolCalls.get(index);
          if (existing) {
            const partialJson = String(delta?.partial_json ?? "");
            existing.arguments = mergeAnthropicToolArguments(
              existing.arguments,
              partialJson,
            );
            /* v8 ignore next -- final_answer delta streaming, tested via FinalAnswerStreamer unit tests @preserve */
            if (existing.name === "final_answer" && toolCalls.size === 1) {
              answerStreamer.processDelta(partialJson);
            }
          }
          continue;
        }
      }

      if (eventType === "content_block_stop") {
        const index = Number(event.index);
        const existing = toolCalls.get(index);
        if (existing && existing.arguments.trim().length === 0) {
          existing.arguments = "{}";
        }
        continue;
      }

      if (eventType === "message_delta") {
        const rawUsage = event.usage;
        if (rawUsage && typeof rawUsage === "object") {
          usage = toAnthropicUsage(rawUsage as Record<string, unknown>);
        }
      }
    }
  } catch (error) {
    throw withAnthropicAuthGuidance(error);
  }

  // Collect all thinking blocks (regular + redacted) sorted by index to preserve ordering
  const allThinkingIndices = [...thinkingBlocks.keys(), ...redactedBlocks.keys()].sort((a, b) => a - b);
  const outputItems: AnthropicThinkingBlock[] = allThinkingIndices.map((idx) => {
    const tb = thinkingBlocks.get(idx);
    if (tb) return tb;
    return redactedBlocks.get(idx)!;
  });

  return {
    content,
    toolCalls: [...toolCalls.values()],
    outputItems,
    usage,
    finalAnswerStreamed: answerStreamer.streamed,
  };
}

export function createAnthropicProviderRuntime(): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "anthropic provider init",
    meta: { provider: "anthropic" },
  });
  const anthropicConfig = getAnthropicConfig();
  if (!(anthropicConfig.model && anthropicConfig.setupToken)) {
    throw new Error(
      getAnthropicReauthGuidance(
        "provider 'anthropic' is selected in agent.json but providers.anthropic.model/setupToken is incomplete in secrets.json.",
      ),
    );
  }
  const modelCaps = getModelCapabilities(anthropicConfig.model);
  const capabilities = new Set<ProviderCapability>();
  if (modelCaps.reasoningEffort) capabilities.add("reasoning-effort");

  const credential = resolveAnthropicSetupTokenCredential();
  const client = new Anthropic({
    authToken: credential.token,
    timeout: 30000,
    maxRetries: 0,
    defaultHeaders: {
      "anthropic-beta": ANTHROPIC_OAUTH_BETA_HEADER,
    },
  });
  return {
    id: "anthropic",
    model: anthropicConfig.model,
    client,
    capabilities,
    supportedReasoningEfforts: modelCaps.reasoningEffort,
    resetTurnState(_messages: OpenAI.ChatCompletionMessageParam[]): void {
      // Anthropic request payload is derived from canonical messages each turn.
    },
    appendToolOutput(_callId: string, _output: string): void {
      // Anthropic uses canonical messages for tool_result tracking.
    },
    streamTurn(request: ProviderTurnRequest): Promise<TurnResult> {
      return streamAnthropicMessages(client, anthropicConfig.model, request);
    },
  };
}
