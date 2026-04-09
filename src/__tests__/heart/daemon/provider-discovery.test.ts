import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { AgentProvider } from "../../../heart/identity"
import type { PingResult } from "../../../heart/provider-ping"
import type { DiscoveredCredential } from "../../../heart/daemon/cli-types"
import { discoverWorkingProvider } from "../../../heart/daemon/provider-discovery"

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
