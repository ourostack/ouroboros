import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockLoadAgentSecrets = vi.fn()
vi.mock("../../heart/daemon/auth-flow", () => ({
  loadAgentSecrets: (...args: any[]) => mockLoadAgentSecrets(...args),
}))

import { runHealthInventory } from "../../heart/provider-ping"

const fullSecrets = {
  providers: {
    anthropic: { model: "claude-opus-4-6", setupToken: "sk-ant-oat01-valid" },
    "openai-codex": { model: "gpt-5.4", oauthAccessToken: "valid-token" },
    minimax: { model: "minimax-text-01", apiKey: "" },
    azure: { modelName: "", apiKey: "", endpoint: "", deployment: "", apiVersion: "" },
    "github-copilot": { model: "", githubToken: "", baseUrl: "" },
  },
}

describe("runHealthInventory", () => {
  const mockPing = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("pings all configured providers except current and returns results", async () => {
    mockLoadAgentSecrets.mockReturnValue({ secretsPath: "/mock/secrets.json", secrets: fullSecrets })
    mockPing.mockResolvedValue({ ok: false, classification: "auth-failure", message: "empty" })
    mockPing.mockResolvedValueOnce({ ok: true }) // anthropic (first in PINGABLE_PROVIDERS)

    const result = await runHealthInventory("slugger", "openai-codex", { ping: mockPing })

    // Should ping all providers EXCEPT openai-codex (current): anthropic, azure, minimax, github-copilot
    expect(mockPing).toHaveBeenCalledTimes(4)
    expect(result.anthropic).toEqual({ ok: true })
    expect(result["openai-codex"]).toBeUndefined()
  })

  it("excludes current provider from inventory", async () => {
    mockLoadAgentSecrets.mockReturnValue({ secretsPath: "/mock/secrets.json", secrets: fullSecrets })
    mockPing.mockResolvedValue({ ok: true })

    const result = await runHealthInventory("slugger", "anthropic", { ping: mockPing })

    expect(result["anthropic"]).toBeUndefined()
    expect(result["openai-codex"]).toBeDefined()
  })

  it("returns results for all non-current providers even with empty creds", async () => {
    mockLoadAgentSecrets.mockReturnValue({ secretsPath: "/mock/secrets.json", secrets: fullSecrets })
    mockPing.mockResolvedValue({ ok: false, classification: "auth-failure", message: "empty" })

    const result = await runHealthInventory("slugger", "openai-codex", { ping: mockPing })

    // anthropic, minimax, azure, github-copilot (4 non-current providers)
    expect(Object.keys(result)).toHaveLength(4)
    for (const [, pingResult] of Object.entries(result)) {
      expect((pingResult as any).ok).toBe(false)
    }
  })

  it("pings providers in parallel", async () => {
    const callOrder: string[] = []
    mockLoadAgentSecrets.mockReturnValue({ secretsPath: "/mock/secrets.json", secrets: fullSecrets })
    mockPing.mockImplementation(async (provider: string) => {
      callOrder.push(`start:${provider}`)
      await new Promise((r) => setTimeout(r, 10))
      callOrder.push(`end:${provider}`)
      return { ok: true }
    })

    await runHealthInventory("slugger", "openai-codex", { ping: mockPing })

    // Multiple providers should start before any ends (parallel)
    const anthropicStart = callOrder.indexOf("start:anthropic")
    const minimaxStart = callOrder.indexOf("start:minimax")
    const anthropicEnd = callOrder.indexOf("end:anthropic")
    expect(anthropicStart).toBeLessThan(anthropicEnd)
    expect(minimaxStart).toBeLessThan(anthropicEnd)
  })
})
