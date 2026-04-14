import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn(),
  pingGithubCopilotModel: vi.fn(async () => ({ ok: true })),
}))

const mockProviderCredentials = vi.hoisted(() => ({
  pools: new Map<string, any>(),
  refreshProviderCredentialPool: vi.fn(async (agentName: string) => {
    return mockProviderCredentials.pools.get(agentName) ?? {
      ok: true,
      poolPath: `vault:${agentName}:providers/*`,
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-04-12T20:10:00.000Z",
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

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { pingProvider } from "../../../heart/provider-ping"
import type {
  ProviderCredentialPool,
  ProviderCredentialPoolReadResult,
} from "../../../heart/provider-credentials"
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

function writeProviderCredentialPool(_homeDir: string, pool: ProviderCredentialPool, agentName = "Slugger"): void {
  mockProviderCredentials.pools.set(agentName, okCredentialPool(agentName, pool))
}

function writeUnavailableProviderCredentialPool(agentName: string, error: string): void {
  mockProviderCredentials.pools.set(agentName, unavailableCredentialPool(agentName, error))
}

function readProviderCredentialPool(_homeDir: string, agentName = "Slugger"): ProviderCredentialPoolReadResult {
  return mockProviderCredentials.pools.get(agentName) ?? unavailableCredentialPool(agentName, "provider credentials have not been loaded from vault")
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
          source: "manual",
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
  mockProviderCredentials.pools.clear()
  mockProviderCredentials.refreshProviderCredentialPool.mockClear()
  mockProviderCredentials.readProviderCredentialPool.mockClear()
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
      "human",
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-4-6",
    ])).toEqual({
      kind: "provider.use",
      agent: "Slugger",
      lane: "outward",
      provider: "anthropic",
      model: "claude-opus-4-6",
      legacyFacing: "human",
    })

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
    expect(parseOuroCommand(["check", "--agent", "Slugger", "--facing", "agent"])).toEqual({
      kind: "provider.check",
      agent: "Slugger",
      lane: "inner",
      legacyFacing: "agent",
    })
    expect(parseOuroCommand(["check", "--agent", "Slugger", "--facing", "human"])).toEqual({
      kind: "provider.check",
      agent: "Slugger",
      lane: "outward",
      legacyFacing: "human",
    })
  })

  it("rejects malformed provider command shapes with direct usage", () => {
    emitTestEvent("provider cli parse malformed")

    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "sideways", "--provider", "minimax", "--model", "m"]))
      .toThrow("lane")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "not-real", "--model", "m"]))
      .toThrow("ouro use --agent <name>")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "minimax"]))
      .toThrow("ouro use --agent <name>")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--provider", "minimax", "--model", "m"]))
      .toThrow("ouro use --agent <name>")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "minimax", "--model", "m", "--surprise"]))
      .toThrow("ouro use --agent <name>")
    expect(() => parseOuroCommand(["check", "--lane", "inner"]))
      .toThrow("ouro check --agent <name>")
    expect(() => parseOuroCommand(["check", "--agent", "Slugger"]))
      .toThrow("ouro check --agent <name>")
    expect(() => parseOuroCommand(["status", "--agent", "Slugger", "extra"]))
      .toThrow("ouro status --agent <name>")
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

  it("ouro use treats unavailable agent vault credentials as unavailable credentials", async () => {
    emitTestEvent("provider cli use invalid credential pool")
    const bundlesRoot = makeTempDir("provider-cli-invalid-pool-bundles")
    const homeDir = makeTempDir("provider-cli-invalid-pool-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeUnavailableProviderCredentialPool("Slugger", "vault locked")

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
  })

  it("ouro use --force records a failed binding when credentials are unavailable", async () => {
    emitTestEvent("provider cli use force missing credentials")
    const bundlesRoot = makeTempDir("provider-cli-force-missing-bundles")
    const homeDir = makeTempDir("provider-cli-force-missing-home")
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
      "--force",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("forced")
    expect(result).toContain("no credentials")
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
      error: "no credentials stored for minimax",
    })
  })

  it("ouro use ignores unrelated legacy per-agent secrets while checking the agent vault", async () => {
    emitTestEvent("provider cli use ignores legacy secrets")
    const bundlesRoot = makeTempDir("provider-cli-unreadable-legacy-bundles")
    const homeDir = makeTempDir("provider-cli-unreadable-legacy-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const legacyDir = path.join(homeDir, ".agentsecrets", "Slugger")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "secrets.json"), "{bad-json", "utf-8")

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
    expect(mockPingProvider).not.toHaveBeenCalled()
  })

  it("ouro use does not fall back to legacy per-agent secrets for other providers", async () => {
    emitTestEvent("provider cli use no legacy fallback")
    const bundlesRoot = makeTempDir("provider-cli-wrong-legacy-bundles")
    const homeDir = makeTempDir("provider-cli-wrong-legacy-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const legacyDir = path.join(homeDir, ".agentsecrets", "Slugger")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "secrets.json"), `${JSON.stringify({
      providers: {
        anthropic: { setupToken: "anthropic-only" },
      },
    })}\n`, "utf-8")

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
    expect(mockPingProvider).not.toHaveBeenCalled()
  })

  it("ouro use refuses failed live checks unless forced", async () => {
    emitTestEvent("provider cli use failed check without force")
    const bundlesRoot = makeTempDir("provider-cli-failed-check-bundles")
    const homeDir = makeTempDir("provider-cli-failed-check-home")
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
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("failed (bad key)")
    expect(result).toContain("--force")
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

  it("ouro auth delegates storage to the auth flow and does not switch bindings", async () => {
    emitTestEvent("provider cli auth delegates storage")
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
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner.provider).toBe("anthropic")
    expect(stateResult.state.lanes.outward.provider).toBe("anthropic")
  })

  it("legacy auth switch with --facing agent updates only the inner local lane", async () => {
    emitTestEvent("provider cli legacy auth switch agent lane")
    const bundlesRoot = makeTempDir("provider-cli-auth-switch-bundles")
    const homeDir = makeTempDir("provider-cli-auth-switch-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: 1 })

    const result = await runOuroCli([
      "auth",
      "switch",
      "--agent",
      "Slugger",
      "--provider",
      "minimax",
      "--facing",
      "agent",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("deprecated")
    expect(result).toContain("minimax")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.outward.provider).toBe("anthropic")
    expect(stateResult.state.lanes.inner.provider).toBe("minimax")
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "ready",
      provider: "minimax",
    })
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

  it("ouro status --agent renders missing provider-state repair guidance", async () => {
    emitTestEvent("provider cli status missing state")
    const bundlesRoot = makeTempDir("provider-cli-status-missing-bundles")
    const homeDir = makeTempDir("provider-cli-status-missing-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli(["status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("provider status: Slugger")
    expect(result).toContain("outward: unavailable")
    expect(result).toContain("provider-state-missing")
    expect(result).toContain("ouro use --agent Slugger --lane outward")
  })

  it("ouro status --agent renders credential warnings without exposing secret values", async () => {
    emitTestEvent("provider cli status credential warnings")
    const bundlesRoot = makeTempDir("provider-cli-status-warning-bundles")
    const homeDir = makeTempDir("provider-cli-status-warning-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
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
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))

    const result = await runOuroCli(["status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("credentials: missing")
    expect(result).toContain("warning: minimax has no credential record")
    expect(result).toContain("ouro auth --agent Slugger --provider minimax")
    expect(result).not.toContain("minimax-secret")
  })

  it("ouro status --agent renders invalid credential-pool repair guidance", async () => {
    emitTestEvent("provider cli status invalid credential pool")
    const bundlesRoot = makeTempDir("provider-cli-status-invalid-pool-bundles")
    const homeDir = makeTempDir("provider-cli-status-invalid-pool-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "local",
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
    writeUnavailableProviderCredentialPool("Slugger", "vault locked")

    const result = await runOuroCli(["status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("credentials: vault unavailable")
    expect(result).toContain("repair: ouro auth --agent Slugger --provider minimax")
    expect(result).toContain("warning: minimax cannot read credentials")
  })

  it("ouro status --agent renders failed readiness and sparse credential provenance", async () => {
    emitTestEvent("provider cli status failed readiness sparse credentials")
    const bundlesRoot = makeTempDir("provider-cli-status-failed-readiness-bundles")
    const homeDir = makeTempDir("provider-cli-status-failed-readiness-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "github-copilot",
          model: "gpt-4o",
          source: "local",
          updatedAt: NOW,
        },
        inner: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: NOW,
        },
      },
      readiness: {
        outward: {
          status: "failed",
          provider: "github-copilot",
          model: "gpt-4o",
          checkedAt: NOW,
          credentialRevision: "cred_ghc_config_only",
          error: "bad token",
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_config_only",
          updatedAt: NOW,
          credentials: {},
          config: { baseUrl: "https://api.copilot.example.com" },
          provenance: {
            source: "manual",
            updatedAt: NOW,
          },
        },
      },
    }))

    const result = await runOuroCli(["status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("readiness: failed (bad token)")
    expect(result).toContain("credentials: present in vault (manual; cred_ghc_config_only; credentials: none; config: baseUrl)")
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
    mockPingProvider.mockResolvedValue({
      ok: true,
      attempts: [
        {
          attempt: 1,
          provider: "minimax",
          model: "MiniMax-M2.5",
          operation: "ping",
          ok: false,
          willRetry: true,
        },
        {
          attempt: 2,
          provider: "minimax",
          model: "MiniMax-M2.5",
          operation: "ping",
          ok: true,
          willRetry: false,
        },
      ],
    })

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

  it("ouro check records failed live readiness", async () => {
    emitTestEvent("provider cli check failed live state")
    const bundlesRoot = makeTempDir("provider-cli-check-failed-bundles")
    const homeDir = makeTempDir("provider-cli-check-failed-home")
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
    mockPingProvider.mockResolvedValue({ ok: false, message: "bad key", attempts: 2 })

    const result = await runOuroCli(["check", "--agent", "Slugger", "--lane", "inner"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("failed (bad key)")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "failed",
      error: "bad key",
      attempts: 2,
    })
  })

  it("ouro check records readiness when ping results omit attempt counts", async () => {
    emitTestEvent("provider cli check no attempts")
    const bundlesRoot = makeTempDir("provider-cli-check-no-attempts-bundles")
    const homeDir = makeTempDir("provider-cli-check-no-attempts-home")
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
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok" })

    const result = await runOuroCli(["check", "--agent", "Slugger", "--lane", "inner"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("ready")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "ready",
      credentialRevision: "cred_minimax_1",
    })
    expect(stateResult.state.readiness.inner).not.toHaveProperty("attempts")
  })

  it("ouro check reports missing selected credentials without pinging", async () => {
    emitTestEvent("provider cli check missing credentials")
    const bundlesRoot = makeTempDir("provider-cli-check-missing-bundles")
    const homeDir = makeTempDir("provider-cli-check-missing-home")
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
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))

    const result = await runOuroCli(["check", "--agent", "Slugger", "--lane", "inner"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("Slugger inner minimax / MiniMax-M2.5: unknown")
    expect(result).toContain("ouro auth --agent Slugger --provider minimax")
    expect(mockPingProvider).not.toHaveBeenCalled()
  })

  it("ouro check fails fast when local provider state is invalid", async () => {
    emitTestEvent("provider cli check invalid state")
    const bundlesRoot = makeTempDir("provider-cli-check-invalid-state-bundles")
    const homeDir = makeTempDir("provider-cli-check-invalid-state-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    fs.mkdirSync(path.join(agentRoot(bundlesRoot, "Slugger"), "state"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot(bundlesRoot, "Slugger"), "state", "providers.json"), "{bad-json", "utf-8")

    await expect(runOuroCli(["check", "--agent", "Slugger", "--lane", "inner"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("provider state for Slugger is invalid")
  })

  it("legacy config model validates github-copilot models with machine-pool credentials", async () => {
    emitTestEvent("provider cli config model github copilot validation")
    const bundlesRoot = makeTempDir("provider-cli-config-ghc-bundles")
    const homeDir = makeTempDir("provider-cli-config-ghc-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "github-copilot",
          model: "old-model",
          source: "local",
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
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_1",
          updatedAt: NOW,
          credentials: { githubToken: "ghp-test" },
          config: { baseUrl: "https://api.copilot.example.com" },
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: "gpt-4o", name: "GPT-4o" }],
    })) as unknown as typeof fetch

    const result = await runOuroCli([
      "config",
      "model",
      "--agent",
      "Slugger",
      "--facing",
      "human",
      "gpt-4o",
    ], makeCliDeps(homeDir, bundlesRoot, { fetchImpl }))

    expect(result).toContain("deprecated")
    expect(result).toContain("old-model -> gpt-4o")
    expect(fetchImpl).toHaveBeenCalled()
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.outward).toMatchObject({
      provider: "github-copilot",
      model: "gpt-4o",
      source: "local",
    })
  })

  it("legacy config model can use global fetch for github-copilot validation", async () => {
    emitTestEvent("provider cli config model github copilot global fetch")
    const bundlesRoot = makeTempDir("provider-cli-config-ghc-global-bundles")
    const homeDir = makeTempDir("provider-cli-config-ghc-global-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "github-copilot",
          model: "old-model",
          source: "local",
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
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_global",
          updatedAt: NOW,
          credentials: { githubToken: "ghp-test" },
          config: { baseUrl: "https://api.copilot.example.com" },
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: "gpt-4o", name: "GPT-4o" }],
    })) as unknown as typeof fetch
    const originalFetch = globalThis.fetch
    vi.stubGlobal("fetch", fetchImpl)

    try {
      const result = await runOuroCli([
        "config",
        "model",
        "--agent",
        "Slugger",
        "gpt-4o",
      ], makeCliDeps(homeDir, bundlesRoot))

      expect(result).toContain("old-model -> gpt-4o")
      expect(fetchImpl).toHaveBeenCalled()
    } finally {
      vi.stubGlobal("fetch", originalFetch)
    }
  })

  it("legacy config model skips github-copilot validation when endpoint details are incomplete", async () => {
    emitTestEvent("provider cli config model github copilot incomplete credentials")
    const bundlesRoot = makeTempDir("provider-cli-config-ghc-incomplete-bundles")
    const homeDir = makeTempDir("provider-cli-config-ghc-incomplete-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "github-copilot",
          model: "old-model",
          source: "local",
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
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_incomplete",
          updatedAt: NOW,
          credentials: { githubToken: "ghp-test" },
          config: {},
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: "gpt-4o", name: "GPT-4o" }],
    })) as unknown as typeof fetch

    const result = await runOuroCli([
      "config",
      "model",
      "--agent",
      "Slugger",
      "gpt-4o",
    ], makeCliDeps(homeDir, bundlesRoot, { fetchImpl }))

    expect(result).toContain("old-model -> gpt-4o")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("legacy config model skips github-copilot validation when credentials are missing", async () => {
    emitTestEvent("provider cli config model github copilot missing credentials")
    const bundlesRoot = makeTempDir("provider-cli-config-ghc-missing-bundles")
    const homeDir = makeTempDir("provider-cli-config-ghc-missing-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "github-copilot",
          model: "old-model",
          source: "local",
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
    }))
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: "gpt-4o", name: "GPT-4o" }],
    })) as unknown as typeof fetch

    const result = await runOuroCli([
      "config",
      "model",
      "--agent",
      "Slugger",
      "gpt-4o",
    ], makeCliDeps(homeDir, bundlesRoot, { fetchImpl }))

    expect(result).toContain("old-model -> gpt-4o")
    expect(fetchImpl).not.toHaveBeenCalled()
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
