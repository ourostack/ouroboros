import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentProvider } from "../../../heart/identity"
import type { PingResult } from "../../../heart/provider-ping"
import type { ProviderCredentialPoolReadResult } from "../../../heart/provider-credentials"

const mockProviderCredentials = vi.hoisted(() => ({
  refreshProviderCredentialPool: vi.fn(),
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockProviderCredentials.refreshProviderCredentialPool,
  }
})

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

import { discoverWorkingProvider, scanEnvVarCredentials } from "../../../heart/daemon/provider-discovery"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function okPool(
  providers: ProviderCredentialPoolReadResult extends { ok: true; pool: infer Pool }
    ? Pool["providers"]
    : never,
): ProviderCredentialPoolReadResult {
  return {
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: "2026-04-13T00:00:00.000Z",
      providers,
    },
  }
}

describe("scanEnvVarCredentials", () => {
  it("returns empty array when no env vars match", () => {
    emitTestEvent("scan env empty")
    const result = scanEnvVarCredentials({})
    expect(result).toEqual([])
  })

  it("discovers anthropic credentials from ANTHROPIC_API_KEY", () => {
    emitTestEvent("scan env anthropic")
    const result = scanEnvVarCredentials({ ANTHROPIC_API_KEY: "sk-test" })
    expect(result).toHaveLength(1)
    expect(result[0].provider).toBe("anthropic")
    expect(result[0].credentials).toEqual({ setupToken: "sk-test" })
    expect(result[0].agentName).toBe("env")
  })

  it("discovers azure credentials from multiple env vars", () => {
    emitTestEvent("scan env azure")
    const result = scanEnvVarCredentials({
      AZURE_OPENAI_API_KEY: "az-key",
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
    })
    expect(result.find((c) => c.provider === "azure")).toMatchObject({
      credentials: {
        apiKey: "az-key",
        endpoint: "https://example.openai.azure.com",
        deployment: "gpt-4o",
      },
    })
  })
})

describe("discoverWorkingProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null when the agent vault cannot be read", async () => {
    emitTestEvent("discover vault unavailable")
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:slugger:providers/*",
      error: "vault locked",
    })

    const result = await discoverWorkingProvider({
      agentName: "slugger",
      pingProvider: vi.fn(),
    })

    expect(result).toBeNull()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.provider_discovery_none",
      meta: expect.objectContaining({ agentName: "slugger", reason: "vault locked" }),
    }))
  })

  it("returns null when the vault has no provider credentials", async () => {
    emitTestEvent("discover no vault credentials")
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue(okPool({}))

    const result = await discoverWorkingProvider({
      agentName: "slugger",
      pingProvider: vi.fn(),
    })

    expect(result).toBeNull()
  })

  it("returns the first vault credential whose live ping succeeds", async () => {
    emitTestEvent("discover working vault provider")
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue(okPool({
      anthropic: {
        provider: "anthropic",
        revision: "vault_bad",
        updatedAt: "2026-04-13T00:00:00.000Z",
        credentials: { setupToken: "sk-bad" },
        config: {},
        provenance: { source: "auth-flow", updatedAt: "2026-04-13T00:00:00.000Z" },
      },
      minimax: {
        provider: "minimax",
        revision: "vault_good",
        updatedAt: "2026-04-13T00:00:00.000Z",
        credentials: { apiKey: "mm-good" },
        config: {},
        provenance: { source: "manual", updatedAt: "2026-04-13T00:00:00.000Z" },
      },
    }))
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValueOnce({ ok: false, classification: "auth-failure", message: "bad" })
      .mockResolvedValueOnce({ ok: true })

    const result = await discoverWorkingProvider({
      agentName: "slugger",
      pingProvider,
    })

    expect(result).toEqual({
      provider: "minimax",
      credentials: { apiKey: "mm-good" },
      providerConfig: {},
    })
    expect(pingProvider).toHaveBeenCalledTimes(2)
    expect(pingProvider).toHaveBeenLastCalledWith("minimax", { apiKey: "mm-good" })
  })

  it("returns null when every vault credential fails ping", async () => {
    emitTestEvent("discover all vault credentials fail")
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue(okPool({
      minimax: {
        provider: "minimax",
        revision: "vault_bad",
        updatedAt: "2026-04-13T00:00:00.000Z",
        credentials: { apiKey: "mm-bad" },
        config: {},
        provenance: { source: "manual", updatedAt: "2026-04-13T00:00:00.000Z" },
      },
    }))
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: false, classification: "auth-failure", message: "bad" })

    const result = await discoverWorkingProvider({
      agentName: "slugger",
      pingProvider,
    })

    expect(result).toBeNull()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.provider_discovery_all_failed",
      meta: expect.objectContaining({ agentName: "slugger", candidateCount: 1 }),
    }))
  })
})
