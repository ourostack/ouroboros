import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentProvider } from "../../heart/identity"
import type { PingResult } from "../../heart/provider-ping"
import type { ProviderCredentialPoolReadResult } from "../../heart/provider-credentials"

const mockProviderCredentials = vi.hoisted(() => ({
  refreshProviderCredentialPool: vi.fn(),
}))

vi.mock("../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../heart/provider-credentials")>("../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockProviderCredentials.refreshProviderCredentialPool,
  }
})

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

import {
  buildFailoverContext,
  formatCredentialProvenanceLabel,
  handleFailoverReply,
  runMachineProviderFailoverInventory,
} from "../../heart/provider-failover"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function okPool(providers: NonNullable<Extract<ProviderCredentialPoolReadResult, { ok: true }>["pool"]["providers"]>): ProviderCredentialPoolReadResult {
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

describe("provider failover", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("builds a user-facing failover message with ready vault providers and switch replies", () => {
    emitTestEvent("failover context ready providers")

    const context = buildFailoverContext(
      "401 token expired",
      "auth-failure",
      "openai-codex",
      "gpt-5.4",
      "slugger",
      {
        ready: [{
          provider: "minimax",
          model: "MiniMax-M2.7",
          credentialRevision: "vault_mm",
          source: "auth-flow",
          result: { ok: true },
        }],
        unavailable: [],
        unconfigured: ["anthropic"],
      },
      { minimax: "MiniMax-M2.7" },
      { currentLane: "inner" },
    )

    expect(context.userMessage).toContain('reply "switch to minimax"')
    expect(context.userMessage).toContain("credentials in vault via auth-flow")
    expect(context.userMessage).toContain("ouro auth --agent slugger --provider anthropic")
    expect(handleFailoverReply("switch to minimax", context)).toEqual({
      action: "switch",
      provider: "minimax",
      model: "MiniMax-M2.7",
      lane: "inner",
      credentialRevision: "vault_mm",
      source: "auth-flow",
    })
  })

  it("formats credential provenance without cross-agent ownership language", () => {
    emitTestEvent("failover provenance label")
    expect(formatCredentialProvenanceLabel({ source: "manual" })).toBe("credentials in vault via manual")
    expect(formatCredentialProvenanceLabel({})).toBeUndefined()
  })

  it("builds machine failover inventory from the agent vault", async () => {
    emitTestEvent("machine failover inventory vault")
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue(okPool({
      minimax: {
        provider: "minimax",
        revision: "vault_mm",
        updatedAt: "2026-04-13T00:00:00.000Z",
        credentials: { apiKey: "mm-key" },
        config: {},
        provenance: { source: "auth-flow", updatedAt: "2026-04-13T00:00:00.000Z" },
      },
      azure: {
        provider: "azure",
        revision: "vault_az",
        updatedAt: "2026-04-13T00:00:00.000Z",
        credentials: { apiKey: "az-key" },
        config: { endpoint: "https://example.openai.azure.com", deployment: "gpt-4o" },
        provenance: { source: "manual", updatedAt: "2026-04-13T00:00:00.000Z" },
      },
    }))
    const ping = vi.fn<(provider: AgentProvider, config: Record<string, unknown>, options?: unknown) => Promise<PingResult>>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, classification: "server-error", message: "down" })

    const inventory = await runMachineProviderFailoverInventory("slugger", "openai-codex", { ping: ping as never })

    expect(inventory.ready).toMatchObject([{ provider: "azure", credentialRevision: "vault_az", source: "manual" }])
    expect(inventory.unavailable).toMatchObject([{ provider: "minimax", credentialRevision: "vault_mm", source: "auth-flow" }])
    expect(inventory.unconfigured).toContain("anthropic")
    expect(ping).toHaveBeenCalledWith("azure", expect.objectContaining({ apiKey: "az-key", endpoint: "https://example.openai.azure.com" }), expect.anything())
    expect(JSON.stringify(inventory)).not.toContain("mm-key")
  })

  it("treats a locked vault as no configured failover providers", async () => {
    emitTestEvent("machine failover inventory locked vault")
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:slugger:providers/*",
      error: "vault locked",
    })

    const inventory = await runMachineProviderFailoverInventory("slugger", "minimax", {
      ping: vi.fn() as never,
    })

    expect(inventory.ready).toEqual([])
    expect(inventory.unavailable).toEqual([])
    expect(inventory.unconfigured).toEqual(expect.arrayContaining(["anthropic", "openai-codex", "azure", "github-copilot"]))
  })
})
