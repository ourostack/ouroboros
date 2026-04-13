import type { ProviderErrorClassification, ProviderRuntime } from "./core"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "./identity"
import type {
  AnthropicProviderConfig,
  AzureProviderConfig,
  GithubCopilotProviderConfig,
  MinimaxProviderConfig,
  OpenAICodexProviderConfig,
} from "./config"
import { createAnthropicProviderRuntime } from "./providers/anthropic"
import { createAzureProviderRuntime } from "./providers/azure"
import { createMinimaxProviderRuntime } from "./providers/minimax"
import { createOpenAICodexProviderRuntime } from "./providers/openai-codex"
import { classifyGithubCopilotError, createGithubCopilotProviderRuntime } from "./providers/github-copilot"
import { loadAgentSecrets } from "./auth/auth-flow"
import { getDefaultModelForProvider } from "./provider-models"
import { emitNervesEvent } from "../nerves/runtime"
import {
  runProviderAttempt,
  type ProviderAttemptPolicy,
  type ProviderAttemptRecord,
} from "./provider-attempt"

export type PingResult =
  | { ok: true; attempts?: ProviderAttemptRecord[] }
  | { ok: false; classification: ProviderErrorClassification; message: string; attempts?: ProviderAttemptRecord[] }

export type GithubCopilotModelPingResult =
  | { ok: true }
  | { ok: false; error: string }

export type ProviderRuntimeConfig =
  | AnthropicProviderConfig
  | AzureProviderConfig
  | GithubCopilotProviderConfig
  | MinimaxProviderConfig
  | OpenAICodexProviderConfig

export interface ProviderPingOptions {
  model?: string
  attemptPolicy?: Partial<ProviderAttemptPolicy>
  sleep?: (delayMs: number) => Promise<void>
}

const PING_TIMEOUT_MS = 10_000
const PING_PROMPT = "ping"
const CHAT_PING_MAX_TOKENS = 1
const RESPONSE_PING_MAX_OUTPUT_TOKENS = 16
const DEFAULT_AZURE_API_VERSION = "2025-04-01-preview"

type PingMessage = { role: "user"; content: string }

function createPingMessages(): PingMessage[] {
  return [{ role: "user", content: PING_PROMPT }]
}

function createChatPingRequest(model: string): { model: string; max_tokens: number; messages: PingMessage[] } {
  return { model, max_tokens: CHAT_PING_MAX_TOKENS, messages: createPingMessages() }
}

function createResponsePingRequest(model: string): { model: string; input: string; max_output_tokens: number } {
  return { model, input: PING_PROMPT, max_output_tokens: RESPONSE_PING_MAX_OUTPUT_TOKENS }
}

/**
 * Strip raw JSON/HTML API response bodies from error messages.
 * SDK errors often include the full response: "400 {"type":"error",...}" or "403 <html>...".
 * Extract just the HTTP status and a short human-readable summary.
 */
export function sanitizeErrorMessage(message: string): string {
  const statusMatch = message.match(/^(\d{3})\s/)
  if (!statusMatch) return message

  const status = statusMatch[1]
  const body = message.slice(status.length).trim()

  // HTML response (Cloudflare challenge, error pages, etc.)
  if (body.startsWith("<") || body.includes("<!DOCTYPE") || body.includes("<html")) {
    return `HTTP ${status}`
  }

  // JSON response
  if (body.startsWith("{")) {
    try {
      const json = JSON.parse(body)
      const inner = json?.error?.message
      if (typeof inner === "string" && inner && inner !== "Error") {
        return `${status} ${inner}`
      }
    } catch { /* not valid JSON */ }
    return `HTTP ${status}`
  }

  // Already clean (e.g., "401 Provided authentication token is expired.")
  return message
}

