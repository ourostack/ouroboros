import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { emitNervesEvent } from "../../../nerves/runtime"
import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"
import { loadOrCreateMachineIdentity } from "../../../heart/machine-identity"
import { getDefaultModelForProvider } from "../../../heart/provider-models"
import { readProviderCredentialPool, upsertProviderCredential } from "../../../heart/provider-credential-pool"
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

function seedCredential(input: {
  homeDir: string
  provider: "anthropic" | "minimax" | "openai-codex"
  credentials: Record<string, string>
  revision: string
}): void {
  upsertProviderCredential({
    homeDir: input.homeDir,
    provider: input.provider,
    credentials: input.credentials,
    config: {},
    provenance: { source: "manual", contributedByAgent: "test-agent" },
    now: new Date("2026-04-12T22:00:00.000Z"),
    makeRevision: () => input.revision,
  })
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
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("bootstraps missing provider state from agent.json and checks selected lane models from the machine pool", async () => {
    emitTestEvent("agent config bootstraps provider state")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
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

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

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
    expect(fs.existsSync(path.join(secretsRoot, "slugger", "secrets.json"))).toBe(false)
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
    const secretsRoot = path.join(homeDir, ".agentsecrets")
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

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

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
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: {},
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

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
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: {},
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

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
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      enabled: false,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result).toEqual({ ok: true })
    expect(fs.existsSync(getProviderStatePath(agentRoot))).toBe(false)
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports invalid agent.json before bootstrapping provider state", async () => {
    emitTestEvent("agent config provider check invalid agent json")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = path.join(bundlesRoot, "slugger.ouro")
    const agentJsonPath = path.join(agentRoot, "agent.json")
    fs.mkdirSync(agentRoot, { recursive: true })
    fs.writeFileSync(agentJsonPath, "{bad-json", "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

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
    const secretsRoot = path.join(homeDir, ".agentsecrets")
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

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result).toEqual({ ok: true })
    expect(pingProvider).toHaveBeenCalledTimes(1)
    expect(pingProvider).toHaveBeenCalledWith(
      "minimax",
      { apiKey: "minimax-key" },
      expect.objectContaining({ model: "MiniMax-M2.5" }),
    )
    expect(pingProvider).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything())
  })

  it("migrates legacy per-agent provider credentials into the machine pool before checking", async () => {
    emitTestEvent("agent config migrates legacy provider credentials")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    const legacySecretsPath = path.join(secretsRoot, "slugger", "secrets.json")
    fs.mkdirSync(path.dirname(legacySecretsPath), { recursive: true })
    fs.writeFileSync(legacySecretsPath, `${JSON.stringify({
      providers: {
        minimax: { apiKey: "legacy-minimax-key" },
      },
    }, null, 2)}\n`, "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result).toEqual({ ok: true })
    const poolResult = readProviderCredentialPool(homeDir)
    expect(poolResult.ok).toBe(true)
    if (!poolResult.ok) throw new Error(poolResult.error)
    expect(poolResult.pool.providers.minimax).toMatchObject({
      provider: "minimax",
      credentials: { apiKey: "legacy-minimax-key" },
      provenance: {
        source: "legacy-agent-secrets",
        contributedByAgent: "slugger",
      },
    })
    expect(pingProvider).toHaveBeenCalledWith(
      "minimax",
      { apiKey: "legacy-minimax-key" },
      expect.objectContaining({ model: "MiniMax-M2.5" }),
    )
  })

  it("ignores unusable legacy credential entries and reports missing machine credentials", async () => {
    emitTestEvent("agent config ignores unusable legacy credentials")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    const legacySecretsPath = path.join(secretsRoot, "slugger", "secrets.json")
    fs.mkdirSync(path.dirname(legacySecretsPath), { recursive: true })
    fs.writeFileSync(legacySecretsPath, `${JSON.stringify({
      providers: {
        minimax: { apiKey: "" },
        "not-a-provider": { apiKey: "ignored" },
        anthropic: null,
      },
    }, null, 2)}\n`, "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 has no credentials")
    expect(result.fix).toContain("ouro auth --agent slugger --provider minimax")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("ignores legacy secrets files that are not JSON objects", async () => {
    emitTestEvent("agent config ignores legacy secrets non-object")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    const legacySecretsPath = path.join(secretsRoot, "slugger", "secrets.json")
    fs.mkdirSync(path.dirname(legacySecretsPath), { recursive: true })
    fs.writeFileSync(legacySecretsPath, "[]\n", "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 has no credentials")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("ignores legacy secrets files without a providers object", async () => {
    emitTestEvent("agent config ignores legacy secrets without providers object")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    const legacySecretsPath = path.join(secretsRoot, "slugger", "secrets.json")
    fs.mkdirSync(path.dirname(legacySecretsPath), { recursive: true })
    fs.writeFileSync(legacySecretsPath, `${JSON.stringify({ providers: [] }, null, 2)}\n`, "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 has no credentials")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports missing machine credentials when no pool or legacy credentials are present", async () => {
    emitTestEvent("agent config missing machine provider credentials")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain(path.join(homeDir, ".agentsecrets", "providers.json"))
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 has no credentials")
    expect(result.fix).toContain("ouro use --agent slugger --lane outward")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports invalid machine credential pool guidance before pinging", async () => {
    emitTestEvent("agent config invalid machine provider credentials")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    writeProviderState(agentRoot, providerState())
    fs.mkdirSync(secretsRoot, { recursive: true })
    fs.writeFileSync(path.join(secretsRoot, "providers.json"), "{bad-json", "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("outward provider minimax model MiniMax-M2.5 cannot read machine provider credentials")
    expect(result.fix).toContain("Fix")
    expect(result.fix).toContain("ouro use --agent slugger --lane outward")
    expect(result.fix).toContain("--force")
    expect(pingProvider).not.toHaveBeenCalled()
  })

  it("reports the failed lane/provider/model and persists failed readiness when the selected live check fails", async () => {
    emitTestEvent("agent config records failed readiness")
    const homeDir = makeTempHome()
    cleanup.push(homeDir)
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const secretsRoot = path.join(homeDir, ".agentsecrets")
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
          classification: "provider-error",
          message: "400 status code (no body)",
          attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }],
        } as const
      }
      return { ok: true, attempts: [{ attempt: 1 }] } as const
    })

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("inner")
    expect(result.error).toContain("openai-codex")
    expect(result.error).toContain("gpt-5.4")
    expect(result.error).toContain("400 status code (no body)")
    expect(result.fix).toContain("ouro auth --agent slugger --provider openai-codex")
    expect(result.fix).toContain("ouro use --agent slugger --lane inner")

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
    const secretsRoot = path.join(homeDir, ".agentsecrets")
    const agentRoot = writeAgentConfig(bundlesRoot, "slugger", {
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    })
    fs.mkdirSync(path.dirname(getProviderStatePath(agentRoot)), { recursive: true })
    fs.writeFileSync(getProviderStatePath(agentRoot), "{bad-json", "utf-8")
    const pingProvider = vi.fn(async () => ({ ok: true }) as const)

    const result = await checkAgentConfigWithProviderHealth("slugger", bundlesRoot, secretsRoot, { pingProvider } as any)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("provider state for slugger is invalid")
    expect(result.fix).toContain("ouro use --agent slugger --lane outward --provider <provider> --model <model> --force")
    expect(pingProvider).not.toHaveBeenCalled()
  })
})
