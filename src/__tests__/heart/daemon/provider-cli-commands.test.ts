import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn(),
  pingGithubCopilotModel: vi.fn(async () => ({ ok: true })),
}))

const mockProviderCredentials = vi.hoisted(() => ({
  pools: new Map<string, any>(),
  refreshProviderCredentialPool: vi.fn(async (agentName: string, options?: { onProgress?: (message: string) => void }) => {
    options?.onProgress?.(`reading vault items for ${agentName}...`)
    options?.onProgress?.("parsing provider credentials...")
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

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}))

vi.stubGlobal("fetch", fetchMock)

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

vi.mock("../../../repertoire/vault-unlock", async () => {
  const actual = await vi.importActual<typeof import("../../../repertoire/vault-unlock")>("../../../repertoire/vault-unlock")
  return {
    promptConfirmedVaultUnlockSecret: actual.promptConfirmedVaultUnlockSecret,
    credentialVaultNotConfiguredError: (agentName: string, configPath: string) =>
      `credential vault is not configured in ${configPath}. Run 'ouro vault create --agent ${agentName}' to create this agent's vault before loading or storing credentials.`,
    storeVaultUnlockSecret: (...args: unknown[]) => mockVaultDeps.storeVaultUnlockSecret(...args),
    getVaultUnlockStatus: (...args: unknown[]) => mockVaultDeps.getVaultUnlockStatus(...args),
    isCredentialVaultNotConfiguredError: (message: string) =>
      message.includes("credential vault is not configured in "),
    vaultCreateRecoverFix: (agentName: string) =>
      `Run 'ouro vault create --agent ${agentName}' to set up this agent's vault.`,
    vaultUnlockReplaceRecoverFix: (agentName: string) =>
      `Run 'ouro vault unlock --agent ${agentName}' or 'ouro vault replace --agent ${agentName}' if the secret is lost.`,
  }
})

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
import * as agentConfigCheck from "../../../heart/daemon/agent-config-check"
import { pingGithubCopilotModel, pingProvider } from "../../../heart/provider-ping"
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
const mockPingGithubCopilotModel = vi.mocked(pingGithubCopilotModel)
const cleanup: string[] = []

mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: [1] })

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

function writeMachineIdentity(homeDir: string, machineId = "machine_unit"): void {
  const dir = path.join(homeDir, ".ouro-cli")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "machine.json"), `${JSON.stringify({
    schemaVersion: 1,
    machineId,
    createdAt: NOW,
    updatedAt: NOW,
    hostnameAliases: ["unit-host"],
  }, null, 2)}\n`, "utf-8")
}

function readRuntimeSecret(agentName: string, itemName = "runtime/config"): { config: Record<string, unknown> } {
  return JSON.parse(mockVaultDeps.rawSecrets.get(`${agentName}:${itemName}`) ?? "{}") as { config: Record<string, unknown> }
}

function readProviderCredentialPool(_homeDir: string, agentName = "Slugger"): ProviderCredentialPoolReadResult {
  return mockProviderCredentials.pools.get(agentName) ?? unavailableCredentialPool(agentName, "provider credentials have not been loaded from vault")
}

function mockJsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  } as Response
}

