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
    const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
    const GPT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]

    it.each(["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"])("has a Copilot row for %s without a thinking format", async (id) => {
      emitTestEvent(`${id} registry entry`)
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      expect(MODEL_CAPABILITIES[id]).toEqual({ reasoningEffort: CLAUDE_EFFORTS, maxOutputTokens: 128000, vision: true })
    })

    it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])("has a direct Anthropic row for %s with the anthropic thinking format", async (id) => {
      emitTestEvent(`${id} registry entry`)
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      expect(MODEL_CAPABILITIES[id]).toEqual({ reasoningEffort: CLAUDE_EFFORTS, thinkingFormat: "anthropic", maxOutputTokens: 128000, vision: true })
    })

    it.each(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-luna", "gpt-5.6-terra"])("has a GPT row for %s with phase support and effort none through max", async (id) => {
      emitTestEvent(`${id} registry entry`)
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      expect(MODEL_CAPABILITIES[id]).toEqual({ reasoningEffort: GPT_EFFORTS, phase: true, maxOutputTokens: 128000, vision: true })
    })

    it("has a gpt-6-astra row without the none effort", async () => {
      emitTestEvent("gpt-6-astra registry entry")
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      expect(MODEL_CAPABILITIES["gpt-6-astra"]).toEqual({ reasoningEffort: CLAUDE_EFFORTS, phase: true, maxOutputTokens: 128000, vision: true })
    })

    it("has a gpt-5.5 row topping out at xhigh", async () => {
      emitTestEvent("gpt-5.5 registry entry")
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      expect(MODEL_CAPABILITIES["gpt-5.5"]).toEqual({ reasoningEffort: ["none", "low", "medium", "high", "xhigh"], phase: true, maxOutputTokens: 128000, vision: true })
    })

    it.each(["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4.6", "claude-sonnet-4.6", "gpt-5.4", "gpt-5.3-codex"])("no longer lists retired model %s", async (id) => {
      emitTestEvent(`${id} purged`)
      const { MODEL_CAPABILITIES } = await import("../../heart/model-capabilities")
      expect(MODEL_CAPABILITIES[id]).toBeUndefined()
    })
  })

  describe("vision capability rows", () => {
    it("MiniMax-Text-01 has vision: true", async () => {
      emitTestEvent("MiniMax-Text-01 vision")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      expect(getModelCapabilities("MiniMax-Text-01").vision).toBe(true)
    })

    it("MiniMax-VL-01 has vision: true", async () => {
      emitTestEvent("MiniMax-VL-01 vision")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      expect(getModelCapabilities("MiniMax-VL-01").vision).toBe(true)
    })

    it("MiniMax-M2.1 does NOT have vision set (falsy)", async () => {
      emitTestEvent("MiniMax-M2.1 vision unset")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      expect(getModelCapabilities("MiniMax-M2.1").vision).toBeFalsy()
    })

    it("MiniMax-M2.5 does NOT have vision set (falsy)", async () => {
      emitTestEvent("MiniMax-M2.5 vision unset")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      expect(getModelCapabilities("MiniMax-M2.5").vision).toBeFalsy()
    })

    it("MiniMax-M2.7 does NOT have vision set (falsy)", async () => {
      emitTestEvent("MiniMax-M2.7 vision unset")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      expect(getModelCapabilities("MiniMax-M2.7").vision).toBeFalsy()
    })

    it("unknown model does NOT have vision set", async () => {
      emitTestEvent("unknown model vision unset")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      expect(getModelCapabilities("unknown-model-xyz").vision).toBeUndefined()
    })

    it("ModelCapabilities type accepts vision and audio flags", async () => {
      emitTestEvent("ModelCapabilities vision/audio type")
      type ModelCapabilities = import("../../heart/model-capabilities").ModelCapabilities
      const withBoth: ModelCapabilities = { vision: true, audio: false }
      const withNeither: ModelCapabilities = {}
      expect(withBoth.vision).toBe(true)
      expect(withBoth.audio).toBe(false)
      expect(withNeither.vision).toBeUndefined()
      expect(withNeither.audio).toBeUndefined()
    })
  })

  describe("getModelCapabilities()", () => {
    it("returns capabilities for a known model", async () => {
      emitTestEvent("getModelCapabilities known model")
      const { getModelCapabilities } = await import("../../heart/model-capabilities")
      const caps = getModelCapabilities("claude-opus-5-5")
      expect(caps.reasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
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
      ping: async () => {},
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
      ping: async () => {},
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
