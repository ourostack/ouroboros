import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockRefreshProviderCredentialPool = vi.fn()
vi.mock("../../heart/provider-credentials", () => ({
  refreshProviderCredentialPool: (...args: unknown[]) => mockRefreshProviderCredentialPool(...args),
}))

import { runHealthInventory } from "../../heart/provider-ping"

function record(provider: string, fields: {
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
}) {
  return {
    provider,
    revision: `cred_${provider}`,
    updatedAt: "2026-04-12T22:30:00.000Z",
    credentials: fields.credentials ?? {},
    config: fields.config ?? {},
    provenance: { source: "manual", updatedAt: "2026-04-12T22:30:00.000Z" },
  }
}

const fullPool = {
  ok: true,
  poolPath: "vault:slugger:providers/*",
  pool: {
    schemaVersion: 1,
    updatedAt: "2026-04-12T22:30:00.000Z",
    providers: {
      anthropic: record("anthropic", { credentials: { setupToken: "sk-ant-oat01-valid" } }),
      "openai-codex": record("openai-codex", { credentials: { oauthAccessToken: "valid-token" } }),
      minimax: record("minimax", { credentials: { apiKey: "mm-key" } }),
      azure: record("azure", { credentials: { apiKey: "az-key" }, config: { endpoint: "e", deployment: "d", apiVersion: "v" } }),
      "github-copilot": record("github-copilot", { credentials: { githubToken: "gh" }, config: { baseUrl: "https://copilot.example" } }),
    },
  },
} as const

describe("runHealthInventory", () => {
  const mockPing = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockRefreshProviderCredentialPool.mockResolvedValue(fullPool)
  })

  it("pings all vault-configured providers except current and returns results", async () => {
    mockPing.mockResolvedValue({ ok: false, classification: "auth-failure", message: "empty" })
    mockPing.mockResolvedValueOnce({ ok: true })

    const result = await runHealthInventory("slugger", "openai-codex", { ping: mockPing })

    expect(mockRefreshProviderCredentialPool).toHaveBeenCalledWith("slugger")
    expect(mockPing).toHaveBeenCalledTimes(4)
    expect(result.anthropic).toEqual({ ok: true })
    expect(result["openai-codex"]).toBeUndefined()
  })

  it("excludes current provider from inventory", async () => {
    mockPing.mockResolvedValue({ ok: true })

    const result = await runHealthInventory("slugger", "anthropic", { ping: mockPing })

    expect(result.anthropic).toBeUndefined()
    expect(result["openai-codex"]).toBeDefined()
  })

  it("returns unconfigured results for providers missing from the agent vault", async () => {
    mockRefreshProviderCredentialPool.mockResolvedValue({
      ok: true,
      poolPath: "vault:slugger:providers/*",
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-04-12T22:30:00.000Z",
        providers: {
          anthropic: record("anthropic", { credentials: { setupToken: "tok" } }),
        },
      },
    })
    mockPing.mockResolvedValue({ ok: true })

    const result = await runHealthInventory("slugger", "openai-codex", { ping: mockPing })

    expect(result.anthropic).toEqual({ ok: true })
    expect(result.minimax).toEqual({ ok: false, classification: "auth-failure", message: "no credentials configured" })
    expect(mockPing).toHaveBeenCalledTimes(1)
  })

  it("pings providers in parallel", async () => {
    const callOrder: string[] = []
    mockPing.mockImplementation(async (provider: string) => {
      callOrder.push(`start:${provider}`)
      await new Promise((r) => setTimeout(r, 10))
      callOrder.push(`end:${provider}`)
      return { ok: true }
    })

    await runHealthInventory("slugger", "openai-codex", { ping: mockPing })

    const anthropicStart = callOrder.indexOf("start:anthropic")
    const minimaxStart = callOrder.indexOf("start:minimax")
    const anthropicEnd = callOrder.indexOf("end:anthropic")
    expect(anthropicStart).toBeLessThan(anthropicEnd)
    expect(minimaxStart).toBeLessThan(anthropicEnd)
  })
})
