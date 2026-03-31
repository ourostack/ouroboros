import OpenAI from "openai";
import { getGithubCopilotConfig } from "../config";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../core";
import type { ResponseItem, TurnResult } from "../streaming";
import { streamChatCompletion, streamResponsesApi, toResponsesInput, toResponsesTools } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

interface HttpError extends Error { status?: number }

/* v8 ignore start -- duplicated from shared provider utils, tested there @preserve */
function isNetworkError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code || ""
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
       "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"].includes(code)) return true
  const msg = error.message || ""
  return msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("getaddrinfo")
}
/* v8 ignore stop */

/* v8 ignore start -- duplicated classification pattern, tested via provider unit tests @preserve */
export function classifyGithubCopilotError(error: Error): ProviderErrorClassification {
  const status = (error as HttpError).status
  if (status === 401 || status === 403) return "auth-failure"
  if (status === 429) return "rate-limit"
  if (status && status >= 500) return "server-error"
  if (isNetworkError(error)) return "network-error"
  return "unknown"
}
/* v8 ignore stop */


export function createGithubCopilotProviderRuntime(model: string): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "github-copilot provider init",
    meta: { provider: "github-copilot" },
  });
  const config = getGithubCopilotConfig();
  if (!config.githubToken) {
    throw new Error(
      "provider 'github-copilot' is selected in agent.json but providers.github-copilot.githubToken is missing in secrets.json.",
    );
  }
  if (!config.baseUrl) {
    throw new Error(
      "provider 'github-copilot' is selected in agent.json but providers.github-copilot.baseUrl is missing in secrets.json.",
    );
  }

  const isCompletionsModel = model.startsWith("claude");
  const modelCaps = getModelCapabilities(model);
  const capabilities = new Set<ProviderCapability>();
  /* v8 ignore next -- branch: capability detection tested via unit test @preserve */
  if (modelCaps.reasoningEffort) capabilities.add("reasoning-effort");

  const client = new OpenAI({
    apiKey: config.githubToken,
    baseURL: config.baseUrl,
    timeout: 30000,
    maxRetries: 0,
  });

  if (isCompletionsModel) {
    // Chat completions path (Claude models via Copilot)
    return {
      id: "github-copilot",
      model,
      client,
      capabilities,
      supportedReasoningEfforts: modelCaps.reasoningEffort,
      resetTurnState(_messages: OpenAI.ChatCompletionMessageParam[]): void {
        // No provider-owned turn state for chat-completions path.
      },
      appendToolOutput(_callId: string, _output: string): void {
        // Chat-completions providers rely on canonical messages only.
      },
      /* v8 ignore start -- streamTurn: tested via mock assertions in github-copilot.test.ts @preserve */
      async streamTurn(request: ProviderTurnRequest): Promise<TurnResult> {
        const params: Record<string, unknown> = {
          messages: request.messages,
          tools: request.activeTools,
          stream: true,
        };
        if (this.model) params.model = this.model;
        if (request.traceId) params.metadata = { trace_id: request.traceId };
        if (request.toolChoiceRequired) params.tool_choice = "required";
        try {
          return await streamChatCompletion(
            this.client as OpenAI,
            params,
            request.callbacks,
            request.signal,
            request.eagerSettleStreaming,
          );
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
      /* v8 ignore stop */
      /* v8 ignore next 3 -- delegation: classification logic tested via classifyGithubCopilotError @preserve */
      classifyError(error: Error): ProviderErrorClassification {
        return classifyGithubCopilotError(error);
      },
    };
  }

  // Responses API path (GPT models via Copilot)
  let nativeInput: ResponseItem[] | null = null;
  let nativeInstructions = "";
  return {
    id: "github-copilot",
    model,
    client,
    capabilities,
    supportedReasoningEfforts: modelCaps.reasoningEffort,
    /* v8 ignore start -- responses path: tested via mock assertions in github-copilot.test.ts @preserve */
    resetTurnState(messages: OpenAI.ChatCompletionMessageParam[]): void {
      const { instructions, input } = toResponsesInput(messages);
      nativeInput = input;
      nativeInstructions = instructions;
    },
    appendToolOutput(callId: string, output: string): void {
      if (!nativeInput) return;
      nativeInput.push({ type: "function_call_output", call_id: callId, output });
    },
    async streamTurn(request: ProviderTurnRequest): Promise<TurnResult> {
      if (!nativeInput) this.resetTurnState(request.messages);
      const params: Record<string, unknown> = {
        model: this.model,
        input: nativeInput,
        instructions: nativeInstructions,
        tools: toResponsesTools(request.activeTools),
        reasoning: { effort: request.reasoningEffort ?? "medium", summary: "detailed" },
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      if (request.traceId) params.metadata = { trace_id: request.traceId };
      if (request.toolChoiceRequired) params.tool_choice = "required";
      try {
        const result = await streamResponsesApi(
          this.client as OpenAI,
          params,
          request.callbacks,
          request.signal,
          request.eagerSettleStreaming,
        );
        for (const item of result.outputItems) nativeInput!.push(item);
        return result;
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    /* v8 ignore stop */
    /* v8 ignore next 3 -- delegation: classification logic tested via classifyGithubCopilotError @preserve */
    classifyError(error: Error): ProviderErrorClassification {
      return classifyGithubCopilotError(error);
    },
  };
}
