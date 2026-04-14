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

const mockVaultDeps = vi.hoisted(() => ({
  createVaultAccount: vi.fn(async () => ({ success: true })),
  storeVaultUnlockSecret: vi.fn(() => ({ kind: "plaintext-file", secure: false, location: "/tmp/ouro-unlock" })),
  getVaultUnlockStatus: vi.fn(() => ({
    configured: true,
    stored: false,
    store: { kind: "plaintext-file", secure: false, location: "/tmp/ouro-unlock" },
    fix: "run ouro vault unlock",
  })),
  resetCredentialStore: vi.fn(),
  credentialProbeGet: vi.fn(async () => null),
  rawSecrets: new Map<string, string>(),
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockProviderCredentials.refreshProviderCredentialPool,
    readProviderCredentialPool: mockProviderCredentials.readProviderCredentialPool,
  }
})

vi.mock("../../../repertoire/vault-setup", () => ({
  createVaultAccount: (...args: unknown[]) => mockVaultDeps.createVaultAccount(...args),
}))

vi.mock("../../../repertoire/vault-unlock", () => ({
  storeVaultUnlockSecret: (...args: unknown[]) => mockVaultDeps.storeVaultUnlockSecret(...args),
  getVaultUnlockStatus: (...args: unknown[]) => mockVaultDeps.getVaultUnlockStatus(...args),
}))

vi.mock("../../../repertoire/credential-access", () => ({
  resetCredentialStore: () => mockVaultDeps.resetCredentialStore(),
  getCredentialStore: (agentName = "Slugger") => ({
    get: (...args: unknown[]) => mockVaultDeps.credentialProbeGet(...args),
    getRawSecret: async (domain: string) => {
      const raw = mockVaultDeps.rawSecrets.get(`${agentName}:${domain}`)
      if (raw === undefined) throw new Error(`no credential found for domain "${domain}"`)
      return raw
    },
    store: async (domain: string, data: { password: string }) => {
      mockVaultDeps.rawSecrets.set(`${agentName}:${domain}`, data.password)
    },
    list: async () => [],
    delete: async () => false,
    isReady: () => true,
  }),
}))

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
import { resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"

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

function writeInvalidProviderCredentialPool(agentName: string, error: string): void {
  mockProviderCredentials.pools.set(agentName, {
    ok: false,
    reason: "invalid",
    poolPath: `vault:${agentName}:providers/*`,
    error,
  })
}

function writeMissingProviderCredentialPool(agentName: string): void {
  mockProviderCredentials.pools.set(agentName, {
    ok: false,
    reason: "missing",
    poolPath: `vault:${agentName}:providers/*`,
    error: "provider credentials have not been loaded from vault",
  })
}

function runtimeConfigSecret(config: Record<string, unknown>, updatedAt = NOW): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt,
    config,
  })
}