async function readGithubCopilotModelPingError(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`
  try {
    const json = await response.json() as Record<string, unknown>
    /* v8 ignore start -- error format parsing: all branches tested via config-models.test.ts @preserve */
    if (typeof json.error === "string") detail = json.error
    else if (typeof json.error === "object" && json.error !== null) {
      const errObj = json.error as Record<string, unknown>
      if (typeof errObj.message === "string") detail = errObj.message
    }
    else if (typeof json.message === "string") detail = json.message
    /* v8 ignore stop */
  } catch {
    // response body not JSON — keep HTTP status
  }
  return detail
}

function createStatusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

export async function pingGithubCopilotModel(
  baseUrl: string,
  token: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubCopilotModelPingResult> {
  const base = baseUrl.replace(/\/+$/, "")
  const isClaude = model.startsWith("claude")
  const url = isClaude ? `${base}/chat/completions` : `${base}/responses`
  const body = isClaude
    ? JSON.stringify(createChatPingRequest(model))
    : JSON.stringify(createResponsePingRequest(model))

  const attempt = await runProviderAttempt({
    operation: "model-ping",
    provider: "github-copilot",
    model,
    classifyError: classifyGithubCopilotError,
    policy: {
      maxAttempts: 3,
      baseDelayMs: 0,
      backoffMultiplier: 2,
    },
    run: async () => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
      })
      if (!response.ok) {
        throw createStatusError(await readGithubCopilotModelPingError(response), response.status)
      }
    },
  })

  return attempt.ok ? { ok: true } : { ok: false, error: attempt.error.message }
}

function hasEmptyCredentials(provider: AgentProvider, config: ProviderRuntimeConfig): boolean {
  const record = config as unknown as Record<string, unknown>
  if (provider === "azure") {
    const hasManagedIdentity =
      typeof record.endpoint === "string" && record.endpoint.length > 0 &&
      typeof record.deployment === "string" && record.deployment.length > 0 &&
      typeof record.managedIdentityClientId === "string" && record.managedIdentityClientId.length > 0
    if (hasManagedIdentity) return false
  }
  return PROVIDER_CREDENTIALS[provider].required.some((key) => !record[key])
}

export function createProviderRuntimeForConfig(
  provider: AgentProvider,
  config: ProviderRuntimeConfig,
  options: { model?: string } = {},
): ProviderRuntime {
  // Use the same provider defaults as auth switch and hatch so verification
  // cannot drift to stale provider/model pairings, and pass the checked
  // credentials directly so daemon-side pings do not depend on --agent globals.
  const resolvedModel = options.model ?? getDefaultModelForProvider(provider)
  switch (provider) {
    case "anthropic":
      return createAnthropicProviderRuntime(resolvedModel, config as AnthropicProviderConfig)
    case "azure":
      return createAzureProviderRuntime(resolvedModel, {
        ...(config as AzureProviderConfig),
        apiVersion: (config as AzureProviderConfig).apiVersion ?? DEFAULT_AZURE_API_VERSION,
      })
    case "minimax":
      return createMinimaxProviderRuntime(resolvedModel, config as MinimaxProviderConfig)
    case "openai-codex":
      return createOpenAICodexProviderRuntime(resolvedModel, config as OpenAICodexProviderConfig)
    case "github-copilot":
      return createGithubCopilotProviderRuntime(resolvedModel, config as GithubCopilotProviderConfig)
    /* v8 ignore next 2 -- exhaustive: all providers handled above @preserve */
    default:
      throw new Error(`unsupported provider for ping: ${provider}`)
  }
}


export async function pingProvider(
  provider: AgentProvider,
  config: ProviderRuntimeConfig,
  options: ProviderPingOptions = {},
): Promise<PingResult> {
  if (hasEmptyCredentials(provider, config)) {
    return { ok: false, classification: "auth-failure", message: "no credentials configured" }
  }

  let runtime: ProviderRuntime
  try {
    runtime = createProviderRuntimeForConfig(provider, config, { model: options.model })
  /* v8 ignore start -- factory creation failure: tested via individual provider init tests @preserve */
  } catch (error) {
    return {
      ok: false,
      classification: "auth-failure",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  /* v8 ignore stop */

  const attempt = await runProviderAttempt({
    operation: "ping",
    provider,
    model: runtime.model,
    classifyError: (error) => runtime.classifyError(error),
    policy: {
      maxAttempts: 3,
      baseDelayMs: 0,
      backoffMultiplier: 2,
      ...options.attemptPolicy,
    },
    sleep: options.sleep,
    run: async () => {
      const controller = new AbortController()
      /* v8 ignore next -- timeout callback: only fires after 10s, tests resolve faster @preserve */
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
      try {
        await runtime.ping(controller.signal)
      } finally {
        clearTimeout(timeout)
      }
    },
  })

  if (attempt.ok) {
    return { ok: true, attempts: attempt.attempts }
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.provider_ping_fail",
    message: `provider ping failed: ${provider}`,
    meta: { provider, classification: attempt.classification, error: attempt.error.message },
  })
  return {
    ok: false,
    classification: attempt.classification,
    message: sanitizeErrorMessage(attempt.error.message),
    attempts: attempt.attempts,
  }
}

export type HealthInventoryResult = Partial<Record<AgentProvider, PingResult>>

export interface HealthInventoryDeps {
  ping?: typeof pingProvider
}

const PINGABLE_PROVIDERS: AgentProvider[] = ["anthropic", "openai-codex", "azure", "minimax", "github-copilot"]

export async function runHealthInventory(
  agentName: string,
  currentProvider: AgentProvider,
  deps: HealthInventoryDeps = {},
): Promise<HealthInventoryResult> {
  /* v8 ignore next -- default: tests inject ping dep @preserve */
  const ping = deps.ping ?? pingProvider
  const { secrets } = loadAgentSecrets(agentName)
  const providers = PINGABLE_PROVIDERS.filter((p) => p !== currentProvider)

  const results = await Promise.all(
    providers.map(async (provider) => {
      const config = secrets.providers[provider as keyof typeof secrets.providers]
      const result = await ping(provider, config as ProviderRuntimeConfig)
      return [provider, result] as const
    }),
  )

  const inventory: HealthInventoryResult = {}
  for (const [provider, result] of results) {
    inventory[provider] = result
  }
  return inventory
}