function installDefaultCapabilityFetchMock(): void {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    if (url.includes("api.perplexity.ai")) {
      return mockJsonResponse({
        results: [{ title: "ping", url: "https://example.com/ping", snippet: "pong" }],
      })
    }
    if (url.includes("api.openai.com/v1/embeddings")) {
      return mockJsonResponse({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
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

function joinedPrompt(prompts: string[]): string {
  return prompts.join("\n")
}

function expectConnectStatus(prompt: string, option: number, name: string, status: string): void {
  expect(prompt).toContain(`${option}. ${name} [${status}]`)
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

function updateAgentConfig(bundlesRoot: string, agentName: string, update: (config: Record<string, unknown>) => void): void {
  const configPath = path.join(agentRoot(bundlesRoot, agentName), "agent.json")
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
  update(config)
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

function initBundleGit(bundleRoot: string): void {
  execFileSync("git", ["init"], { cwd: bundleRoot, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: bundleRoot, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Ouro Test"], { cwd: bundleRoot, stdio: "pipe" })
  execFileSync("git", ["add", "agent.json"], { cwd: bundleRoot, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "initial bundle"], { cwd: bundleRoot, stdio: "pipe" })
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

function daemonStatusData(
  agentName: string,
  status: "running" | "starting" | "stopped" | "crashed" = "running",
  overrides: Partial<{
    worker: string
    pid: number | null
    startedAt: string | null
    errorReason: string | null
    fixHint: string | null
  }> = {},
): Record<string, unknown> {
  return {
    overview: {
      daemon: "running",
      health: status === "running" ? "ok" : "warn",
      socketPath: "/tmp/test-socket",
      outlookUrl: "http://127.0.0.1:6876",
      version: "0.1.0-alpha.test",
      lastUpdated: NOW,
      repoRoot: "/tmp/test-repo",
      configFingerprint: "cfg_test",
      workerCount: 1,
      senseCount: 0,
      entryPath: "/tmp/daemon-entry.js",
      mode: "production",
    },
    workers: [{
      agent: agentName,
      worker: overrides.worker ?? "inner-dialog",
      status,
      pid: overrides.pid ?? 4242,
      restartCount: 0,
      startedAt: overrides.startedAt ?? NOW,
      lastExitCode: null,
      lastSignal: null,
      errorReason: overrides.errorReason ?? null,
      fixHint: overrides.fixHint ?? null,
    }],
    senses: [],
    sync: [],
    agents: [{ name: agentName, enabled: true }],
    providers: [],
  }
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

beforeEach(() => {
  installDefaultCapabilityFetchMock()
})

afterEach(() => {
  installDefaultCapabilityFetchMock()
  mockPingProvider.mockReset()
  mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: [1] })
  mockPingGithubCopilotModel.mockReset()
  mockPingGithubCopilotModel.mockResolvedValue({ ok: true })
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
      "--lane",
      "inner",
      "--provider",
      "minimax",
      "--model",
      "MiniMax-M2.5",
    ])).toEqual({
      kind: "provider.use",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
    })

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
    expect(parseOuroCommand(["check", "--lane", "inner"])).toEqual({
      kind: "provider.check",
      lane: "inner",
    })
  })

  it("parses provider refresh and vault lifecycle commands", () => {
    emitTestEvent("provider cli parse refresh vault")

    expect(parseOuroCommand(["provider", "refresh", "--agent", "Slugger"])).toEqual({
      kind: "provider.refresh",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["provider", "refresh"])).toEqual({
      kind: "provider.refresh",
    })
    expect(() => parseOuroCommand(["provider", "refresh", "--agent", "Slugger", "--extra"]))
      .toThrow("ouro provider refresh [--agent <name>]")

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
      "create",
      "--email",
      "operator@example.com",
    ])).toEqual({
      kind: "vault.create",
      email: "operator@example.com",
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
    expect(parseOuroCommand(["vault", "replace"])).toEqual({
      kind: "vault.replace",
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
    expect(parseOuroCommand(["vault", "recover", "--from", "/tmp/legacy-secrets.json"])).toEqual({
      kind: "vault.recover",
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
    expect(parseOuroCommand(["vault", "unlock", "--store", "auto"])).toEqual({
      kind: "vault.unlock",
      store: "auto",
    })
    expect(parseOuroCommand(["vault", "status", "--agent", "Slugger"])).toEqual({
      kind: "vault.status",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["vault", "status"])).toEqual({
      kind: "vault.status",
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
    expect(parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--scope", "machine"])).toEqual({
      kind: "vault.config.set",
      agent: "Slugger",
      key: "bluebubbles.password",
      scope: "machine",
    })
    expect(parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--value", "secret"])).toEqual({
      kind: "vault.config.set",
      agent: "Slugger",
      key: "bluebubbles.password",
      value: "secret",
    })
    expect(parseOuroCommand(["vault", "config", "set", "--key", "bluebubbles.password", "--value", "secret"])).toEqual({
      kind: "vault.config.set",
      key: "bluebubbles.password",
      value: "secret",
    })
    expect(parseOuroCommand(["vault", "config", "status", "--agent", "Slugger"])).toEqual({
      kind: "vault.config.status",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["vault", "config", "status"])).toEqual({
      kind: "vault.config.status",
    })
    expect(parseOuroCommand(["vault", "config", "status", "--agent", "Slugger", "--scope", "all"])).toEqual({
      kind: "vault.config.status",
      agent: "Slugger",
      scope: "all",
    })
    expect(() => parseOuroCommand(["vault", "config", "status", "--agent", "Slugger", "--key", "bluebubbles.password"]))
      .toThrow("ouro vault config status")
    expect(() => parseOuroCommand(["vault", "config", "set", "--agent", "Slugger"]))
      .toThrow("ouro vault config set")
    expect(() => parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--bad"]))
      .toThrow("ouro vault config set")
    expect(() => parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--scope", "planet"]))
      .toThrow("vault config --scope")
    expect(() => parseOuroCommand(["vault", "config", "set", "--agent", "Slugger", "--key", "bluebubbles.password", "--scope", "all"]))
      .toThrow("scope all is only valid for status")
    expect(() => parseOuroCommand(["vault", "config", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault config set")
    expect(() => parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "bad"]))
      .toThrow("vault --store")
    expect(() => parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--bad"]))
      .toThrow("ouro vault create|replace|recover|unlock|status [--agent <name>]")
    expect(() => parseOuroCommand(["vault", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault create|replace|recover|unlock|status [--agent <name>]")
  })

  it("parses connect commands for guided integration onboarding", () => {
    emitTestEvent("provider cli parse connect")

    expect(parseOuroCommand(["connect"])).toEqual({
      kind: "connect",
    })
    expect(parseOuroCommand(["connect", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["connect", "perplexity"])).toEqual({
      kind: "connect",
      target: "perplexity",
    })
    expect(parseOuroCommand(["connect", "perplexity", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "perplexity",
    })
    expect(parseOuroCommand(["connect", "--agent", "Slugger", "perplexity-search"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "perplexity",
    })
    expect(parseOuroCommand(["connect", "providers", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "providers",
    })
    expect(parseOuroCommand(["connect", "embeddings", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "embeddings",
    })
    expect(parseOuroCommand(["connect", "teams", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "teams",
    })
    expect(parseOuroCommand(["connect", "bluebubbles", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "bluebubbles",
    })
    expect(() => parseOuroCommand(["connect", "perplexity", "bluebubbles", "--agent", "Slugger"])).toThrow("providers|perplexity|embeddings|teams|bluebubbles")
    expect(() => parseOuroCommand(["connect", "unknown", "--agent", "Slugger"])).toThrow("providers|perplexity|embeddings|teams|bluebubbles")
  })

  it("rejects malformed provider command shapes with direct usage", () => {
    emitTestEvent("provider cli parse malformed")

    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "sideways", "--provider", "minimax", "--model", "m"]))
      .toThrow("lane")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "not-real", "--model", "m"]))
      .toThrow("ouro use [--agent <name>]")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "minimax"]))
      .toThrow("ouro use [--agent <name>]")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--provider", "minimax", "--model", "m"]))
      .toThrow("ouro use [--agent <name>]")
    expect(() => parseOuroCommand(["use", "--agent", "Slugger", "--lane", "inner", "--provider", "minimax", "--model", "m", "--surprise"]))
      .toThrow("ouro use [--agent <name>]")
    expect(() => parseOuroCommand(["check", "--agent", "Slugger"]))
      .toThrow("ouro check [--agent <name>]")
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

    const deps = makeCliDeps(homeDir, bundlesRoot)
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
    ], deps)

    expect(result).toContain("Slugger inner")
    expect(result).toContain("minimax")
    expect(result).toContain("MiniMax-M2.5")
    expect(result).toContain("ready")
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("\n")
    expect(output).toContain("... reading minimax credentials")
    expect(output).toContain("reading vault items for Slugger...")
    expect(output).toContain("✓ reading minimax credentials")
    expect(output).toContain("... checking minimax / MiniMax-M2.5")
    expect(output).toContain("✓ checking minimax / MiniMax-M2.5")
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

  it("ouro use keeps progress visible when the credential read throws", async () => {
    emitTestEvent("provider cli use credential read throws")
    const bundlesRoot = makeTempDir("provider-cli-use-read-throws-bundles")
    const homeDir = makeTempDir("provider-cli-use-read-throws-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    mockProviderCredentials.refreshProviderCredentialPool.mockRejectedValueOnce(new Error("vault exploded"))
    const deps = makeCliDeps(homeDir, bundlesRoot)

    await expect(runOuroCli([
      "use",
      "--agent",
      "Slugger",
      "--lane",
      "inner",
      "--provider",
      "minimax",
      "--model",
      "MiniMax-M2.5",
    ], deps)).rejects.toThrow("vault exploded")

    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("\n")
    expect(output).toContain("... reading minimax credentials")
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

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      runAuthFlow: async (input) => {
        input.onProgress?.("starting minimax credential entry...")
        input.onProgress?.("storing minimax credentials in Slugger's vault...")
        return {
          agentName: "Slugger",
          provider: "minimax",
          message: "authenticated Slugger with minimax",
          credentialPath: "providers/minimax",
          credentials: { apiKey: "new-minimax-secret" },
        }
      },
    })
    const result = await runOuroCli([
      "auth",
      "--agent",
      "Slugger",
      "--provider",
      "minimax",
    ], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("authenticated Slugger with minimax")
    expect(output).toContain("... authenticating minimax")
    expect(output).toContain("starting minimax credential entry")
    expect(output).toContain("storing minimax credentials")
    expect(output).toContain("✓ authenticating minimax")
    expect(output).toContain("... verifying minimax")
    expect(output).toContain("✓ verifying minimax")
    expect(output).not.toContain("new-minimax-secret")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.lanes.inner.provider).toBe("anthropic")
    expect(stateResult.state.lanes.outward.provider).toBe("anthropic")
  })

  it("ouro auth lands on a shared completion board in TTY mode", async () => {
    emitTestEvent("provider cli auth tty board")
    const bundlesRoot = makeTempDir("provider-cli-auth-tty-bundles")
    const homeDir = makeTempDir("provider-cli-auth-tty-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool())

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      isTTY: true,
      stdoutColumns: 78,
      runAuthFlow: async (input) => {
        input.onProgress?.("starting minimax credential entry...")
        input.onProgress?.("storing minimax credentials in Slugger's vault...")
        return {
          agentName: "Slugger",
          provider: "minimax",
          message: "authenticated Slugger with minimax",
          credentialPath: "providers/minimax",
          credentials: { apiKey: "new-minimax-secret" },
        }
      },
    })

    const result = await runOuroCli([
      "auth",
      "--agent",
      "Slugger",
      "--provider",
      "minimax",
    ], deps)

    expect(result).toContain("Provider auth")
    expect(result).toContain("Slugger can now use minimax when this lane is selected.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
    expect(result).toContain("secret was not printed")
  })

  it("vault unlock stores local unlock material and probes the agent vault", async () => {
    emitTestEvent("provider cli vault unlock")
    const bundlesRoot = makeTempDir("provider-cli-vault-unlock-bundles")
    const homeDir = makeTempDir("provider-cli-vault-unlock-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "unlock-material",
    })
    const result = await runOuroCli([
      "vault",
      "unlock",
      "--agent",
      "Slugger",
      "--store",
      "plaintext-file",
    ], deps)
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("")

    expect(result).toContain("vault unlocked for Slugger")
    expect(result).toContain("explicit plaintext fallback")
    expect(output).toContain("... saving local unlock")
    expect(output).toContain("✓ saving local unlock")
    expect(output).toContain("... checking vault access")
    expect(output).toContain("✓ checking vault access")
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

    const createDeps = makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "Chosen-create-secret1!",
    })
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
    ], createDeps)
    const createOutput = (createDeps as OuroCliDeps & { _output: string[] })._output.join("")

    expect(created).toContain("vault created for Slugger")
    expect(created).not.toContain("vault unlock secret:")
    expect(createOutput).toContain("... creating vault account")
    expect(createOutput).toContain("✓ creating vault account")
    expect(createOutput).toContain("... saving local unlock")
    expect(createOutput).toContain("✓ saving local unlock")
    expect(createOutput).toContain("... checking vault access")
    expect(createOutput).toContain("✓ checking vault access")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "operator@example.com",
      "Chosen-create-secret1!",
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
      promptSecret: async () => "Chosen-create-secret1!",
    }))

    expect(failed).toContain("vault create failed for Slugger: already exists")
    expect(failed).toContain("ouro vault unlock --agent Slugger")

    mockVaultDeps.createVaultAccount.mockRejectedValueOnce(new Error("network down"))
    const rejectedDeps = makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "Chosen-create-secret1!",
    })
    await expect(runOuroCli([
      "vault",
      "create",
      "--agent",
      "Slugger",
      "--email",
      "operator@example.com",
      "--server",
      "https://vault.example.com",
    ], rejectedDeps)).rejects.toThrow("network down")
    const rejectedOutput = (rejectedDeps as OuroCliDeps & { _output: string[] })._output.join("")
    expect(rejectedOutput).toContain("... creating vault account")
    expect(rejectedOutput).toContain("✗ creating vault account")
    expect(rejectedOutput).toContain("failed")
  })

  it("vault create defaults to the stable agent email when no locator exists", async () => {
    emitTestEvent("provider cli vault create stable default")
	    const bundlesRoot = makeTempDir("provider-cli-vault-create-default-bundles")
	    const homeDir = makeTempDir("provider-cli-vault-create-default-home")
	    writeAgentConfig(bundlesRoot, "Slugger")
	    const promptQuestions: string[] = []

	    const result = await runOuroCli([
	      "vault",
	      "create",
	      "--agent",
	      "Slugger",
	    ], makeCliDeps(homeDir, bundlesRoot, {
	      promptSecret: async (question) => {
	        promptQuestions.push(question)
	        return "Chosen-vault-secret1!"
	      },
	    }))

	    expect(result).toContain("vault created for Slugger")
	    expect(result).toContain("vault: slugger@ouro.bot at https://vault.ouroboros.bot")
	    expect(promptQuestions).toEqual([
	      "Choose Ouro vault unlock secret for slugger@ouro.bot: ",
	      "Confirm Ouro vault unlock secret for slugger@ouro.bot: ",
	    ])
	    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.ouroboros.bot",
      "slugger@ouro.bot",
      "Chosen-vault-secret1!",
    )
  })

  it("runs bundle sync after vault create mutates a sync-enabled bundle", async () => {
    emitTestEvent("provider cli vault create bundle sync")
    const bundlesRoot = makeTempDir("provider-cli-vault-create-sync-bundles")
    const homeDir = makeTempDir("provider-cli-vault-create-sync-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.sync = { enabled: true }
    })
    const root = agentRoot(bundlesRoot, "Slugger")
    initBundleGit(root)

    const result = await runOuroCli([
      "vault",
      "create",
      "--agent",
      "Slugger",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "Chosen-vault-secret1!",
    }))

    expect(result).toContain("vault created for Slugger")
    expect(result).toContain("bundle sync: ran post-change sync (remote: origin)")
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, stdio: "pipe" }).toString().trim()).toBe("")
    expect(execFileSync("git", ["log", "--oneline", "-1"], { cwd: root, stdio: "pipe" }).toString()).toContain("sync: post-turn update")
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

  it("ouro repair renders a shared readiness board in TTY mode before prompting", async () => {
    emitTestEvent("provider cli repair shared board")
    const bundlesRoot = makeTempDir("provider-cli-repair-board-bundles")
    const homeDir = makeTempDir("provider-cli-repair-board-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentVaultLocator(bundlesRoot, "Slugger", {
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.ouroboros.bot",
    })
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeUnavailableProviderCredentialPool("Slugger", "vault locked")

    const prompts: string[] = []
    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      isTTY: true,
      stdoutColumns: 74,
      promptInput: async (prompt) => {
        prompts.push(prompt)
        return "4"
      },
    }))

    expect(result).toContain("OUROBOROS")
    expect(result).toContain("Repair Slugger")
    expect(result).toContain("Unlock with saved secret")
    expect(result).toContain("[human required]")
    expect(prompts).toContain("Choose [1-4]: ")
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

  it("ouro repair offers vault creation when an existing agent has no vault locator yet", async () => {
    emitTestEvent("provider cli repair missing vault locator")
    const bundlesRoot = makeTempDir("provider-cli-repair-create-bundles")
    const homeDir = makeTempDir("provider-cli-repair-create-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeUnavailableProviderCredentialPool(
      "Slugger",
      "credential vault is not configured in /tmp/Slugger.ouro/agent.json. Run 'ouro vault create --agent Slugger' to create this agent's vault before loading or storing credentials.",
    )

	    const prompts: string[] = []
	    const secretPrompts: string[] = []
	    const result = await runOuroCli(["repair", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
	      promptInput: async (prompt) => {
	        prompts.push(prompt)
	        return "1"
	      },
	      promptSecret: async (question) => {
	        secretPrompts.push(question)
	        return "Chosen-vault-secret1!"
	      },
	    }))

    expect(result).toContain("Slugger: vault not configured")
    expect(result).toContain("1. Create this agent's vault")
    expect(result).toContain("   ouro vault create --agent Slugger")
	    expect(result).toContain("repair step finished for Slugger.")
	    expect(prompts).toContain("Choose [1-3]: ")
	    expect(secretPrompts).toEqual([
	      "Choose Ouro vault unlock secret for slugger@ouro.bot: ",
	      "Confirm Ouro vault unlock secret for slugger@ouro.bot: ",
	    ])
	    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.ouroboros.bot",
      "slugger@ouro.bot",
      "Chosen-vault-secret1!",
    )
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
	      promptSecret: async () => "Chosen-replacement-material1!",
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
    const runAuthFlow = vi.fn(async (input: { onProgress?: (message: string) => void }) => {
      input.onProgress?.("starting anthropic credential entry...")
      return { ok: true, message: "authenticated Slugger with anthropic" }
    })

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
    expect(result).toContain("... authenticating anthropic")
    expect(result).toContain("starting anthropic credential entry...")
    expect(result).toContain("✓ authenticating anthropic")
    expect(result).toContain("... verifying anthropic")
    expect(result).toContain("✓ verifying anthropic")
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
        return "Chosen-unlock-material1!"
      },
    }))

    expect(result).toContain("vault created for Slugger")
    expect(result).not.toContain("vault unlock secret:")
    expect(result).toContain("local unlock store: macos-keychain")
	    expect(result).not.toContain("explicit plaintext fallback")
	    expect(prompts).toEqual([
	      "secret:Choose Ouro vault unlock secret for operator@example.com: ",
	      "secret:Confirm Ouro vault unlock secret for operator@example.com: ",
	    ])
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.ouroboros.bot",
      "operator@example.com",
      "Chosen-unlock-material1!",
    )
  })

  it("vault replace creates an empty vault at the stable agent email by default", async () => {
    emitTestEvent("provider cli vault replace")
	    const bundlesRoot = makeTempDir("provider-cli-vault-replace-bundles")
	    const homeDir = makeTempDir("provider-cli-vault-replace-home")
	    writeAgentConfig(bundlesRoot, "Slugger")
	    const promptQuestions: string[] = []

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        promptQuestions.push(question)
        return "Chosen-replacement-secret1!"
      },
    })
    const result = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
	    ], deps)
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("")

    expect(result).toContain("vault replaced for Slugger")
    expect(output).toContain("... creating vault account")
    expect(output).toContain("✓ creating vault account")
    expect(output).toContain("... saving local unlock")
    expect(output).toContain("✓ saving local unlock")
    expect(output).toContain("... checking vault access")
    expect(output).toContain("✓ checking vault access")
    expect(result).toContain("vault: slugger@ouro.bot at https://vault.example.com")
    expect(result).toContain("imported: none")
    expect(result).toContain("next: ouro repair --agent Slugger")
	    expect(result).toContain("Keep the vault unlock secret saved outside Ouro")
	    expect(result).not.toContain("Chosen-replacement-secret1!")
	    expect(promptQuestions).toEqual([
	      "Choose new Ouro vault unlock secret for slugger@ouro.bot: ",
	      "Confirm new Ouro vault unlock secret for slugger@ouro.bot: ",
	    ])
	    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "slugger@ouro.bot",
      "Chosen-replacement-secret1!",
    )
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "slugger@ouro.bot", serverUrl: "https://vault.example.com" },
      "Chosen-replacement-secret1!",
      { homeDir, store: "plaintext-file" },
    )
    expect(readAgentConfig(bundlesRoot, "Slugger").vault).toEqual({
      email: "slugger@ouro.bot",
      serverUrl: "https://vault.example.com",
    })
    expect(mockVaultDeps.rawSecrets.size).toBe(0)
  })

  it("vault replace lands on a shared TTY repair board instead of a raw transcript", async () => {
    emitTestEvent("provider cli vault replace tty board")
    const bundlesRoot = makeTempDir("provider-cli-vault-replace-tty-bundles")
    const homeDir = makeTempDir("provider-cli-vault-replace-tty-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--server",
      "https://vault.example.com",
    ], makeCliDeps(homeDir, bundlesRoot, {
      isTTY: true,
      stdoutColumns: 78,
      promptSecret: async () => "Chosen-replacement-secret1!",
    }))

    expect(result).toContain("Credential vault")
    expect(result).toContain("Slugger now has a fresh empty vault.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
    expect(result).toContain("secret was not printed")
  })

  it("vault replace reports bundle sync when the repaired bundle is sync-enabled", async () => {
    emitTestEvent("provider cli vault replace bundle sync")
    const bundlesRoot = makeTempDir("provider-cli-vault-replace-sync-bundles")
    const homeDir = makeTempDir("provider-cli-vault-replace-sync-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.sync = { enabled: true }
    })
    initBundleGit(agentRoot(bundlesRoot, "Slugger"))

    const result = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--server",
      "https://vault.example.com",
    ], makeCliDeps(homeDir, bundlesRoot, {
      isTTY: true,
      stdoutColumns: 78,
      promptSecret: async () => "Chosen-replacement-secret1!",
    }))

    expect(result).toContain("bundle sync: ran post-change sync (remote: origin)")
    expect(execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: agentRoot(bundlesRoot, "Slugger"),
      stdio: "pipe",
    }).toString()).toContain("sync: post-turn update")
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
	    const promptQuestions: string[] = []

    const result = await runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
	    ], makeCliDeps(homeDir, bundlesRoot, {
	      now: () => Date.parse(NOW),
	      promptSecret: async (question) => {
	        promptQuestions.push(question)
	        return "Chosen-replacement-secret1!"
	      },
	    }))

	    expect(result).toContain("vault: slugger@ouro.bot at https://vault.example.com")
	    expect(promptQuestions).toEqual([
	      "Choose new Ouro vault unlock secret for slugger@ouro.bot: ",
	      "Confirm new Ouro vault unlock secret for slugger@ouro.bot: ",
	    ])
	    expect(result).not.toContain("+replaced-20260412201000")
    expect(result).not.toContain("+replaced-20260415233600")
    expect(mockVaultDeps.createVaultAccount).toHaveBeenCalledWith(
      "Ouro credential vault",
      "https://vault.example.com",
      "slugger@ouro.bot",
      "Chosen-replacement-secret1!",
    )
  })

  it("vault replace covers prompted secrets, failures, and guards", async () => {
    emitTestEvent("provider cli vault replace guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-replace-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-replace-guards-home")
	    writeAgentConfig(bundlesRoot, "Slugger")
	    const promptQuestions: string[] = []
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
	        promptQuestions.push(question)
	        return "Chosen-replacement-secret1!"
	      },
	    }))
    expect(prompted).toContain("vault replaced for Slugger")
	    expect(prompted).toContain("local unlock store: macos-keychain")
	    expect(prompted).not.toContain("explicit plaintext fallback")
	    expect(prompted).not.toContain("Chosen-replacement-secret1!")
	    expect(promptQuestions).toEqual([
	      "Choose new Ouro vault unlock secret for slugger+manual@example.com: ",
	      "Confirm new Ouro vault unlock secret for slugger+manual@example.com: ",
	    ])

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
      promptSecret: async () => "Chosen-replacement-secret1!",
    }))).rejects.toThrow("Replace the hatchling agent vault")
    await expect(runOuroCli([
      "vault",
      "replace",
      "--agent",
      "Slugger",
      "--generate-unlock-secret",
    ], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "Chosen-replacement-secret1!",
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
      promptSecret: async () => "Chosen-replacement-secret1!",
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
    writeMachineIdentity(homeDir, "machine_recover")
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

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async () => "Chosen-recovery-secret1!",
    })
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
    ], deps)
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("")

    expect(result).toContain("vault recovered for Slugger")
    expect(output).toContain("... creating vault account")
    expect(output).toContain("✓ creating vault account")
    expect(output).toContain("... saving local unlock")
    expect(output).toContain("✓ saving local unlock")
    expect(output).toContain("... checking vault access")
    expect(output).toContain("✓ checking vault access")
    expect(output).toContain("... importing recovered credentials")
    expect(output).toContain("✓ importing recovered credentials")
    expect(result).toContain("vault: slugger@ouro.bot at https://vault.example.com")
    expect(result).toContain("provider credentials imported: anthropic, github-copilot, minimax")
    expect(result).toContain("runtime credentials imported: operatorNote")
    expect(result).toContain("machine runtime credentials imported: bluebubbles.accountId, bluebubbles.password, bluebubbles.serverUrl")
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
      "Chosen-recovery-secret1!",
    )
    expect(mockVaultDeps.storeVaultUnlockSecret).toHaveBeenCalledWith(
      { agentName: "Slugger", email: "slugger@ouro.bot", serverUrl: "https://vault.example.com" },
      "Chosen-recovery-secret1!",
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
      operatorNote: "scalar-secret",
    })
    const machineRuntimeRaw = mockVaultDeps.rawSecrets.get("Slugger:runtime/machines/machine_recover/config")
    expect(machineRuntimeRaw).toBeDefined()
    const machineRuntime = JSON.parse(machineRuntimeRaw ?? "{}") as { config: Record<string, unknown> }
    expect(machineRuntime.config).toEqual({
      bluebubbles: { serverUrl: "http://bluebubbles.local", password: "bb-secret", accountId: "default" },
    })
    expect(runtime.config).not.toHaveProperty("providers")
    expect(runtime.config).not.toHaveProperty("vault")
  })

  it("vault recover reports bundle sync when the recovered bundle is sync-enabled", async () => {
    emitTestEvent("provider cli vault recover bundle sync")
    const bundlesRoot = makeTempDir("provider-cli-vault-recover-sync-bundles")
    const homeDir = makeTempDir("provider-cli-vault-recover-sync-home")
    const sourceDir = makeTempDir("provider-cli-vault-recover-sync-source")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.sync = { enabled: true }
    })
    initBundleGit(agentRoot(bundlesRoot, "Slugger"))
    writeMachineIdentity(homeDir, "machine_recover_sync")

    const legacySecretsPath = path.join(sourceDir, "legacy-secrets.json")
    fs.writeFileSync(legacySecretsPath, JSON.stringify({
      providers: {
        minimax: { apiKey: "mini-secret", model: "MiniMax-M2.5" },
      },
      vault: { masterPassword: "" },
    }), "utf-8")

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async () => "Chosen-recovery-secret1!",
    })
    const result = await runOuroCli([
      "vault",
      "recover",
      "--agent",
      "Slugger",
      "--from",
      legacySecretsPath,
      "--server",
      "https://vault.example.com",
      "--store",
      "plaintext-file",
    ], deps)

    expect(result).toContain("bundle sync: ran post-change sync (remote: origin)")
    expect(execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: agentRoot(bundlesRoot, "Slugger"),
      stdio: "pipe",
    }).toString()).toContain("sync: post-turn update")
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
	    const promptQuestions: string[] = []

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
	        promptQuestions.push(question)
	        return "Chosen-recovery-secret1!"
	      },
	    }))
    expect(prompted).toContain("provider credentials imported: none")
    expect(prompted).toContain("runtime credentials imported: none")
    expect(prompted).toContain("machine runtime credentials imported: none")
	    expect(prompted).toContain("Keep the vault unlock secret saved outside Ouro")
	    expect(prompted).not.toContain("Chosen-recovery-secret1!")
	    expect(prompted).not.toContain("ignored-secret")
	    expect(promptQuestions).toEqual([
	      "Choose new Ouro vault unlock secret for slugger+manual@example.com: ",
	      "Confirm new Ouro vault unlock secret for slugger+manual@example.com: ",
	    ])

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
      promptSecret: async () => "Chosen-recovery-secret1!",
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
      promptSecret: async () => "Chosen-recovery-secret1!",
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
	      promptSecret: async () => "Chosen-recovery-secret1!",
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
	      promptSecret: async () => "Chosen-recovery-secret1!",
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
      promptSecret: async () => "Chosen-create-secret1!",
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

    const deps = makeCliDeps(homeDir, bundlesRoot)
    const result = await runOuroCli(["vault", "status", "--agent", "Slugger"], deps)
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("")

    expect(result).toContain("agent: Slugger")
    expect(output).toContain("... reading runtime credentials")
    expect(output).toContain("✓ reading runtime credentials")
    expect(output).toContain("... reading provider credentials")
    expect(output).toContain("✓ reading provider credentials")
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

    const outputAfterSet = (deps as OuroCliDeps & { _output: string[] })._output.join("")
    expect(outputAfterSet).toContain("... storing runtime credential")
    expect(outputAfterSet).toContain("✓ storing runtime credential")

    const statusDeps = makeCliDeps(homeDir, bundlesRoot)
    const status = await runOuroCli(["vault", "config", "status", "--agent", "Slugger"], statusDeps)
    const statusOutput = (statusDeps as OuroCliDeps & { _output: string[] })._output.join("")
    expect(status).toContain("runtime config item: vault:Slugger:runtime/config")
    expect(status).toContain("fields: bluebubbles.password, bluebubbles.serverUrl")
    expect(status).not.toContain("super-secret")
    expect(statusOutput).toContain("... reading agent runtime config")
    expect(statusOutput).toContain("✓ reading agent runtime config")

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

    mockVaultDeps.rawSecrets.clear()
    resetRuntimeCredentialConfigCache()
    const allScopesMissing = await runOuroCli(["vault", "config", "status", "--agent", "Slugger", "--scope", "all"], makeCliDeps(homeDir, bundlesRoot))
    expect(allScopesMissing).toContain("agent runtime config item: vault:Slugger:runtime/config")
    expect(allScopesMissing).toContain("machine runtime config item: vault:Slugger:runtime/machines/")
    expect(allScopesMissing).toContain("ouro vault config set --agent Slugger --key <field> --scope machine")

    writeMachineIdentity(homeDir, "machine_config")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/machines/machine_config/config", runtimeConfigSecret({
      bluebubbles: { serverUrl: "http://127.0.0.1:1234" },
    }))
    resetRuntimeCredentialConfigCache()
    const machineSet = await runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--scope", "machine", "--key", "bluebubbles.password", "--value", "local-password"],
      makeCliDeps(homeDir, bundlesRoot, { now: () => Date.parse(NOW) }),
    )
    expect(machineSet).toContain("stored bluebubbles.password for Slugger")
    expect(machineSet).toContain("this machine's vault runtime config item")
    expect(machineSet).not.toContain("local-password")
    const machineStored = readRuntimeSecret("Slugger", "runtime/machines/machine_config/config")
    expect(machineStored.config).toMatchObject({
      bluebubbles: {
        serverUrl: "http://127.0.0.1:1234",
        password: "local-password",
      },
    })

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

    const promptedSecret = await runOuroCli(["vault", "config", "set", "--agent", "Slugger", "--key", "integrations.perplexityApiKey"], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async (question) => {
        expect(question).toBe("Value for integrations.perplexityApiKey: ")
        return "pplx-hidden"
      },
    }))
    expect(promptedSecret).toContain("stored integrations.perplexityApiKey")
    expect(promptedSecret).not.toContain("pplx-hidden")
  })

  it("connects Perplexity through a discoverable hidden-prompt flow", async () => {
    emitTestEvent("provider cli connect perplexity")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        expect(question).toBe("Perplexity API key: ")
        return "pplx-secret"
      },
    })
    const result = await runOuroCli(["connect", "perplexity", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("Perplexity connected for Slugger")
    expect(result).toContain("Perplexity search")
    expect(result).toContain("runtime/config")
    expect(result).toContain("running agent: daemon is not running; next `ouro up` will load the change")
    expect(result).toContain("secret was not printed")
    expect(result).not.toContain("pplx-secret")
    expect(output).toContain("Connect Perplexity for Slugger")
    expect(output).toContain("The API key stays hidden while you type.")
    expect(output).toContain("... saving Perplexity search")
    expect(output).toContain("... verifying Perplexity search")
    expect(output).toContain("checking existing runtime config")
    expect(output).toContain("storing integrations.perplexityApiKey")
    expect(output).toContain("✓ saving Perplexity search")
    expect(output).toContain("✓ verifying Perplexity search")
    expect(output).toContain("... applying change to running Slugger")
    expect(output).toContain("checking whether Ouro is already running")
    expect(output).toContain("daemon is not running; next `ouro up` will load the change")
    expect(output).not.toContain("pplx-secret")

    const stored = readRuntimeSecret("Slugger")
    expect(stored.config).toMatchObject({
      integrations: {
        perplexityApiKey: "pplx-secret",
      },
    })
  })

  it("renders a richer TTY onboarding board for Perplexity", async () => {
    emitTestEvent("provider cli connect perplexity tty board")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-tty-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-tty-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      isTTY: true,
      stdoutColumns: 90,
      promptSecret: async () => "pplx-secret",
    })
    await runOuroCli(["connect", "perplexity", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(output).toContain("Connect Perplexity")
    expect(output).toContain("Unlocks")
    expect(output).toContain("What you need")
    expect(output).toContain("Where it lives")
    expect(output).toContain("Portable web search inside Ouro")
  })

  it("renders a shared TTY completion board for Perplexity", async () => {
    emitTestEvent("provider cli connect perplexity tty completion")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-tty-complete-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-tty-complete-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli(["connect", "perplexity", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      isTTY: true,
      stdoutColumns: 88,
      promptSecret: async () => "pplx-secret",
    }))

    expect(result).toContain("Capability connected")
    expect(result).toContain("Perplexity search is ready to travel with Slugger.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
  })

  it("connect Perplexity keeps progress visible when the vault write path fails", async () => {
    emitTestEvent("provider cli connect perplexity failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/config", "{not-json")
    resetRuntimeCredentialConfigCache()

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async (question) => {
        expect(question).toBe("Perplexity API key: ")
        return "pplx-secret"
      },
    })

    await expect(runOuroCli(["connect", "perplexity", "--agent", "Slugger"], deps))
      .rejects.toThrow("cannot read existing runtime credentials")

    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
    expect(output).toContain("Connect Perplexity for Slugger")
    expect(output).toContain("... saving Perplexity search")
    expect(output).toContain("checking existing runtime config")
    expect(output).not.toContain("✓ saving Perplexity search")
    expect(output).not.toContain("pplx-secret")
  })

  it("connects BlueBubbles as a current-machine attachment", async () => {
    emitTestEvent("provider cli connect bluebubbles")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.senses = {
        cli: { enabled: false },
        teams: { enabled: true },
        bluebubbles: { enabled: false, preserved: "yes" },
      }
    })
    writeMachineIdentity(homeDir, "machine_bb")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async (question) => {
        expect(question).not.toContain("password")
        return answers.shift() ?? ""
      },
      promptSecret: async (question) => {
        expect(question).toBe("BlueBubbles app password: ")
        return "bb-password"
      },
    })
    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    expect(result).toContain("runtime/machines/machine_bb/config")
    expect(result).toContain("secret was not printed")
    expect(result).not.toContain("bb-password")
    expect(output).toContain("Connect BlueBubbles for Slugger")
    expect(output).toContain("This is a local attachment for this machine.")
    expect(output).toContain("... saving BlueBubbles attachment")
    expect(output).toContain("storing local machine config")
    expect(output).toContain("✓ saving BlueBubbles attachment")
    expect(output).not.toContain("bb-password")

    const stored = readRuntimeSecret("Slugger", "runtime/machines/machine_bb/config")
    expect(stored.config).toMatchObject({
      bluebubbles: {
        serverUrl: "http://127.0.0.1:1234",
        password: "bb-password",
      },
      bluebubblesChannel: {
        port: 18888,
        webhookPath: "/bb-webhook",
        requestTimeoutMs: 12000,
      },
    })

    const agentJson = JSON.parse(fs.readFileSync(path.join(agentRoot(bundlesRoot, "Slugger"), "agent.json"), "utf-8")) as {
      senses?: { bluebubbles?: { enabled?: boolean; preserved?: string } }
    }
    expect(agentJson.senses?.bluebubbles?.enabled).toBe(true)
    expect(agentJson.senses?.bluebubbles?.preserved).toBe("yes")
  })

  it("renders a richer TTY onboarding board and shared completion board for BlueBubbles", async () => {
    emitTestEvent("provider cli connect bluebubbles tty boards")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-tty-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-tty-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb_tty")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      isTTY: true,
      stdoutColumns: 88,
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    })
    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(output).toContain("Connect BlueBubbles")
    expect(output).toContain("Unlocks")
    expect(output).toContain("What you need")
    expect(output).toContain("Where it lives")
    expect(result).toContain("Capability connected")
    expect(result).toContain("BlueBubbles is attached on this machine for Slugger.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
  })

  it("guards connect flows that cannot persist credentials", async () => {
    emitTestEvent("provider cli connect guardrails")
    const bundlesRoot = makeTempDir("provider-cli-connect-guards-bundles")
    const homeDir = makeTempDir("provider-cli-connect-guards-home")

    await expect(runOuroCli(
      ["connect", "perplexity", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot, { promptSecret: async () => "pplx-secret" }),
    )).rejects.toThrow("SerpentGuide has no persistent runtime credentials")

    await expect(runOuroCli(
      ["connect", "bluebubbles", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptInput: async () => "http://127.0.0.1:1234",
        promptSecret: async () => "bb-password",
      }),
    )).rejects.toThrow("SerpentGuide has no persistent runtime credentials")

    await expect(runOuroCli(
      ["connect", "teams", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptInput: async () => "teams-client-id",
        promptSecret: async () => "teams-secret",
      }),
    )).rejects.toThrow("SerpentGuide has no persistent runtime credentials")

    await expect(runOuroCli(
      ["connect", "embeddings", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => "embed-secret",
      }),
    )).rejects.toThrow("SerpentGuide has no persistent runtime credentials")
  })

  it("requires an interactive terminal for direct connect flows that need hidden input", async () => {
    emitTestEvent("provider cli connect requires interactive terminal")
    const bundlesRoot = makeTempDir("provider-cli-connect-interactive-guards-bundles")
    const homeDir = makeTempDir("provider-cli-connect-interactive-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(
      ["connect", "perplexity", "--agent", "Slugger"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("Perplexity API key entry requires an interactive terminal")

    await expect(runOuroCli(
      ["connect", "bluebubbles", "--agent", "Slugger"],
      makeCliDeps(homeDir, bundlesRoot, { promptSecret: async () => "bb-password" }),
    )).rejects.toThrow("BlueBubbles setup requires an interactive terminal")
  })

  it("rejects blank Perplexity API keys", async () => {
    emitTestEvent("provider cli connect perplexity blank key")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-blank-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-blank-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["connect", "perplexity", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "   ",
    }))).rejects.toThrow("Perplexity API key cannot be blank")
  })

  it("rejects blank OpenAI embeddings API keys", async () => {
    emitTestEvent("provider cli connect embeddings blank key")
    const bundlesRoot = makeTempDir("provider-cli-connect-embeddings-blank-bundles")
    const homeDir = makeTempDir("provider-cli-connect-embeddings-blank-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["connect", "embeddings", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptSecret: async () => "   ",
    }))).rejects.toThrow("OpenAI embeddings API key cannot be blank")
  })

  it("validates BlueBubbles port and timeout prompts before storing the attachment", async () => {
    emitTestEvent("provider cli connect bluebubbles prompt validation")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-validation-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-validation-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb")

    await expect(runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "   ",
      promptSecret: async () => "bb-password",
    }))).rejects.toThrow("BlueBubbles server URL cannot be blank")

    await expect(runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => question.includes("server URL") ? "http://127.0.0.1:1234" : "70000",
      promptSecret: async () => "bb-password",
    }))).rejects.toThrow("BlueBubbles webhook port must be an integer between 1 and 65535")

    const timeoutAnswers = [
      "http://127.0.0.1:1234",
      "",
      "",
      "0",
    ]
    await expect(runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => timeoutAnswers.shift() ?? "",
      promptSecret: async () => "bb-password",
    }))).rejects.toThrow("BlueBubbles request timeout must be a positive integer")

    await expect(runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => question.includes("server URL") ? "http://127.0.0.1:1234" : "",
      promptSecret: async () => "",
    }))).rejects.toThrow("BlueBubbles app password cannot be blank")
  })

  it("stops BlueBubbles setup before overwriting an unreadable machine runtime item", async () => {
    emitTestEvent("provider cli connect bluebubbles unreadable machine item")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-unreadable-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-unreadable-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/machines/machine_bb/config", JSON.stringify({ bad: true }))
    resetRuntimeCredentialConfigCache()

    const answers = [
      "http://127.0.0.1:1234",
      "",
      "bb-webhook",
      "",
    ]
    await expect(runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    }))).rejects.toThrow("cannot read existing machine runtime credentials")
  })

  it("preserves existing BlueBubbles machine runtime fields while attaching this machine", async () => {
    emitTestEvent("provider cli connect bluebubbles preserves machine item")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-preserve-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-preserve-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/machines/machine_bb/config", runtimeConfigSecret({
      localTool: { token: "keep-me" },
    }))
    resetRuntimeCredentialConfigCache()

    const answers = [
      "http://127.0.0.1:1234",
      "",
      "bb-webhook",
      "",
    ]
    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    }))

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    const stored = readRuntimeSecret("Slugger", "runtime/machines/machine_bb/config")
    expect(stored.config).toMatchObject({
      localTool: { token: "keep-me" },
      bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-password" },
      bluebubblesChannel: { webhookPath: "/bb-webhook" },
    })
  })

  it("keeps BlueBubbles setup successful but reports bundle sync failure when sync is enabled without git", async () => {
    emitTestEvent("provider cli connect bluebubbles sync failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-sync-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-sync-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.sync = { enabled: true, remote: "origin" }
    })
    writeMachineIdentity(homeDir, "machine_bb")

    const answers = [
      "http://127.0.0.1:1234",
      "",
      "",
      "",
    ]
    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    }))

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    expect(result).toContain("bundle sync: could not push bundle changes")
    expect(result).toContain("not a git repo")
    expect(readAgentConfig(bundlesRoot, "Slugger").senses).toMatchObject({
      bluebubbles: { enabled: true },
    })
  })

  it("renders a compact connect menu and dispatches the selected onboarding path", async () => {
    emitTestEvent("provider cli connect menu")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async (question) => {
        prompts.push(question)
        return "2"
      },
      promptSecret: async () => "pplx-secret",
    })
    const result = await runOuroCli(["connect", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
    const prompt = joinedPrompt(prompts)

    expect(prompt).toContain("Slugger connect bay")
    expect(prompt).toContain("Next best move")
    expect(prompt).toContain("Provider core")
    expect(prompt).toContain("Portable")
    expect(prompt).toContain("This machine")
    expect(output).toContain("... checking current connections")
    expect(output).toContain("checking selected providers")
    expect(output).toContain("loading portable settings")
    expect(output).toContain("loading this machine's settings")
    expect(prompt).toContain("Providers")
    expect(prompt).toContain("Perplexity search")
    expect(prompt).toContain("Memory embeddings")
    expect(prompt).toContain("Teams")
    expect(prompt).toContain("BlueBubbles iMessage")
    expect(result).toContain("Perplexity connected for Slugger")
  })

  it("runs the shared live provider verification path before rendering the root connect bay", async () => {
    emitTestEvent("provider cli connect menu live verification")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-live-verification-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-live-verification-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_openai_connect_live",
          updatedAt: NOW,
          credentials: { oauthAccessToken: "openai-secret" },
          config: {},
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    mockPingProvider.mockImplementation(async (provider) => {
      if (provider === "openai-codex") return { ok: true, message: "ok", attempts: [1] }
      if (provider === "minimax") return { ok: true, message: "ok", attempts: [1] }
      throw new Error(`unexpected provider ${provider}`)
    })

    const prompts: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    })
    const result = await runOuroCli(["connect", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
    const prompt = joinedPrompt(prompts)

    expect(result).toBe("connect cancelled.")
    expect(output).toContain("checking selected providers")
    expect(output).toContain("reading vault items for Slugger...")
    expect(output).toContain("checking openai-codex / gpt-5.4...")
    expect(output).toContain("checking minimax / MiniMax-M2.5...")
    expectConnectStatus(prompt, 1, "Providers", "ready")
    expect(mockPingProvider).toHaveBeenCalledTimes(2)
    expect(mockPingProvider).toHaveBeenNthCalledWith(1, "openai-codex", { oauthAccessToken: "openai-secret" }, { model: "gpt-5.4" })
    expect(mockPingProvider).toHaveBeenNthCalledWith(2, "minimax", { apiKey: "minimax-secret" }, { model: "MiniMax-M2.5" })
  })

  it("renders failed live provider checks as attention instead of auth gaps in the root connect bay", async () => {
    emitTestEvent("provider cli connect menu live verification failed")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-live-verification-failed-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-live-verification-failed-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_openai_connect_failed",
          updatedAt: NOW,
          credentials: { oauthAccessToken: "openai-secret" },
          config: {},
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    mockPingProvider.mockImplementation(async (provider) => {
      if (provider === "openai-codex") return { ok: false, message: "400 status code (no body)", attempts: [1] }
      if (provider === "minimax") return { ok: true, message: "ok", attempts: [1] }
      throw new Error(`unexpected provider ${provider}`)
    })

    const prompts: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    })
    const result = await runOuroCli(["connect", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
    const prompt = joinedPrompt(prompts)

    expect(result).toBe("connect cancelled.")
    expect(output).toContain("checking openai-codex / gpt-5.4...")
    expectConnectStatus(prompt, 1, "Providers", "needs attention")
    expect(prompt).toContain("openai-codex / gpt-5.4")
    expect(prompt).toContain("failed live check: 400 status code (no body)")
    expect(prompt).not.toContain("Providers - needs credentials")
  })

  it("shows an everything-ready next move when every connect capability is already available", async () => {
    emitTestEvent("provider cli connect menu everything ready")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-everything-ready-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-everything-ready-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.senses = {
        ...(config.senses ?? {}),
        teams: { enabled: true },
        bluebubbles: { enabled: true },
      }
    })
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_openai_connect_everything_ready",
          updatedAt: NOW,
          credentials: { oauthAccessToken: "openai-secret" },
          config: {},
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    writeRuntimeConfig("Slugger", {
      integrations: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "embed-secret",
      },
      teams: {
        clientId: "teams-client-id",
        clientSecret: "teams-secret",
        tenantId: "tenant-id",
      },
    })
    writeMachineIdentity(homeDir, "machine_everything_ready")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/machines/machine_everything_ready/config", runtimeConfigSecret({
      bluebubbles: {
        serverUrl: "http://127.0.0.1:1234",
        password: "bb-password",
        accountId: "default",
      },
    }))
    mockPingProvider.mockImplementation(async (provider) => {
      if (provider === "openai-codex") return { ok: true, message: "ok", attempts: [1] }
      if (provider === "minimax") return { ok: true, message: "ok", attempts: [1] }
      throw new Error(`unexpected provider ${provider}`)
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expect(joinedPrompt(prompts)).toContain("Everything here is ready. Pick what you want to review or refresh.")
  })

  it("renders transient provider-read trouble as attention in the root connect bay", async () => {
    emitTestEvent("provider cli connect menu transient provider trouble")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-transient-provider-trouble-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-transient-provider-trouble-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeUnavailableProviderCredentialPool("Slugger", "ETIMEDOUT while reading vault")

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 1, "Providers", "needs attention")
  })

  it("renders locked provider access with an unlock next move in the root connect bay", async () => {
    emitTestEvent("provider cli connect menu provider locked")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-locked-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-locked-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
    writeUnavailableProviderCredentialPool("Slugger", "vault locked on this machine")

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 1, "Providers", "locked")
    expect(prompt).toContain("ouro vault unlock --agent Slugger")
  })

  it("treats generic provider vault read failures as unlockable in the root connect bay", async () => {
    emitTestEvent("provider cli connect menu provider unlock repair")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-unlock-repair-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-unlock-repair-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
    writeUnavailableProviderCredentialPool("Slugger", "vault backend refused the request")

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 1, "Providers", "locked")
    expect(prompt).toContain("ouro vault unlock --agent Slugger")
  })

  it("keeps the connect bay usable when provider verification throws unexpectedly", async () => {
    emitTestEvent("provider cli connect menu provider health throws")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-health-throws-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-health-throws-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    mockProviderCredentials.refreshProviderCredentialPool.mockImplementationOnce(async (_agentName, options) => {
      options?.onProgress?.("opening credential vault")
      throw new Error("vault subprocess crashed")
    })

    const prompts: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    })
    const result = await runOuroCli(["connect", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
    const prompt = joinedPrompt(prompts)

    expect(result).toBe("connect cancelled.")
    expect(output).toContain("opening credential vault")
    expectConnectStatus(prompt, 1, "Providers", "needs attention")
    expect(prompt).toContain("run: ouro auth verify --agent Slugger")
  })

  it("includes a runnable next-step command when the recommended capability needs setup", async () => {
    emitTestEvent("provider cli connect menu next step command")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-next-step-command-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-next-step-command-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expect(joinedPrompt(prompts)).toContain("run: ouro connect perplexity --agent Slugger")
  })

  it("keeps the connect bay usable when provider verification throws a string", async () => {
    emitTestEvent("provider cli connect menu provider health throws string")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-health-throws-string-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-health-throws-string-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    mockProviderCredentials.refreshProviderCredentialPool.mockImplementationOnce(async (_agentName, options) => {
      options?.onProgress?.("opening credential vault")
      throw "vault subprocess string broke"
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    const prompt = joinedPrompt(prompts)
    expect(result).toBe("connect cancelled.")
    expectConnectStatus(prompt, 1, "Providers", "needs attention")
    expect(prompt).toContain("run: ouro auth verify --agent Slugger")
  })

  it("renders the connect bay with ANSI section styling on TTY terminals", async () => {
    emitTestEvent("provider cli connect menu tty styling")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-tty-styling-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-tty-styling-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      isTTY: true,
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expect(prompt).toContain("\x1b[38;2;78;201;176m╭─ \x1b[0m")
    expect(prompt).toContain("\x1b[38;2;238;242;234m\x1b[1mSlugger connect bay\x1b[0m")
  })

  it("renders the TTY connect bay as framed panels with humane provider lane labels", async () => {
    emitTestEvent("provider cli connect menu framed panels")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-framed-panels-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-framed-panels-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      isTTY: true,
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    const prompt = joinedPrompt(prompts)
    expect(result).toBe("connect cancelled.")
    expect(prompt).toContain("╭")
    expect(prompt).toContain("╰")
    expect(prompt).toContain("Outward lane")
    expect(prompt).toContain("Inner lane")
    expect(prompt).toContain("Pick a path")
  })

  it("uses a side-by-side layout on wide TTY terminals", async () => {
    emitTestEvent("provider cli connect menu wide tty layout")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-wide-tty-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-wide-tty-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const result = await runOuroCli(
      ["connect", "--agent", "Slugger"],
      makeCliDeps(homeDir, bundlesRoot, {
        isTTY: true,
        promptInput: async (question) => {
          prompts.push(question)
          return "cancel"
        },
        ...( { stdoutColumns: 132 } as Record<string, unknown>),
      }),
    )

    const promptLines = joinedPrompt(prompts).split("\n")
    expect(result).toBe("connect cancelled.")
    expect(promptLines.some((line) => line.includes("Provider core") && line.includes("Portable"))).toBe(true)
    expect(promptLines.some((line) => line.includes("Next best move") && line.includes("This machine"))).toBe(true)
  })

  it("shows setup guidance when a provider lane is not configured on this machine", async () => {
    emitTestEvent("provider cli connect menu unconfigured lane")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-unconfigured-lane-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-unconfigured-lane-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    fs.mkdirSync(path.join(agentRoot(bundlesRoot, "Slugger"), "state"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot(bundlesRoot, "Slugger"), "state", "providers.json"), "{not-json", "utf-8")

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expect(prompt).toContain("choose provider and model")
    expectConnectStatus(prompt, 1, "Providers", "needs setup")
  })

  it("treats missing agent.json provider selection as setup work in the root connect bay", async () => {
    emitTestEvent("provider cli connect menu missing agent json provider")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-missing-agent-json-provider-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-missing-agent-json-provider-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      delete config.humanFacing
    })
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 1, "Providers", "needs setup")
    expect(prompt).toContain("run: ouro use --agent Slugger --lane outward --provider <provider> --model <model>")
  })

  it("surfaces stale provider readiness when another lane blocks the live check", async () => {
    emitTestEvent("provider cli connect menu stale readiness")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-stale-readiness-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-stale-readiness-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
          source: "local",
          updatedAt: NOW,
        },
        inner: {
          provider: "github-copilot",
          model: "gpt-4o",
          source: "local",
          updatedAt: NOW,
        },
      },
      readiness: {
        inner: {
          status: "stale",
          provider: "github-copilot",
          model: "gpt-4o",
          checkedAt: NOW,
          credentialRevision: "cred_ghc_stale",
          reason: "previous ping expired",
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_stale",
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

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expect(prompt).toContain("live check is stale")
    expectConnectStatus(prompt, 1, "Providers", "needs credentials")
  })

  it("renders provider repair status in the connect bay when bindings need auth or attention", async () => {
    emitTestEvent("provider cli connect menu provider statuses")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-statuses-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-statuses-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
    writeProviderCredentialPool(homeDir, credentialPool())
    let prompts: string[] = []
    let result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))
    expect(result).toBe("connect cancelled.")
    let prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 1, "Providers", "needs credentials")
    expect(prompt).toContain("credentials missing")

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
          credentialRevision: "cred_ghc_status",
          error: "bad token",
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_status",
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
    prompts = []
    mockPingProvider.mockImplementation(async (provider) => {
      if (provider === "github-copilot") return { ok: false, message: "bad token", attempts: [1] }
      return { ok: true, message: "ok", attempts: [1] }
    })
    result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))
    expect(result).toBe("connect cancelled.")
    prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 1, "Providers", "needs attention")
    expect(prompt).toContain("failed live check: bad token")

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
          status: "stale",
          provider: "github-copilot",
          model: "gpt-4o",
          checkedAt: NOW,
          credentialRevision: "cred_ghc_status",
        },
      },
    }))
    prompts = []
    mockPingProvider.mockImplementation(async () => ({ ok: true, message: "ok", attempts: [1] }))
    result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))
    expect(result).toBe("connect cancelled.")
    prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 1, "Providers", "ready")
  })

  it("clears cached failed-live-check wording once a fresh live provider check succeeds", async () => {
    emitTestEvent("provider cli connect menu clears stale failed readiness")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-failed-readiness-fallback-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-failed-readiness-fallback-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState({
      lanes: {
        outward: {
          provider: "openai-codex",
          model: "gpt-5.4",
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
      readiness: {
        outward: {
          status: "failed",
          provider: "openai-codex",
          model: "gpt-5.4",
          checkedAt: NOW,
          credentialRevision: "cred_openai_fallback",
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_openai_fallback",
          updatedAt: NOW,
          credentials: { oauthAccessToken: "openai-secret" },
          config: {},
          provenance: {
            source: "auth-flow",
            updatedAt: NOW,
          },
        },
      },
    }))
    const healthSpy = vi.spyOn(agentConfigCheck, "checkAgentConfigWithProviderHealth").mockResolvedValueOnce({ ok: true })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))
    healthSpy.mockRestore()

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expect(prompt).toContain("1. Providers [ready]")
    expect(prompt).toContain("Outward lane: openai-codex / gpt-5.4")
    expect(prompt).toContain("ready")
    expect(prompt).not.toContain("failed live check: unknown error")
  })

  it("clears cached stale wording once a fresh live provider check succeeds", async () => {
    emitTestEvent("provider cli connect menu clears stale readiness")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-stale-readiness-fallback-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-stale-readiness-fallback-home")
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
          status: "stale",
          provider: "github-copilot",
          model: "gpt-4o",
          checkedAt: NOW,
          credentialRevision: "cred_ghc_stale_fallback",
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_ghc_stale_fallback",
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
    const healthSpy = vi.spyOn(agentConfigCheck, "checkAgentConfigWithProviderHealth").mockResolvedValueOnce({ ok: true })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))
    healthSpy.mockRestore()

    expect(result).toBe("connect cancelled.")
    expect(joinedPrompt(prompts)).toContain("1. Providers [ready]")
    expect(joinedPrompt(prompts)).not.toContain("live check is stale")
  })

  it("shows providers as ready in the connect bay when both lanes are configured and healthy", async () => {
    emitTestEvent("provider cli connect menu provider ready")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-ready-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-ready-home")
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
        outward: {
          status: "ready",
          provider: "anthropic",
          model: "claude-opus-4-6",
          checkedAt: NOW,
          credentialRevision: "cred_anthropic_1",
        },
        inner: {
          status: "ready",
          provider: "minimax",
          model: "MiniMax-M2.5",
          checkedAt: NOW,
          credentialRevision: "cred_minimax_1",
        },
      },
    }))
    writeProviderCredentialPool(homeDir, credentialPool())

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 1, "Providers", "ready")
  })

  it("keeps connect menu fallbacks compact for noninteractive shells and alternate choices", async () => {
    emitTestEvent("provider cli connect menu fallbacks")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-fallbacks-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-fallbacks-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_menu")

    const noninteractive = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(noninteractive).toContain("Slugger connect bay")
    expect(noninteractive).toContain("Next best move")
    expect(noninteractive).toContain("ouro connect providers --agent Slugger")
    expect(noninteractive).toContain("ouro connect perplexity --agent Slugger")
    expect(noninteractive).toContain("ouro connect embeddings --agent Slugger")
    expect(noninteractive).toContain("ouro connect teams --agent Slugger")
    expect(noninteractive).toContain("ouro connect bluebubbles --agent Slugger")

    const blueBubblesAnswers = ["5", "http://127.0.0.1:1234", "", "", ""]
    const blueBubbles = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => blueBubblesAnswers.shift() ?? "",
      promptSecret: async () => "bb-password",
    }))
    expect(blueBubbles).toContain("BlueBubbles attached for Slugger on this machine")
    expect(blueBubbles).toContain("runtime/machines/machine_menu/config")
    expect(blueBubbles).not.toContain("bb-password")

    const providerAuth = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "6",
    }))
    expect(providerAuth).toBe("connect cancelled.")

    const cancelled = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "cancel",
    }))
    expect(cancelled).toBe("connect cancelled.")
  })

  it("routes providers, embeddings, and Teams from the root connect bay menu", async () => {
    emitTestEvent("provider cli connect menu dispatch")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-dispatch-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-dispatch-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const runAuthFlow = vi.fn(async ({ agentName, provider }: { agentName: string; provider: string }) => {
      writeProviderCredentialPool(homeDir, credentialPool({
        providers: {
          ...credentialPool().providers,
          minimax: {
            provider: "minimax",
            revision: "cred_minimax_dispatch",
            updatedAt: NOW,
            credentials: { apiKey: "minimax-dispatch-key" },
            config: {},
            provenance: { source: "manual", updatedAt: NOW },
          },
        },
      }), agentName)
      return { message: `authenticated ${agentName} with ${provider}` }
    })
    const providers = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      runAuthFlow,
      promptInput: async (question) => question.includes("Provider: ") ? "minimax" : "1",
    }))
    expect(providers).toContain("authenticated Slugger with minimax")

    const embeddings = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => "3",
      promptSecret: async () => "embed-secret",
    }))
    expect(embeddings).toContain("Embeddings connected for Slugger")

    const teamAnswers = ["4", "teams-client-id", "teams-tenant-id", ""]
    const teams = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => teamAnswers.shift() ?? "",
      promptSecret: async () => "teams-secret",
    }))
    expect(teams).toContain("Teams connected for Slugger")
  })

  it("connects OpenAI embeddings through a hidden guided flow", async () => {
    emitTestEvent("provider cli connect embeddings")
    const bundlesRoot = makeTempDir("provider-cli-connect-embeddings-bundles")
    const homeDir = makeTempDir("provider-cli-connect-embeddings-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        expect(question).toBe("OpenAI embeddings API key: ")
        return "emb-secret"
      },
    })
    const result = await runOuroCli(["connect", "embeddings", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("Embeddings connected for Slugger")
    expect(result).toContain("memory embeddings")
    expect(result).toContain("running agent: daemon is not running; next `ouro up` will load the change")
    expect(result).not.toContain("emb-secret")
    expect(output).toContain("Connect embeddings for Slugger")
    expect(output).toContain("... saving memory embeddings")
    expect(output).toContain("... verifying memory embeddings")
    expect(output).toContain("storing integrations.openaiEmbeddingsApiKey")
    expect(output).toContain("✓ verifying memory embeddings")
    expect(output).toContain("... applying change to running Slugger")
    expect(output).not.toContain("emb-secret")

    const stored = readRuntimeSecret("Slugger")
    expect(stored.config).toMatchObject({
      integrations: {
        openaiEmbeddingsApiKey: "emb-secret",
      },
    })
  })

  it("does not claim Perplexity is connected when the live check fails", async () => {
    emitTestEvent("provider cli connect perplexity verify failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-verify-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-verify-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      error: { message: "bad api key" },
    }, {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }))

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async () => "pplx-secret",
    })
    const result = await runOuroCli(["connect", "perplexity", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("Perplexity key was saved for Slugger, but the live check failed")
    expect(result).toContain("stored: vault:Slugger:runtime/config")
    expect(result).toContain("live check:")
    expect(result).not.toContain("Perplexity connected for Slugger")
    expect(output).toContain("✗ verifying Perplexity search")
  })

  it("renders a shared TTY failure board when Perplexity live verification fails", async () => {
    emitTestEvent("provider cli connect perplexity tty verify failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-perplexity-tty-verify-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-perplexity-tty-verify-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      error: { message: "bad api key" },
    }, {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }))

    const result = await runOuroCli(["connect", "perplexity", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      isTTY: true,
      stdoutColumns: 88,
      promptSecret: async () => "pplx-secret",
    }))

    expect(result).toContain("Capability needs attention")
    expect(result).toContain("Perplexity search was saved, but the live check failed.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
  })

  it("does not claim embeddings are connected when the live check fails", async () => {
    emitTestEvent("provider cli connect embeddings verify failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-embeddings-verify-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-embeddings-verify-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      error: { message: "bad embeddings key" },
    }, {
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    }))

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async () => "emb-secret",
    })
    const result = await runOuroCli(["connect", "embeddings", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("Embeddings key was saved for Slugger, but the live check failed")
    expect(result).toContain("stored: vault:Slugger:runtime/config")
    expect(result).toContain("live check:")
    expect(result).not.toContain("Embeddings connected for Slugger")
    expect(output).toContain("✗ verifying memory embeddings")
  })

  it("verifies saved portable capabilities when the root connect bay opens", async () => {
    emitTestEvent("provider cli connect menu live capability verification")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-live-capability-verification-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-live-capability-verification-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    writeRuntimeConfig("Slugger", {
      integrations: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "emb-secret",
      },
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expect(prompt).toContain("verified live just now")
    expectConnectStatus(prompt, 2, "Perplexity search", "ready")
    expectConnectStatus(prompt, 3, "Memory embeddings", "ready")
  })

  it("marks saved portable capabilities as needing attention when their live checks fail", async () => {
    emitTestEvent("provider cli connect menu failed capability verification")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-failed-capability-verification-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-failed-capability-verification-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    writeRuntimeConfig("Slugger", {
      integrations: {
        perplexityApiKey: "pplx-secret",
        openaiEmbeddingsApiKey: "emb-secret",
      },
    })
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({
        error: { message: "bad perplexity key" },
      }, {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        error: { message: "bad embeddings key" },
      }, {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      }))

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 2, "Perplexity search", "needs attention")
    expectConnectStatus(prompt, 3, "Memory embeddings", "needs attention")
    expect(prompt).toContain("live check failed: 401 bad perplexity key")
    expect(prompt).toContain("live check failed: 401 bad embeddings key")
  })

  it("connects Teams through a guided flow and enables the sense", async () => {
    emitTestEvent("provider cli connect teams")
    const bundlesRoot = makeTempDir("provider-cli-connect-teams-bundles")
    const homeDir = makeTempDir("provider-cli-connect-teams-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const answers = [
      "teams-client-id",
      "teams-tenant-id",
      "teams-managed-identity",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async (question) => {
        expect(question).not.toContain("secret")
        return answers.shift() ?? ""
      },
      promptSecret: async (question) => {
        expect(question).toBe("Teams client secret: ")
        return "teams-secret"
      },
    })
    const result = await runOuroCli(["connect", "teams", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("Teams connected for Slugger")
    expect(result).toContain("senses.teams.enabled = true")
    expect(result).toContain("run `ouro up` so the daemon picks up the Teams sense change")
    expect(result).not.toContain("teams-secret")
    expect(output).toContain("Connect Teams for Slugger")
    expect(output).toContain("... saving Teams setup")
    expect(output).toContain("storing teams.clientId")
    expect(output).toContain("storing teams.clientSecret")
    expect(output).toContain("storing teams.tenantId")
    expect(output).not.toContain("teams-secret")

    const stored = readRuntimeSecret("Slugger")
    expect(stored.config).toMatchObject({
      teams: {
        clientId: "teams-client-id",
        clientSecret: "teams-secret",
        tenantId: "teams-tenant-id",
        managedIdentityClientId: "teams-managed-identity",
      },
    })
    expect(readAgentConfig(bundlesRoot, "Slugger").senses).toMatchObject({
      teams: { enabled: true },
    })
  })

  it("renders a richer TTY onboarding board and shared completion board for Teams", async () => {
    emitTestEvent("provider cli connect teams tty boards")
    const bundlesRoot = makeTempDir("provider-cli-connect-teams-tty-bundles")
    const homeDir = makeTempDir("provider-cli-connect-teams-tty-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const answers = [
      "teams-client-id",
      "teams-tenant-id",
      "",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      isTTY: true,
      stdoutColumns: 88,
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "teams-secret",
    })
    const result = await runOuroCli(["connect", "teams", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(output).toContain("Connect Teams")
    expect(output).toContain("Unlocks")
    expect(output).toContain("What you need")
    expect(output).toContain("Where it lives")
    expect(result).toContain("Capability connected")
    expect(result).toContain("Teams is ready for Slugger.")
    expect(result).toContain("What changed")
    expect(result).toContain("Next moves")
  })

  it("reports bundle sync from Teams onboarding when the bundle is sync-enabled", async () => {
    emitTestEvent("provider cli connect teams bundle sync")
    const bundlesRoot = makeTempDir("provider-cli-connect-teams-sync-bundles")
    const homeDir = makeTempDir("provider-cli-connect-teams-sync-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.sync = { enabled: true }
    })
    initBundleGit(agentRoot(bundlesRoot, "Slugger"))

    const answers = [
      "teams-client-id",
      "teams-tenant-id",
      "",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "teams-secret",
    })
    const result = await runOuroCli(["connect", "teams", "--agent", "Slugger"], deps)

    expect(result).toContain("bundle sync: ran post-change sync (remote: origin)")
    expect(execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: agentRoot(bundlesRoot, "Slugger"),
      stdio: "pipe",
    }).toString()).toContain("sync: post-turn update")
  })

  it("rejects blank required Teams fields before storing anything", async () => {
    emitTestEvent("provider cli connect teams blank fields")
    const bundlesRoot = makeTempDir("provider-cli-connect-teams-blank-bundles")
    const homeDir = makeTempDir("provider-cli-connect-teams-blank-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["connect", "teams", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "",
      promptSecret: async () => "teams-secret",
    }))).rejects.toThrow("Teams client ID cannot be blank")

    await expect(runOuroCli(["connect", "teams", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "teams-client-id",
      promptSecret: async () => "",
    }))).rejects.toThrow("Teams client secret cannot be blank")

    const tenantAnswers = ["teams-client-id", ""]
    await expect(runOuroCli(["connect", "teams", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => tenantAnswers.shift() ?? "",
      promptSecret: async () => "teams-secret",
    }))).rejects.toThrow("Teams tenant ID cannot be blank")
  })

  it("routes provider auth through the connect hub without making the human remember the auth command", async () => {
    emitTestEvent("provider cli connect providers")
    const bundlesRoot = makeTempDir("provider-cli-connect-providers-bundles")
    const homeDir = makeTempDir("provider-cli-connect-providers-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    mockPingProvider.mockResolvedValue({ ok: true, message: "ok", attempts: 1 })

    const runAuthFlow = vi.fn(async ({ agentName, provider }: { agentName: string; provider: string }) => {
      writeProviderCredentialPool(homeDir, credentialPool({
        providers: {
          minimax: {
            provider: "minimax",
            revision: "cred_minimax_connect",
            updatedAt: NOW,
            credentials: { apiKey: "minimax-key" },
            config: {},
            provenance: { source: "manual", updatedAt: NOW },
          },
        },
      }), agentName)
      return { message: `authenticated ${agentName} with ${provider}` }
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "providers", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      runAuthFlow,
      promptInput: async (question) => {
        prompts.push(question)
        return "minimax"
      },
    }))

    expect(prompts.join("\n")).toContain("Which provider should Slugger use credentials for?")
    expect(result).toContain("authenticated Slugger with minimax")
    expect(runAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "Slugger",
      provider: "minimax",
    }))
  })

  it("shows a direct noninteractive provider-auth fallback for connect providers", async () => {
    emitTestEvent("provider cli connect providers noninteractive")
    const bundlesRoot = makeTempDir("provider-cli-connect-providers-noninteractive-bundles")
    const homeDir = makeTempDir("provider-cli-connect-providers-noninteractive-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli(["connect", "providers", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("Provider auth for Slugger")
    expect(result).toContain("ouro auth --agent Slugger --provider openai-codex")
    expect(result).toContain("ouro auth --agent Slugger --provider anthropic")
    expect(result).toContain("ouro auth --agent Slugger --provider minimax")
    expect(result).toContain("ouro auth --agent Slugger --provider azure")
    expect(result).toContain("ouro auth --agent Slugger --provider github-copilot")
  })

  it("keeps provider auth guardrails friendly when connect providers hits an unknown choice", async () => {
    emitTestEvent("provider cli connect providers invalid choice")
    const bundlesRoot = makeTempDir("provider-cli-connect-providers-invalid-bundles")
    const homeDir = makeTempDir("provider-cli-connect-providers-invalid-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(["connect", "providers", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "definitely-not-a-provider",
    }))).rejects.toThrow(/Unknown provider 'definitely-not-a-provider'\. Use .*openai-codex.*anthropic.*minimax.*azure.*github-copilot\./)
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
    )).rejects.toThrow("secret entry requires an interactive terminal")
    await expect(runOuroCli(
      ["vault", "config", "set", "--agent", "Slugger", "--key", "teams.clientId"],
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

    const restartDeps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") return { ok: true, data: daemonStatusData("Slugger", "running") }
        return { ok: true }
      },
    })
    const restarted = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], restartDeps)
    const restartOutput = ((restartDeps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(restarted).toContain("refreshed provider credential snapshot for Slugger")
    expect(restarted).toContain("providers: minimax, anthropic")
    expect(restarted).toContain("running agent: restarted Slugger and the daemon reports it running")
    expect(restartOutput).toContain("... refreshing provider credentials")
    expect(restartOutput).toContain("reading vault items for Slugger")
    expect(restartOutput).toContain("✓ refreshing provider credentials")
    expect(restartOutput).toContain("... applying change to running Slugger")
    expect(restartOutput).toContain("checking whether Ouro is already running")
    expect(restartOutput).toContain("asking Ouro to reload Slugger")
    expect(restartOutput).toContain("waiting for Slugger to come back")
    expect(restartOutput).toContain("- reload request accepted")
    expect(restartOutput).toContain("- daemon reports Slugger/inner-dialog running")
    expect(restartOutput).toContain("✓ applying change to running Slugger")

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

  it("provider refresh times out cleanly when the daemon never reports the agent running again", async () => {
    emitTestEvent("provider cli refresh runtime-apply-timeout")
    const bundlesRoot = makeTempDir("provider-cli-refresh-timeout-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-timeout-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    let nowMs = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") return { ok: true, data: daemonStatusData("Slugger", "starting") }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
    expect(output).toContain("... applying change to running Slugger")
    expect(output).toContain("waiting for Slugger to come back")
    expect(output).toContain("- current worker state: starting")
    expect(output).toContain("✓ applying change to running Slugger")
  })

  it("provider refresh reports a timed out restart request when the daemon never answers", async () => {
    emitTestEvent("provider cli refresh restart-request-timeout")
    const bundlesRoot = makeTempDir("provider-cli-refresh-restart-timeout-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-restart-timeout-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    try {
      const deps = makeCliDeps(homeDir, bundlesRoot, {
        checkSocketAlive: async () => true,
        sendCommand: async (_socketPath, command) => {
          if (command.kind === "agent.restart") return new Promise<never>(() => {})
          return { ok: true }
        },
      })

      const runPromise = runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
      await vi.advanceTimersByTimeAsync(8_001)
      const result = await runPromise
      const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

      expect(result).toContain("daemon restart skipped: daemon restart request timed out")
      expect(output).toContain("... applying change to running Slugger")
      expect(output).toContain("asking Ouro to reload Slugger")
      expect(output).toContain("✓ applying change to running Slugger")
    } finally {
      vi.useRealTimers()
    }
  })

  it("provider refresh reports a crashed worker during runtime apply", async () => {
    emitTestEvent("provider cli refresh runtime-apply-crashed")
    const bundlesRoot = makeTempDir("provider-cli-refresh-crashed-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-crashed-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") {
          return { ok: true, data: daemonStatusData("Slugger", "crashed", { fixHint: "check logs" }) }
        }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger/inner-dialog crashed before reporting running: check logs")
    expect(output).toContain("... applying change to running Slugger")
  })

  it("provider refresh surfaces an explicit worker error reason during runtime apply", async () => {
    emitTestEvent("provider cli refresh runtime-apply-crashed-error-reason")
    const bundlesRoot = makeTempDir("provider-cli-refresh-crashed-error-reason-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-crashed-error-reason-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") {
          return { ok: true, data: daemonStatusData("Slugger", "crashed", { errorReason: "bad config" }) }
        }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)

    expect(result).toContain("running agent: restart requested, but Slugger/inner-dialog crashed before reporting running: bad config")
  })

  it("provider refresh still summarizes a crashed worker when no extra reason is available", async () => {
    emitTestEvent("provider cli refresh runtime-apply-crashed-no-reason")
    const bundlesRoot = makeTempDir("provider-cli-refresh-crashed-no-reason-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-crashed-no-reason-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") {
          return { ok: true, data: daemonStatusData("Slugger", "crashed") }
        }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)

    expect(result).toContain("running agent: restart requested, but Slugger/inner-dialog crashed before reporting running")
    expect(result).not.toContain(": undefined")
  })

  it("provider refresh keeps progress visible when daemon status returns an error response", async () => {
    emitTestEvent("provider cli refresh runtime-apply-status-error")
    const bundlesRoot = makeTempDir("provider-cli-refresh-status-error-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-status-error-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    let nowMs = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") return { ok: false, error: "status unavailable" }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
    expect(output).toContain("- latest status check: status unavailable")
  })

  it("provider refresh keeps progress visible when daemon status returns only a message", async () => {
    emitTestEvent("provider cli refresh runtime-apply-status-message")
    const bundlesRoot = makeTempDir("provider-cli-refresh-status-message-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-status-message-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    let nowMs = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") return { ok: false, message: "status said nope" }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
    expect(output).toContain("- latest status check: status said nope")
  })

  it("provider refresh falls back to unknown error text when daemon status returns no detail", async () => {
    emitTestEvent("provider cli refresh runtime-apply-status-unknown")
    const bundlesRoot = makeTempDir("provider-cli-refresh-status-unknown-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-status-unknown-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    let nowMs = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") return { ok: false }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
    expect(output).toContain("- latest status check: unknown error")
  })

  it("provider refresh keeps progress visible when daemon status throws", async () => {
    emitTestEvent("provider cli refresh runtime-apply-status-throws")
    const bundlesRoot = makeTempDir("provider-cli-refresh-status-throws-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-status-throws-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    let nowMs = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") throw "status probe blew up"
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
    expect(output).toContain("- latest status check: status probe blew up")
  })

  it("provider refresh keeps progress visible when daemon status throws an Error object", async () => {
    emitTestEvent("provider cli refresh runtime-apply-status-error-object")
    const bundlesRoot = makeTempDir("provider-cli-refresh-status-error-object-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-status-error-object-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    let nowMs = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") throw new Error("status error object")
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
    expect(output).toContain("- latest status check: status error object")
  })

  it("provider refresh explains when daemon status payload is not structured", async () => {
    emitTestEvent("provider cli refresh runtime-apply-unstructured-status")
    const bundlesRoot = makeTempDir("provider-cli-refresh-unstructured-status-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-unstructured-status-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const deps = makeCliDeps(homeDir, bundlesRoot, {
      checkSocketAlive: async () => true,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
        if (command.kind === "daemon.status") return { ok: true, data: { definitely: "not-status-payload" } }
        return { ok: true }
      },
    })

    const result = await runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

    expect(result).toContain("running agent: restart requested; daemon status is unavailable, so verify with `ouro status` if needed")
    expect(output).toContain("daemon status did not include structured worker state")
  })

  it("renders connect bay statuses when the machine-local runtime config is locked or malformed", async () => {
    emitTestEvent("provider cli connect menu machine runtime statuses")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-machine-runtime-statuses-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-machine-runtime-statuses-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    writeMachineIdentity(homeDir, "machine_menu_status")
    writeRuntimeConfig("Slugger", {
      integrations: { perplexityApiKey: "pplx-secret", openaiEmbeddingsApiKey: "embed-secret" },
      teams: { clientId: "teams-client-id" },
    })

    const originalGet = mockVaultDeps.rawSecrets.get.bind(mockVaultDeps.rawSecrets)
    mockVaultDeps.rawSecrets.get = ((key: string) => {
      if (key === "Slugger:runtime/machines/machine_menu_status/config") {
        throw new Error("vault locked on this machine")
      }
      return originalGet(key)
    }) as typeof mockVaultDeps.rawSecrets.get
    try {
      const prompts: string[] = []
      const deps = makeCliDeps(homeDir, bundlesRoot, {
        promptInput: async (question) => {
          prompts.push(question)
          return "cancel"
        },
      })
      const locked = await runOuroCli(["connect", "--agent", "Slugger"], deps)
      const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
      expect(locked).toBe("connect cancelled.")
      expect(output).toContain("... checking current connections")
      expect(output).toContain("loading this machine's settings")
      expectConnectStatus(joinedPrompt(prompts), 5, "BlueBubbles iMessage", "locked")
    } finally {
      mockVaultDeps.rawSecrets.get = originalGet as typeof mockVaultDeps.rawSecrets.get
    }

    mockVaultDeps.rawSecrets.set(
      "Slugger:runtime/machines/machine_menu_status/config",
      "{not-json",
    )
    const prompts: string[] = []
    const malformed = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))
    expect(malformed).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 5, "BlueBubbles iMessage", "needs attention")
  })

  it("shows BlueBubbles as attached in the connect bay when this machine is already configured", async () => {
    emitTestEvent("provider cli connect menu bluebubbles attached")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-bluebubbles-attached-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-bluebubbles-attached-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.senses = {
        ...(config.senses ?? {}),
        bluebubbles: { enabled: true },
      }
    })
    writeProviderCredentialPool(homeDir, credentialPool())
    writeMachineIdentity(homeDir, "machine_attached")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/machines/machine_attached/config", runtimeConfigSecret({
      bluebubbles: {
        serverUrl: "http://127.0.0.1:1234",
        password: "bb-password",
        accountId: "default",
      },
    }))

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 5, "BlueBubbles iMessage", "attached")
  })

  it("shows BlueBubbles as not attached when this machine config is incomplete", async () => {
    emitTestEvent("provider cli connect menu bluebubbles incomplete")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-bluebubbles-incomplete-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-bluebubbles-incomplete-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.senses = {
        ...(config.senses ?? {}),
        bluebubbles: { enabled: true },
      }
    })
    writeProviderCredentialPool(homeDir, credentialPool())
    writeMachineIdentity(homeDir, "machine_incomplete")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/machines/machine_incomplete/config", runtimeConfigSecret({
      bluebubbles: {
        password: "bb-password",
        accountId: "default",
      },
    }))

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 5, "BlueBubbles iMessage", "not attached")
  })

  it("renders portable runtime config trouble clearly in the connect bay", async () => {
    emitTestEvent("provider cli connect menu runtime-config-attention")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-runtime-config-attention-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-runtime-config-attention-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    mockVaultDeps.rawSecrets.set("Slugger:runtime/config", "{not-json")

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 2, "Perplexity search", "needs attention")
    expectConnectStatus(prompt, 3, "Memory embeddings", "needs attention")
    expectConnectStatus(prompt, 4, "Teams", "needs attention")
  })

  it("renders portable runtime config as locked when this machine cannot read the runtime vault item", async () => {
    emitTestEvent("provider cli connect menu runtime-config-locked")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-runtime-config-locked-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-runtime-config-locked-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const originalGet = mockVaultDeps.rawSecrets.get.bind(mockVaultDeps.rawSecrets)
    mockVaultDeps.rawSecrets.get = ((key: string) => {
      if (key === "Slugger:runtime/config") {
        throw new Error("vault locked for runtime config")
      }
      return originalGet(key)
    }) as typeof mockVaultDeps.rawSecrets.get
    try {
      const prompts: string[] = []
      const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
        promptInput: async (question) => {
          prompts.push(question)
          return "cancel"
        },
      }))

      expect(result).toBe("connect cancelled.")
      const prompt = joinedPrompt(prompts)
      expectConnectStatus(prompt, 2, "Perplexity search", "locked")
      expectConnectStatus(prompt, 3, "Memory embeddings", "locked")
      expectConnectStatus(prompt, 4, "Teams", "locked")
    } finally {
      mockVaultDeps.rawSecrets.get = originalGet as typeof mockVaultDeps.rawSecrets.get
    }
  })

  it("shows missing portable runtime modules when runtime config exists but is incomplete", async () => {
    emitTestEvent("provider cli connect menu runtime-config-incomplete")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-runtime-config-incomplete-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-runtime-config-incomplete-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    writeRuntimeConfig("Slugger", {
      integrations: { perplexityApiKey: "pplx-secret" },
      teams: { clientSecret: "teams-secret", tenantId: "tenant-id" },
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    const prompt = joinedPrompt(prompts)
    expectConnectStatus(prompt, 2, "Perplexity search", "ready")
    expectConnectStatus(prompt, 3, "Memory embeddings", "missing")
    expectConnectStatus(prompt, 4, "Teams", "missing")
  })

  it("keeps Teams marked missing until the sense is enabled, even when credentials already exist", async () => {
    emitTestEvent("provider cli connect menu teams disabled")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-teams-disabled-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-teams-disabled-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())
    writeRuntimeConfig("Slugger", {
      teams: {
        clientId: "teams-client-id",
        clientSecret: "teams-secret",
        tenantId: "tenant-id",
      },
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 4, "Teams", "missing")
  })

  it("shows Teams as ready in the connect bay when credentials exist and the sense is enabled", async () => {
    emitTestEvent("provider cli connect menu teams ready")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-teams-ready-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-teams-ready-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.senses = {
        ...(config.senses ?? {}),
        teams: { enabled: true },
      }
    })
    writeProviderCredentialPool(homeDir, credentialPool())
    writeRuntimeConfig("Slugger", {
      teams: {
        clientId: "teams-client-id",
        clientSecret: "teams-secret",
        tenantId: "tenant-id",
      },
    })

    const prompts: string[] = []
    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async (question) => {
        prompts.push(question)
        return "cancel"
      },
    }))

    expect(result).toBe("connect cancelled.")
    expectConnectStatus(joinedPrompt(prompts), 4, "Teams", "ready")
  })

  it("provider refresh leaves visible progress when vault refresh throws", async () => {
    emitTestEvent("provider cli refresh throws")
    const bundlesRoot = makeTempDir("provider-cli-refresh-throws-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-throws-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    mockProviderCredentials.refreshProviderCredentialPool.mockImplementationOnce(async (_agentName, options) => {
      options?.onProgress?.("opening credential vault")
      throw new Error("vault subprocess crashed")
    })
    const deps = makeCliDeps(homeDir, bundlesRoot)

    await expect(runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)).rejects.toThrow("vault subprocess crashed")

    const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")
    expect(output).toContain("... refreshing provider credentials")
    expect(output).toContain("opening credential vault")
    expect(output).not.toContain("✓ refreshing provider credentials")
  })

  it("provider refresh resolves the only discovered agent when --agent is omitted", async () => {
    emitTestEvent("provider cli refresh single discovered")
    const bundlesRoot = makeTempDir("provider-cli-refresh-single-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-single-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    const result = await runOuroCli(["provider", "refresh"], makeCliDeps(homeDir, bundlesRoot, {
      listDiscoveredAgents: () => ["Slugger"],
      checkSocketAlive: async () => false,
    }))

    expect(result).toContain("refreshed provider credential snapshot for Slugger")
  })

  it("provider refresh throws multi-agent guidance when --agent is omitted without prompt support", async () => {
    emitTestEvent("provider cli refresh missing agent throws")
    const bundlesRoot = makeTempDir("provider-cli-refresh-missing-agent-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-missing-agent-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentConfig(bundlesRoot, "Ouroboros")

    await expect(runOuroCli(["provider", "refresh"], makeCliDeps(homeDir, bundlesRoot, {
      listDiscoveredAgents: () => ["Slugger", "Ouroboros"],
    }))).rejects.toThrow("multiple agents found: Slugger, Ouroboros")
  })

  it("connect prompts for an agent when --agent is omitted and multiple bundles exist", async () => {
    emitTestEvent("provider cli connect prompt for agent")
    const bundlesRoot = makeTempDir("provider-cli-connect-agent-prompt-bundles")
    const homeDir = makeTempDir("provider-cli-connect-agent-prompt-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeAgentConfig(bundlesRoot, "Ouroboros")

    const promptInput = vi.fn()
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("cancel")

    const result = await runOuroCli(["connect"], makeCliDeps(homeDir, bundlesRoot, {
      listDiscoveredAgents: () => ["Slugger", "Ouroboros"],
      promptInput,
    }))

    expect(promptInput).toHaveBeenNthCalledWith(1, expect.stringContaining("Which agent should this use?"))
    expect(result).toBe("connect cancelled.")
  })

  it("provider refresh uses the default timer path and keeps progress visible when the daemon omits the agent", async () => {
    emitTestEvent("provider cli refresh runtime-apply-missing-worker")
    const bundlesRoot = makeTempDir("provider-cli-refresh-missing-worker-bundles")
    const homeDir = makeTempDir("provider-cli-refresh-missing-worker-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderCredentialPool(homeDir, credentialPool())

    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    try {
      const deps = makeCliDeps(homeDir, bundlesRoot, {
        checkSocketAlive: async () => true,
        sendCommand: async (_socketPath, command) => {
          if (command.kind === "agent.restart") return { ok: true, summary: "restarted" }
          if (command.kind === "daemon.status") return { ok: true, data: daemonStatusData("OtherAgent", "running") }
          return { ok: true }
        },
      })

      const runPromise = runOuroCli(["provider", "refresh", "--agent", "Slugger"], deps)
      await vi.advanceTimersByTimeAsync(16_000)
      const result = await runPromise
      const output = ((deps as OuroCliDeps & { _output: string[] })._output).join("")

      expect(result).toContain("running agent: restart requested, but Slugger did not report running before timeout")
      expect(output).toContain("- Slugger is not listed by daemon yet")
    } finally {
      vi.useRealTimers()
    }
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

    const deps = makeCliDeps(homeDir, bundlesRoot)
    const result = await runOuroCli(["status", "--agent", "Slugger"], deps)
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("")

    expect(result).toContain("provider status: Slugger")
    expect(output).toContain("... reading provider credentials")
    expect(output).toContain("✓ reading provider credentials")
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

  it("config models and config model show progress while reading GitHub Copilot credentials and checking models", async () => {
    emitTestEvent("provider cli config model progress")
    const bundlesRoot = makeTempDir("provider-cli-config-model-progress-bundles")
    const homeDir = makeTempDir("provider-cli-config-model-progress-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config["humanFacing"] = { provider: "github-copilot", model: "gpt-5.4" }
      config["agentFacing"] = { provider: "github-copilot", model: "gpt-5.4" }
    })
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        "github-copilot": {
          provider: "github-copilot",
          revision: "cred_github_1",
          updatedAt: NOW,
          credentials: { githubToken: "gh-secret" },
          config: { baseUrl: "https://api.githubcopilot.com" },
          provenance: { source: "auth-flow", updatedAt: NOW },
        },
      },
    }))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "gpt-5.4", capabilities: ["chat"] }] }),
    })) as unknown as typeof fetch

    const modelListDeps = makeCliDeps(homeDir, bundlesRoot, { fetchImpl })
    const models = await runOuroCli(["config", "models", "--agent", "Slugger"], modelListDeps)
    const modelListOutput = (modelListDeps as OuroCliDeps & { _output: string[] })._output.join("")
    expect(models).toContain("available models:")
    expect(models).toContain("gpt-5.4")
    expect(models).not.toContain("gh-secret")
    expect(modelListOutput).toContain("... reading github-copilot credentials")
    expect(modelListOutput).toContain("✓ reading github-copilot credentials")
    expect(modelListOutput).toContain("... listing github-copilot models")
    expect(modelListOutput).toContain("✓ listing github-copilot models")

    const modelSetDeps = makeCliDeps(homeDir, bundlesRoot, { fetchImpl })
    const updated = await runOuroCli(["config", "model", "--agent", "Slugger", "gpt-5.4"], modelSetDeps)
    const modelSetOutput = (modelSetDeps as OuroCliDeps & { _output: string[] })._output.join("")
    expect(updated).toContain("updated Slugger model")
    expect(updated).not.toContain("gh-secret")
    expect(modelSetOutput).toContain("... reading github-copilot credentials")
    expect(modelSetOutput).toContain("✓ reading github-copilot credentials")
    expect(modelSetOutput).toContain("... listing github-copilot models")
    expect(modelSetOutput).toContain("✓ listing github-copilot models")
    expect(modelSetOutput).toContain("... checking gpt-5.4")
    expect(modelSetOutput).toContain("✓ checking gpt-5.4")

    mockPingGithubCopilotModel.mockRejectedValueOnce(new Error("github ping exploded"))
    const thrownDeps = makeCliDeps(homeDir, bundlesRoot, { fetchImpl })
    await expect(runOuroCli(["config", "model", "--agent", "Slugger", "gpt-5.4"], thrownDeps))
      .rejects.toThrow("github ping exploded")
    const thrownOutput = (thrownDeps as OuroCliDeps & { _output: string[] })._output.join("")
    expect(thrownOutput).toContain("... checking gpt-5.4")
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

    const deps = makeCliDeps(homeDir, bundlesRoot)
    const result = await runOuroCli(["check", "--agent", "Slugger", "--lane", "inner"], deps)

    expect(result).toContain("Slugger inner")
    expect(result).toContain("minimax")
    expect(result).toContain("MiniMax-M2.5")
    expect(result).toContain("ready")
    const output = (deps as OuroCliDeps & { _output: string[] })._output.join("\n")
    expect(output).toContain("... reading minimax credentials")
    expect(output).toContain("reading vault items for Slugger...")
    expect(output).toContain("✓ reading minimax credentials")
    expect(output).toContain("... checking minimax / MiniMax-M2.5")
    expect(output).toContain("✓ checking minimax / MiniMax-M2.5")
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
