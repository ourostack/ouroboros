import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  DEFAULT_PROVIDER_MODELS,
  getDefaultModelForProvider,
  getProviderDisplayName,
  getProviderModelMismatchMessage,
  isModelClearlyIncompatibleWithProvider,
  resolveModelForProviderDisplay,
  resolveModelForProviderSelection,
} from "../../heart/provider-models"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "config/identity",
    event: "config_identity.test_run",
    message: testName,
    meta: { test: true },
  })
}

describe("provider model helpers", () => {
  it("returns provider display names and defaults", () => {
    emitTestEvent("provider display names and defaults")

    expect(getProviderDisplayName("anthropic")).toBe("Anthropic")
    expect(getProviderDisplayName("azure")).toBe("Azure OpenAI")
    expect(getProviderDisplayName("minimax")).toBe("MiniMax")
    expect(getProviderDisplayName("openai-codex")).toBe("OpenAI Codex")
    expect(getProviderDisplayName("github-copilot")).toBe("GitHub Copilot")

    expect(getDefaultModelForProvider("anthropic")).toBe(DEFAULT_PROVIDER_MODELS.anthropic)
    expect(getDefaultModelForProvider("azure")).toBe(DEFAULT_PROVIDER_MODELS.azure)
    expect(getDefaultModelForProvider("minimax")).toBe(DEFAULT_PROVIDER_MODELS.minimax)
    expect(getDefaultModelForProvider("openai-codex")).toBe(DEFAULT_PROVIDER_MODELS["openai-codex"])
    expect(getDefaultModelForProvider("github-copilot")).toBe(DEFAULT_PROVIDER_MODELS["github-copilot"])
  })

  it("detects clearly incompatible provider/model pairings", () => {
    emitTestEvent("provider model incompatibility detection")

    expect(isModelClearlyIncompatibleWithProvider("anthropic", "")).toBe(true)
    expect(isModelClearlyIncompatibleWithProvider("anthropic", "claude-opus-4-6")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("anthropic", "gpt-5.4")).toBe(true)

    expect(isModelClearlyIncompatibleWithProvider("minimax", "MiniMax-M2.5")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("minimax", "claude-sonnet-4.6")).toBe(true)

    expect(isModelClearlyIncompatibleWithProvider("openai-codex", "gpt-5.4")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("openai-codex", "claude-sonnet-4.6")).toBe(true)
    expect(isModelClearlyIncompatibleWithProvider("openai-codex", "MiniMax-M2.5")).toBe(true)

    expect(isModelClearlyIncompatibleWithProvider("azure", "gpt-4o-mini")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("azure", "claude-sonnet-4.6")).toBe(true)
    expect(isModelClearlyIncompatibleWithProvider("azure", "MiniMax-M2.5")).toBe(true)

    expect(isModelClearlyIncompatibleWithProvider("github-copilot", "claude-sonnet-4.6")).toBe(false)
    expect(isModelClearlyIncompatibleWithProvider("github-copilot", "gpt-5.4")).toBe(false)
  })

  it("preserves compatible models during provider selection", () => {
    emitTestEvent("provider selection preserves compatible models")

    expect(resolveModelForProviderSelection("openai-codex", "  gpt-5.4  ")).toEqual({
      model: "gpt-5.4",
      preserved: true,
    })
    expect(resolveModelForProviderSelection("github-copilot", "claude-sonnet-4.6")).toEqual({
      model: "claude-sonnet-4.6",
      preserved: true,
    })
  })

  it("defaults incompatible models during provider selection", () => {
    emitTestEvent("provider selection defaults incompatible models")

    expect(resolveModelForProviderSelection("openai-codex", "claude-sonnet-4.6")).toEqual({
      model: "gpt-5.4",
      preserved: false,
    })
    expect(resolveModelForProviderSelection("minimax", "")).toEqual({
      model: "MiniMax-M2.7",
      preserved: false,
    })
  })

  it("resolves display models from hints with safe fallbacks", () => {
    emitTestEvent("provider display model fallback")

    expect(resolveModelForProviderDisplay("anthropic", "claude-opus-4-6")).toBe("claude-opus-4-6")
    expect(resolveModelForProviderDisplay("anthropic", "gpt-5.4")).toBe("claude-opus-4-6")
    expect(resolveModelForProviderDisplay("minimax")).toBe("MiniMax-M2.7")
  })

  it("describes model mismatch repairs", () => {
    emitTestEvent("provider model mismatch message")

    expect(getProviderModelMismatchMessage("openai-codex", "gpt-5.4")).toBeNull()
    expect(getProviderModelMismatchMessage("openai-codex", "")).toBe(
      "OpenAI Codex has no model set. Suggested model: gpt-5.4.",
    )
    expect(getProviderModelMismatchMessage("openai-codex", "claude-sonnet-4.6")).toBe(
      "OpenAI Codex is currently paired with claude-sonnet-4.6, which does not look like a model for OpenAI Codex. Suggested model: gpt-5.4.",
    )
  })
})
