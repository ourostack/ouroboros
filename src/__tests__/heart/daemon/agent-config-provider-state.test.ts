import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockProviderCredentials = vi.hoisted(() => ({
  pools: new Map<string, any>(),
  refreshProviderCredentialPool: vi.fn(async (agentName: string) => {
    return mockProviderCredentials.pools.get(agentName) ?? {
      ok: true,
      poolPath: `vault:${agentName}:providers/*`,
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-04-12T22:00:00.000Z",
        providers: {},
      },
    }
  }),
  readProviderCredentialPool: vi.fn((agentName: string) => {
    return mockProviderCredentials.pools.get(agentName) ?? {
      ok: false,
      reason: "missing",
      poolPath: `vault:${agentName}:providers/*`,
      error: "provider credentials have not been loaded from vault",
    }
  }),
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockProviderCredentials.refreshProviderCredentialPool,
    readProviderCredentialPool: mockProviderCredentials.readProviderCredentialPool,
  }
})

import { emitNervesEvent } from "../../../nerves/runtime"
import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"
import { loadOrCreateMachineIdentity } from "../../../heart/machine-identity"
import { getDefaultModelForProvider } from "../../../heart/provider-models"
import type { AgentProvider } from "../../../heart/identity"
import type {
  ProviderCredentialPool,
  ProviderCredentialPoolReadResult,
} from "../../../heart/provider-credentials"
import {
  getProviderStatePath,
  readProviderState,
  writeProviderState,
  type ProviderState,
} from "../../../heart/provider-state"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-up-provider-state-"))
}

