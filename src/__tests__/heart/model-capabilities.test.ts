import { describe, it, expect } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

// Emit nerves event to satisfy the every-test-emits audit rule
function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

describe("model-capabilities", () => {
  describe("MODEL_CAPABILITIES registry", () => {
    it("has an entry for claude-opus-4-6", async () => {
      emitTestEvent("claude-opus-4-6 registry entry")
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      const entry = MODEL_CAPABILITIES["claude-opus-4-6"]
      expect(entry).toBeDefined()
      expect(entry.reasoningEffort).toEqual(["low", "medium", "high", "max"])
      expect(entry.thinkingFormat).toBe("anthropic")
      expect(entry.maxOutputTokens).toBe(128000)
    })

    it("has an entry for claude-sonnet-4-6", async () => {
      emitTestEvent("claude-sonnet-4-6 registry entry")
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      const entry = MODEL_CAPABILITIES["claude-sonnet-4-6"]
      expect(entry).toBeDefined()
      expect(entry.reasoningEffort).toEqual(["low", "medium", "high"])
      expect(entry.thinkingFormat).toBe("anthropic")
      expect(entry.maxOutputTokens).toBe(64000)
    })

    it("has an entry for gpt-5.4 with phase support", async () => {
      emitTestEvent("gpt-5.4 registry entry")
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      const entry = MODEL_CAPABILITIES["gpt-5.4"]
      expect(entry).toBeDefined()
      expect(entry.reasoningEffort).toEqual(["low", "medium", "high"])
      expect(entry.phase).toBe(true)
      expect(entry.maxOutputTokens).toBeDefined()
    })
  })

  describe("getModelCapabilities()", () => {
    it("returns capabilities for a known model", async () => {
      emitTestEvent("getModelCapabilities known model")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      const caps = getModelCapabilities("claude-opus-4-6")
      expect(caps.reasoningEffort).toEqual(["low", "medium", "high", "max"])
      expect(caps.thinkingFormat).toBe("anthropic")
      expect(caps.maxOutputTokens).toBe(128000)
    })

    it("returns safe empty defaults for an unknown model", async () => {
      emitTestEvent("getModelCapabilities unknown model")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      const caps = getModelCapabilities("unknown-model-xyz")
      expect(caps.reasoningEffort).toBeUndefined()
      expect(caps.thinkingFormat).toBeUndefined()
      expect(caps.phase).toBeUndefined()
      expect(caps.maxOutputTokens).toBeUndefined()
    })

    it("returns a distinct object for unknown models (not a shared mutable reference)", async () => {
      emitTestEvent("getModelCapabilities unknown model distinct object")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      const a = getModelCapabilities("foo")
      const b = getModelCapabilities("bar")
      expect(a).not.toBe(b)
    })
  })
})

describe("ProviderRuntime interface shape", () => {
  it("ProviderRuntime has capabilities and supportedReasoningEfforts fields", async () => {
    emitTestEvent("ProviderRuntime interface shape")
    // This test verifies the interface contract by constructing a conforming object.
    // If the interface doesn't have these fields, TypeScript compilation will fail.
    const { } = await import("../../heart/core")
    type ProviderRuntime = import("../../heart/core").ProviderRuntime
    const runtime: ProviderRuntime = {
      id: "minimax",
      model: "test",
      client: null,
      capabilities: new Set(),
      streamTurn: async () => ({ content: "", toolCalls: [], outputItems: [], usage: undefined }),
      appendToolOutput: () => {},
      resetTurnState: () => {},
    }
    expect(runtime.capabilities).toBeDefined()
    expect(runtime.capabilities.size).toBe(0)
    // supportedReasoningEfforts is optional
    expect(runtime.supportedReasoningEfforts).toBeUndefined()
  })

  it("ProviderRuntime.capabilities is ReadonlySet<ProviderCapability>", async () => {
    emitTestEvent("ProviderRuntime capabilities type")
    type ProviderRuntime = import("../../heart/core").ProviderRuntime
    type ProviderCapability = import("../../heart/core").ProviderCapability
    const caps: ReadonlySet<ProviderCapability> = new Set(["reasoning-effort", "phase-annotation"])
    const runtime: ProviderRuntime = {
      id: "azure",
      model: "test",
      client: null,
      capabilities: caps,
      supportedReasoningEfforts: ["low", "medium", "high"],
      streamTurn: async () => ({ content: "", toolCalls: [], outputItems: [], usage: undefined }),
      appendToolOutput: () => {},
      resetTurnState: () => {},
    }
    expect(runtime.capabilities.has("reasoning-effort")).toBe(true)
    expect(runtime.capabilities.has("phase-annotation")).toBe(true)
    expect(runtime.supportedReasoningEfforts).toEqual(["low", "medium", "high"])
  })
})

describe("ProviderTurnRequest interface shape", () => {
  it("ProviderTurnRequest has reasoningEffort field", async () => {
    emitTestEvent("ProviderTurnRequest reasoningEffort field")
    type ProviderTurnRequest = import("../../heart/core").ProviderTurnRequest
    const request: ProviderTurnRequest = {
      messages: [],
      activeTools: [],
      callbacks: {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      },
      reasoningEffort: "high",
    }
    expect(request.reasoningEffort).toBe("high")
  })

  it("ProviderTurnRequest.reasoningEffort is optional", async () => {
    emitTestEvent("ProviderTurnRequest reasoningEffort optional")
    type ProviderTurnRequest = import("../../heart/core").ProviderTurnRequest
    const request: ProviderTurnRequest = {
      messages: [],
      activeTools: [],
      callbacks: {
        onModelStart: () => {},
        onModelStreamStart: () => {},
        onTextChunk: () => {},
        onReasoningChunk: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: () => {},
      },
    }
    expect(request.reasoningEffort).toBeUndefined()
  })
})
