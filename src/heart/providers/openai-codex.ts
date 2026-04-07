import OpenAI from "openai";
import { getOpenAICodexConfig } from "../config";
import { getAgentName, getAgentSecretsPath } from "../identity";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../core";
import type { ResponseItem } from "../streaming";
import { streamResponsesApi, toResponsesInput, toResponsesTools } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";
import { classifyHttpError } from "./error-classification";

const OPENAI_CODEX_AUTH_FAILURE_MARKERS = [
  "authentication failed",
  "unauthorized",
  "invalid api key",
  "invalid x-api-key",
  "invalid bearer token",
]
const OPENAI_CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";

type JsonRecord = Record<string, unknown>;

function getOpenAICodexSecretsPathForGuidance(): string {
  return getAgentSecretsPath();
}

function getOpenAICodexAgentNameForGuidance(): string {
  return getAgentName();
}

function getOpenAICodexOAuthInstructions(): string {
  const agentName = getOpenAICodexAgentNameForGuidance();
  return [
    "Fix:",
    `  1. Run \`ouro auth --agent ${agentName}\``,
    `  2. Open ${getOpenAICodexSecretsPathForGuidance()}`,
    "  3. Confirm providers.openai-codex.oauthAccessToken is set",
    "  4. This provider uses chatgpt.com/backend-api/codex/responses (not api.openai.com/responses).",
    "  5. After reauth, retry the failed ouro command or reconnect this session.",
  ].join("\n");
}

function getOpenAICodexReauthGuidance(reason: string): string {
  return [
    "OpenAI Codex configuration error.",
    reason,
    getOpenAICodexOAuthInstructions(),
  ].join("\n");
}

export function classifyOpenAICodexError(error: Error): ProviderErrorClassification {
  return classifyHttpError(error, {
    isAuthFailure: isOpenAICodexAuthFailure,
    isUsageLimit: (e) => {
      const lower = e.message.toLowerCase()
      return lower.includes("usage") || lower.includes("quota") || lower.includes("exceeded your")
    },
  })
}

function isOpenAICodexAuthFailure(error: Error): boolean {
  const lower = error.message.toLowerCase();
  return OPENAI_CODEX_AUTH_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}


function decodeJwtPayload(token: string): JsonRecord | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1]!
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1]!.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload as JsonRecord;
  } catch {
    return null;
  }
}

function getChatGPTAccountIdFromToken(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload) return "";
  const authClaim = payload["https://api.openai.com/auth"];
  if (!authClaim || typeof authClaim !== "object" || Array.isArray(authClaim)) return "";
  const accountId = (authClaim as JsonRecord).chatgpt_account_id;
  if (typeof accountId !== "string") return "";
  return accountId.trim();
}

export function createOpenAICodexProviderRuntime(model: string): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "openai-codex provider init",
    meta: { provider: "openai-codex" },
  });
  const codexConfig = getOpenAICodexConfig();
  if (!codexConfig.oauthAccessToken) {
    throw new Error(
      getOpenAICodexReauthGuidance(
        "provider 'openai-codex' is selected in agent.json but providers.openai-codex.oauthAccessToken is missing in secrets.json.",
      ),
    );
  }
  const token = codexConfig.oauthAccessToken.trim();
  if (!token) {
    throw new Error(
      getOpenAICodexReauthGuidance(
        "OpenAI Codex OAuth access token is empty.",
      ),
    );
  }
  const chatgptAccountId = getChatGPTAccountIdFromToken(token);
  if (!chatgptAccountId) {
    throw new Error(
      getOpenAICodexReauthGuidance(
        "OpenAI Codex OAuth access token is missing a chatgpt_account_id claim required for chatgpt.com/backend-api/codex.",
      ),
    );
  }
  const modelCaps = getModelCapabilities(model);
  const capabilities = new Set<ProviderCapability>();
  if (modelCaps.reasoningEffort) capabilities.add("reasoning-effort");
  if (modelCaps.phase) capabilities.add("phase-annotation");

  const client = new OpenAI({
    apiKey: token,
    baseURL: OPENAI_CODEX_BACKEND_BASE_URL,
    defaultHeaders: {
      "chatgpt-account-id": chatgptAccountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "ouroboros",
    },
    maxRetries: 0,
  });
  let nativeInput: ResponseItem[] | null = null;
  let nativeInstructions = "";
  return {
    id: "openai-codex",
    model,
    client,
    capabilities,
    supportedReasoningEfforts: modelCaps.reasoningEffort,
    resetTurnState(messages: OpenAI.ChatCompletionMessageParam[]): void {
      const { instructions, input } = toResponsesInput(messages);
      nativeInput = input;
      nativeInstructions = instructions;
    },
    appendToolOutput(callId: string, output: string): void {
      if (!nativeInput) return;
      nativeInput.push({ type: "function_call_output", call_id: callId, output });
    },
    async streamTurn(request: ProviderTurnRequest) {
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
    /* v8 ignore next 3 -- delegation: classification logic tested via classifyOpenAICodexError @preserve */
    classifyError(error: Error): ProviderErrorClassification {
      return classifyOpenAICodexError(error);
    },
  };
}
