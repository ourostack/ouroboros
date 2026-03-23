import type Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import type { ProviderErrorClassification, ProviderRuntime } from "./core"
import type { AgentProvider } from "./identity"
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
import { loadAgentSecrets } from "./daemon/auth-flow"
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

/**
 * Strip raw JSON API response bodies from error messages.
 * SDK errors often include the full response body: "400 {"type":"error","error":...}".
 * Extract just the HTTP status prefix or a short summary.
 */
export function sanitizeErrorMessage(message: string): string {
  // Match "NNN {json...}" pattern — keep the status code, drop the JSON
  const match = message.match(/^(\d{3})\s*\{/)
  if (match) {
    // Try to extract the inner message from the JSON
    try {
      const json = JSON.parse(message.slice(match[1].length).trim())
      const inner = json?.error?.message
      if (typeof inner === "string" && inner && inner !== "Error") {
        return `${match[1]} ${inner}`
      }
    } catch { /* not valid JSON, fall through */ }
    return `HTTP ${match[1]}`
  }
  return message
}

function hasEmptyCredentials(provider: AgentProvider, config: ProviderConfig): boolean {
  switch (provider) {
    case "anthropic":
      return !(config as AnthropicProviderConfig).setupToken
    case "openai-codex":
      return !(config as OpenAICodexProviderConfig).oauthAccessToken
    case "minimax":
      return !(config as MinimaxProviderConfig).apiKey
    case "azure": {
      const azure = config as AzureProviderConfig
      return !(azure.apiKey && azure.endpoint && azure.deployment)
    }
    case "github-copilot": {
      const copilot = config as GithubCopilotProviderConfig
      return !(copilot.githubToken && copilot.baseUrl)
    }
    /* v8 ignore next 2 -- exhaustive: all providers handled above @preserve */
    default:
      return true
  }
}

function createRuntimeForPing(provider: AgentProvider, config: ProviderConfig): ProviderRuntime {
  switch (provider) {
    case "anthropic":
      return createAnthropicProviderRuntime(config as AnthropicProviderConfig)
    case "azure":
      return createAzureProviderRuntime(config as AzureProviderConfig)
    case "minimax":
      return createMinimaxProviderRuntime(config as MinimaxProviderConfig)
    case "openai-codex":
      return createOpenAICodexProviderRuntime(config as OpenAICodexProviderConfig)
    case "github-copilot":
      return createGithubCopilotProviderRuntime(config as GithubCopilotProviderConfig)
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
      } else {
        // OpenAI-compatible providers (azure, codex, minimax, github-copilot)
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
