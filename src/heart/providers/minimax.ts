import OpenAI from "openai";
import { getMinimaxConfig } from "../config";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../core";

interface HttpError extends Error { status?: number }

/* v8 ignore start -- shared network error utility, tested via classification tests @preserve */
function isNetworkError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code || ""
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
       "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"].includes(code)) return true
  const msg = error.message || ""
  return msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("getaddrinfo")
}
/* v8 ignore stop */

export function classifyMinimaxError(error: Error): ProviderErrorClassification {
  const status = (error as HttpError).status
  if (status === 401 || status === 403) return "auth-failure"
  if (status === 429) return "rate-limit"
  if (status && status >= 500) return "server-error"
  if (isNetworkError(error)) return "network-error"
  return "unknown"
}
import { streamChatCompletion } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

export function createMinimaxProviderRuntime(model: string): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "minimax provider init",
    meta: { provider: "minimax" },
  });
  const minimaxConfig = getMinimaxConfig();
  if (!minimaxConfig.apiKey) {
    throw new Error(
      "provider 'minimax' is selected in agent.json but providers.minimax.apiKey is missing in secrets.json.",
    );
  }
  // Registry consulted; MiniMax models return empty defaults (no capabilities to derive)
  getModelCapabilities(model);

  const client = new OpenAI({
    apiKey: minimaxConfig.apiKey,
    baseURL: "https://api.minimaxi.chat/v1",
    timeout: 30000,
    maxRetries: 0,
  });
  return {
    id: "minimax",
    model,
    client,
    capabilities: new Set(),
    resetTurnState(_messages: OpenAI.ChatCompletionMessageParam[]): void {
      // No provider-owned turn state for chat-completions providers.
    },
    appendToolOutput(_callId: string, _output: string): void {
      // Chat-completions providers rely on canonical messages only.
    },
    streamTurn(request: ProviderTurnRequest) {
      const params: Record<string, unknown> = {
        messages: request.messages,
        tools: request.activeTools,
        stream: true,
      };
      if (this.model) params.model = this.model;
      if (request.traceId) params.metadata = { trace_id: request.traceId };
      if (request.toolChoiceRequired) params.tool_choice = "required";
      return streamChatCompletion(
        this.client as OpenAI,
        params,
        request.callbacks,
        request.signal,
        request.eagerSettleStreaming,
      );
    },
    classifyError(error: Error): ProviderErrorClassification {
      return classifyMinimaxError(error);
    },
  };
}
