import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { emitNervesEvent } from "../../../nerves/runtime"
import { checkAgentConfigWithProviderHealth } from "../../../heart/daemon/agent-config-check"
import { loadOrCreateMachineIdentity } from "../../../heart/machine-identity"
import { upsertProviderCredential } from "../../../heart/provider-credential-pool"
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
