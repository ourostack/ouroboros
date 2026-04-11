import type { ProviderErrorClassification } from "./core"
import type { AgentProvider } from "./identity"
import type { HealthInventoryResult, PingResult } from "./provider-ping"
import {
  getDefaultModelForProvider,
  getProviderModelMismatchMessage,
  resolveModelForProviderDisplay,
} from "./provider-models"
import { emitNervesEvent } from "../nerves/runtime"

export interface FailoverContext {
  errorSummary: string
  classification: ProviderErrorClassification
  currentProvider: AgentProvider
  agentName: string
  workingProviders: AgentProvider[]
  unconfiguredProviders: AgentProvider[]
  userMessage: string
}

export type FailoverAction =
  | { action: "switch"; provider: AgentProvider }
  | { action: "dismiss" }

const CLASSIFICATION_LABELS: Record<ProviderErrorClassification, string> = {
  "auth-failure": "authentication failed",
  "usage-limit": "hit its usage limit",
  "rate-limit": "is being rate limited",
  "server-error": "is experiencing an outage",
  "network-error": "is unreachable (network error)",
  "unknown": "encountered an error",
}

function formatProviderWithModel(provider: AgentProvider, model: string): string {
  if (!model) return provider
  if (getProviderModelMismatchMessage(provider, model)) {
    return `${provider} [configured model: ${model}]`
  }
  return `${provider} (${model})`
}

function formatErrorDetail(errorMessage: string, errorSummary: string): string {
  const detail = errorMessage.replace(/\s+/g, " ").trim()
  if (!detail || detail === errorSummary) return ""
  return detail.length > 300 ? `${detail.slice(0, 297)}...` : detail
}

function formatFailingProviderLine(
  provider: AgentProvider,
  classification: ProviderErrorClassification,
  agentName: string,
): string {
  const authCommand = `ouro auth --agent ${agentName} --provider ${provider}`
  switch (classification) {
    case "auth-failure":
      return `  - ${provider}: credentials need to be refreshed. Run \`${authCommand}\`.`
    case "network-error":
      return `  - ${provider}: could not be reached. Check network/provider availability; if credentials may be stale, run \`${authCommand}\`.`
    case "server-error":
      return `  - ${provider}: provider outage or server error. Retry later; if it keeps failing, run \`${authCommand}\`.`
    case "rate-limit":
      return `  - ${provider}: rate limited. Wait and retry, or switch to a ready provider below.`
    case "usage-limit":
      return `  - ${provider}: usage limit hit. Wait for quota reset, raise quota, or switch to a ready provider below.`
    case "unknown":
      return `  - ${provider}: could not be reached. Run \`${authCommand}\` if credentials may be stale.`
  }
}

export function buildFailoverContext(
  errorMessage: string,
  classification: ProviderErrorClassification,
  currentProvider: AgentProvider,
  currentModel: string,
  agentName: string,
  inventory: HealthInventoryResult,
  providerModels: Partial<Record<AgentProvider, string>>,
): FailoverContext {
  const label = CLASSIFICATION_LABELS[classification]
  const providerWithModel = formatProviderWithModel(currentProvider, currentModel)
  const errorSummary = `${providerWithModel} ${label}`
  const errorDetail = formatErrorDetail(errorMessage, errorSummary)
  const modelMismatch = getProviderModelMismatchMessage(currentProvider, currentModel)

  const workingProviders: AgentProvider[] = []
  const unconfiguredProviders: AgentProvider[] = []
  const failingProviders: { provider: AgentProvider; classification: ProviderErrorClassification }[] = []

  for (const [provider, result] of Object.entries(inventory) as [AgentProvider, PingResult][]) {
    if (result.ok) {
      workingProviders.push(provider)
    } else if (result.classification === "auth-failure" && result.message === "no credentials configured") {
      unconfiguredProviders.push(provider)
    } else {
      // Configured but ping failed (expired token, provider also down, etc.)
      failingProviders.push({ provider, classification: result.classification })
    }
  }

  const lines: string[] = [`${errorSummary}.`]
  if (errorDetail) {
    lines.push(`provider detail: ${errorDetail}`)
  }

  if (classification === "auth-failure") {
    lines.push("")
    lines.push("To keep using the current provider:")
    lines.push(`  1. Run \`ouro auth --agent ${agentName} --provider ${currentProvider}\``)
  }

  if (modelMismatch) {
    const defaultModel = getDefaultModelForProvider(currentProvider)
    lines.push("")
    lines.push("Config warning:")
    lines.push(`  - ${modelMismatch}`)
    lines.push("  - Repair the configured model with:")
    lines.push(`    \`ouro config model --agent ${agentName} --facing human ${defaultModel}\``)
    lines.push(`    \`ouro config model --agent ${agentName} --facing agent ${defaultModel}\``)
  }

  if (workingProviders.length > 0) {
    lines.push("")
    lines.push("Ready providers:")
    for (const provider of workingProviders) {
      const model = resolveModelForProviderDisplay(provider, providerModels[provider])
      lines.push(`  - ${provider} (${model}): reply "switch to ${provider}"`)
    }
  }

  if (failingProviders.length > 0) {
    lines.push("")
    lines.push("Configured but unavailable:")
    for (const { provider, classification } of failingProviders) {
      lines.push(formatFailingProviderLine(provider, classification, agentName))
    }
  }

  if (unconfiguredProviders.length > 0) {
    lines.push("")
    lines.push("Not configured:")
    for (const provider of unconfiguredProviders) {
      lines.push(`  - ${provider}: run \`ouro auth --agent ${agentName} --provider ${provider}\``)
    }
  }

  if (workingProviders.length === 0 && unconfiguredProviders.length === 0 && failingProviders.length === 0) {
    lines.push("")
    lines.push(`No other providers are available. Run \`ouro auth --agent ${agentName}\` in terminal to configure one.`)
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.failover_context_built",
    message: "built provider failover context",
    meta: { currentProvider, classification, workingProviders, unconfiguredProviders },
  })

  return {
    errorSummary,
    classification,
    currentProvider,
    agentName,
    workingProviders,
    unconfiguredProviders,
    userMessage: lines.join("\n"),
  }
}

export function handleFailoverReply(
  reply: string,
  context: FailoverContext,
): FailoverAction {
  const lower = reply.toLowerCase().trim()
  for (const provider of context.workingProviders) {
    if (lower.includes(`switch to ${provider}`) || lower === provider) {
      return { action: "switch", provider }
    }
  }
  return { action: "dismiss" }
}