function writeAgentConfig(
  bundlesRoot: string,
  agentName: string,
  config: Record<string, unknown>,
): string {
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
    version: 2,
    enabled: true,
    ...config,
  }, null, 2)}\n`, "utf-8")
  return agentRoot
}

function okCredentialPool(agentName: string, pool: ProviderCredentialPool): ProviderCredentialPoolReadResult {
  return {
    ok: true,
    poolPath: `vault:${agentName}:providers/*`,
    pool,
  }
}

function unavailableCredentialPool(agentName: string, error: string): ProviderCredentialPoolReadResult {
  return {
    ok: false,
    reason: "unavailable",
    poolPath: `vault:${agentName}:providers/*`,
    error,
  }
}

function readProviderCredentialPool(agentName: string): ProviderCredentialPoolReadResult {
  return mockProviderCredentials.pools.get(agentName) ?? unavailableCredentialPool(agentName, "provider credentials have not been loaded from vault")
}

function writeProviderCredentialPool(agentName: string, pool: ProviderCredentialPool): void {
  mockProviderCredentials.pools.set(agentName, okCredentialPool(agentName, pool))
}

function writeUnavailableProviderCredentialPool(agentName: string, error: string): void {
  mockProviderCredentials.pools.set(agentName, unavailableCredentialPool(agentName, error))
}

function seedCredential(input: {
  homeDir: string
  agentName?: string
  provider: "anthropic" | "minimax" | "openai-codex"
  credentials: Record<string, string>
  revision: string
}): void {
  const agentName = input.agentName ?? "slugger"
  const existing = readProviderCredentialPool(agentName)
  const pool: ProviderCredentialPool = existing.ok
    ? {
      ...existing.pool,
      providers: { ...existing.pool.providers },
    }
    : {
      schemaVersion: 1,
      updatedAt: "2026-04-12T22:00:00.000Z",
      providers: {},
    }
  pool.providers[input.provider as AgentProvider] = {
    provider: input.provider,
    revision: input.revision,
    updatedAt: "2026-04-12T22:00:00.000Z",
    credentials: input.credentials,
    config: {},
    provenance: { source: "manual", updatedAt: "2026-04-12T22:00:00.000Z" },
  }
  writeProviderCredentialPool(agentName, pool)
}

function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
  return {
    schemaVersion: 1,
    machineId: "machine_unit6",
    updatedAt: "2026-04-12T22:00:00.000Z",
    lanes: {
      outward: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "local",
        updatedAt: "2026-04-12T22:00:00.000Z",
      },
      inner: {
        provider: "minimax",
        model: "MiniMax-M2.5",
        source: "local",
        updatedAt: "2026-04-12T22:00:00.000Z",
      },
    },
    readiness: {},
    ...overrides,
  }
}

describe("checkAgentConfigWithProviderHealth provider state integration", () => {
  const cleanup: string[] = []

  afterEach(() => {
    mockProviderCredentials.pools.clear()
    mockProviderCredentials.refreshProviderCredentialPool.mockClear()
    mockProviderCredentials.readProviderCredentialPool.mockClear()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("bootstraps missing provider state from agent.json and checks selected lane models from the agent vault", async () => {
    emitTestEvent("agent config bootstraps provider state")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    loadOrCreateMachineIdentity({
      homeDir,
      now: () => new Date("2026-04-12T22:00:00.000Z"),
      hostname: () => "unit-host",
      randomId: () => "machine_unit6",
    })
    seedCredential({
      homeDir,
      provider: "anthropic",
      credentials: { setupToken: "anthropic-token" },
      revision: "cred_anthropic",
    })
    seedCredential({
      homeDir,
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      revision: "cred_minimax",
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result).toEqual({ ok: true })
    const stateResult = readProviderState(agentRoot)
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.machineId).toBe("machine_unit6")
    expect(stateResult.state.lanes.outward).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "bootstrap",
    })
    expect(stateResult.state.lanes.inner).toMatchObject({
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "bootstrap",
    })
    expect(pingProvider).toHaveBeenCalledWith(
      "anthropic",
      { setupToken: "anthropic-token" },
      expect.objectContaining({ model: "claude-opus-4-6" }),
    )
    expect(pingProvider).toHaveBeenCalledWith(
      "minimax",
      { apiKey: "minimax-key" },
      expect.objectContaining({ model: "MiniMax-M2.5" }),
    )
  })

  it("uses provider default models when bootstrapping state from facings without models", async () => {
    emitTestEvent("agent config bootstraps provider state default models")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax" },
      agentFacing: { provider: "minimax" },
    })
    loadOrCreateMachineIdentity({
      homeDir,
      now: () => new Date("2026-04-12T22:00:00.000Z"),
      hostname: () => "unit-host",
      randomId: () => "machine_unit6",
    })
    seedCredential({
      homeDir,
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      revision: "cred_minimax",
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result).toEqual({ ok: true })
    const expectedModel = getDefaultModelForProvider("minimax")
    const stateResult = readProviderState(agentRoot)
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.outward.model).toBe(expectedModel)
    expect(stateResult.state.lanes.inner.model).toBe(expectedModel)
    expect(pingProvider).toHaveBeenCalledTimes(1)
    expect(pingProvider).toHaveBeenCalledWith(
      "minimax",
      { apiKey: "minimax-key" },
      expect.objectContaining({ model: expectedModel }),
    )
  })

  it("returns outward lane repair guidance when human-facing bootstrap provider is missing", async () => {
    emitTestEvent("agent config missing human-facing bootstrap provider")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: {},
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("humanFacing.provider")
    expect(result.fix).toContain("ouro use --agent slugger --lane outward")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("returns inner lane repair guidance when agent-facing bootstrap provider is missing", async () => {
    emitTestEvent("agent config missing agent-facing bootstrap provider")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: {},
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("agentFacing.provider")
    expect(result.fix).toContain("ouro use --agent slugger --lane inner")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("skips provider state and credential checks for disabled agents", async () => {
    emitTestEvent("agent config provider check skips disabled agents")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      enabled: false,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result).toEqual({ ok: true })
    expect(fs.existsSync(getProviderStatePath(agentRoot))).toBe(false)
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports invalid agent.json before bootstrapping provider state", async () => {
    emitTestEvent("agent config provider check invalid agent json")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = path.join(bundlesRoot, "slugger.ouro")
    const agentJsonPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(agentJsonPath, "{bad-json", "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain(`agent.json at ${agentJsonPath} contains invalid JSON`)
    expect(result.fix).toContain(`Open ${agentJsonPath} and fix the JSON syntax.`)
    expect(fs.existsSync(getProviderStatePath(agentRoot))).toBe(false)
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("uses existing state/providers.json instead of falling back to synced agent.json provider fields", async () => {
    emitTestEvent("agent config uses local provider state authority")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    })
    writeProviderState(agentRoot, providerState())
    seedCredential({
      homeDir,
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      revision: "cred_minimax",
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result).toEqual({ ok: true })
    expect(pingProvider).toHaveBeenCalledTimes(1)
    expect(pingProvider).toHaveBeenCalledWith(
      "minimax",
      { apiKey: "minimax-key" },
      expect.objectContaining({ model: "MiniMax-M2.5" }),
    )
    expect(pingProvider).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything())
  })

  it("reports missing vault configuration before treating provider credentials as missing", async () => {
    emitTestEvent("agent config missing vault locator")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    writeUnavailableProviderCredentialPool(
      "slugger",
      "credential vault is not configured in /tmp/slugger.ouro/agent.json. Run 'ouro vault create --agent slugger' to create this agent's vault before loading or storing credentials.",
    )
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 cannot read provider credentials because slugger's credential vault is not configured in agent.json")
    expect(result.fix).toBe("Run 'ouro vault create --agent slugger' to set up this agent's vault.")
    expect(result.issue).toMatchObject({
      kind: "vault-unconfigured",
      severity: "blocked",
      actor: "human-required",
      actions: [
        { kind: "vault-create", command: "ouro vault create --agent slugger" },
        { kind: "vault-recover", command: "ouro vault recover --agent slugger --from <json>" },
      ],
    })
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports missing agent-vault credentials when the selected provider is absent", async () => {
    emitTestEvent("agent config missing vault provider credentials")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      vault: { email: "slugger@ouro.bot", serverUrl: "https://vault.ouroboros.bot" },
    })
    writeProviderState(agentRoot, providerState())
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("slugger's vault at vault:slugger:providers/*")
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 has no credentials")
    expect(result.fix).toBe("Run 'ouro auth --agent slugger --provider minimax' to authenticate.")
    expect(result.issue).toMatchObject({
      kind: "provider-credentials-missing",
      severity: "blocked",
      actor: "human-required",
      actions: [
        { kind: "provider-auth", command: "ouro auth --agent slugger --provider minimax" },
        { kind: "provider-use", command: "ouro use --agent slugger --lane outward --provider <provider> --model <model>" },
      ],
    })
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports unavailable agent-vault credential guidance before pinging", async () => {
    emitTestEvent("agent config unavailable vault provider credentials")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    writeUnavailableProviderCredentialPool("slugger", "vault locked")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 cannot read provider credentials because slugger's credential vault is locked on this machine")
    expect(result.fix).toBe("Run 'ouro vault unlock --agent slugger' or 'ouro vault replace --agent slugger' if the secret is lost.")
    expect(result.fix).not.toContain("ouro auth")
    expect(result.issue).toMatchObject({
      kind: "vault-locked",
      severity: "blocked",
      actor: "human-required",
      actions: [
        { kind: "vault-unlock", command: "ouro vault unlock --agent slugger" },
        { kind: "vault-replace", command: "ouro vault replace --agent slugger" },
        { kind: "vault-recover", command: "ouro vault recover --agent slugger --from <json>" },
      ],
    })
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports the failed lane/provider/model and persists failed readiness when the selected live check fails", async () => {
    emitTestEvent("agent config records failed readiness")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
    })
    writeProviderState(agentRoot, providerState({
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: "2026-04-12T22:00:00.000Z",
        },
        inner: {
          provider: "openai-codex",
          model: "gpt-5.4",
          source: "local",
          updatedAt: "2026-04-12T22:00:00.000Z",
        },
      },
    }))
    seedCredential({
      homeDir,
      provider: "anthropic",
      credentials: { setupToken: "anthropic-token" },
      revision: "cred_anthropic",
    })
    seedCredential({
      homeDir,
      provider: "openai-codex",
      credentials: { oauthAccessToken: "codex-token" },
      revision: "cred_codex",
    })
    const pingProvider = vi.fn(async (provider: string) => {
      if (provider === "openai-codex") {
        return {
          ok: false,
          classification: "auth-failure",
          message: "400 status code (no body)",
          attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
        } as const
      }
      return { ok: true, attempts: [{ attempt: 1 }] } as const
    })

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("inner")
    expect(result.error).toContain("openai-codex")
    expect(result.error).toContain("gpt-5.4")
    expect(result.error).toContain("400 status code (no body)")
    expect(result.fix).toBe(
      "Run 'ouro auth --agent slugger --provider openai-codex' to refresh credentials, or run 'ouro use --agent slugger --lane inner --provider <provider> --model <model>' to choose another provider/model for this lane.",
    )
    expect(result.issue).toMatchObject({
      kind: "provider-live-check-failed",
      severity: "blocked",
      actor: "human-choice",
      actions: [
        { kind: "provider-auth", command: "ouro auth --agent slugger --provider openai-codex" },
        { kind: "provider-use", command: "ouro use --agent slugger --lane inner --provider <provider> --model <model>" },
      ],
    })

    const stateResult = readProviderState(agentRoot)
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "failed",
      provider: "openai-codex",
      model: "gpt-5.4",
      credentialRevision: "cred_codex",
      error: "400 status code (no body)",
      attempts: 3,
    })
  })

  it("fails invalid provider state with direct force-use repair guidance", async () => {
    emitTestEvent("agent config invalid provider state repair")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    fs.mkdirSync(path.dirname(getProviderStatePath(agentRoot)), { recursive: true })
    fs.writeFileSync(getProviderStatePath(agentRoot), "{bad-json", "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, { homeDir, pingProvider })

    expect(result.ok).toBe(false)
    expect(result.error).toContain("provider state for slugger is invalid")
    expect(result.fix).toContain("ouro use --agent slugger --lane outward --provider <provider> --model <model> --force")
    expect(pingProvider).not.toHaveBeenCalled()
  })
})
