import { emitNervesEvent } from "../nerves/runtime"

export interface ModelCapabilities {
  reasoningEffort?: readonly string[]
  thinkingFormat?: "anthropic"
  phase?: boolean
  maxOutputTokens?: number
  /**
   * True when the model can consume OpenAI-style `image_url` content parts
   * natively. When false/undefined, the BlueBubbles sense falls back to a
   * VLM describe step and replaces the image with text before the turn.
   */
  vision?: boolean
  /**
   * True when the model can consume audio input natively (e.g. `input_audio`
   * content parts). When false/undefined, audio attachments are transcribed
   * to text before the turn. Rows are intentionally unset in this PR — the
   * audio path ships in a later PR after A/B validation.
   */
  audio?: boolean
}

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-opus-4-6": {
    reasoningEffort: ["low", "medium", "high", "max"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-sonnet-4-6": {
    reasoningEffort: ["low", "medium", "high"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 64000,
    vision: true,
  },
  "claude-opus-4.6": {
    reasoningEffort: ["low", "medium", "high", "max"],
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-sonnet-4.6": {
    reasoningEffort: ["low", "medium", "high"],
    maxOutputTokens: 64000,
    vision: true,
  },
  "gpt-5.4": {
    reasoningEffort: ["low", "medium", "high"],
    phase: true,
    maxOutputTokens: 100000,
    vision: true,
  },
  "gpt-5.3-codex": {
    reasoningEffort: ["low", "medium", "high"],
    phase: true,
    maxOutputTokens: 100000,
  },
  "MiniMax-Text-01": {
    vision: true,
  },
  "MiniMax-VL-01": {
    vision: true,
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