function writeRuntimeConfig(agentName: string, config: Record<string, unknown>): void {
  mockVaultDeps.rawSecrets.set(`${agentName}:runtime/config`, runtimeConfigSecret(config))
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
    homeDir,
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
  mockVaultDeps.createVaultAccount.mockReset()
  mockVaultDeps.createVaultAccount.mockResolvedValue({ success: true })
  mockVaultDeps.storeVaultUnlockSecret.mockReset()
  mockVaultDeps.storeVaultUnlockSecret.mockReturnValue({ kind: "plaintext-file", secure: false, location: "/tmp/ouro-unlock" })
  mockVaultDeps.getVaultUnlockStatus.mockReset()
  mockVaultDeps.getVaultUnlockStatus.mockReturnValue({
    configured: true,
    stored: false,
    store: { kind: "plaintext-file", secure: false, location: "/tmp/ouro-unlock" },
    fix: "run ouro vault unlock",
  })
  mockVaultDeps.resetCredentialStore.mockClear()
  mockVaultDeps.credentialProbeGet.mockReset()
  mockVaultDeps.credentialProbeGet.mockResolvedValue(null)
  mockVaultDeps.rawSecrets.clear()
  resetRuntimeCredentialConfigCache()
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

  it("parses provider refresh and vault lifecycle commands", () => {
    emitTestEvent("provider cli parse refresh vault")

    expect(parseOuroCommand(["provider", "refresh", "--agent", "Slugger"])).toEqual({
      kind: "provider.refresh",
      agent: "Slugger",
    })
    expect(() => parseOuroCommand(["provider", "refresh", "--agent", "Slugger", "--extra"]))
      .toThrow("ouro provider refresh --agent <name>")

    expect(parseOuroCommand([
      "vault",
      "create",
      "--agent",
      "Slugger",
      "--email",
      "operator@example.com",
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
      "--generate-unlock-secret",
    ])).toEqual({
      kind: "vault.create",
      agent: "Slugger",
      email: "operator@example.com",
      serverUrl: "https://vault.example.com",
      store: "plaintext-file",
      generateUnlockSecret: true,
    })
    expect(parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "auto"])).toEqual({
      kind: "vault.unlock",
      agent: "Slugger",
      store: "auto",
    })
    expect(parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "macos-keychain"])).toEqual({
      kind: "vault.unlock",
      agent: "Slugger",
      store: "macos-keychain",
    })
    expect(parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "windows-dpapi"])).toEqual({
      kind: "vault.unlock",
      agent: "Slugger",
      store: "windows-dpapi",
    })
    expect(parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "linux-secret-service"])).toEqual({
      kind: "vault.unlock",
      agent: "Slugger",
      store: "linux-secret-service",
    })
    expect(parseOuroCommand(["vault", "status", "--agent", "Slugger"])).toEqual({
      kind: "vault.status",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["vault", "status", "--agent", "Slugger", "--store", "plaintext-file"])).toEqual({
      kind: "vault.status",
      agent: "Slugger",
      store: "plaintext-file",
    })
    expect(parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password"])).toEqual({
      kind: "vault.config.set",
      agent: "Slugger",
      key: "bluebubbles.password",
    })
    expect(parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--value", "secret"])).toEqual({
      kind: "vault.config.set",
      agent: "Slugger",
      key: "bluebubbles.password",
      value: "secret",
    })
    expect(parseOuroCommand(["vault", "config", "status", "--agent", "Slugger"])).toEqual({
      kind: "vault.config.status",
      agent: "Slugger",
    })
    expect(() => parseOuroCommand(["vault", "config", "status", "--agent", "Slugger", "--key", "bluebubbles.password"]))
      .toThrow("ouro vault config status")
    expect(() => parseOuroCommand(["vault", "config", "set", "--agent", "Slugger"]))
      .toThrow("ouro vault config set")
    expect(() => parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--bad"]))
      .toThrow("ouro vault config set")
    expect(() => parseOuroCommand(["vault", "config", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault config set")
    expect(() => parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "bad"]))
      .toThrow("vault --store")
    expect(() => parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--bad"]))
      .toThrow("ouro vault create|unlock|status --agent <name>")
    expect(() => parseOuroCommand(["vault", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault create|unlock|status --agent <name>")
    expect(() => parseOuroCommand(["vault", "status"]))
      .toThrow("ouro vault create|unlock|status --agent <name>")
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

  it("ouro use bootstraps missing local provider state and records optional ping attempts only when present", async () => {
    emitTestEvent("provider cli use bootstraps provider state")
    const bundlesRoot = makeTempDir("provider-cli-bootstrap-state-bundles")
    const homeDir = makeTempDir("provider-cli-bootstrap-state-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok" })

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

    expect(result).toContain("ready")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.machineId).toMatch(/^machine_/)
    expect(stateResult.state.readiness.inner).toMatchObject({
      status: "ready",
      provider: "minimax",
      model: "MiniMax-M2.5",
    })
    expect(stateResult.state.readiness.inner.attempts).toBeUndefined()
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

  it("ouro use treats invalid agent vault credential snapshots as unavailable credentials", async () => {
    emitTestEvent("provider cli use invalid credential snapshot")
    const bundlesRoot = makeTempDir("provider-cli-invalid-snapshot-bundles")
    const homeDir = makeTempDir("provider-cli-invalid-snapshot-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeInvalidProviderCredentialPool("Slugger", "bad vault payload")

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

  it("ouro use treats a missing vault credential snapshot as missing credentials", async () => {
    emitTestEvent("provider cli use missing credential snapshot")
    const bundlesRoot = makeTempDir("provider-cli-missing-snapshot-bundles")
    const homeDir = makeTempDir("provider-cli-missing-snapshot-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeMissingProviderCredentialPool("Slugger")

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

  it("vault unlock stores local unlock material and probes the agent vault", async () => {
    emitTestEvent("provider cli vault unlock")
    const bundlesRoot = makeTempDir("provider-cli-vault-unlock-bundles")
    const homeDir = makeTempDir("provider-cli-vault-unlock-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli([
      "vault",
      "unlock",
      "--agent",
      "Slugger",
      "--store",
      "plaintext-file",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "unlock-material",
    }))

    expect(result).toContain("vault unlocked for Slugger")
    expect(result).toContain("explicit plaintext fallback")
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "Slugger@ouro.bot", serverUrl: "https://vault.ouro.bot" },
      "unlock-material",
      { homeDir, store: "plaintext-file" },
    )
    expect(mockVaultDeps.resetCredentialStore).toHaveBeenCalled()
    expect(mockVaultDeps.credentialProbeGet).toHaveBeenCalledWith("__ouro_vault_probe__")

    mockVaultDeps.storeVaultUnlockSecret.mockReturnValueOnce({ kind: "macos-keychain", secure: true, location: "macOS Keychain" })
    const secureResult = await runOuroCli([
      "vault",
      "unlock",
      "--agent",
      "Slugger",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "unlock-material",
    }))
    expect(secureResult).toContain("local unlock store: macos-keychain")
    expect(secureResult).not.toContain("explicit plaintext fallback")
  })

  it("vault unlock rejects SerpentGuide and non-interactive runs", async () => {
    emitTestEvent("provider cli vault unlock guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-unlock-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-unlock-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["vault", "unlock", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "unlock-material",
    }))).rejects.toThrow("SerpentGuide does not have a persistent credential vault")
    await expect(runOuroCli(["vault", "unlock", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("vault unlock requires an interactive prompt")
  })

  it("vault create writes vault locator, stores unlock material, and handles existing accounts", async () => {
    emitTestEvent("provider cli vault create")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const created = await runOuroCli([
      "vault",
      "create",
      "--agent",
      "Slugger",
      "--email",
      "operator@example.com",
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
      "--generate-unlock-secret",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(created).toContain("vault created for Slugger")
    expect(created).toContain("vault unlock secret:")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "operator@example.com",
      expect.any(String),
    )
    expect(readAgentConfig(bundlesRoot, "Slugger").vault).toEqual({
      email: "operator@example.com",
      serverUrl: "https://vault.example.com",
    })

    mockVaultDeps.createVaultAccount.mockResolvedValueOnce({ success: false, error: "already exists" })
    const failed = await runOuroCli([
      "vault",
      "create",
      "--agent",
      "Slugger",
      "--email",
      "operator@example.com",
      "--server",
      "https://vault.example.com",
      "--generate-unlock-secret",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(failed).toContain("vault create failed for Slugger: already exists")
    expect(failed).toContain("ouro vault unlock --agent Slugger")
  })

  it("vault create can prompt for email and unlock material", async () => {
    emitTestEvent("provider cli vault create prompts")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-prompt-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-prompt-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const prompts: string[] = []
    mockVaultDeps.storeVaultUnlockSecret.mockReturnValueOnce({ kind: "macos-keychain", secure: true, location: "macOS Keychain" })

    const result = await runOuroCli(["vault", "create", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return question.includes("email") ? "operator@example.com" : "chosen-unlock-material"
      },
    }))

    expect(result).toContain("vault created for Slugger")
    expect(result).not.toContain("vault unlock secret:")
    expect(result).toContain("local unlock store: macos-keychain")
    expect(result).not.toContain("explicit plaintext fallback")
    expect(prompts).toEqual([
      "Ouro credential vault email: ",
      "Choose Ouro vault unlock secret for operator@example.com: ",
    ])
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.ouro.bot",
      "operator@example.com",
      "chosen-unlock-material",
    )
  })

  it("vault create rejects unsupported persistent SerpentGuide vaults and missing inputs", async () => {
    emitTestEvent("provider cli vault create guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["vault", "create", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "operator@example.com",
    }))).rejects.toThrow("Create a vault for the hatchling agent")
    await expect(runOuroCli(["vault", "create", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("vault create requires --email")
    await expect(runOuroCli(["vault", "create", "--agent", "Slugger", "--email", "operator@example.com"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("vault create requires an unlock secret")
  })

  it("vault status reports local unlock state and vault provider summaries", async () => {
    emitTestEvent("provider cli vault status")
    const bundlesRoot = makeTempDir("provider-cli-vault-status-bundles")
    const homeDir = makeTempDir("provider-cli-vault-status-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "plaintext-file", secure: false, location: "/tmp/ouro-unlock" },
      fix: "available",
    })
    writeProviderCredentialPool(homeDir, credentialPool())
    writeRuntimeConfig("Slugger", {
      bluebubbles: { password: "bb-secret" },
      integrations: { perplexityApiKey: "pplx-secret" },
    })

    const result = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("agent: Slugger")
    expect(result).toContain("local unlock: available")
    expect(result).toContain("runtime credentials: bluebubbles.password, integrations.perplexityApiKey")
    expect(result).not.toContain("bb-secret")
    expect(result).not.toContain("pplx-secret")
    expect(result).toContain("minimax: credential fields apiKey")
    expect(result).toContain("anthropic: credential fields setupToken")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      fix: "available",
    })
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const empty = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(empty).toContain("local unlock store: macos-keychain")
    expect(empty).toContain("provider credentials: none stored")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      fix: "available",
    })
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        minimax: {
          provider: "minimax",
          revision: "cred_empty",
          updatedAt: NOW,
          credentials: {},
          config: {},
          provenance: { source: "manual", updatedAt: NOW },
        },
      },
    }))
    const noneFields = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(noneFields).toContain("minimax: credential fields none, config fields none")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      fix: "available",
    })
    mockVaultDeps.rawSecrets.delete("Slugger:runtime/config")
    resetRuntimeCredentialConfigCache()
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const missingRuntime = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(missingRuntime).toContain("runtime credentials: missing")
    expect(missingRuntime).toContain("ouro vault config set --agent Slugger")

    const agentConfigPath = path.join(bundlesRoot, "Slugger.ouro", "agent.json")
    const agentConfig = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as Record<string, unknown>
    fs.writeFileSync(agentConfigPath, `${JSON.stringify({
      ...agentConfig,
      vault: {
        email: "slugger@example.com",
        serverUrl: "https://vault.example.com",
      },
    }, null, 2)}\n`, "utf-8")
    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      fix: "available",
    })
    writeRuntimeConfig("Slugger", {})
    resetRuntimeCredentialConfigCache()
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const emptyRuntime = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(emptyRuntime).toContain("vault locator: agent.json")
    expect(emptyRuntime).toContain("vault: slugger@example.com at https://vault.example.com")
    expect(emptyRuntime).toContain("runtime credentials: none stored")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      fix: "available",
    })
    mockVaultDeps.rawSecrets.set("Slugger:runtime/config", JSON.stringify({
      schemaVersion: 1,
      kind: "wrong",
      updatedAt: NOW,
      config: {},
    }))
    resetRuntimeCredentialConfigCache()
    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const invalidRuntime = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(invalidRuntime).toContain("runtime credentials: invalid")
    expect(invalidRuntime).not.toContain("store sense/integration credentials")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: true,
      store: { kind: "macos-keychain", secure: true, location: "macOS Keychain" },
      fix: "available",
    })
    writeUnavailableProviderCredentialPool("Slugger", "vault locked")
    const unavailable = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(unavailable).toContain("provider credentials: unavailable (vault locked)")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: true,
      stored: false,
      store: { kind: "plaintext-file", secure: false, location: "/tmp/ouro-unlock" },
      fix: "run ouro vault unlock",
    })
    const missing = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(missing).toContain("local unlock: missing")
    expect(missing).toContain("run ouro vault unlock")

    mockVaultDeps.getVaultUnlockStatus.mockReturnValueOnce({
      configured: false,
      stored: false,
      fix: "no local store",
    })
    const noStore = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(noStore).toContain("local unlock store: unavailable")

    const serpent = await runOuroCli(["vault", "status", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot))
    expect(serpent).toContain("SerpentGuide has no persistent credential vault")
  })

  it("vault config set and status manage runtime credentials without printing values", async () => {
    emitTestEvent("provider cli vault config")
    const bundlesRoot = makeTempDir("provider-cli-vault-config-bundles")
    const homeDir = makeTempDir("provider-cli-vault-config-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeRuntimeConfig("Slugger", {
      bluebubbles: { serverUrl: "http://localhost:1234" },
    })

    const deps = makeCliDeps(homeDir, bundlesRoot, { now: () => Date.parse(NOW) })
    const set = await runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--value", "super-secret"],
      deps,
    )

    expect(set).toContain("stored bluebubbles.password for Slugger")
    expect(set).toContain("value was not printed")
    expect(set).not.toContain("super-secret")
    const raw = mockVaultDeps.rawSecrets.get("Slugger:runtime/config")
    expect(raw).toBeDefined()
    const stored = JSON.parse(raw ?? "{}") as { config: { bluebubbles?: { serverUrl?: string; password?: string } } }
    expect(stored.config.bluebubbles?.serverUrl).toBe("http://localhost:1234")
    expect(stored.config.bluebubbles?.password).toBe("super-secret")

    const status = await runOuroCli(["vault", "config", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(status).toContain("runtime config item: vault:Slugger:runtime/config")
    expect(status).toContain("fields: bluebubbles.password, bluebubbles.serverUrl")
    expect(status).not.toContain("super-secret")

    writeRuntimeConfig("Slugger", {})
    resetRuntimeCredentialConfigCache()
    const emptyStatus = await runOuroCli(["vault", "config", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(emptyStatus).toContain("fields: none stored")

    mockVaultDeps.rawSecrets.set("Slugger:runtime/config", JSON.stringify({
      schemaVersion: 1,
      kind: "wrong",
      updatedAt: NOW,
      config: {},
    }))
    resetRuntimeCredentialConfigCache()
    const invalidStatus = await runOuroCli(["vault", "config", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(invalidStatus).toContain("status: invalid")
    expect(invalidStatus).toContain("ouro vault unlock --agent Slugger")

    writeRuntimeConfig("Slugger", {
      bluebubbles: { serverUrl: "http://localhost:1234", password: "super-secret" },
    })
    resetRuntimeCredentialConfigCache()
    const prompted = await runOuroCli(["vault", "config", "set", "--agent", "Slugger", "--key", "teams.clientId"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        expect(question).toBe("Value for teams.clientId: ")
        return "teams-client-id"
      },
    }))
    expect(prompted).toContain("stored teams.clientId")
    expect(prompted).not.toContain("teams-client-id")
  })

  it("vault config guards unsupported agents, invalid keys, and unreadable runtime config", async () => {
    emitTestEvent("provider cli vault config guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-config-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-config-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(
      ["vault", "config", "set", "--agent", "SerpentGuide", "--key", "bluebubbles.password", "--value", "x"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("SerpentGuide does not have persistent runtime credentials")
    const serpentStatus = await runOuroCli(
      ["vault", "config", "status", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(serpentStatus).toContain("SerpentGuide has no persistent runtime credentials")
    await expect(runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles", "--value", "x"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("runtime config key must be a dotted path")
    await expect(runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("vault config set requires --value")
    await expect(runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--key", "__proto__.polluted", "--value", "x"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("invalid runtime config key segment")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/config", JSON.stringify({ bad: true }))
    resetRuntimeCredentialConfigCache()
    await expect(runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--value", "x"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("cannot read existing runtime credentials")

    mockVaultDeps.rawSecrets.clear()
    const missing = await runOuroCli(["vault", "config", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(missing).toContain("status: missing")
    expect(missing).toContain("ouro vault config set --agent Slugger")
  })

  it("provider refresh reloads vault credentials and restarts running agents when possible", async () => {
    emitTestEvent("provider cli refresh")
    const bundlesRoot = makeTempDir("provider-cli-refresh-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const restarted = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async () => ({ ok: true, summary: "restarted" }),
    }))

    expect(restarted).toContain("refreshed provider credential snapshot for Slugger")
    expect(restarted).toContain("providers: minimax, anthropic")
    expect(restarted).toContain("restarted Slugger")

    writeProviderCredentialPool(homeDir, credentialPool({ providers: {} }))
    const none = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => false,
    }))
    expect(none).toContain("providers: none")

    writeUnavailableProviderCredentialPool("Slugger", "vault locked")
    const failed = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => false,
    }))
    expect(failed).toContain("provider credential refresh failed for Slugger: vault locked")
    expect(failed).toContain("daemon is not running")

    const skipped = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async () => ({ ok: false, error: "restart failed" }),
    }))
    expect(skipped).toContain("daemon restart skipped: restart failed")

    const skippedMessage = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async () => ({ ok: false, message: "restart declined" }),
    }))
    expect(skippedMessage).toContain("daemon restart skipped: restart declined")

    const skippedUnknown = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async () => ({ ok: false }),
    }))
    expect(skippedUnknown).toContain("daemon restart skipped: unknown daemon error")

    const threw = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => {
        throw new Error("socket broke")
      },
    }))
    expect(threw).toContain("daemon restart skipped: socket broke")

    const threwString = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => {
        throw "socket string broke"
      },
    }))
    expect(threwString).toContain("daemon restart skipped: socket string broke")

    const serpent = await runOuroCli(["provider", "refresh", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot))
    expect(serpent).toContain("SerpentGuide has no persistent provider credentials")
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
