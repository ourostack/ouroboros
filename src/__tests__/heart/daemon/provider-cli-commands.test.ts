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
  vaultUnlockReplaceRecoverFix: (agentName: string, nextStep = "Then run 'ouro up' again.") => [
    `Run 'ouro vault unlock --agent ${agentName}' if you have the saved vault unlock secret.`,
    `If this agent predates vault auth or nobody saved the unlock secret, run 'ouro vault replace --agent ${agentName}' to create a new empty vault, then re-auth/re-enter credentials.`,
    `If you do have a local JSON credential export, run 'ouro vault recover --agent ${agentName} --from <json>' to create a replacement vault and import it.`,
    nextStep,
  ].join(" "),
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

function writeAgentVaultLocator(
  bundlesRoot: string,
  agentName: string,
  vault: { email: string; serverUrl: string },
): void {
  const agentConfigPath = path.join(bundlesRoot, `${agentName}.ouro`, "agent.json")
  const agentConfig = JSON.parse(fs.readFileSync(agentConfigPath, "utf-8")) as Record<string, unknown>
  fs.writeFileSync(agentConfigPath, `${JSON.stringify({ ...agentConfig, vault }, null, 2)}\n`, "utf-8")
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

  it("parses ouro repair with optional agent", () => {
    emitTestEvent("provider cli parse repair")

    expect(parseOuroCommand(["repair"])).toEqual({ kind: "repair" })
    expect(parseOuroCommand(["repair", "--agent", "Slugger"])).toEqual({
      kind: "repair",
      agent: "Slugger",
    })
    expect(() => parseOuroCommand(["repair", "slugger"])).toThrow("Usage: ouro repair [--agent <name>]")
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
    expect(parseOuroCommand([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--email",
      "slugger+replacement@example.com",
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
      "--generate-unlock-secret",
    ])).toEqual({
      kind: "vault.replace",
      agent: "Slugger",
      email: "slugger+replacement@example.com",
      serverUrl: "https://vault.example.com",
      store: "plaintext-file",
      generateUnlockSecret: true,
    })
    expect(parseOuroCommand(["vault", "replace", "--agent", "Slugger"])).toEqual({
      kind: "vault.replace",
      agent: "Slugger",
    })
    expect(() => parseOuroCommand(["vault", "replace", "--agent", "Slugger", "--from", "/tmp/legacy-secrets.json"]))
      .toThrow("--from is only valid")
    expect(parseOuroCommand([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      "/tmp/legacy-secrets.json",
      "--from",
      "/tmp/provider-pool.json",
      "--email",
      "slugger+recovered@example.com",
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
      "--generate-unlock-secret",
    ])).toEqual({
      kind: "vault.recover",
      agent: "Slugger",
      sources: ["/tmp/legacy-secrets.json", "/tmp/provider-pool.json"],
      email: "slugger+recovered@example.com",
      serverUrl: "https://vault.example.com",
      store: "plaintext-file",
      generateUnlockSecret: true,
    })
    expect(() => parseOuroCommand(["vault", "recover", "--agent", "Slugger"]))
      .toThrow("ouro vault recover")
    expect(() => parseOuroCommand(["vault", "recover", "--agent", "Slugger", "--from"]))
      .toThrow("ouro vault recover")
    expect(parseOuroCommand(["vault", "recover", "--agent", "Slugger", "--from", "/tmp/legacy-secrets.json"])).toEqual({
      kind: "vault.recover",
      agent: "Slugger",
      sources: ["/tmp/legacy-secrets.json"],
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
      .toThrow("ouro vault create|replace|recover|unlock|status --agent <name>")
    expect(() => parseOuroCommand(["vault", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault create|replace|recover|unlock|status --agent <name>")
    expect(() => parseOuroCommand(["vault", "status"]))
      .toThrow("ouro vault create|replace|recover|unlock|status --agent <name>")
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
        credentialPath: "providers/minimax",
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
      promptSecret: async () => "unlock-material",
    }))

    expect(result).toContain("vault unlocked for Slugger")
    expect(result).toContain("explicit plaintext fallback")
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "slugger@ouro.bot", serverUrl: "https://vault.ouroboros.bot" },
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
      promptSecret: async () => "unlock-material",
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
      promptSecret: async () => "unlock-material",
    }))).rejects.toThrow("SerpentGuide does not have a persistent credential vault")
    await expect(runOuroCli(["vault", "unlock", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("vault unlock requires an interactive secret prompt")
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
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-create-secret",
    }))

    expect(created).toContain("vault created for Slugger")
    expect(created).not.toContain("vault unlock secret:")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "operator@example.com",
      "chosen-create-secret",
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
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-create-secret",
    }))

    expect(failed).toContain("vault create failed for Slugger: already exists")
    expect(failed).toContain("ouro vault unlock --agent Slugger")
  })

  it("vault create defaults to the stable agent email when no locator exists", async () => {
    emitTestEvent("provider cli vault create stable default")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-default-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-default-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli([
      "vault",
      "create",
      "--agent",
      "Slugger",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async (question) => {
        expect(question).toBe("Choose Ouro vault unlock secret for slugger@ouro.bot: ")
        return "chosen-vault-secret"
      },
    }))

    expect(result).toContain("vault created for Slugger")
    expect(result).toContain("vault: slugger@ouro.bot at https://vault.ouroboros.bot")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.ouroboros.bot",
      "slugger@ouro.bot",
      "chosen-vault-secret",
    )
  })

  it("ouro repair guides locked-vault repair with typed choices", async () => {
    emitTestEvent("provider cli repair locked vault")
    const bundlesRoot = makeTempDir("provider-cli-repair-vault-bundles")
    const homeDir = makeTempDir("provider-cli-repair-vault-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentVaultLocator(bundlesRoot, "Slugger", {
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.ouroboros.bot",
    })
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeUnavailableProviderCredentialPool("Slugger", "vault locked")

    const prompts: string[] = []
    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (prompt) => {
        prompts.push(prompt)
        return "1"
      },
      promptSecret: async (question) => {
        expect(question).toBe("Ouro vault unlock secret for slugger@ouro.bot: ")
        return "saved-unlock-secret"
      },
    }))

    expect(result).toContain("repair step finished for Slugger.")
    expect(result).toContain("Slugger: vault locked")
    expect(result).toContain("1. Unlock with saved secret")
    expect(result).toContain("   ouro vault unlock --agent Slugger")
    expect(prompts).toContain("Choose [1-4]: ")
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "slugger@ouro.bot", serverUrl: "https://vault.ouroboros.bot" },
      "saved-unlock-secret",
      { homeDir, store: undefined },
    )
  })

  it("ouro repair explains when no agents are available", async () => {
    emitTestEvent("provider cli repair no agents")
    const bundlesRoot = makeTempDir("provider-cli-repair-empty-bundles")
    const homeDir = makeTempDir("provider-cli-repair-empty-home")

    const result = await runOuroCli(["repair"], makeCliDeps(homeDir, bundlesRoot, {
      listDiscoveredAgents: () => [],
    }))

    expect(result).toBe("no agents found to repair.")
  })

  it("ouro repair reports ready agents without prompting", async () => {
    emitTestEvent("provider cli repair ready agent")
    const bundlesRoot = makeTempDir("provider-cli-repair-ready-bundles")
    const homeDir = makeTempDir("provider-cli-repair-ready-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: 1 })
    const promptInput = vi.fn(async () => "1")

    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput,
    }))

    expect(result).toContain("Slugger: ready")
    expect(promptInput).not.toHaveBeenCalled()
  })

  it("ouro repair renders readiness-check failures as generic repair guidance", async () => {
    emitTestEvent("provider cli repair readiness check failure")
    const bundlesRoot = makeTempDir("provider-cli-repair-missing-bundles")
    const homeDir = makeTempDir("provider-cli-repair-missing-home")

    const result = await runOuroCli(["repair", "--agent", "Missing"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("agent.json not found")
    expect(result).toContain("Run 'ouro hatch Missing' to create the agent bundle")
    expect(result).toContain("manual repair required for Missing")
  })

  it("ouro repair can replace a locked vault from the typed repair menu", async () => {
    emitTestEvent("provider cli repair vault replace")
    const bundlesRoot = makeTempDir("provider-cli-repair-replace-bundles")
    const homeDir = makeTempDir("provider-cli-repair-replace-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentVaultLocator(bundlesRoot, "Slugger", {
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.ouroboros.bot",
    })
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeUnavailableProviderCredentialPool("Slugger", "vault locked")

    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "2",
      promptSecret: async (question) => {
        expect(question).toBe("Choose new Ouro vault unlock secret for slugger@ouro.bot: ")
        return "chosen-replacement-material"
      },
    }))

    expect(result).toContain("vault replaced for Slugger")
    expect(result).toContain("repair step finished for Slugger.")
  })

  it("ouro repair can refresh provider credentials from the typed repair menu", async () => {
    emitTestEvent("provider cli repair provider auth")
    const bundlesRoot = makeTempDir("provider-cli-repair-auth-bundles")
    const homeDir = makeTempDir("provider-cli-repair-auth-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    mockProviderCredentials.refreshProviderCredentialPool
      .mockResolvedValueOnce({
        ok: false,
        reason: "missing",
        poolPath: "vault:Slugger:providers/*",
        error: "provider credentials have not been loaded from vault",
      })
      .mockResolvedValueOnce(okCredentialPool("Slugger", credentialPool()))
    mockProviderCredentials.pools.set(
      "Slugger",
      okCredentialPool("Slugger", credentialPool()),
    )
    const runAuthFlow = vi.fn(async () => ({ ok: true, message: "authenticated Slugger with anthropic" }))

    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "1",
      runAuthFlow,
    }))

    expect(runAuthFlow).toHaveBeenCalledWith({
      agentName: "Slugger",
      provider: "anthropic",
      promptInput: expect.any(Function),
      onProgress: expect.any(Function),
    })
    expect(result).toContain("authenticated Slugger with anthropic")
    expect(result).toContain("refreshed provider credential snapshot for Slugger")
    expect(result).toContain("repair step finished for Slugger.")
  })

  it("ouro repair uses the default auth flow when no test runner is injected", async () => {
    emitTestEvent("provider cli repair default provider auth")
    const bundlesRoot = makeTempDir("provider-cli-repair-default-auth-bundles")
    const homeDir = makeTempDir("provider-cli-repair-default-auth-home")
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
    }))
    writeMissingProviderCredentialPool("Slugger")
    const prompts: string[] = []

    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return question.startsWith("Choose ") ? "1" : "minimax-secret"
      },
    }))

    expect(prompts).toContain("Choose [1-3]: ")
    expect(prompts).toContain("MiniMax API key: ")
    expect(mockVaultDeps.rawSecrets.get("Slugger:providers/minimax")).toContain("minimax-secret")
    expect(result).toContain("checking Slugger's vault access...")
    expect(result).toContain("opening Slugger's vault session...")
    expect(result).toContain("storing minimax credentials in Slugger's vault...")
    expect(result).toContain("refreshing local provider snapshot from Slugger's vault...")
    expect(result).toContain("credentials stored at providers/minimax; local provider snapshot refreshed.")
    expect(result).toContain("authenticated Slugger with minimax")
    expect(result).toContain("repair step finished for Slugger.")
  })

  it("vault create can use an explicit email and prompted unlock material", async () => {
    emitTestEvent("provider cli vault create prompts")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-prompt-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-prompt-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const prompts: string[] = []
    mockVaultDeps.storeVaultUnlockSecret.mockReturnValueOnce({ kind: "macos-keychain", secure: true, location: "macOS Keychain" })

    const result = await runOuroCli(["vault", "create", "--agent", "Slugger", "--email", "operator@example.com"], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async (question) => {
        prompts.push(`secret:${question}`)
        return "chosen-unlock-material"
      },
    }))

    expect(result).toContain("vault created for Slugger")
    expect(result).not.toContain("vault unlock secret:")
    expect(result).toContain("local unlock store: macos-keychain")
    expect(result).not.toContain("explicit plaintext fallback")
    expect(prompts).toEqual([
      "secret:Choose Ouro vault unlock secret for operator@example.com: ",
    ])
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.ouroboros.bot",
      "operator@example.com",
      "chosen-unlock-material",
    )
  })

  it("vault replace creates an empty vault at the stable agent email by default", async () => {
    emitTestEvent("provider cli vault replace")
    const bundlesRoot = makeTempDir("provider-cli-vault-replace-bundles")
    const homeDir = makeTempDir("provider-cli-vault-replace-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        expect(question).toBe("Choose new Ouro vault unlock secret for slugger@ouro.bot: ")
        return "chosen-replacement-secret"
      },
    }))

    expect(result).toContain("vault replaced for Slugger")
    expect(result).toContain("vault: slugger@ouro.bot at https://vault.example.com")
    expect(result).toContain("imported: none")
    expect(result).toContain("next: ouro repair --agent Slugger")
    expect(result).toContain("Keep the vault unlock secret saved outside Ouro")
    expect(result).not.toContain("chosen-replacement-secret")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "slugger@ouro.bot",
      "chosen-replacement-secret",
    )
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "slugger@ouro.bot", serverUrl: "https://vault.example.com" },
      "chosen-replacement-secret",
      { homeDir, store: "plaintext-file" },
    )
    expect(readAgentConfig(bundlesRoot, "Slugger").vault).toEqual({
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.example.com",
    })
    expect(mockVaultDeps.rawSecrets.size).toBe(0)
  })

  it("vault replace repairs prior generated replacement emails instead of compounding them", async () => {
    emitTestEvent("provider cli vault replace stable default")
    const bundlesRoot = makeTempDir("provider-cli-vault-replace-stable-bundles")
    const homeDir = makeTempDir("provider-cli-vault-replace-stable-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentVaultLocator(bundlesRoot, "Slugger", {
      email: "slugger+replaced-20260412201000+replaced-20260415233600@ouro.bot",
      serverUrl: "https://vault.example.com",
    })

    const result = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        expect(question).toBe("Choose new Ouro vault unlock secret for slugger@ouro.bot: ")
        return "chosen-replacement-secret"
      },
    }))

    expect(result).toContain("vault: slugger@ouro.bot at https://vault.example.com")
    expect(result).not.toContain("+replaced-20260412201000")
    expect(result).not.toContain("+replaced-20260415233600")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "slugger@ouro.bot",
      "chosen-replacement-secret",
    )
  })

  it("vault replace covers prompted secrets, failures, and guards", async () => {
    emitTestEvent("provider cli vault replace guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-replace-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-replace-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    mockVaultDeps.storeVaultUnlockSecret.mockReturnValueOnce({
      kind: "macos-keychain",
      secure: true,
      location: "macOS Keychain",
    })

    const prompted = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--email",
      "slugger+manual@example.com",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async (question) => {
        expect(question).toBe("Choose new Ouro vault unlock secret for slugger+manual@example.com: ")
        return "chosen-replacement-secret"
      },
    }))
    expect(prompted).toContain("vault replaced for Slugger")
    expect(prompted).toContain("local unlock store: macos-keychain")
    expect(prompted).not.toContain("explicit plaintext fallback")
    expect(prompted).not.toContain("chosen-replacement-secret")

    await expect(runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
    ], makeCliDeps(homeDir, bundlesRoot))).rejects.toThrow("vault replace requires an interactive secret prompt")
    await expect(runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "   ",
    }))).rejects.toThrow("vault replace requires an unlock secret")
    await expect(runOuroCli(["vault", "replace", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-replacement-secret",
    }))).rejects.toThrow("Replace the hatchling agent vault")
    await expect(runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--generate-unlock-secret",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-replacement-secret",
    }))).rejects.toThrow("vault replace no longer supports --generate-unlock-secret")

    mockVaultDeps.createVaultAccount.mockResolvedValueOnce({ success: false, error: "already exists" })
    const failed = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--email",
      "slugger+manual@example.com",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-replacement-secret",
    }))
    expect(failed).toContain("vault replace failed for Slugger: already exists")
    expect(failed).toContain("If this is the existing vault, run:")
    expect(failed).toContain("ouro vault unlock --agent Slugger")
    expect(failed).toContain("If the unlock secret is lost and you intentionally need a different vault account, rerun with --email <email>.")
  })

  it("vault recover creates a replacement vault and imports local JSON credential exports without printing values", async () => {
    emitTestEvent("provider cli vault recover")
    const bundlesRoot = makeTempDir("provider-cli-vault-recover-bundles")
    const homeDir = makeTempDir("provider-cli-vault-recover-home")
    const sourceDir = makeTempDir("provider-cli-vault-recover-source")
    writeAgentConfig(bundlesRoot, "Slugger")
    const legacySecretsPath = path.join(sourceDir, "legacy-secrets.json")
    const providerPoolPath = path.join(sourceDir, "provider-pool.json")
    fs.writeFileSync(legacySecretsPath, JSON.stringify({
      providers: {
        minimax: { apiKey: "mini-secret", model: "MiniMax-M2.5" },
        "github-copilot": { githubToken: "gh-secret", baseUrl: "https://api.githubcopilot.com" },
	      },
	      bluebubbles: { serverUrl: "http://bluebubbles.local", password: "bb-secret" },
	      operatorNote: "scalar-secret",
	      vault: { masterPassword: "" },
	    }), "utf-8")
    fs.writeFileSync(providerPoolPath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: NOW,
      providers: {
	        anthropic: {
	          provider: "anthropic",
	          credentials: { setupToken: "anthropic-secret", expiresAt: 1_777_777_777, ignoredFlag: true },
	          config: null,
	        },
      },
      bluebubbles: { accountId: "default" },
    }), "utf-8")

    const result = await runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      legacySecretsPath,
      "--from",
      providerPoolPath,
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async () => "chosen-recovery-secret",
    }))

    expect(result).toContain("vault recovered for Slugger")
    expect(result).toContain("vault: slugger@ouro.bot at https://vault.example.com")
    expect(result).toContain("provider credentials imported: anthropic, github-copilot, minimax")
	    expect(result).toContain("runtime credentials imported: bluebubbles.accountId, bluebubbles.password, bluebubbles.serverUrl, operatorNote")
    expect(result).toContain("credential values were not printed")
    expect(result).not.toContain("mini-secret")
    expect(result).not.toContain("gh-secret")
	    expect(result).not.toContain("anthropic-secret")
	    expect(result).not.toContain("bb-secret")
	    expect(result).not.toContain("scalar-secret")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "slugger@ouro.bot",
      "chosen-recovery-secret",
    )
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "slugger@ouro.bot", serverUrl: "https://vault.example.com" },
      "chosen-recovery-secret",
      { homeDir, store: "plaintext-file" },
    )
    expect(readAgentConfig(bundlesRoot, "Slugger").vault).toEqual({
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.example.com",
    })
    const minimaxRaw = mockVaultDeps.rawSecrets.get("Slugger:providers/minimax")
    expect(minimaxRaw).toBeDefined()
    expect(JSON.parse(minimaxRaw ?? "{}")).toMatchObject({
      kind: "provider-credential",
      provider: "minimax",
      credentials: { apiKey: "mini-secret" },
      config: {},
    })
	    const githubRaw = mockVaultDeps.rawSecrets.get("Slugger:providers/github-copilot")
	    expect(JSON.parse(githubRaw ?? "{}")).toMatchObject({
	      provider: "github-copilot",
	      credentials: { githubToken: "gh-secret" },
	      config: { baseUrl: "https://api.githubcopilot.com" },
	    })
	    const anthropicRaw = mockVaultDeps.rawSecrets.get("Slugger:providers/anthropic")
	    expect(JSON.parse(anthropicRaw ?? "{}")).toMatchObject({
	      provider: "anthropic",
	      credentials: { setupToken: "anthropic-secret", expiresAt: 1_777_777_777 },
	    })
	    const runtimeRaw = mockVaultDeps.rawSecrets.get("Slugger:runtime/config")
    expect(runtimeRaw).toBeDefined()
    const runtime = JSON.parse(runtimeRaw ?? "{}") as { config: Record<string, unknown> }
	    expect(runtime.config).toEqual({
	      bluebubbles: { serverUrl: "http://bluebubbles.local", password: "bb-secret", accountId: "default" },
	      operatorNote: "scalar-secret",
	    })
    expect(runtime.config).not.toHaveProperty("providers")
    expect(runtime.config).not.toHaveProperty("vault")
  })

	  it("vault recover covers empty imports, prompted secrets, failures, and guards", async () => {
	    emitTestEvent("provider cli vault recover guards")
	    const bundlesRoot = makeTempDir("provider-cli-vault-recover-guards-bundles")
	    const homeDir = makeTempDir("provider-cli-vault-recover-guards-home")
	    const sourceDir = makeTempDir("provider-cli-vault-recover-guards-source")
    writeAgentConfig(bundlesRoot, "Slugger")
    const emptySource = path.join(sourceDir, "empty.json")
	    fs.writeFileSync(emptySource, JSON.stringify({
	      providers: {
	        minimax: { credentials: null, config: null },
	        anthropic: null,
	        "not-a-provider": { apiKey: "ignored-secret" },
	      },
	    }), "utf-8")

    const prompted = await runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      emptySource,
      "--email",
      "slugger+manual@example.com",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async (question) => {
        expect(question).toBe("Choose new Ouro vault unlock secret for slugger+manual@example.com: ")
        return "chosen-recovery-secret"
      },
    }))
    expect(prompted).toContain("provider credentials imported: none")
    expect(prompted).toContain("runtime credentials imported: none")
    expect(prompted).toContain("Keep the vault unlock secret saved outside Ouro")
    expect(prompted).not.toContain("chosen-recovery-secret")
    expect(prompted).not.toContain("ignored-secret")

    await expect(runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      emptySource,
    ], makeCliDeps(homeDir, bundlesRoot))).rejects.toThrow("vault recover requires an interactive secret prompt")
    await expect(runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      emptySource,
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "   ",
    }))).rejects.toThrow("vault recover requires an unlock secret")

    await expect(runOuroCli([
      "vault",
      "recover",
      "--agent",
      "SerpentGuide",
      "--from",
      emptySource,
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-recovery-secret",
    }))).rejects.toThrow("Recover the hatchling agent vault")

    mockVaultDeps.createVaultAccount.mockResolvedValueOnce({ success: false, error: "already exists" })
    const failed = await runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      emptySource,
      "--email",
      "slugger+manual@example.com",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "chosen-recovery-secret",
    }))
    expect(failed).toContain("vault recover failed for Slugger: already exists")
    expect(failed).toContain("If this is the existing vault, run:")
    expect(failed).toContain("ouro vault unlock --agent Slugger")
    expect(failed).toContain("If the unlock secret is lost and you intentionally need a different vault account, rerun with --email <email>.")

    const nonObjectSource = path.join(sourceDir, "non-object.json")
    fs.writeFileSync(nonObjectSource, "[]", "utf-8")
    const nonObjectPromptSecret = vi.fn(async () => "unused-recovery-secret")
    await expect(runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      nonObjectSource,
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: nonObjectPromptSecret,
    }))).rejects.toThrow("must be a JSON object")
    expect(nonObjectPromptSecret).not.toHaveBeenCalled()

    const missingPromptSecret = vi.fn(async () => "unused-recovery-secret")
    await expect(runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      path.join(sourceDir, "missing.json"),
	    ], makeCliDeps(homeDir, bundlesRoot, {
	      promptSecret: missingPromptSecret,
	    }))).rejects.toThrow("cannot read vault recover source")
    expect(missingPromptSecret).not.toHaveBeenCalled()
	  })

	  it("vault recover explains sanitized defaults and secure local stores", async () => {
	    emitTestEvent("provider cli vault recover edge cases")
	    const bundlesRoot = makeTempDir("provider-cli-vault-recover-edge-bundles")
	    const homeDir = makeTempDir("provider-cli-vault-recover-edge-home")
	    const sourceDir = makeTempDir("provider-cli-vault-recover-edge-source")
	    writeAgentConfig(bundlesRoot, "!!!")
	    const emptySource = path.join(sourceDir, "empty.json")
	    fs.writeFileSync(emptySource, JSON.stringify({ providers: {} }), "utf-8")
	    mockVaultDeps.storeVaultUnlockSecret.mockReturnValueOnce({
	      kind: "macos-keychain",
	      secure: true,
	      location: "macOS Keychain",
	    })

	    const recovered = await runOuroCli([
	      "vault",
	      "recover",
	      "--agent",
	      "!!!",
	      "--from",
	      emptySource,
	    ], makeCliDeps(homeDir, bundlesRoot, {
	      now: () => Date.parse(NOW),
	      promptSecret: async () => "chosen-recovery-secret",
	    }))

	    expect(recovered).toContain("vault: agent@ouro.bot at https://vault.ouroboros.bot")
	    expect(recovered).toContain("local unlock store: macos-keychain")
	    expect(recovered).not.toContain("explicit plaintext fallback")

	    writeAgentConfig(bundlesRoot, "TopLevel")
	    const topLevelProviderSource = path.join(sourceDir, "top-level-provider.json")
	    fs.writeFileSync(topLevelProviderSource, JSON.stringify({
	      minimax: { apiKey: "top-level-mini-secret" },
	    }), "utf-8")

	    const topLevelRecovered = await runOuroCli([
	      "vault",
	      "recover",
	      "--agent",
	      "TopLevel",
	      "--from",
	      topLevelProviderSource,
	    ], makeCliDeps(homeDir, bundlesRoot, {
	      now: () => Date.parse(NOW),
	      promptSecret: async () => "chosen-recovery-secret",
	    }))

	    expect(topLevelRecovered).toContain("provider credentials imported: minimax")
	    expect(topLevelRecovered).toContain("runtime credentials imported: none")
	    expect(topLevelRecovered).not.toContain("top-level-mini-secret")
	  })

	  it("vault create rejects unsupported persistent SerpentGuide vaults and missing inputs", async () => {
    emitTestEvent("provider cli vault create guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["vault", "create", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "operator@example.com",
      promptSecret: async () => "chosen-create-secret",
    }))).rejects.toThrow("Create a vault for the hatchling agent")
    await expect(runOuroCli(["vault", "create", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("vault create requires an interactive secret prompt")
    await expect(runOuroCli(["vault", "create", "--agent", "Slugger", "--email", "operator@example.com"], makeCliDeps(homeDir, bundlesRoot)))
      .rejects.toThrow("vault create requires an interactive secret prompt")
    await expect(runOuroCli(["vault", "create", "--agent", "Slugger", "--email", "operator@example.com"], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "   ",
    }))).rejects.toThrow("vault create requires an unlock secret")
    await expect(runOuroCli([
      "vault",
      "create",
      "--agent",
      "Slugger",
      "--email",
      "operator@example.com",
      "--generate-unlock-secret",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "unused",
    }))).rejects.toThrow("no longer supports --generate-unlock-secret")
    await expect(runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      path.join(homeDir, "missing.json"),
      "--generate-unlock-secret",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "unused",
    }))).rejects.toThrow("no longer supports --generate-unlock-secret")
  })

  it("vault status reports local unlock state and vault provider summaries", async () => {
    emitTestEvent("provider cli vault status")
    const bundlesRoot = makeTempDir("provider-cli-vault-status-bundles")
    const homeDir = makeTempDir("provider-cli-vault-status-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentVaultLocator(bundlesRoot, "Slugger", {
      email: "slugger@example.com",
      serverUrl: "https://vault.example.com",
    })
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

  it("vault status gives a create path when an existing agent has no vault locator", async () => {
    emitTestEvent("provider cli vault status no locator")
    const bundlesRoot = makeTempDir("provider-cli-vault-status-no-locator-bundles")
    const homeDir = makeTempDir("provider-cli-vault-status-no-locator-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli(["vault", "status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("vault locator: not configured in agent.json")
    expect(result).toContain("local unlock: not checked")
    expect(result).toContain("ouro vault create --agent Slugger")
    expect(result).toContain("ouro auth --agent Slugger --provider <provider>")
    expect(mockVaultDeps.getVaultUnlockStatus).not.toHaveBeenCalled()
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
    expect(failed).toContain("ouro vault unlock --agent Slugger")
    expect(failed).toContain("ouro vault replace --agent Slugger")
    expect(failed).toContain("Then retry 'ouro provider refresh'.")
    expect(failed).not.toContain("daemon is not running")
    expect(failed).not.toContain("restarted Slugger")

    writeProviderCredentialPool(homeDir, credentialPool())
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
