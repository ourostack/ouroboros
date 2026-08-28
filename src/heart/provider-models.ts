import type { AgentProvider } from "./identity"
import { emitNervesEvent } from "../nerves/runtime"

export const DEFAULT_PROVIDER_MODELS: Record<AgentProvider, string> = {
  anthropic: "claude-opus-4-6",
  azure: "gpt-4o-mini",
  minimax: "MiniMax-M3",
  "openai-codex": "gpt-5.4",
  "github-copilot": "claude-sonnet-4.6",
  "openai-compatible": "glm-5.3-flash",
  "openai-compatible-gemini": "gemini-3.6-flash",
}

const PROVIDER_NAMES: Record<AgentProvider, string> = {
  anthropic: "Anthropic",
  azure: "Azure OpenAI",
  minimax: "MiniMax",
  "openai-codex": "OpenAI Codex",
  "github-copilot": "GitHub Copilot",
  "openai-compatible": "Z.ai OpenAI-compatible",
  "openai-compatible-gemini": "Gemini OpenAI-compatible",
}

function normalized(model: string): string {
  return model.trim().toLowerCase()
}

export function getProviderDisplayName(provider: AgentProvider): string {
  return PROVIDER_NAMES[provider]
}

export function getDefaultModelForProvider(provider: AgentProvider): string {
  return DEFAULT_PROVIDER_MODELS[provider]
}

export function isModelClearlyIncompatibleWithProvider(provider: AgentProvider, model: string): boolean {
  const value = normalized(model)
  if (!value) return true

  switch (provider) {
    case "anthropic":
      return !value.startsWith("claude-")
    case "minimax":
      return !value.startsWith("minimax")
    case "openai-codex":
      return value.startsWith("claude-") || value.startsWith("minimax")
    case "azure":
      return value.startsWith("claude-") || value.startsWith("minimax")
    case "github-copilot":
      return false
    case "openai-compatible":
      return ![
        "glm-5.3-flash",
        "glm-5.3",
        "glm-5.2",
        "glm-5-turbo",
        "glm-4.7-flash",
        "glm-4.5-flash",
      ].includes(value)
    case "openai-compatible-gemini":
      return value !== "gemini-3.6-flash"
  }
}

export function resolveModelForProviderSelection(
  provider: AgentProvider,
  currentModel: string,
): { model: string; preserved: boolean } {
  const trimmed = currentModel.trim()
  if (trimmed && !isModelClearlyIncompatibleWithProvider(provider, trimmed)) {
    return { model: trimmed, preserved: true }
  }
  const model = getDefaultModelForProvider(provider)
  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.provider_model_defaulted",
    message: "defaulted provider model during provider selection",
    meta: { provider, previousModel: currentModel, model },
  })
  return { model, preserved: false }
}

export function resolveModelForProviderDisplay(provider: AgentProvider, modelHint?: string): string {
  const hint = modelHint?.trim() ?? ""
  if (hint && !isModelClearlyIncompatibleWithProvider(provider, hint)) return hint
  return getDefaultModelForProvider(provider)
}

export function getProviderModelMismatchMessage(provider: AgentProvider, model: string): string | null {
  const trimmed = model.trim()
  if (!isModelClearlyIncompatibleWithProvider(provider, trimmed)) return null

  const providerName = getProviderDisplayName(provider)
  const defaultModel = getDefaultModelForProvider(provider)
  if (!trimmed) {
    return `${providerName} has no model set. Suggested model: ${defaultModel}.`
  }
  return `${providerName} is currently paired with ${trimmed}, which does not look like a model for ${providerName}. Suggested model: ${defaultModel}.`
}
