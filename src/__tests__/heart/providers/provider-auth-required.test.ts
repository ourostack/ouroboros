import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

const mockOpenAICtor = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(opts?: unknown) {
      mockOpenAICtor(opts)
    }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: vi.fn() }
  },
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: () => "slugger",
}))

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

describe("provider auth guards", () => {
  it("requires Anthropic setup-token credentials", async () => {
    emitTestEvent("provider auth guard anthropic")
    const { createAnthropicProviderRuntime } = await import("../../../heart/providers/anthropic")

    expect(() => createAnthropicProviderRuntime("claude-opus-4-6", { setupToken: "   " }))
      .toThrow("no setup-token credential was found")
  })

  it("requires MiniMax API key credentials", async () => {
    emitTestEvent("provider auth guard minimax")
    const { createMinimaxProviderRuntime } = await import("../../../heart/providers/minimax")

    expect(() => createMinimaxProviderRuntime("MiniMax-M2.5", {})).toThrow("minimax.apiKey is missing")
  })

  it("rejects blank OpenAI Codex OAuth access tokens", async () => {
    emitTestEvent("provider auth guard openai codex blank token")
    const { createOpenAICodexProviderRuntime } = await import("../../../heart/providers/openai-codex")

    expect(() => createOpenAICodexProviderRuntime("gpt-5.4", { oauthAccessToken: "   " })).toThrow("OAuth access token is empty")
  })
})
