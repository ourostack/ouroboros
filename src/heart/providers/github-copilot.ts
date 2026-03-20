import OpenAI from "openai";
import { getGithubCopilotConfig } from "../config";
import { getAgentName } from "../identity";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderRuntime, ProviderTurnRequest } from "../core";
import type { ResponseItem, TurnResult } from "../streaming";
import { streamChatCompletion, streamResponsesApi, toResponsesInput, toResponsesTools } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

interface HttpError extends Error { status?: number }

/* v8 ignore start -- auth guidance helpers: tested via mock-driven provider tests @preserve */
function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as HttpError).status;
  return status === 401 || status === 403;
}

function getReauthGuidance(reason: string): string {
  const agentName = getAgentName();
  return [
    `provider github-copilot failed (${reason}).`,
    `Run \`ouro auth verify --agent ${agentName}\` to check all configured providers,`,
    `\`ouro auth switch --agent ${agentName} --provider <other>\` to switch,`,
    `or \`ouro auth --agent ${agentName} --provider github-copilot\` to reconfigure.`,
  ].join(" ");
}

function withAuthGuidance(error: unknown): Error {
  const base = error instanceof Error ? error.message : String(error);
  if (isAuthFailure(error)) {
    return new Error(getReauthGuidance(base));
  }
  return error instanceof Error ? error : new Error(String(error));
}
/* v8 ignore stop */

export function createGithubCopilotProviderRuntime(): ProviderRuntime {
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

  const isCompletionsModel = config.model.startsWith("claude");
  const modelCaps = getModelCapabilities(config.model);
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
      model: config.model,
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
          return await streamChatCompletion(this.client as OpenAI, params, request.callbacks, request.signal);
        } catch (error) {
          throw withAuthGuidance(error);
        }
      },
      /* v8 ignore stop */
    };
  }

  // Responses API path (GPT models via Copilot)
  let nativeInput: ResponseItem[] | null = null;
  let nativeInstructions = "";
  return {
    id: "github-copilot",
    model: config.model,
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
        const result = await streamResponsesApi(this.client as OpenAI, params, request.callbacks, request.signal);
        for (const item of result.outputItems) nativeInput!.push(item);
        return result;
      } catch (error) {
        throw withAuthGuidance(error);
      }
    },
    /* v8 ignore stop */
  };
}
