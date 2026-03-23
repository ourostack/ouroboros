import OpenAI from "openai";
import { getOpenAICodexConfig, type OpenAICodexProviderConfig } from "../config";
import { getAgentName, getAgentSecretsPath } from "../identity";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../core";
import type { ResponseItem } from "../streaming";
import { streamResponsesApi, toResponsesInput, toResponsesTools } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

interface HttpError extends Error { status?: number }
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

/* v8 ignore start -- shared network error utility, tested via classification tests @preserve */
function isNetworkError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code || ""
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EPIPE",
       "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"].includes(code)) return true
  const msg = error.message || ""
  return msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("getaddrinfo")
}
/* v8 ignore stop */

export function classifyOpenAICodexError(error: Error): ProviderErrorClassification {
  const status = (error as HttpError).status
  if (status === 401 || status === 403 || isOpenAICodexAuthFailure(error)) return "auth-failure"
  if (status === 429) {
    const lower = error.message.toLowerCase()
    if (lower.includes("usage") || lower.includes("quota") || lower.includes("exceeded your")) return "usage-limit"
    return "rate-limit"
  }
  if (status && status >= 500) return "server-error"
  if (isNetworkError(error)) return "network-error"
  return "unknown"
}

/* v8 ignore start -- auth detection: only called from classifyOpenAICodexError which always passes Error @preserve */
function isOpenAICodexAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as HttpError).status;
  if (status === 401 || status === 403) return true;
  const lower = error.message.toLowerCase();
  return OPENAI_CODEX_AUTH_FAILURE_MARKERS.some((marker) => lower.includes(marker));
}
/* v8 ignore stop */


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

export function createOpenAICodexProviderRuntime(config?: OpenAICodexProviderConfig): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "openai-codex provider init",
    meta: { provider: "openai-codex" },
  });
  const codexConfig = config ?? getOpenAICodexConfig();
  if (!(codexConfig.model && codexConfig.oauthAccessToken)) {
    throw new Error(
      getOpenAICodexReauthGuidance(
        "provider 'openai-codex' is selected in agent.json but providers.openai-codex.model/oauthAccessToken is incomplete in secrets.json.",
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
  const modelCaps = getModelCapabilities(codexConfig.model);
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
    timeout: 30000,
    maxRetries: 0,
  });
  let nativeInput: ResponseItem[] | null = null;
  let nativeInstructions = "";
  return {
    id: "openai-codex",
    model: codexConfig.model,
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
          request.eagerFinalAnswerStreaming,
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
