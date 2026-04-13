import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn(),
}))

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { pingProvider } from "../../../heart/provider-ping"
import {
  readProviderCredentialPool,
  writeProviderCredentialPool,
  type ProviderCredentialPool,
} from "../../../heart/provider-credential-pool"
import {
  readProviderState,
  writeProviderState,
  type ProviderState,
} from "../../../heart/provider-state"

const NOW = "2026-04-12T20:10:00.000Z"
const mockPingProvider = vi.mocked(pingProvider)
const cleanup: string[] = []

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.test_run",
    message: testName,
    meta: { test: true },
  })
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

function makeCliDeps(homeDir: string, bundlesRoot: string, overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  const output: string[] = []
  return {
    socketPath: "/tmp/test-socket",
    sendCommand: async () => ({ ok: true, summary: "" }),
    startDaemonProcess: async () => ({ pid: null }),
    writeStdout: (text: string) => output.push(text),
    checkSocketAlive: async () => false,
    cleanupStaleSocket: () => {},
    fallbackPendingMessage: () => "",
    bundlesRoot,
    secretsRoot: path.join(homeDir, ".agentsecrets"),
    ...overrides,
    _output: output,
  } as OuroCliDeps & { _output: string[] }
}

function writeAgentConfig(bundlesRoot: string, agentName: string): void {
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
    version: 2,
    enabled: true,
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    context: { maxTokens: 80000, contextMargin: 20 },
  }, null, 2)}\n`, "utf-8")
}

function agentRoot(bundlesRoot: string, agentName: string): string {
  return path.join(bundlesRoot, `${agentName}.ouro`)
}

function providerState(overrides: Partial<ProviderState> = {}): ProviderState {
  const base: ProviderState = {
    schemaVersion: 1,
    machineId: "machine_test",
    updatedAt: NOW,
    lanes: {
      outward: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "bootstrap",
        updatedAt: NOW,
      },
      inner: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        source: "bootstrap",
        updatedAt: NOW,
      },
    },
    readiness: {},
  }
  return { ...base, ...overrides }
}

function credentialPool(overrides: Partial<ProviderCredentialPool> = {}): ProviderCredentialPool {
  const base: ProviderCredentialPool = {
    schemaVersion: 1,
    updatedAt: NOW,
    providers: {
      minimax: {
        provider: "minimax",
        revision: "cred_minimax_1",
        updatedAt: NOW,
        credentials: { apiKey: "minimax-secret" },
        config: {},
        provenance: {
          source: "auth-flow",
          contributedByAgent: "Slugger",
          updatedAt: NOW,
        },
      },
      anthropic: {
        provider: "anthropic",
        revision: "cred_anthropic_1",
        updatedAt: NOW,
        credentials: { setupToken: "anthropic-secret" },
        config: {},
        provenance: {
          source: "legacy-agent-secrets",
          contributedByAgent: "LegacyAgent",
          updatedAt: NOW,
        },
      },
    },
  }
  return { ...base, ...overrides }
}

function readAgentConfig(bundlesRoot: string, agentName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(agentRoot(bundlesRoot, agentName), "agent.json"), "utf-8")) as Record<string, unknown>
}

afterEach(() => {
  mockPingProvider.mockReset()
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (!entry) continue
    fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("provider CLI command parsing", () => {
  it("parses ouro use with lane vocabulary and force", () => {
    emitTestEvent("provider cli parse use lane force")

    expect(parseOuroCommand([
      "use",
      "--agent",
      "Slugger",
      "--lane",
      "inner",
      "--provider",
      "minimax",
      "--model",
      "MiniMax-M2.5",
      "--force",
    ])).toEqual({
      kind: "provider.use",
      agent: "Slugger",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
      force: true,
    })
  })

  it("maps legacy facing flags to provider lanes", () => {
    emitTestEvent("provider cli parse legacy facing")

    expect(parseOuroCommand([
      "use",
      "--agent",
      "Slugger",
      "--facing",
      "agent",
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-4-6",
    ])).toEqual({
      kind: "provider.use",
      agent: "Slugger",
      lane: "inner",
      provider: "anthropic",
      model: "claude-opus-4-6",
      legacyFacing: "agent",
    })
  })

  it("parses provider check and provider status commands without breaking daemon status", () => {
    emitTestEvent("provider cli parse check status")

    expect(parseOuroCommand(["status"])).toEqual({ kind: "daemon.status" })
    expect(parseOuroCommand(["status", "--agent", "Slugger"])).toEqual({
      kind: "provider.status",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["check", "--agent", "Slugger", "--lane", "outward"])).toEqual({
      kind: "provider.check",
      agent: "Slugger",
      lane: "outward",
    })
  })

  it("rejects malformed provider command shapes with direct usage", () => {
    emitTestEvent("provider cli parse malformed")

    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "sideways", "--provider", "minimax", "--model", "m"]))
      .toThrow("lane")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "minimax"]))
      .toThrow("ouro use --agent <name>")
    expect(() => parseOuroCommand(["check", "--lane", "inner"]))
      .toThrow("ouro check --agent <name>")
  })
})

describe("provider CLI command execution", () => {
  it("ouro use writes local provider state after a successful live check", async () => {
    emitTestEvent("provider cli use writes provider state")
    const bundlesRoot = makeTempDir("provider-cli-bundles")
    const homeDir = makeTempDir("provider-cli-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: 1 })

    const result = await runOuroCli([
      "use",
      "--agent",
      "Slugger",
      "--lane",
      "inner",
      "--provider",
      "minimax",
      "--model",
      "MiniMax-M2.5",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("Slugger inner")
    expect(result).toContain("minimax")
    expect(result).toContain("MiniMax-M2.5")
    expect(result).toContain("ready")
    expect(mockPingProvider).toHaveBeenCalledWith("minimax", { apiKey: "minimax-secret" }, expect.anything())

    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner).toMatchObject({
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
    })
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "ready",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "cred_minimax_1",
      attempts: 1,
    })
  })

  it("ouro use refuses missing credentials unless forced", async () => {
    emitTestEvent("provider cli use missing credentials")
    const bundlesRoot = makeTempDir("provider-cli-missing-bundles")
    const homeDir = makeTempDir("provider-cli-missing-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))

    const result = await runOuroCli([
      "use",
      "--agent",
      "Slugger",
      "--lane",
      "inner",
      "--provider",
      "minimax",
      "--model",
      "MiniMax-M2.5",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("no credentials")
    expect(result).toContain("ouro auth --agent Slugger --provider minimax")
    expect(mockPingProvider).not.toHaveBeenCalled()
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner.provider).toBe("anthropic")
  })

  it("ouro use --force records a failed readiness result without hiding the broken binding", async () => {
    emitTestEvent("provider cli use force failed readiness")
    const bundlesRoot = makeTempDir("provider-cli-force-bundles")
    const homeDir = makeTempDir("provider-cli-force-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockResolvedValue({ ok: false, message: "bad key", attempts: 3 })

    const result = await runOuroCli([
      "use",
      "--agent",
      "Slugger",
      "--lane",
      "inner",
      "--provider",
      "minimax",
      "--model",
      "MiniMax-M2.5",
      "--force",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("forced")
    expect(result).toContain("bad key")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner).toMatchObject({
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
    })
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "failed",
      error: "bad key",
      attempts: 3,
    })
  })

  it("ouro auth stores credentials in the machine pool and does not switch bindings", async () => {
    emitTestEvent("provider cli auth writes machine pool")
    const bundlesRoot = makeTempDir("provider-cli-auth-bundles")
    const homeDir = makeTempDir("provider-cli-auth-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())

    const result = await runOuroCli([
      "auth",
      "--agent",
      "Slugger",
      "--provider",
      "minimax",
    ], makeCliDeps(homeDir, bundlesRoot, {
      runAuthFlow: async () => ({
        agentName: "Slugger",
        provider: "minimax",
        message: "authenticated Slugger with minimax",
        secretsPath: path.join(homeDir, ".agentsecrets", "legacy", "secrets.json"),
        credentials: { apiKey: "new-minimax-secret" },
      }),
    }))

    expect(result).toContain("authenticated Slugger with minimax")
    const poolResult = readProviderCredentialPool(homeDir)
    expect(poolResult.ok).toBe(true)
    if (!poolResult.ok) throw new Error(poolResult.error)
    expect(poolResult.pool.providers.minimax).toMatchObject({
      provider: "minimax",
      credentials: { apiKey: "new-minimax-secret" },
      provenance: {
        source: "auth-flow",
        contributedByAgent: "Slugger",
      },
    })

    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner.provider).toBe("anthropic")
    expect(stateResult.state.lanes.outward.provider).toBe("anthropic")
  })

  it("ouro status --agent renders cached provider state without raw secrets", async () => {
    emitTestEvent("provider cli status cached state")
    const bundlesRoot = makeTempDir("provider-cli-status-bundles")
    const homeDir = makeTempDir("provider-cli-status-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: NOW,
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
          updatedAt: NOW,
        },
      },
      readiness: {
        inner: {
          status: "ready",
          provider: "minimax",
          model: "MiniMax-M2.5",
          checkedAt: NOW,
          credentialRevision: "cred_minimax_1",
          attempts: 1,
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool())

    const result = await runOuroCli(["status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("provider status: Slugger")
    expect(result).toContain("inner")
    expect(result).toContain("minimax")
    expect(result).toContain("MiniMax-M2.5")
    expect(result).toContain("ready")
    expect(result).toContain("auth-flow")
    expect(result).toContain("Slugger")
    expect(result).not.toContain("minimax-secret")
    expect(result).not.toContain("anthropic-secret")
  })

  it("ouro check performs a live selected binding check and updates readiness", async () => {
    emitTestEvent("provider cli check live state")
    const bundlesRoot = makeTempDir("provider-cli-check-bundles")
    const homeDir = makeTempDir("provider-cli-check-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: NOW,
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
          updatedAt: NOW,
        },
      },
      readiness: {},
    }))
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: 2 })

    const result = await runOuroCli(["check", "--agent", "Slugger", "--lane", "inner"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("Slugger inner")
    expect(result).toContain("minimax")
    expect(result).toContain("MiniMax-M2.5")
    expect(result).toContain("ready")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "ready",
      provider: "minimax",
      model: "MiniMax-M2.5",
      credentialRevision: "cred_minimax_1",
      attempts: 2,
    })
  })

  it("legacy config model updates provider state instead of live agent.json provider fields", async () => {
    emitTestEvent("provider cli config model compatibility")
    const bundlesRoot = makeTempDir("provider-cli-config-model-bundles")
    const homeDir = makeTempDir("provider-cli-config-model-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: NOW,
        },
        inner: {
          provider: "minimax",
          model: "old-minimax-model",
          source: "local",
          updatedAt: NOW,
        },
      },
      readiness: {},
    }))
    writeProviderCredentialPool(homeDir, credentialPool())

    const result = await runOuroCli([
      "config",
      "model",
      "--agent",
      "Slugger",
      "--facing",
      "agent",
      "MiniMax-M2.5",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("deprecated")
    expect(result).toContain("ouro use")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner).toMatchObject({
      provider: "minimax",
      model: "MiniMax-M2.5",
      source: "local",
    })

    const agentConfig = readAgentConfig(bundlesRoot, "Slugger")
    expect(agentConfig.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })
})
