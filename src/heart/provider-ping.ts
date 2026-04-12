import type Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import type { ChannelCallbacks, ProviderErrorClassification, ProviderRuntime } from "./core"
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
import { createGithubCopilotProviderRuntime } from "./providers/github-copilot"
import { loadAgentSecrets } from "./auth/auth-flow"
import { getDefaultModelForProvider } from "./provider-models"
import { emitNervesEvent } from "../nerves/runtime"

export type PingResult =
  | { ok: true }
  | { ok: false; classification: ProviderErrorClassification; message: string }

type ProviderConfig =
  | AnthropicProviderConfig
  | AzureProviderConfig
  | GithubCopilotProviderConfig
  | MinimaxProviderConfig
  | OpenAICodexProviderConfig

const PING_TIMEOUT_MS = 10_000
const DEFAULT_AZURE_API_VERSION = "2025-04-01-preview"
const PING_CALLBACKS: ChannelCallbacks = {
  onModelStart() {},
  onModelStreamStart() {},
  onTextChunk() {},
  onReasoningChunk() {},
  onToolStart() {},
  onToolEnd() {},
  onError() {},
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

function hasEmptyCredentials(provider: AgentProvider, config: ProviderConfig): boolean {
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

function createRuntimeForPing(provider: AgentProvider, config: ProviderConfig): ProviderRuntime {
  // Use the same provider defaults as auth switch and hatch so verification
  // cannot drift to stale provider/model pairings, and pass the checked
  // credentials directly so daemon-side pings do not depend on --agent globals.
  const model = getDefaultModelForProvider(provider)
  switch (provider) {
    case "anthropic":
      return createAnthropicProviderRuntime(model, config as AnthropicProviderConfig)
    case "azure":
      return createAzureProviderRuntime(model, {
        ...(config as AzureProviderConfig),
        apiVersion: (config as AzureProviderConfig).apiVersion ?? DEFAULT_AZURE_API_VERSION,
      })
    case "minimax":
      return createMinimaxProviderRuntime(model, config as MinimaxProviderConfig)
    case "openai-codex":
      return createOpenAICodexProviderRuntime(model, config as OpenAICodexProviderConfig)
    case "github-copilot":
      return createGithubCopilotProviderRuntime(model, config as GithubCopilotProviderConfig)
    /* v8 ignore next 2 -- exhaustive: all providers handled above @preserve */
    default:
      throw new Error(`unsupported provider for ping: ${provider}`)
  }
}


export async function pingProvider(
  provider: AgentProvider,
  config: ProviderConfig,
): Promise<PingResult> {
  if (hasEmptyCredentials(provider, config)) {
    return { ok: false, classification: "auth-failure", message: "no credentials configured" }
  }

  let runtime: ProviderRuntime
  try {
    runtime = createRuntimeForPing(provider, config)
  /* v8 ignore start -- factory creation failure: tested via individual provider init tests @preserve */
  } catch (error) {
    return {
      ok: false,
      classification: "auth-failure",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  /* v8 ignore stop */

  try {
    const controller = new AbortController()
    /* v8 ignore next -- timeout callback: only fires after 10s, tests resolve faster @preserve */
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    try {
      // Minimal API call — no thinking, no reasoning, no tools.
      if (provider === "anthropic") {
        // Use haiku for the ping — setup tokens may not have access to newer
        // models, but if haiku works, the credentials are valid.
        // Override the beta header to exclude thinking (which requires a
        // thinking param in the request body).
        const client = runtime.client as Anthropic
        await client.messages.create(
          { model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
          { signal: controller.signal, headers: { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" } },
        )
      } else if (provider === "openai-codex") {
        await runtime.streamTurn({
          messages: [{ role: "user", content: "ping" }],
          activeTools: [],
          callbacks: PING_CALLBACKS,
          signal: controller.signal,
          toolChoiceRequired: false,
        })
      } else {
        // OpenAI-compatible providers (azure, minimax, github-copilot)
        const client = runtime.client as OpenAI
        await client.chat.completions.create(
          { model: runtime.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
          { signal: controller.signal },
        )
      }
      return { ok: true }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    const err = error instanceof Error ? error : /* v8 ignore next -- defensive @preserve */ new Error(String(error))
    let classification: ProviderErrorClassification
    try {
      classification = runtime.classifyError(err)
    } catch {
      /* v8 ignore next -- defensive: classifyError should not throw @preserve */
      classification = "unknown"
    }
    emitNervesEvent({
      component: "engine",
      event: "engine.provider_ping_fail",
      message: `provider ping failed: ${provider}`,
      meta: { provider, classification, error: err.message },
    })
    return { ok: false, classification, message: sanitizeErrorMessage(err.message) }
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
      const result = await ping(provider, config as ProviderConfig)
      return [provider, result] as const
    }),
  )

  const inventory: HealthInventoryResult = {}
  for (const [provider, result] of results) {
    inventory[provider] = result
  }
  return inventory
}
