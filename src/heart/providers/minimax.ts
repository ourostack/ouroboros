import OpenAI from "openai";
import { getMinimaxConfig, type MinimaxProviderConfig } from "../config";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../core";
import { classifyHttpError } from "./error-classification";

/**
 * Canonical MiniMax chat-completions base URL. Exported so the BlueBubbles
 * VLM fallback (which targets a sibling endpoint under the same host) can
 * derive its URL from one source of truth instead of hard-coding.
 */
export const MINIMAX_PROVIDER_BASE_URL = "https://api.minimaxi.chat/v1"

export function classifyMinimaxError(error: Error): ProviderErrorClassification {
  return classifyHttpError(error)
}
import { streamChatCompletion } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

export function createMinimaxProviderRuntime(model: string, minimaxConfig: MinimaxProviderConfig = getMinimaxConfig()): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "minimax provider init",
    meta: { provider: "minimax" },
  });
  if (!minimaxConfig.apiKey) {
    throw new Error(
      "provider 'minimax' is selected in agent.json but providers.minimax.apiKey is missing in secrets.json.",
    );
  }
  // Registry consulted; MiniMax models return empty defaults (no capabilities to derive)
  getModelCapabilities(model);

  const client = new OpenAI({
    apiKey: minimaxConfig.apiKey,
    baseURL: MINIMAX_PROVIDER_BASE_URL,
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
