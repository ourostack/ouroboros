import { emitNervesEvent } from "../nerves/runtime"

export interface ModelCapabilities {
  reasoningEffort?: readonly string[]
  thinkingFormat?: "anthropic"
  phase?: boolean
  maxOutputTokens?: number
}

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-opus-4-6": {
    reasoningEffort: ["low", "medium", "high", "max"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 128000,
  },
  "claude-sonnet-4-6": {
    reasoningEffort: ["low", "medium", "high"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 64000,
  },
  "claude-opus-4.6": {
    reasoningEffort: ["low", "medium", "high", "max"],
    maxOutputTokens: 128000,
  },
  "claude-sonnet-4.6": {
    reasoningEffort: ["low", "medium", "high"],
    maxOutputTokens: 64000,
  },
  "gpt-5.4": {
    reasoningEffort: ["low", "medium", "high"],
    phase: true,
    maxOutputTokens: 100000,
  },
  "gpt-5.3-codex": {
    reasoningEffort: ["low", "medium", "high"],
    phase: true,
    maxOutputTokens: 100000,
  },
}

const EMPTY_CAPABILITIES: ModelCapabilities = Object.freeze({})

export function getModelCapabilities(modelId: string): ModelCapabilities {
  emitNervesEvent({
    component: "engine",
    event: "engine.model_capabilities_lookup",
    message: `model capabilities lookup: ${modelId}`,
    meta: { modelId, found: modelId in MODEL_CAPABILITIES },
  })
  const entry = MODEL_CAPABILITIES[modelId]
  if (entry) return entry
  return { ...EMPTY_CAPABILITIES }
}
