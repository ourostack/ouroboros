import OpenAI from "openai";
import { getMinimaxConfig } from "../config";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderRuntime, ProviderTurnRequest } from "../core";
import { streamChatCompletion } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

export function createMinimaxProviderRuntime(): ProviderRuntime {
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
  getModelCapabilities(minimaxConfig.model);

  const client = new OpenAI({
    apiKey: minimaxConfig.apiKey,
    baseURL: "https://api.minimaxi.chat/v1",
    timeout: 30000,
    maxRetries: 0,
  });
  return {
    id: "minimax",
    model: minimaxConfig.model,
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
        request.eagerFinalAnswerStreaming,
      );
    },
  };
}
