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

// Copilot rows (dot-named ids) mirror GitHub Copilot's /models endpoint as of
// 2026-10-12. Direct Anthropic rows (dash-named ids) copy their Copilot twins.
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "claude-opus-5.5": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-sonnet-5.5": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-haiku-5.5": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-opus-5-5": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-sonnet-5-5": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 128000,
    vision: true,
  },
  "claude-haiku-5-5": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    thinkingFormat: "anthropic",
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-6.1-sol": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-6-sol": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-6-luna": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-6-astra": {
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-5.6-sol": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-5.6-sol-fast": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-5.6-luna": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-5.6-terra": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
  },
  "gpt-5.5": {
    reasoningEffort: ["none", "low", "medium", "high", "xhigh"],
    phase: true,
    maxOutputTokens: 128000,
    vision: true,
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
