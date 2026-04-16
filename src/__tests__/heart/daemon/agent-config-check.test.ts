import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"

const providerPingMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))
const refreshProviderCredentialPoolMock = vi.hoisted(() => vi.fn())

vi.mock("fs")
vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: (provider: string, config: Record<string, unknown>, options?: Record<string, unknown>) =>
    providerPingMock(provider, config, options),
}))
vi.mock("../../../heart/provider-credentials", () => ({
  providerCredentialMachineHomeDir: (homeDir?: string) => homeDir ?? "/home/test",
  refreshProviderCredentialPool: (...args: unknown[]) => refreshProviderCredentialPoolMock(...args),
}))

import { checkAgentConfig, checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"

const mockReadFileSync = vi.mocked(fs.readFileSync)
const mockExistsSync = vi.mocked(fs.existsSync)

const BUNDLES = "/bundles"

function agentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    ...overrides,
  })
}

function providerStateJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    machineId: "machine_test",
    updatedAt: "2026-04-12T22:30:00.000Z",
    lanes: {
      outward: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "bootstrap",
        updatedAt: "2026-04-12T22:30:00.000Z",
      },
      inner: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "bootstrap",
        updatedAt: "2026-04-12T22:30:00.000Z",
      },
    },
    readiness: {},
    ...overrides,
  })
}

function providerRecord(provider: string, fields: {
  credentials?: Record<string, unknown>
  config?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    provider,
    revision: `cred_${provider.replace(/[^a-z]/g, "_")}`,
    updatedAt: "2026-04-12T22:30:00.000Z",
    credentials: fields.credentials ?? {},
    config: fields.config ?? {},
    provenance: {
      source: "manual",
      updatedAt: "2026-04-12T22:30:00.000Z",
    },
  }
}

function credentialPool(providers: Record<string, Record<string, unknown>>) {
  return {
    ok: true,
    poolPath: "vault:myagent:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: "2026-04-12T22:30:00.000Z",
      providers,
    },
  } as const
}

function mockAgentAndProviderState(input: {
  agentConfig?: string
  providerState?: string
} = {}): void {
  mockExistsSync.mockImplementation((filePath: fs.PathLike) => String(filePath).endsWith("/state/providers.json"))
  mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
    const p = String(filePath)
    if (p === path.join(BUNDLES, "myagent.ouro", "agent.json")) {
      return input.agentConfig ?? agentJson()
    }
    if (p === path.join(BUNDLES, "myagent.ouro", "state", "providers.json")) {
      return input.providerState ?? providerStateJson()
    }
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
  })
}

describe("checkAgentConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
    }))
    providerPingMock.mockResolvedValue({ ok: true })
  })

  it("returns ok when both facing configs are present", () => {
    mockReadFileSync.mockReturnValueOnce(agentJson())

    expect(checkAgentConfig("myagent", BUNDLES)).toEqual({ ok: true })
  })

  it("returns error when agent.json is missing", () => {
    mockReadFileSync.mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = checkAgentConfig("myagent", BUNDLES)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("agent.json not found")
    expect(result.fix).toContain("ouro hatch")
  })

  it("returns error when agent.json is invalid JSON", () => {
    mockReadFileSync.mockReturnValueOnce("not json{{{")

    const result = checkAgentConfig("myagent", BUNDLES)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("invalid JSON")
  })

  it("returns ok when agent is disabled", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ enabled: false }))

    expect(checkAgentConfig("myagent", BUNDLES)).toEqual({ ok: true })
  })

  it("requires explicit humanFacing and agentFacing provider blocks", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ provider: "minimax" }))

    const result = checkAgentConfig("myagent", BUNDLES)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing humanFacing.provider")
  })

  it("returns error for unknown facing providers", () => {
    mockReadFileSync.mockReturnValueOnce(agentJson({ humanFacing: { provider: "fake-provider" } }))

    const result = checkAgentConfig("myagent", BUNDLES)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unknown provider 'fake-provider'")
  })

  it("returns error when agentFacing provider is missing", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    }))

    const result = checkAgentConfig("myagent", BUNDLES)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing agentFacing.provider")
  })

  it("reads only agent.json during structural validation", () => {
    mockReadFileSync.mockReturnValueOnce(agentJson())

    checkAgentConfig("myagent", BUNDLES)

    expect(mockReadFileSync).toHaveBeenCalledOnce()
    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(BUNDLES, "myagent.ouro", "agent.json"),
      "utf-8",
    )
  })
})

describe("checkAgentConfigWithProviderHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providerPingMock.mockResolvedValue({ ok: true })
    mockAgentAndProviderState()
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
    }))
  })

  it("live-checks selected providers from local provider state using vault credentials", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    mockAgentAndProviderState({
      agentConfig: agentJson({
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "github-copilot", model: "claude-sonnet-4.6" },
      }),
      providerState: providerStateJson({
        lanes: {
          outward: {
            provider: "anthropic",
            model: "claude-opus-4-6",
            source: "bootstrap",
            updatedAt: "2026-04-12T22:30:00.000Z",
          },
          inner: {
            provider: "github-copilot",
            model: "claude-sonnet-4.6",
            source: "local",
            updatedAt: "2026-04-12T22:30:00.000Z",
          },
        },
      }),
    })
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({
      anthropic: providerRecord("anthropic", { credentials: { setupToken: "tok" } }),
      "github-copilot": providerRecord("github-copilot", {
        credentials: { githubToken: "gh" },
        config: { baseUrl: "https://copilot.example" },
      }),
      minimax: providerRecord("minimax", { credentials: { apiKey: "unselected" } }),
    }))

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result).toEqual({ ok: true })
    expect(pingProvider).toHaveBeenCalledTimes(2)
    expect(pingProvider).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
    expect(pingProvider).toHaveBeenCalledWith("github-copilot", { githubToken: "gh", baseUrl: "https://copilot.example" }, expect.objectContaining({ model: "claude-sonnet-4.6" }))
    expect(pingProvider).not.toHaveBeenCalledWith("minimax", expect.anything())
  })

  it("dedupes live provider checks when both lanes share provider, model, and credential revision", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result).toEqual({ ok: true })
    expect(pingProvider).toHaveBeenCalledOnce()
    expect(pingProvider).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
  })

  it("uses the default live provider ping when no ping dependency is supplied", async () => {
    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES)

    expect(result).toEqual({ ok: true })
    expect(providerPingMock).toHaveBeenCalledOnce()
    expect(providerPingMock).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
  })

  it("fails before pinging when selected credentials are missing from the agent vault", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    refreshProviderCredentialPoolMock.mockResolvedValue(credentialPool({}))

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("has no credentials in myagent's vault")
    expect(result.fix).toContain("ouro auth --agent myagent --provider anthropic")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("treats a missing credential pool as missing selected credentials", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "missing",
      poolPath: "vault:myagent:providers/*",
      error: "provider credentials have not been loaded from vault",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("has no credentials in myagent's vault")
    expect(result.fix).toContain("ouro auth --agent myagent --provider anthropic")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("fails when the agent vault cannot be read", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:myagent:providers/*",
      error: "Ouro credential vault is locked on this machine for myagent.\n\nRun `ouro vault unlock --agent myagent`.",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("cannot read provider credentials")
    expect(result.error).toContain("credential vault is locked on this machine")
    expect(result.error).not.toContain("Run `ouro vault unlock")
    expect(result.fix).toContain("ouro vault unlock --agent myagent")
    expect(result.fix).toContain("ouro vault replace --agent myagent")
    expect(result.fix).toContain("ouro vault recover --agent myagent --from <json>")
    expect(result.fix).toContain("ouro up")
    expect(result.fix).not.toContain("ouro auth")
  })

  it("tells the user to rewrite credentials when the agent vault record is invalid", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "invalid",
      poolPath: "vault:myagent:providers/*",
      error: "provider credential JSON is malformed",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("cannot read provider credentials from myagent's vault")
    expect(result.error).toContain("provider credential JSON is malformed")
    expect(result.fix).toContain("ouro auth --agent myagent --provider anthropic")
    expect(result.fix).toContain("rewrite this provider credential")
    expect(result.fix).toContain("ouro up")
    expect(result.fix).not.toContain("ouro vault unlock")
  })

  it("keeps unlock first for unavailable vault errors that are not explicit lock messages", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:myagent:providers/*",
      error: "temporary vault service outage",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("temporary vault service outage")
    expect(result.fix).toContain("ouro vault unlock --agent myagent")
    expect(result.fix).toContain("ouro up")
    expect(result.fix).toContain("ouro auth --agent myagent --provider anthropic")
  })

  it("classifies timeout errors as transient and suggests retry instead of unlock/replace/recover", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:myagent:providers/*",
      error: "bw CLI error: list items timed out while waiting for a vault response",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("timed out")
    expect(result.fix).toContain("usually resolves on retry")
    expect(result.fix).toContain("ouro up")
    expect(result.fix).not.toContain("ouro vault unlock")
    expect(result.fix).not.toContain("ouro vault replace")
    expect(result.fix).not.toContain("ouro vault recover")
    expect(result.issue).toBeUndefined()
  })

  it("classifies econnrefused errors as transient and suggests retry", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:myagent:providers/*",
      error: "connect ECONNREFUSED 127.0.0.1:8087",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.fix).toContain("usually resolves on retry")
    expect(result.fix).toContain("ouro up")
    expect(result.fix).not.toContain("ouro vault unlock")
    expect(result.issue).toBeUndefined()
  })

  it("classifies socket hang up errors as transient and suggests retry", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:myagent:providers/*",
      error: "socket hang up",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.fix).toContain("usually resolves on retry")
    expect(result.fix).not.toContain("ouro vault unlock")
    expect(result.issue).toBeUndefined()
  })

  it("still classifies vault locked errors correctly after transient check is added", async () => {
    refreshProviderCredentialPoolMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:myagent:providers/*",
      error: "Ouro credential vault is locked on this machine for myagent.",
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider: providerPingMock as any })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("credential vault is locked")
    expect(result.fix).toContain("ouro vault unlock --agent myagent")
    expect(result.issue).toBeDefined()
  })

  it("returns a provider-specific failure when ping fails", async () => {
    const pingProvider = vi.fn(async () => ({
      ok: false,
      classification: "usage-limit",
      message: "quota exceeded",
    }) as const)

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider anthropic")
    expect(result.error).toContain("quota exceeded")
    expect(result.fix).toContain("ouro auth --agent myagent --provider anthropic")
    expect(result.fix).toContain("ouro use --agent myagent --lane outward")
  })

  it("returns structural config errors before live health checks", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    mockReadFileSync.mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("agent.json not found")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("threads onProgress callback to refreshProviderCredentialPool", async () => {
    const onProgress = vi.fn()
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider, onProgress })

    expect(result).toEqual({ ok: true })
    // Verify refreshProviderCredentialPool was called with options containing onProgress
    expect(refreshProviderCredentialPoolMock).toHaveBeenCalledWith(
      "myagent",
      expect.objectContaining({ onProgress }),
    )
  })

  it("does not pass onProgress when not provided in deps (backward compat)", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, { pingProvider })

    expect(result).toEqual({ ok: true })
    // refreshProviderCredentialPool should be called without onProgress in options
    const callArgs = refreshProviderCredentialPoolMock.mock.calls[0]
    expect(callArgs[0]).toBe("myagent")
    // Second arg should either be undefined or not have onProgress
    if (callArgs[1]) {
      expect(callArgs[1].onProgress).toBeUndefined()
    }
  })
})
