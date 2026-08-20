import type OpenAI from "openai"

import { getPackageVersion } from "../../mind/bundle-manifest"
import { emitNervesEvent } from "../../nerves/runtime"
import type { ProviderErrorClassification, ProviderId, ProviderRuntime, ProviderTurnRequest } from "../core"
import type { TurnResult, UsageData } from "../streaming"
import { classifyHttpError } from "./error-classification"

export type OpenAICompatibleProviderId = "openai-compatible" | "openai-compatible-gemini"

export interface OpenAICompatibleProviderConfig {
  apiKey: string
  baseUrl: string
}

export interface OpenAICompatibleProviderDeps {
  fetch?: typeof fetch
  packageVersion?: string
}

const CANONICAL_BASE_URLS: Record<OpenAICompatibleProviderId, string> = {
  "openai-compatible": "https://api.z.ai/api/paas/v4/",
  "openai-compatible-gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
}

function canonicalBaseUrl(provider: OpenAICompatibleProviderId, value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${provider} requires its canonical base URL`)
  }
  const normalized = parsed.toString().replace(/\/+$/u, "/")
  const normalizedInput = value.replace(/\/+$/u, "/")
  if (normalizedInput !== CANONICAL_BASE_URLS[provider] || normalized !== CANONICAL_BASE_URLS[provider]) {
    throw new Error(`${provider} requires its canonical base URL ${CANONICAL_BASE_URLS[provider]}`)
  }
  return normalized
}

function safeError(error: unknown, apiKey: string): Error {
  const redact = (value: string): string => value.split(apiKey).join("[redacted]")
  const message = redact(error instanceof Error ? error.message : String(error))
  const safe = new Error(message) as Error & { status?: number; code?: string }
  if (error instanceof Error) {
    const source = error as Error & { status?: unknown; code?: unknown }
    if (typeof source.status === "number" && Number.isFinite(source.status)) safe.status = source.status
    if (typeof source.code === "string") safe.code = redact(source.code)
  }
  return safe
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`OpenAI-compatible response ${label} is missing`)
  return value
}

function parseUsage(value: unknown): UsageData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const usage = value as Record<string, unknown>
  const input = usage.prompt_tokens
  const output = usage.completion_tokens
  const total = usage.total_tokens
  if (![input, output, total].every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) return undefined
  const details = usage.completion_tokens_details
  const reasoning = details && typeof details === "object" && !Array.isArray(details)
    && Number.isSafeInteger((details as Record<string, unknown>).reasoning_tokens)
    ? Number((details as Record<string, unknown>).reasoning_tokens)
    : 0
  return { input_tokens: Number(input), output_tokens: Number(output), reasoning_tokens: reasoning, total_tokens: Number(total) }
}

function parseCompletion(value: unknown, callbacks: ProviderTurnRequest["callbacks"]): TurnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OpenAI-compatible response envelope is invalid")
  const choices = (value as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length !== 1 || !choices[0] || typeof choices[0] !== "object") {
    throw new Error("OpenAI-compatible response must contain exactly one choice")
  }
  const choice = choices[0] as Record<string, unknown>
  const message = choice.message
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("OpenAI-compatible choice message is invalid")
  const record = message as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, "function_call")) {
    throw new Error("OpenAI-compatible legacy function_call is unsupported")
  }
  const rawCalls = record.tool_calls
  const calls = rawCalls === undefined || rawCalls === null ? [] : rawCalls
  if (!Array.isArray(calls)) throw new Error("OpenAI-compatible tool_calls must be an array")
  const toolCalls = calls.map((call) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("OpenAI-compatible tool call is invalid")
    const callRecord = call as Record<string, unknown>
    const fn = callRecord.function
    if (callRecord.type !== "function" || !fn || typeof fn !== "object" || Array.isArray(fn)) {
      throw new Error("OpenAI-compatible tool call must be a function")
    }
    return {
      id: requiredString(callRecord.id, "tool call id"),
      name: requiredString((fn as Record<string, unknown>).name, "tool name"),
      arguments: requiredString((fn as Record<string, unknown>).arguments, "tool arguments"),
    }
  })
  const content = typeof record.content === "string" ? record.content : ""
  if (choice.finish_reason === "stop") {
    if (toolCalls.length !== 0 || content.trim().length === 0) throw new Error("OpenAI-compatible stop response shape is invalid")
  } else if (choice.finish_reason === "tool_calls") {
    if (toolCalls.length < 1 || toolCalls.length > 8 || content.trim().length !== 0) {
      throw new Error("OpenAI-compatible tool_calls response shape is invalid")
    }
  } else {
    throw new Error("OpenAI-compatible finish_reason is unsupported")
  }
  callbacks.onModelStreamStart()
  if (content) callbacks.onTextChunk(content)
  return {
    content,
    toolCalls,
    outputItems: [],
    usage: parseUsage((value as Record<string, unknown>).usage),
  }
}

export function createOpenAICompatibleProviderRuntime(
  provider: OpenAICompatibleProviderId,
  model: string,
  config: OpenAICompatibleProviderConfig,
  deps: OpenAICompatibleProviderDeps = {},
): ProviderRuntime {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) throw new Error(`provider '${provider}' is selected but apiKey is missing in the agent vault`)
  const baseUrl = canonicalBaseUrl(provider, config.baseUrl)
  const fetchImpl = deps.fetch ?? fetch
  const packageVersion = deps.packageVersion ?? getPackageVersion()
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "OpenAI-compatible provider init",
    meta: { provider },
  })

  const request = async (messages: OpenAI.ChatCompletionMessageParam[], tools: OpenAI.ChatCompletionFunctionTool[], signal?: AbortSignal, toolChoiceRequired = false): Promise<unknown> => {
    const body: Record<string, unknown> = { model, messages, tools, stream: false }
    if (provider === "openai-compatible") body.temperature = 0
    if (toolChoiceRequired) body.tool_choice = "required"
    try {
      const response = await fetchImpl(new URL("chat/completions", baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(provider === "openai-compatible-gemini"
            ? { "x-goog-api-client": `ouroboros-harness-oai/${packageVersion}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok) throw Object.assign(new Error(`provider request failed with HTTP ${response.status}`), { status: response.status })
      return await response.json()
    } catch (error) {
      throw safeError(error, apiKey)
    }
  }

  return {
    id: provider as ProviderId,
    model,
    client: { baseUrl },
    capabilities: new Set(),
    resetTurnState() {},
    appendToolOutput() {},
    async streamTurn(turnRequest) {
      return parseCompletion(
        await request(turnRequest.messages, turnRequest.activeTools, turnRequest.signal, turnRequest.toolChoiceRequired),
        turnRequest.callbacks,
      )
    },
    async ping(signal) {
      const callbacks: ProviderTurnRequest["callbacks"] = {
        /* v8 ignore next -- parseCompletion cannot invoke this interface-required ping callback @preserve */
        onModelStart() {},
        onModelStreamStart() {},
        onTextChunk() {},
        /* v8 ignore next -- parseCompletion cannot invoke this interface-required ping callback @preserve */
        onReasoningChunk() {},
        /* v8 ignore next -- parseCompletion cannot invoke this interface-required ping callback @preserve */
        onToolStart() {},
        /* v8 ignore next -- parseCompletion cannot invoke this interface-required ping callback @preserve */
        onToolEnd() {},
        /* v8 ignore next -- parseCompletion cannot invoke this interface-required ping callback @preserve */
        onError() {},
      }
      parseCompletion(await request([{ role: "user", content: "ping" }], [], signal), callbacks)
    },
    classifyError(error: Error): ProviderErrorClassification {
      return classifyHttpError(error)
    },
  }
}
