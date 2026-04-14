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

  it("includes config repair, configured failures, and dismiss handling", () => {
    emitTestEvent("failover message repair branches")

    const context = buildFailoverContext(
      "openai-codex rejected configured model claude-sonnet-4.6 with a long provider diagnostic",
      "auth-failure",
      "openai-codex",
      "claude-sonnet-4.6",
      "slugger",
      {
        ready: [],
        unavailable: [
          { provider: "anthropic", result: { ok: false, classification: "auth-failure", message: "expired" } },
          { provider: "azure", result: { ok: false, classification: "network-error", message: "offline" } },
          { provider: "minimax", result: { ok: false, classification: "server-error", message: "500" } },
          { provider: "github-copilot", result: { ok: false, classification: "rate-limit", message: "429" } },
          { provider: "openai-codex", result: { ok: false, classification: "usage-limit", message: "quota" } },
          { provider: "openai-codex", model: "gpt-5.4", result: { ok: false, classification: "unknown", message: "weird" } },
        ],
        unconfigured: [],
      },
      {},
      { currentLane: "inner" },
    )

    expect(context.userMessage).toContain("openai-codex [configured model: claude-sonnet-4.6] authentication failed")
    expect(context.userMessage).toContain("Repair the configured model")
    expect(context.userMessage).toContain("ouro use --agent slugger --lane inner --provider openai-codex")
    expect(context.userMessage).toContain("anthropic: credentials need to be refreshed")
    expect(context.userMessage).toContain("azure: could not be reached. Check network/provider availability")
    expect(context.userMessage).toContain("minimax: provider outage or server error")
    expect(context.userMessage).toContain("github-copilot: rate limited")
    expect(context.userMessage).toContain("openai-codex: usage limit hit")
    expect(context.userMessage).toContain("openai-codex: could not be reached")
    expect(handleFailoverReply("keep trying", context)).toEqual({ action: "dismiss" })
  })

  it("formats blank current models and truncates long provider details", () => {
    emitTestEvent("failover blank model and long detail")

    const longDetail = `minimax encountered an error ${"x".repeat(360)}`
    const context = buildFailoverContext(
      longDetail,
      "unknown",
      "minimax",
      "",
      "slugger",
      {
        ready: [{ provider: "anthropic", model: "", result: { ok: true } }],
        unavailable: [{ provider: "azure", model: undefined, result: { ok: false, classification: "unknown", message: "odd" } }],
        unconfigured: [],
      },
      {},
    )

    expect(context.userMessage).toContain("minimax encountered an error.")
    expect(context.userMessage).toContain("provider detail: minimax encountered an error")
    expect(context.userMessage).toContain("...")
    expect(context.readyProviders[0].model).toBe("claude-opus-4-6")
    expect(context.userMessage).toContain("azure: could not be reached")
  })

  it("normalizes legacy health inventories for failover copy", () => {
    emitTestEvent("failover legacy inventory")

    const context = buildFailoverContext(
      "server down",
      "server-error",
      "minimax",
      "MiniMax-M2.5",
      "slugger",
      {
        anthropic: { ok: true },
        azure: { ok: false, classification: "auth-failure", message: "no credentials configured" },
        "openai-codex": { ok: false, classification: "network-error", message: "connection reset" },
      } as never,
      { anthropic: "claude-opus-4-6", "openai-codex": "gpt-5.4" },
    )

    expect(context.readyProviders).toMatchObject([{ provider: "anthropic", model: "claude-opus-4-6" }])
    expect(context.unconfiguredProviders).toEqual(["azure"])
    expect(context.userMessage).toContain('anthropic (claude-opus-4-6): reply "switch to anthropic"')
    expect(context.userMessage).toContain("openai-codex: could not be reached")
    expect(context.userMessage).toContain("azure: run `ouro auth --agent slugger --provider azure`")
  })

  it("explains when no failover candidates exist", () => {
    emitTestEvent("failover no candidates")

    const context = buildFailoverContext(
      "unknown",
      "unknown",
      "minimax",
      "MiniMax-M2.5",
      "slugger",
      {
        ready: [],
        unavailable: [],
        unconfigured: [],
      },
      {},
    )

    expect(context.userMessage).toContain("No other providers are available. Run `ouro auth --agent slugger`")
  })

  it("omits provider detail when the provider error already matches the summary", () => {
    emitTestEvent("failover no duplicate detail")

    const context = buildFailoverContext(
      "minimax (MiniMax-M2.5) encountered an error",
      "unknown",
      "minimax",
      "MiniMax-M2.5",
      "slugger",
      { ready: [], unavailable: [], unconfigured: [] },
      {},
    )

    expect(context.userMessage).toContain("minimax (MiniMax-M2.5) encountered an error.")
    expect(context.userMessage).not.toContain("provider detail:")
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

  it("uses the default ping implementation when no ping dependency is supplied", async () => {
    emitTestEvent("machine failover inventory default ping")
    vi.resetModules()
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    vi.doMock("../../heart/provider-ping", () => ({ pingProvider }))
    mockProviderCredentials.refreshProviderCredentialPool.mockResolvedValue(okPool({
      anthropic: {
        provider: "anthropic",
        revision: "vault_anthropic",
        updatedAt: "2026-04-13T00:00:00.000Z",
        credentials: { setupToken: "tok" },
        config: {},
        provenance: { source: "manual", updatedAt: "2026-04-13T00:00:00.000Z" },
      },
    }))

    try {
      const { runMachineProviderFailoverInventory: runInventory } = await import("../../heart/provider-failover")
      const inventory = await runInventory("slugger", "minimax")
      expect(pingProvider).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
      expect(inventory.ready).toMatchObject([{ provider: "anthropic" }])
    } finally {
      vi.doUnmock("../../heart/provider-ping")
      vi.resetModules()
    }
  })
})
