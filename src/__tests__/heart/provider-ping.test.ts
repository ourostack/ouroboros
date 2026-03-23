import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockStreamTurn = vi.fn()
const mockClassifyError = vi.fn()

// Mock all provider factories to return a controllable runtime
vi.mock("../../heart/providers/anthropic", () => ({
  createAnthropicProviderRuntime: vi.fn(() => ({
    id: "anthropic",
    model: "claude-opus-4-6",
    streamTurn: mockStreamTurn,
    classifyError: mockClassifyError,
  })),
  classifyAnthropicError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/azure", () => ({
  createAzureProviderRuntime: vi.fn(() => ({
    id: "azure",
    model: "gpt-4o-mini",
    streamTurn: mockStreamTurn,
    classifyError: mockClassifyError,
  })),
  classifyAzureError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/minimax", () => ({
  createMinimaxProviderRuntime: vi.fn(() => ({
    id: "minimax",
    model: "minimax-text-01",
    streamTurn: mockStreamTurn,
    classifyError: mockClassifyError,
  })),
  classifyMinimaxError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/openai-codex", () => ({
  createOpenAICodexProviderRuntime: vi.fn(() => ({
    id: "openai-codex",
    model: "gpt-5.4",
    streamTurn: mockStreamTurn,
    classifyError: mockClassifyError,
  })),
  classifyOpenAICodexError: vi.fn(() => "unknown"),
}))

vi.mock("../../heart/providers/github-copilot", () => ({
  createGithubCopilotProviderRuntime: vi.fn(() => ({
    id: "github-copilot",
    model: "gpt-5.4",
    streamTurn: mockStreamTurn,
    classifyError: mockClassifyError,
  })),
  classifyGithubCopilotError: vi.fn(() => "unknown"),
}))

import { pingProvider, type PingResult } from "../../heart/provider-ping"
import type { ProviderErrorClassification } from "../../heart/core"

describe("pingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns ok: true when streamTurn succeeds for anthropic", async () => {
    mockStreamTurn.mockResolvedValue({ content: "hi", outputItems: [] })
    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(true)
  })

  it("returns ok: true when streamTurn succeeds for openai-codex", async () => {
    mockStreamTurn.mockResolvedValue({ content: "hi", outputItems: [] })
    const result = await pingProvider("openai-codex", {
      model: "gpt-5.4",
      oauthAccessToken: "valid-token",
    })
    expect(result.ok).toBe(true)
  })

  it("returns ok: true when streamTurn succeeds for azure", async () => {
    mockStreamTurn.mockResolvedValue({ content: "hi", outputItems: [] })
    const result = await pingProvider("azure", {
      modelName: "gpt-4o-mini",
      apiKey: "valid-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o-mini",
      apiVersion: "2025-04-01-preview",
    })
    expect(result.ok).toBe(true)
  })

  it("returns ok: true when streamTurn succeeds for minimax", async () => {
    mockStreamTurn.mockResolvedValue({ content: "hi", outputItems: [] })
    const result = await pingProvider("minimax", {
      model: "minimax-text-01",
      apiKey: "valid-key",
    })
    expect(result.ok).toBe(true)
  })

  it("returns auth-failure for empty credentials (anthropic)", async () => {
    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (openai-codex)", async () => {
    const result = await pingProvider("openai-codex", {
      model: "gpt-5.4",
      oauthAccessToken: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (minimax)", async () => {
    const result = await pingProvider("minimax", {
      model: "minimax-text-01",
      apiKey: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (azure)", async () => {
    const result = await pingProvider("azure", {
      modelName: "gpt-4o-mini",
      apiKey: "",
      endpoint: "",
      deployment: "",
      apiVersion: "2025-04-01-preview",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns auth-failure for empty credentials (github-copilot)", async () => {
    const result = await pingProvider("github-copilot", {
      model: "",
      githubToken: "",
      baseUrl: "",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
    }
  })

  it("returns ok: true when streamTurn succeeds for github-copilot", async () => {
    mockStreamTurn.mockResolvedValue({ content: "hi", outputItems: [] })
    const result = await pingProvider("github-copilot", {
      model: "gpt-5.4",
      githubToken: "ghp_test123",
      baseUrl: "https://api.copilot.example.com",
    })
    expect(result.ok).toBe(true)
  })

  it("classifies error from streamTurn failure", async () => {
    const err = Object.assign(new Error("auth failed"), { status: 401 })
    mockStreamTurn.mockRejectedValue(err)
    mockClassifyError.mockReturnValue("auth-failure" as ProviderErrorClassification)

    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("auth-failure")
      expect(result.message).toBe("auth failed")
    }
  })

  it("classifies usage-limit error from streamTurn", async () => {
    const err = Object.assign(new Error("exceeded your usage limit"), { status: 429 })
    mockStreamTurn.mockRejectedValue(err)
    mockClassifyError.mockReturnValue("usage-limit" as ProviderErrorClassification)

    const result = await pingProvider("openai-codex", {
      model: "gpt-5.4",
      oauthAccessToken: "valid-token",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("usage-limit")
    }
  })

  it("returns network-error on timeout", async () => {
    mockStreamTurn.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("aborted")), 100)
    }))
    mockClassifyError.mockReturnValue("network-error" as ProviderErrorClassification)

    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("network-error")
    }
  })

  it("falls back to unknown when classifyError throws", async () => {
    mockStreamTurn.mockRejectedValue(new Error("weird error"))
    mockClassifyError.mockImplementation(() => { throw new Error("classify itself broke") })

    const result = await pingProvider("anthropic", {
      model: "claude-opus-4-6",
      setupToken: "sk-ant-oat01-valid-token-that-is-long-enough-to-pass-format-check-1234567890abcdef",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.classification).toBe("unknown")
    }
  })
})
