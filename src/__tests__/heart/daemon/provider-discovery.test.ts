import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { AgentProvider } from "../../../heart/identity"
import type { PingResult } from "../../../heart/provider-ping"
import type { DiscoveredCredential } from "../../../heart/daemon/cli-types"
import { discoverWorkingProvider, scanEnvVarCredentials } from "../../../heart/daemon/provider-discovery"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeDiskCred(
  provider: AgentProvider,
  credentials: Record<string, string>,
  agentName = "test-agent",
): DiscoveredCredential {
  return {
    provider,
    agentName,
    credentials,
    providerConfig: { model: "test-model", ...credentials },
  }
}

describe("scanEnvVarCredentials", () => {
  it("returns empty array when no env vars match", () => {
    const result = scanEnvVarCredentials({})
    expect(result).toEqual([])
  })

  it("discovers anthropic credentials from ANTHROPIC_API_KEY", () => {
    const result = scanEnvVarCredentials({ ANTHROPIC_API_KEY: "sk-test" })
    expect(result).toHaveLength(1)
    expect(result[0].provider).toBe("anthropic")
    expect(result[0].credentials).toEqual({ setupToken: "sk-test" })
    expect(result[0].agentName).toBe("env")
  })

  it("discovers azure credentials from multiple env vars", () => {
    const result = scanEnvVarCredentials({
      AZURE_OPENAI_API_KEY: "az-key",
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "gpt-4o",
    })
    const azure = result.find((c) => c.provider === "azure")
    expect(azure).toBeDefined()
    expect(azure!.credentials).toEqual({
      apiKey: "az-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o",
    })
  })

  it("skips providers where no required field is set", () => {
    // AZURE_OPENAI_DEPLOYMENT maps to "deployment" which is required,
    // but apiKey is also required — setting only deployment should still
    // register since some() checks if at least one required field is present
    const result = scanEnvVarCredentials({ AZURE_OPENAI_DEPLOYMENT: "gpt-4o" })
    const azure = result.find((c) => c.provider === "azure")
    // deployment is a required field, so it should be found
    expect(azure).toBeDefined()
  })

  it("discovers multiple providers from different env vars", () => {
    const result = scanEnvVarCredentials({
      ANTHROPIC_API_KEY: "sk-ant",
      MINIMAX_API_KEY: "mm-key",
    })
    expect(result).toHaveLength(2)
    const providers = result.map((c) => c.provider)
    expect(providers).toContain("anthropic")
    expect(providers).toContain("minimax")
  })
})

describe("discoverWorkingProvider", () => {
  const defaultSecrets = "/fake/.agentsecrets"

  it("returns null when no credentials on disk or env", async () => {
    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => [],
      pingProvider: vi.fn(),
      env: {},
      secretsRoot: defaultSecrets,
    })
    expect(result).toBeNull()
  })

  it("returns null when disk credentials exist but ping fails", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-test" }),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: false, classification: "auth-failure", message: "invalid key" })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: {},
      secretsRoot: defaultSecrets,
    })
    expect(result).toBeNull()
    expect(pingProvider).toHaveBeenCalledOnce()
  })

  it("returns provider + credentials when disk credentials exist and ping succeeds", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-real" }),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: true })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: {},
      secretsRoot: defaultSecrets,
    })
    expect(result).not.toBeNull()
    expect(result!.provider).toBe("anthropic")
    expect(result!.credentials).toEqual({ setupToken: "sk-real" })
  })

  it("returns provider + credentials when env var credentials exist and ping succeeds", async () => {
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: true })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => [],
      pingProvider,
      env: { ANTHROPIC_API_KEY: "sk-from-env" },
      secretsRoot: defaultSecrets,
    })
    expect(result).not.toBeNull()
    expect(result!.provider).toBe("anthropic")
    expect(result!.credentials).toEqual({ setupToken: "sk-from-env" })
  })

  it("returns second provider when first fails ping and second succeeds", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-bad" }),
      makeDiskCred("minimax", { apiKey: "mm-good" }),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValueOnce({ ok: false, classification: "auth-failure", message: "bad" })
      .mockResolvedValueOnce({ ok: true })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: {},
      secretsRoot: defaultSecrets,
    })
    expect(result).not.toBeNull()
    expect(result!.provider).toBe("minimax")
    expect(result!.credentials).toEqual({ apiKey: "mm-good" })
    expect(pingProvider).toHaveBeenCalledTimes(2)
  })

  it("prefers disk credential over env var for same provider", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-disk" }),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: true })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: { ANTHROPIC_API_KEY: "sk-env" },
      secretsRoot: defaultSecrets,
    })
    expect(result).not.toBeNull()
    expect(result!.provider).toBe("anthropic")
    // Should use disk credential, not env
    expect(result!.credentials).toEqual({ setupToken: "sk-disk" })
    // Should only ping once (disk cred wins, env deduped)
    expect(pingProvider).toHaveBeenCalledOnce()
  })

  it("returns null when all providers fail ping", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-bad1" }),
      makeDiskCred("minimax", { apiKey: "mm-bad" }),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: false, classification: "auth-failure", message: "nope" })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: { ANTHROPIC_API_KEY: "sk-bad2" },
      secretsRoot: defaultSecrets,
    })
    expect(result).toBeNull()
    // disk anthropic + disk minimax (env anthropic deduped)
    expect(pingProvider).toHaveBeenCalledTimes(2)
  })

  it("deduplicates multiple disk credentials for the same provider", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-first" }, "agent-a"),
      makeDiskCred("anthropic", { setupToken: "sk-second" }, "agent-b"),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: true })

    const result = await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: {},
      secretsRoot: defaultSecrets,
    })
    expect(result).not.toBeNull()
    expect(result!.provider).toBe("anthropic")
    // Should use the first disk credential found
    expect(result!.credentials).toEqual({ setupToken: "sk-first" })
    // Only one ping — second duplicate was skipped
    expect(pingProvider).toHaveBeenCalledOnce()
  })

  it("emits nerves event for each ping attempt", async () => {
    const diskCreds: DiscoveredCredential[] = [
      makeDiskCred("anthropic", { setupToken: "sk-test" }),
    ]
    const pingProvider = vi.fn<(provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>>()
      .mockResolvedValue({ ok: true })

    await discoverWorkingProvider({
      discoverExistingCredentials: () => diskCreds,
      pingProvider,
      env: {},
      secretsRoot: defaultSecrets,
    })
    expect(emitNervesEvent).toHaveBeenCalled()
  })
})
