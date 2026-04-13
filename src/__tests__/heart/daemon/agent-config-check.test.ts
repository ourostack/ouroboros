import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"

import { checkAgentConfig, checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"

const providerPingMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const))

vi.mock("fs")
vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: (provider: string, config: Record<string, unknown>, options?: Record<string, unknown>) =>
    providerPingMock(provider, config, options),
}))
vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
  return {
    ...actual,
    PROVIDER_CREDENTIALS: actual.PROVIDER_CREDENTIALS,
  }
})

const mockReadFileSync = vi.mocked(fs.readFileSync)

const BUNDLES = "/bundles"
const SECRETS = "/secrets"

function agentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    ...overrides,
  })
}

function secretsJson(provider: string, fields: Record<string, string>): string {
  return JSON.stringify({ providers: { [provider]: fields } })
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

function credentialPoolJson(providers: Record<string, Record<string, unknown>>): string {
  const records: Record<string, unknown> = {}
  for (const [provider, fields] of Object.entries(providers)) {
    records[provider] = {
      provider,
      revision: `cred_${provider.replace(/[^a-z]/g, "_")}`,
      updatedAt: "2026-04-12T22:30:00.000Z",
      credentials: fields.credentials ?? fields,
      config: fields.config ?? {},
      provenance: {
        source: "manual",
        contributedByAgent: "myagent",
        updatedAt: "2026-04-12T22:30:00.000Z",
      },
    }
  }
  return JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-04-12T22:30:00.000Z",
    providers: records,
  })
}

function mockProviderStateFiles(input: {
  agentConfig?: string
  providerState?: string
  credentialPool?: string
} = {}): void {
  mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
    const p = String(filePath)
    if (p === path.join(BUNDLES, "myagent.ouro", "agent.json")) {
      return input.agentConfig ?? agentJson()
    }
    if (p === path.join(BUNDLES, "myagent.ouro", "state", "providers.json")) {
      return input.providerState ?? providerStateJson()
    }
    if (p === path.join(SECRETS, ".agentsecrets", "providers.json")) {
      return input.credentialPool ?? credentialPoolJson({
        anthropic: { setupToken: "tok" },
      })
    }
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
  })
}

describe("checkAgentConfig", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset()
    providerPingMock.mockReset()
    providerPingMock.mockResolvedValue({ ok: true })
  })

  it("returns ok when agent.json and secrets are valid", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson()) // agent.json
      .mockReturnValueOnce(secretsJson("anthropic", { setupToken: "tok" })) // secrets.json

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("returns error when agent.json is missing", () => {
    mockReadFileSync.mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("agent.json not found")
    expect(result.fix).toContain("ouro hatch")
  })

  it("returns error when agent.json is invalid JSON", () => {
    mockReadFileSync.mockReturnValueOnce("not json{{{")

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("invalid JSON")
  })

  it("returns ok when agent is disabled", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ enabled: false }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("returns error when no provider configured", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({}))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing humanFacing.provider")
  })

  it("returns error for unknown provider", () => {
    mockReadFileSync.mockReturnValueOnce(agentJson({ humanFacing: { provider: "fake-provider" } }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unknown provider")
  })

  it("returns error when a facing provider is not a non-empty string", () => {
    mockReadFileSync.mockReturnValueOnce(agentJson({ humanFacing: { provider: "" } }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing humanFacing.provider")
    expect(result.fix).toContain("Set humanFacing.provider")
  })

  it("returns error when legacy provider is unknown", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({ provider: "fake-provider" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Unknown provider 'fake-provider'")
  })

  it("returns error when agentFacing provider is missing", () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing agentFacing.provider")
  })

  it("returns error when secrets.json is missing", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("secrets.json not found")
    expect(result.fix).toContain("ouro auth")
  })

  it("returns error when secrets.json is missing the providers object", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(JSON.stringify({}))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing providers object")
    expect(result.fix).toContain("ouro auth --agent myagent --provider anthropic")
  })

  it("returns error when provider section is missing from secrets", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(JSON.stringify({ providers: {} }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing providers.anthropic")
  })

  it("returns error when required fields are missing", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(secretsJson("anthropic", {}))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("missing required anthropic credentials selected by humanFacing and agentFacing: setupToken")
  })

  it("returns error when required fields are empty strings", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(secretsJson("anthropic", { setupToken: "" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("setupToken")
  })

  it("falls back to config.provider when humanFacing.provider is absent", () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({ provider: "minimax" }))
      .mockReturnValueOnce(secretsJson("minimax", { apiKey: "key123" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("validates both selected facing providers structurally", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      }))
      .mockReturnValueOnce(JSON.stringify({
        providers: {
          anthropic: { setupToken: "tok" },
          minimax: {},
        },
      }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("minimax")
    expect(result.error).toContain("agentFacing")
    expect(result.fix).toContain("ouro auth --agent myagent --provider minimax")
  })

  it("accepts azure managed identity (no apiKey needed)", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({
        humanFacing: { provider: "azure", model: "gpt-4" },
        agentFacing: { provider: "azure", model: "gpt-4" },
      }))
      .mockReturnValueOnce(secretsJson("azure", {
        endpoint: "https://my.openai.azure.com",
        deployment: "gpt-4",
        managedIdentityClientId: "abc-123",
      }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result).toEqual({ ok: true })
  })

  it("requires apiKey for azure without managed identity", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({ humanFacing: { provider: "azure" } }))
      .mockReturnValueOnce(secretsJson("azure", {
        endpoint: "https://my.openai.azure.com",
        deployment: "gpt-4",
      }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("apiKey")
  })

  it("validates github-copilot requires both githubToken and baseUrl", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson({ humanFacing: { provider: "github-copilot" } }))
      .mockReturnValueOnce(secretsJson("github-copilot", { githubToken: "tok" }))

    const result = checkAgentConfig("myagent", BUNDLES, SECRETS)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("baseUrl")
  })

  it("reads from correct file paths", () => {
    mockReadFileSync
      .mockReturnValueOnce(agentJson())
      .mockReturnValueOnce(secretsJson("anthropic", { setupToken: "tok" }))

    checkAgentConfig("slugger", BUNDLES, SECRETS)

    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(BUNDLES, "slugger.ouro", "agent.json"),
      "utf-8",
    )
    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(SECRETS, "slugger", "secrets.json"),
      "utf-8",
    )
  })

  it("live-checks only selected humanFacing and agentFacing providers", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    mockProviderStateFiles({
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
      credentialPool: credentialPoolJson({
        anthropic: { setupToken: "tok" },
        "github-copilot": { credentials: { githubToken: "gh" }, config: { baseUrl: "https://copilot.example" } },
        minimax: { apiKey: "unselected" },
      }),
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS, { pingProvider })

    expect(result).toEqual({ ok: true })
    expect(pingProvider).toHaveBeenCalledTimes(2)
    expect(pingProvider).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
    expect(pingProvider).toHaveBeenCalledWith("github-copilot", { githubToken: "gh", baseUrl: "https://copilot.example" }, expect.objectContaining({ model: "claude-sonnet-4.6" }))
    expect(pingProvider).not.toHaveBeenCalledWith("minimax", expect.anything())
  })

  it("dedupes live provider checks when both facings select the same provider", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    mockProviderStateFiles()

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS, { pingProvider })

    expect(result).toEqual({ ok: true })
    expect(pingProvider).toHaveBeenCalledOnce()
    expect(pingProvider).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
  })

  it("uses the default live provider ping when no ping dependency is supplied", async () => {
    mockProviderStateFiles()

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS)

    expect(result).toEqual({ ok: true })
    expect(providerPingMock).toHaveBeenCalledOnce()
    expect(providerPingMock).toHaveBeenCalledWith("anthropic", { setupToken: "tok" }, expect.objectContaining({ model: "claude-opus-4-6" }))
  })

  it("fails live check when a selected agentFacing provider ping fails", async () => {
    const pingProvider = vi.fn(async (provider: string) => {
      if (provider === "github-copilot") {
        return { ok: false, classification: "auth-failure", message: "token expired" } as const
      }
      return { ok: true } as const
    })
    mockProviderStateFiles({
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
      credentialPool: credentialPoolJson({
        anthropic: { setupToken: "tok" },
        "github-copilot": { credentials: { githubToken: "gh" }, config: { baseUrl: "https://copilot.example" } },
      }),
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("github-copilot")
    expect(result.error).toContain("inner")
    expect(result.error).toContain("claude-sonnet-4.6")
    expect(result.error).toContain("token expired")
    expect(result.fix).toContain("ouro auth --agent myagent --provider github-copilot")
    expect(result.fix).toContain("ouro use --agent myagent --lane inner")
  })

  it("uses auth verify guidance for non-auth live check failures", async () => {
    const pingProvider = vi.fn(async () => ({
      ok: false,
      classification: "usage-limit",
      message: "quota exceeded",
    }) as const)
    mockProviderStateFiles()

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("quota exceeded")
    expect(result.fix).toContain("ouro use --agent myagent --lane outward")
  })

  it("returns structural config errors before live health checks", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    mockReadFileSync.mockImplementationOnce(() => { throw new Error("ENOENT") })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("agent.json not found")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("returns credential structural errors before live health checks", async () => {
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)
    mockProviderStateFiles({
      credentialPool: credentialPoolJson({}),
    })

    const result = await checkAgentConfigWithProviderHealth("myagent", BUNDLES, SECRETS, { pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("has no credentials in the machine provider pool")
    expect(pingProvider).not.toHaveBeenCalled()
  })
})
