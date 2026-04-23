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
  credentialProbeList: vi.fn(async () => []),
  rawSecrets: new Map<string, string>(),
  storedItems: new Map<string, { username?: string; password: string; notes?: string }>(),
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
    store: async (domain: string, data: { username?: string; password: string; notes?: string }) => {
      mockVaultDeps.rawSecrets.set(`${agentName}:${domain}`, data.password)
      mockVaultDeps.storedItems.set(`${agentName}:${domain}`, data)
    },
    list: (...args: unknown[]) => mockVaultDeps.credentialProbeList(...args),
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
import * as mailroomReader from "../../../mailroom/reader"
import {
  readProviderState,
  writeProviderState,
  type ProviderState,
} from "../../../heart/provider-state"
import { resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import { provisionMailboxRegistry } from "../../../mailroom/core"

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

const HOSTED_MAIL_CONTROL_URL = "https://mail-control.ouro.test"
const HOSTED_MAIL_CONTROL_TOKEN = "hosted-control-secret"
const HOSTED_BLOB_ACCOUNT_URL = "https://stourotest.blob.core.windows.net"
const HOSTED_NATIVE_KEY = "hosted-native-private-key"
const HOSTED_SOURCE_KEY = "hosted-source-private-key"
const HOSTED_ROTATED_NATIVE_KEY = "hosted-rotated-native-private-key"
const HOSTED_ROTATED_SOURCE_KEY = "hosted-rotated-source-private-key"

function writeHostedWorkSubstrateConfig(agentName: string, mailroom?: Record<string, unknown>): void {
  writeRuntimeConfig(agentName, {
    workSubstrate: {
      mode: "hosted",
      mailControl: {
        url: HOSTED_MAIL_CONTROL_URL,
        token: HOSTED_MAIL_CONTROL_TOKEN,
      },
    },
    ...(mailroom ? { mailroom } : {}),
  })
}

function fetchRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
}

function fetchHeader(init: RequestInit | undefined, key: string): string | undefined {
  const headers = init?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(key) ?? undefined
  if (Array.isArray(headers)) {
    const match = headers.find(([name]) => name.toLowerCase() === key.toLowerCase())
    return match?.[1]
  }
  const record = headers as Record<string, string>
  return record[key] ?? record[key.toLowerCase()] ?? record[key.toUpperCase()]
}

function expectHostedEnsureRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  expectedBody: Record<string, unknown>,
): void {
  expect(fetchRequestUrl(input)).toBe(`${HOSTED_MAIL_CONTROL_URL}/v1/mailboxes/ensure`)
  expect(init?.method).toBe("POST")
  expect(fetchHeader(init, "authorization")).toBe(`Bearer ${HOSTED_MAIL_CONTROL_TOKEN}`)
  expect(fetchHeader(init, "content-type")).toBe("application/json")
  expect(JSON.parse(String(init?.body))).toEqual(expectedBody)
}

function expectHostedRotateRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  expectedBody: Record<string, unknown>,
): void {
  expect(fetchRequestUrl(input)).toBe(`${HOSTED_MAIL_CONTROL_URL}/v1/mailboxes/rotate-keys`)
  expect(init?.method).toBe("POST")
  expect(fetchHeader(init, "authorization")).toBe(`Bearer ${HOSTED_MAIL_CONTROL_TOKEN}`)
  expect(fetchHeader(init, "content-type")).toBe("application/json")
  expect(JSON.parse(String(init?.body))).toEqual(expectedBody)
}

function hostedEnsureResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ok: true,
    mailboxAddress: "slugger@ouro.bot",
    sourceAlias: "me.mendelow.ari.slugger@ouro.bot",
    addedMailbox: true,
    addedSourceGrant: true,
    generatedPrivateKeys: {
      mail_slugger_native: HOSTED_NATIVE_KEY,
      mail_slugger_hey: HOSTED_SOURCE_KEY,
    },
    mailbox: {
      agentId: "slugger",
      mailboxId: "mailbox_slugger",
      canonicalAddress: "slugger@ouro.bot",
      keyId: "mail_slugger_native",
      defaultPlacement: "screener",
    },
    sourceGrant: {
      grantId: "grant_slugger_hey_9f8b26a4",
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: "me.mendelow.ari.slugger@ouro.bot",
      keyId: "mail_slugger_hey",
      defaultPlacement: "imbox",
      enabled: true,
    },
    publicRegistry: {
      kind: "azure-blob",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      container: "mailroom",
      blob: "registry/mailroom.json",
      domain: "ouro.bot",
      revision: "1:1:777",
    },
    blobStore: {
      kind: "azure-blob",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      container: "mailroom",
    },
    ...overrides,
  }
}

function hostedRotateResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return hostedEnsureResponse({
    addedMailbox: false,
    addedSourceGrant: false,
    rotatedMailbox: true,
    rotatedSourceGrant: true,
    generatedPrivateKeys: {
      mail_slugger_native_rotated: HOSTED_ROTATED_NATIVE_KEY,
      mail_slugger_hey_rotated: HOSTED_ROTATED_SOURCE_KEY,
    },
    mailbox: {
      agentId: "slugger",
      mailboxId: "mailbox_slugger",
      canonicalAddress: "slugger@ouro.bot",
      keyId: "mail_slugger_native_rotated",
      defaultPlacement: "screener",
    },
    sourceGrant: {
      grantId: "grant_slugger_hey_9f8b26a4",
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: "me.mendelow.ari.slugger@ouro.bot",
      keyId: "mail_slugger_hey_rotated",
      defaultPlacement: "imbox",
      enabled: true,
    },
    publicRegistry: {
      kind: "azure-blob",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      container: "mailroom",
      blob: "registry/mailroom.json",
      domain: "ouro.bot",
      revision: "1:1:900",
    },
    ...overrides,
  })
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

function expectConnectStatus(prompt: string, option: number, name: string, status: string): void {
  const symbol = status === "ready" || status === "attached"
    ? "●"
    : status === "not attached"
      ? "◌"
      : "◆"
  const plain = stripAnsi(prompt)
  expect(plain).toContain(`${option}. ${name}`)
  expect(plain).toContain(`${symbol} ${status}`)
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
  mockVaultDeps.credentialProbeList.mockReset()
  mockVaultDeps.credentialProbeList.mockResolvedValue([])
  mockVaultDeps.rawSecrets.clear()
  mockVaultDeps.storedItems.clear()
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
    expect(parseOuroCommand([
      "vault", "item", "set",
      "--agent", "Slugger",
      "--item", "ops/porkbun/ari@mendelow.me",
      "--template", "porkbun-api",
      "--note", "human context",
    ])).toEqual({
      kind: "vault.item.set",
      agent: "Slugger",
      item: "ops/porkbun/ari@mendelow.me",
      template: "porkbun-api",
      note: "human context",
    })
    expect(parseOuroCommand([
      "vault", "item", "set",
      "--agent", "Slugger",
      "--item", "ops/custom/service",
      "--secret-field", "apiKey",
      "--secret-field", "secretApiKey",
      "--public-field", "account=ari@mendelow.me",
    ])).toEqual({
      kind: "vault.item.set",
      agent: "Slugger",
      item: "ops/custom/service",
      secretFields: ["apiKey", "secretApiKey"],
      publicFields: ["account=ari@mendelow.me"],
    })
    expect(parseOuroCommand(["vault", "item", "status", "--agent", "Slugger", "--item", "ops/custom/service"])).toEqual({
      kind: "vault.item.status",
      agent: "Slugger",
      item: "ops/custom/service",
    })
    expect(parseOuroCommand(["vault", "item", "status", "--item", "ops/custom/service"])).toEqual({
      kind: "vault.item.status",
      item: "ops/custom/service",
    })
    expect(parseOuroCommand(["vault", "item", "list", "--agent", "Slugger", "--prefix", "ops/"])).toEqual({
      kind: "vault.item.list",
      agent: "Slugger",
      prefix: "ops/",
    })
    expect(parseOuroCommand(["vault", "item", "list"])).toEqual({
      kind: "vault.item.list",
    })
    expect(parseOuroCommand(["vault", "item", "set", "--item", "ops/custom/service", "--secret-field", "apiKey"])).toEqual({
      kind: "vault.item.set",
      item: "ops/custom/service",
      secretFields: ["apiKey"],
    })
    expect(parseOuroCommand(["vault", "item", "set", "--item", "ops/custom/service", "--secret-field", "apiKey", "--note"])).toEqual({
      kind: "vault.item.set",
      item: "ops/custom/service",
      secretFields: ["apiKey"],
      note: "",
    })
    expect(() => parseOuroCommand(["vault", "item", "delete"])).toThrow("ouro vault item set|status|list")
    expect(() => parseOuroCommand(["vault", "item", "status"])).toThrow("ouro vault item status")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "/ops/service", "--secret-field", "apiKey"]))
      .toThrow("Vault item name/path")
    expect(() => parseOuroCommand(["vault", "item", "list", "--prefix"]))
      .toThrow("Vault item prefix")
    expect(() => parseOuroCommand(["vault", "item", "list", "--prefix", ""]))
      .toThrow("Vault item prefix")
    expect(() => parseOuroCommand(["vault", "item", "list", "--prefix", "ops\tbad"]))
      .toThrow("Vault item prefix")
    expect(() => parseOuroCommand(["vault", "item", "list", "--prefix", "/ops"]))
      .toThrow("Vault item prefix")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service", "--template", "aws"]))
      .toThrow("vault item --template")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service", "--secret-field", "bad=field"]))
      .toThrow("Vault item field names")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service", "--secret-field", "apiKey", "--public-field"]))
      .toThrow("vault item --public-field")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service", "--secret-field", "apiKey", "--public-field", "bad"]))
      .toThrow("vault item --public-field")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service", "--secret-field", "apiKey", "--public-field", "account="]))
      .toThrow("vault item --public-field")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service", "--secret-field", "apiKey", "--bad"]))
      .toThrow("Usage: ouro vault item set")
    expect(() => parseOuroCommand(["vault", "item", "set", "--item", "ops/service"]))
      .toThrow("requires --secret-field")
    expect(parseOuroCommand(["vault", "ops", "porkbun", "set", "--agent", "Slugger", "--account", "ari@mendelow.me"])).toEqual({
      kind: "vault.item.set",
      agent: "Slugger",
      item: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      template: "porkbun-api",
      compatibilityAlias: "vault ops porkbun",
    })
    expect(parseOuroCommand(["vault", "ops", "porkbun", "set", "--account", "ari@mendelow.me"])).toEqual({
      kind: "vault.item.set",
      item: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      template: "porkbun-api",
      compatibilityAlias: "vault ops porkbun",
    })
    expect(parseOuroCommand(["vault", "ops", "porkbun", "status", "--agent", "Slugger", "--account", "ari@mendelow.me"])).toEqual({
      kind: "vault.item.status",
      agent: "Slugger",
      item: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      compatibilityAlias: "vault ops porkbun",
    })
    expect(parseOuroCommand(["vault", "ops", "porkbun", "status", "--account", "ari@mendelow.me"])).toEqual({
      kind: "vault.item.status",
      item: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      compatibilityAlias: "vault ops porkbun",
    })
    expect(parseOuroCommand(["vault", "ops", "porkbun", "status"])).toEqual({
      kind: "vault.item.list",
      prefix: "ops/registrars/porkbun/accounts",
      compatibilityAlias: "vault ops porkbun",
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
    expect(() => parseOuroCommand(["vault", "ops", "porkbun", "set", "--agent", "Slugger"]))
      .toThrow("ouro vault ops porkbun set")
    expect(() => parseOuroCommand(["vault", "ops", "porkbun", "set", "--agent", "Slugger", "--account", "ari/mendelow.me"]))
      .toThrow("Porkbun account")
    expect(() => parseOuroCommand(["vault", "ops", "porkbun", "status", "--account"]))
      .toThrow("Porkbun account")
    expect(() => parseOuroCommand(["vault", "ops", "dnsimple", "set", "--agent", "Slugger"]))
      .toThrow("ouro vault ops porkbun")
    expect(() => parseOuroCommand(["vault", "ops", "porkbun", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault ops porkbun")
    expect(() => parseOuroCommand(["vault", "ops", "porkbun", "status", "--bad"]))
      .toThrow("ouro vault ops porkbun status")
    expect(() => parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--store", "bad"]))
      .toThrow("vault --store")
    expect(() => parseOuroCommand(["vault", "unlock", "--agent", "Slugger", "--bad"]))
      .toThrow("ouro vault create|replace|recover|unlock|status [--agent <name>]")
    expect(() => parseOuroCommand(["vault", "delete", "--agent", "Slugger"]))
      .toThrow("ouro vault create|replace|recover|unlock|status [--agent <name>]")
  })

  it("parses DNS workflow commands as binding-backed operations", () => {
    emitTestEvent("provider cli parse dns workflow")
    const bindingPath = "infra/dns/ouro.bot.binding.json"

    expect(parseOuroCommand(["dns", "backup", "--agent", "Slugger", "--binding", bindingPath, "--output", "slugger/tasks/dns-backup.json"])).toEqual({
      kind: "dns.workflow",
      action: "backup",
      agent: "Slugger",
      bindingPath,
      outputPath: "slugger/tasks/dns-backup.json",
    })
    expect(parseOuroCommand(["dns", "plan", "--agent", "Slugger", "--binding", bindingPath])).toEqual({
      kind: "dns.workflow",
      action: "plan",
      agent: "Slugger",
      bindingPath,
    })
    expect(parseOuroCommand(["dns", "apply", "--agent", "Slugger", "--binding", bindingPath, "--yes"])).toEqual({
      kind: "dns.workflow",
      action: "apply",
      agent: "Slugger",
      bindingPath,
      yes: true,
    })
    expect(parseOuroCommand(["dns", "verify", "--binding", bindingPath])).toEqual({
      kind: "dns.workflow",
      action: "verify",
      bindingPath,
    })
    expect(parseOuroCommand(["dns", "certificate", "--agent", "Slugger", "--binding", bindingPath, "--output", "slugger/tasks/dns-cert.json"])).toEqual({
      kind: "dns.workflow",
      action: "certificate",
      agent: "Slugger",
      bindingPath,
      outputPath: "slugger/tasks/dns-cert.json",
    })
    expect(parseOuroCommand(["dns", "rollback", "--binding", bindingPath, "--backup", "slugger/tasks/dns-backup.json", "--yes"])).toEqual({
      kind: "dns.workflow",
      action: "rollback",
      bindingPath,
      backupPath: "slugger/tasks/dns-backup.json",
      yes: true,
    })

    expect(() => parseOuroCommand(["dns", "apply", "--agent", "Slugger", "--binding", bindingPath]))
      .toThrow("dns apply requires --yes after a reviewed dry-run")
    expect(() => parseOuroCommand(["dns", "list", "--agent", "Slugger", "--binding", bindingPath]))
      .toThrow("Usage: ouro dns backup|plan|apply|verify|rollback|certificate")
    expect(() => parseOuroCommand(["dns", "plan", "--agent", "Slugger"]))
      .toThrow("Usage: ouro dns plan [--agent <name>] --binding <path>")
    expect(() => parseOuroCommand(["dns", "plan", "--agent", "Slugger", "--binding"]))
      .toThrow("dns --binding must be a non-empty path without control characters")
    expect(() => parseOuroCommand(["dns", "plan", "--agent", "Slugger", "--binding", " \t"]))
      .toThrow("dns --binding must be a non-empty path without control characters")
    expect(() => parseOuroCommand(["dns", "rollback", "--agent", "Slugger", "--binding", bindingPath]))
      .toThrow("dns rollback requires --backup <path>")
    expect(() => parseOuroCommand(["dns", "rollback", "--agent", "Slugger", "--binding", bindingPath, "--backup", "slugger/tasks/dns-backup.json"]))
      .toThrow("dns rollback requires --yes after choosing a backup")
    expect(() => parseOuroCommand(["dns", "plan", "--agent", "Slugger", "--binding", bindingPath, "--bad"]))
      .toThrow("Usage: ouro dns plan [--agent <name>] --binding <path>")
    expect(() => parseOuroCommand(["dns", "plan", "--agent", "Slugger", "--binding", bindingPath, "--credential-item", "ops/registrars/porkbun/accounts/ari@mendelow.me"]))
      .toThrow("credential item belongs in the DNS workflow binding")
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
    expect(parseOuroCommand(["connect", "mail", "--agent", "Slugger"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "mail",
    })
    expect(parseOuroCommand(["connect", "mail", "--agent", "Slugger", "--owner-email", "ari@mendelow.me", "--source", "hey"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "mail",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(parseOuroCommand(["connect", "mail", "--agent", "Slugger", "--owner-email", "ari@mendelow.me", "--source", "hey", "--rotate-missing-mail-keys"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "mail",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      rotateMissingMailKeys: true,
    })
    expect(parseOuroCommand(["connect", "mail", "--agent", "Slugger", "--no-delegated-source"])).toEqual({
      kind: "connect",
      agent: "Slugger",
      target: "mail",
      noDelegatedSource: true,
    })
    expect(parseOuroCommand(["mail", "import-mbox", "--file", "/tmp/hey.mbox", "--owner-email", "ari@mendelow.me", "--source", "hey", "--agent", "Slugger"])).toEqual({
      kind: "mail.import-mbox",
      agent: "Slugger",
      filePath: "/tmp/hey.mbox",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(parseOuroCommand(["mail", "import-mbox", "--file", "/tmp/hey.mbox"])).toEqual({
      kind: "mail.import-mbox",
      filePath: "/tmp/hey.mbox",
    })
    expect(parseOuroCommand(["account", "ensure", "--agent", "Slugger"])).toEqual({
      kind: "account.ensure",
      agent: "Slugger",
    })
    expect(parseOuroCommand(["account", "ensure", "--agent", "Slugger", "--owner-email", "ari@mendelow.me", "--source", "hey"])).toEqual({
      kind: "account.ensure",
      agent: "Slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(parseOuroCommand(["account", "ensure", "--agent", "Slugger", "--owner-email", "ari@mendelow.me", "--source", "hey", "--rotate-missing-mail-keys"])).toEqual({
      kind: "account.ensure",
      agent: "Slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      rotateMissingMailKeys: true,
    })
    expect(parseOuroCommand(["account", "ensure", "--agent", "Slugger", "--no-delegated-source"])).toEqual({
      kind: "account.ensure",
      agent: "Slugger",
      noDelegatedSource: true,
    })
    expect(parseOuroCommand(["account", "ensure"])).toEqual({
      kind: "account.ensure",
    })
    expect(() => parseOuroCommand(["connect", "perplexity", "bluebubbles", "--agent", "Slugger"])).toThrow("providers|perplexity|embeddings|teams|bluebubbles|mail")
    expect(() => parseOuroCommand(["connect", "unknown", "--agent", "Slugger"])).toThrow("providers|perplexity|embeddings|teams|bluebubbles|mail")
    expect(() => parseOuroCommand(["connect", "teams", "--agent", "Slugger", "--owner-email", "ari@mendelow.me"])).toThrow("Mail source flags require")
    expect(() => parseOuroCommand(["connect", "mail", "--agent", "Slugger", "--owner-email"])).toThrow("ouro connect")
    expect(() => parseOuroCommand(["connect", "mail", "--agent", "Slugger", "--source", "hey"])).toThrow("--source requires --owner-email")
    expect(() => parseOuroCommand(["account", "ensure", "--agent", "Slugger", "--owner-email", "ari@mendelow.me", "--source"])).toThrow("ouro account ensure")
    expect(() => parseOuroCommand(["account", "ensure", "--agent", "Slugger", "--no-delegated-source", "--owner-email", "ari@mendelow.me"])).toThrow("--no-delegated-source")
    expect(() => parseOuroCommand(["mail"])).toThrow("ouro mail import-mbox")
    expect(() => parseOuroCommand(["mail", "status"])).toThrow("ouro mail import-mbox")
    expect(() => parseOuroCommand(["mail", "import-mbox", "--file"])).toThrow("ouro mail import-mbox")
    expect(() => parseOuroCommand(["mail", "import-mbox", "--owner-email", "ari@mendelow.me"])).toThrow("ouro mail import-mbox")
    expect(() => parseOuroCommand(["account"])).toThrow("ouro account ensure")
    expect(() => parseOuroCommand(["account", "reset"])).toThrow("ouro account ensure")
    expect(() => parseOuroCommand(["account", "ensure", "extra"])).toThrow("ouro account ensure")
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
  it("connects Mail as a vault-coupled portable agent sense", async () => {
    emitTestEvent("provider cli connect mail")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const answers = ["ari@mendelow.me", "hey"]

    const result = await runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
    }))

    expect(result).toContain("Agent Mail connected for Slugger")
    expect(result).toContain("mailbox: slugger@ouro.bot")
    expect(result).toContain("delegated alias: me.mendelow.ari.slugger@ouro.bot")
    expect(result).toContain("private mail keys were not printed")
    expect(result).not.toContain("PRIVATE KEY")
    const stored = readRuntimeSecret("Slugger")
    expect(stored.config.mailroom).toEqual(expect.objectContaining({
      mailboxAddress: "slugger@ouro.bot",
      registryPath: path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom", "registry.json"),
      storePath: path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom"),
    }))
    const privateKeys = (stored.config.mailroom as Record<string, unknown>).privateKeys as Record<string, string>
    expect(Object.keys(privateKeys)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^mail_slugger-/),
      expect.stringMatching(/^mail_slugger-native_/),
    ]))
    expect(Object.values(privateKeys).every((value) => value.includes("BEGIN PRIVATE KEY"))).toBe(true)
    const registryPath = (stored.config.mailroom as Record<string, unknown>).registryPath as string
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as { sourceGrants: Array<Record<string, unknown>> }
    expect(registry.sourceGrants[0]).toMatchObject({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: "me.mendelow.ari.slugger@ouro.bot",
    })
    expect(readAgentConfig(bundlesRoot, "Slugger").senses).toMatchObject({
      mail: { enabled: true },
    })
  })

  it("connects Mail without a delegated source alias and preserves SerpentGuide as vaultless", async () => {
    emitTestEvent("provider cli connect mail no delegated source")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-no-source-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-no-source-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    updateAgentConfig(bundlesRoot, "Slugger", (config) => {
      config.sync = { enabled: true, remote: "origin" }
    })

    const result = await runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => "",
    }))

    expect(result).toContain("mailbox: slugger@ouro.bot")
    expect(result).not.toContain("delegated alias:")
    expect(result).toContain("bundle sync: could not push bundle changes")
    await expect(runOuroCli(["connect", "mail", "--agent", "SerpentGuide"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "",
    }))).rejects.toThrow("SerpentGuide has no persistent runtime credentials")
  })

  it("routes Mail setup from the root connect bay", async () => {
    emitTestEvent("provider cli connect menu mail")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-mail-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-mail-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const answers = ["mail", ""]

    const result = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
    }))

    expect(result).toContain("Agent Mail connected for Slugger")
    expect(result).toContain("mailbox: slugger@ouro.bot")
  })

  it("lets agents run Mail setup non-interactively after collecting owner/source details", async () => {
    emitTestEvent("provider cli connect mail noninteractive flags")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-flags-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-flags-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const result = await runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
    }))

    expect(result).toContain("Agent Mail connected for Slugger")
    expect(result).toContain("mailbox: slugger@ouro.bot")
    expect(result).toContain("delegated alias: me.mendelow.ari.slugger@ouro.bot")
    const stored = readRuntimeSecret("Slugger")
    expect(stored.config.mailroom).toEqual(expect.objectContaining({
      mailboxAddress: "slugger@ouro.bot",
    }))
  })

  it("supports non-interactive Mail setup defaults for native-only and HEY source aliases", async () => {
    emitTestEvent("provider cli connect mail noninteractive defaults")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-defaults-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-defaults-home")
    writeAgentConfig(bundlesRoot, "NativeOnly")
    writeAgentConfig(bundlesRoot, "DefaultSource")
    writeAgentConfig(bundlesRoot, "BlankSource")
    writeAgentConfig(bundlesRoot, "BlankOwner")

    const nativeOnly = await runOuroCli([
      "account",
      "ensure",
      "--agent",
      "NativeOnly",
      "--no-delegated-source",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
    }))

    expect(nativeOnly).toContain("mailbox: nativeonly@ouro.bot")
    expect(nativeOnly).not.toContain("delegated alias:")

    const defaultSource = await runOuroCli([
      "account",
      "ensure",
      "--agent",
      "DefaultSource",
      "--owner-email",
      "ari@mendelow.me",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
    }))

    expect(defaultSource).toContain("mailbox: defaultsource@ouro.bot")
    expect(defaultSource).toContain("delegated alias: me.mendelow.ari.defaultsource@ouro.bot")

    const blankSource = await runOuroCli([
      "account",
      "ensure",
      "--agent",
      "BlankSource",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "   ",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
    }))

    expect(blankSource).toContain("mailbox: blanksource@ouro.bot")
    expect(blankSource).toContain("delegated alias: me.mendelow.ari.blanksource@ouro.bot")

    const blankOwner = await runOuroCli([
      "account",
      "ensure",
      "--agent",
      "BlankOwner",
      "--owner-email",
      "   ",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
    }))

    expect(blankOwner).toContain("mailbox: blankowner@ouro.bot")
    expect(blankOwner).not.toContain("delegated alias:")
  })

  it("preserves existing runtime config and defaults the delegated source label", async () => {
    emitTestEvent("provider cli connect mail preserves runtime")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-preserve-runtime-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-preserve-runtime-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeRuntimeConfig("Slugger", {
      integrations: {
        perplexityApiKey: "pplx-secret",
      },
    })
    const answers = ["ari@mendelow.me", ""]

    const result = await runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
    }))

    expect(result).toContain("delegated alias: me.mendelow.ari.slugger@ouro.bot")
    const stored = readRuntimeSecret("Slugger")
    expect(stored.config.integrations).toEqual({ perplexityApiKey: "pplx-secret" })
    const registryPath = (stored.config.mailroom as Record<string, unknown>).registryPath as string
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as { sourceGrants: Array<Record<string, unknown>> }
    expect(registry.sourceGrants[0]).toMatchObject({
      source: "hey",
      ownerEmail: "ari@mendelow.me",
    })
  })

  it("keeps Mail setup idempotent across reruns and source-grant additions", async () => {
    emitTestEvent("provider cli connect mail idempotent")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-idempotent-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-idempotent-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    const firstAnswers = ["", ""]
    await runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => firstAnswers.shift() ?? "",
    }))
    const firstStored = readRuntimeSecret("Slugger")
    const firstMailroom = firstStored.config.mailroom as Record<string, unknown>
    const firstPrivateKeys = firstMailroom.privateKeys as Record<string, string>
    const firstRegistryPath = firstMailroom.registryPath as string
    const firstRegistry = JSON.parse(fs.readFileSync(firstRegistryPath, "utf-8")) as { mailboxes: Array<Record<string, unknown>>; sourceGrants: Array<Record<string, unknown>> }
    expect(firstRegistry.sourceGrants).toHaveLength(0)

    const secondAnswers = ["ari@mendelow.me", "hey"]
    const second = await runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => secondAnswers.shift() ?? "",
    }))
    expect(second).toContain("Agent Mail connected for Slugger")
    expect(second).toContain("mailbox: slugger@ouro.bot")
    expect(second).toContain("delegated alias: me.mendelow.ari.slugger@ouro.bot")
    const secondStored = readRuntimeSecret("Slugger")
    const secondMailroom = secondStored.config.mailroom as Record<string, unknown>
    expect(secondMailroom.registryPath).toBe(firstRegistryPath)
    expect(secondMailroom.privateKeys).toEqual(expect.objectContaining(firstPrivateKeys))
    const secondRegistry = JSON.parse(fs.readFileSync(firstRegistryPath, "utf-8")) as { mailboxes: Array<Record<string, unknown>>; sourceGrants: Array<Record<string, unknown>> }
    expect(secondRegistry.mailboxes).toEqual(firstRegistry.mailboxes)
    expect(secondRegistry.sourceGrants).toHaveLength(1)

    const thirdAnswers = ["ari@mendelow.me", "hey"]
    await runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => thirdAnswers.shift() ?? "",
    }))
    const thirdStored = readRuntimeSecret("Slugger")
    const thirdMailroom = thirdStored.config.mailroom as Record<string, unknown>
    const thirdRegistry = JSON.parse(fs.readFileSync(firstRegistryPath, "utf-8")) as { mailboxes: Array<Record<string, unknown>>; sourceGrants: Array<Record<string, unknown>> }
    expect(thirdMailroom.privateKeys).toEqual(secondMailroom.privateKeys)
    expect(thirdRegistry.sourceGrants).toHaveLength(1)
  })

  it("uses hosted Mail Control for production account setup and stores returned Blob coordinates", async () => {
    emitTestEvent("provider cli hosted mail control account ensure")
    const bundlesRoot = makeTempDir("provider-cli-hosted-account-ensure-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-account-ensure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger")
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      expectHostedEnsureRequest(input, init, {
        agentId: "Slugger",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      })
      return mockJsonResponse(hostedEnsureResponse())
    })

    const result = await runOuroCli([
      "account",
      "ensure",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toContain("Ouro work substrate ready for Slugger")
    expect(result).toContain(`Hosted Mail Control: ${HOSTED_MAIL_CONTROL_URL}`)
    expect(result).toContain(`Blob store: ${HOSTED_BLOB_ACCOUNT_URL}/mailroom`)
    expect(result).toContain("private mail keys were not printed")
    expect(result).not.toContain(HOSTED_NATIVE_KEY)
    expect(result).not.toContain(HOSTED_SOURCE_KEY)
    const stored = readRuntimeSecret("Slugger")
    expect(stored.config.workSubstrate).toEqual(expect.objectContaining({
      mode: "hosted",
    }))
    expect(stored.config.mailroom).toEqual(expect.objectContaining({
      mode: "hosted",
      mailboxAddress: "slugger@ouro.bot",
      sourceAlias: "me.mendelow.ari.slugger@ouro.bot",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      azureContainer: "mailroom",
      registryAzureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      registryContainer: "mailroom",
      registryBlob: "registry/mailroom.json",
      registryDomain: "ouro.bot",
      registryRevision: "1:1:777",
      privateKeys: {
        mail_slugger_native: HOSTED_NATIVE_KEY,
        mail_slugger_hey: HOSTED_SOURCE_KEY,
      },
    }))
    expect(fs.existsSync(path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom", "registry.json"))).toBe(false)
    expect(readAgentConfig(bundlesRoot, "Slugger").senses).toMatchObject({
      mail: { enabled: true },
    })
  })

  it("preserves vault-held hosted mail keys when Mail Control returns no new secrets", async () => {
    emitTestEvent("provider cli hosted mail control preserves keys")
    const bundlesRoot = makeTempDir("provider-cli-hosted-preserve-keys-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-preserve-keys-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const privateKeys = {
      mail_slugger_native: HOSTED_NATIVE_KEY,
      mail_slugger_hey: HOSTED_SOURCE_KEY,
    }
    writeHostedWorkSubstrateConfig("Slugger", {
      mode: "hosted",
      mailboxAddress: "slugger@ouro.bot",
      sourceAlias: "me.mendelow.ari.slugger@ouro.bot",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      azureContainer: "mailroom",
      registryRevision: "1:1:700",
      privateKeys,
    })
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      expectHostedEnsureRequest(input, init, {
        agentId: "Slugger",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      })
      return mockJsonResponse(hostedEnsureResponse({
        addedMailbox: false,
        addedSourceGrant: false,
        generatedPrivateKeys: {},
        publicRegistry: {
          kind: "azure-blob",
          azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
          container: "mailroom",
          blob: "registry/mailroom.json",
          domain: "ouro.bot",
          revision: "1:1:778",
        },
      }))
    })

    await runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    const mailroom = readRuntimeSecret("Slugger").config.mailroom as Record<string, unknown>
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mailroom.privateKeys).toEqual(privateKeys)
    expect(mailroom.registryRevision).toBe("1:1:778")
  })

  it("ignores stale local registry paths during hosted Mail repair", async () => {
    emitTestEvent("provider cli hosted mail control ignores stale local registry")
    const bundlesRoot = makeTempDir("provider-cli-hosted-stale-local-registry-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-stale-local-registry-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const registryPath = path.join(mailStateDir, "registry.json")
    fs.writeFileSync(registryPath, "{not-json", "utf-8")
    writeHostedWorkSubstrateConfig("Slugger", {
      mailboxAddress: "stale-local@ouro.bot",
      registryPath,
      storePath: mailStateDir,
      privateKeys: {
        mail_slugger_old: "old-key",
      },
    })
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      expectHostedEnsureRequest(input, init, {
        agentId: "Slugger",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      })
      return mockJsonResponse(hostedEnsureResponse())
    })

    await runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    const mailroom = readRuntimeSecret("Slugger").config.mailroom as Record<string, unknown>
    expect(mailroom.mailboxAddress).toBe("slugger@ouro.bot")
    expect(mailroom.registryPath).toBeUndefined()
    expect(mailroom.storePath).toBeUndefined()
    expect(mailroom.privateKeys).toEqual({
      mail_slugger_old: "old-key",
      mail_slugger_native: HOSTED_NATIVE_KEY,
      mail_slugger_hey: HOSTED_SOURCE_KEY,
    })
  })

  it("reports hosted registry and vault drift when Mail Control no longer has a missing one-time key", async () => {
    emitTestEvent("provider cli hosted mail control drift")
    const bundlesRoot = makeTempDir("provider-cli-hosted-drift-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-drift-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger", {
      mode: "hosted",
      mailboxAddress: "slugger@ouro.bot",
      sourceAlias: "me.mendelow.ari.slugger@ouro.bot",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      azureContainer: "mailroom",
      privateKeys: {
        mail_slugger_native: HOSTED_NATIVE_KEY,
      },
    })
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      expectHostedEnsureRequest(input, init, {
        agentId: "Slugger",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      })
      return mockJsonResponse(hostedEnsureResponse({
        addedMailbox: false,
        addedSourceGrant: false,
        generatedPrivateKeys: {},
      }))
    })

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("--rotate-missing-mail-keys")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rotates missing hosted mail keys only when explicitly requested", async () => {
    emitTestEvent("provider cli hosted mail control rotates missing keys")
    const bundlesRoot = makeTempDir("provider-cli-hosted-rotate-missing-keys-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-rotate-missing-keys-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger", {
      mode: "hosted",
      mailboxAddress: "slugger@ouro.bot",
      sourceAlias: "me.mendelow.ari.slugger@ouro.bot",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      azureContainer: "mailroom",
      privateKeys: {},
    })
    fetchMock
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expectHostedEnsureRequest(input, init, {
          agentId: "Slugger",
          ownerEmail: "ari@mendelow.me",
          source: "hey",
        })
        return mockJsonResponse(hostedEnsureResponse({
          addedMailbox: false,
          addedSourceGrant: false,
          generatedPrivateKeys: {},
        }))
      })
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expectHostedRotateRequest(input, init, {
          agentId: "Slugger",
          ownerEmail: "ari@mendelow.me",
          source: "hey",
          rotateMailbox: true,
          rotateSourceGrant: true,
          reason: "missing private mail keys in agent vault",
        })
        return mockJsonResponse(hostedRotateResponse())
      })

    const result = await runOuroCli([
      "account",
      "ensure",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
      "--rotate-missing-mail-keys",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toContain("private mail keys were not printed")
    expect(result).not.toContain(HOSTED_ROTATED_NATIVE_KEY)
    expect(result).not.toContain(HOSTED_ROTATED_SOURCE_KEY)
    const mailroom = readRuntimeSecret("Slugger").config.mailroom as Record<string, unknown>
    expect(mailroom.registryRevision).toBe("1:1:900")
    expect(mailroom.privateKeys).toEqual({
      mail_slugger_native_rotated: HOSTED_ROTATED_NATIVE_KEY,
      mail_slugger_hey_rotated: HOSTED_ROTATED_SOURCE_KEY,
    })
  })

  it("rotates a missing native hosted key through connect mail without creating a delegated source", async () => {
    emitTestEvent("provider cli hosted mail control rotates native key through connect")
    const bundlesRoot = makeTempDir("provider-cli-hosted-rotate-native-connect-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-rotate-native-connect-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger", {
      mode: "hosted",
      mailboxAddress: "slugger@ouro.bot",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      azureContainer: "mailroom",
      privateKeys: {},
    })
    fetchMock
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expectHostedEnsureRequest(input, init, {
          agentId: "Slugger",
        })
        return mockJsonResponse(hostedEnsureResponse({
          addedMailbox: false,
          addedSourceGrant: false,
          sourceAlias: undefined,
          sourceGrant: undefined,
          generatedPrivateKeys: {},
        }))
      })
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expectHostedRotateRequest(input, init, {
          agentId: "Slugger",
          rotateMailbox: true,
          rotateSourceGrant: false,
          reason: "missing private mail keys in agent vault",
        })
        return mockJsonResponse(hostedRotateResponse({
          rotatedSourceGrant: false,
          sourceAlias: undefined,
          sourceGrant: undefined,
          generatedPrivateKeys: {
            mail_slugger_native_rotated: HOSTED_ROTATED_NATIVE_KEY,
          },
          publicRegistry: {
            kind: "azure-blob",
            azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
            container: "mailroom",
            blob: "registry/mailroom.json",
            domain: "ouro.bot",
            revision: "1:0:901",
          },
        }))
      })

    const result = await runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--no-delegated-source",
      "--rotate-missing-mail-keys",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toContain("Agent Mail connected for Slugger")
    expect(result).not.toContain("Delegated alias:")
    const mailroom = readRuntimeSecret("Slugger").config.mailroom as Record<string, unknown>
    expect(mailroom.sourceAlias).toBeNull()
    expect(mailroom.registryRevision).toBe("1:0:901")
    expect(mailroom.privateKeys).toEqual({
      mail_slugger_native_rotated: HOSTED_ROTATED_NATIVE_KEY,
    })
  })

  it("fails hosted Mail setup before network calls when the control token is missing", async () => {
    emitTestEvent("provider cli hosted mail control missing token")
    const bundlesRoot = makeTempDir("provider-cli-hosted-missing-token-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-missing-token-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeRuntimeConfig("Slugger", {
      workSubstrate: {
        mode: "hosted",
        mailControl: {
          url: HOSTED_MAIL_CONTROL_URL,
        },
      },
    })

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("requires url and token")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails hosted Mail setup before network calls when the Mail Control config is missing", async () => {
    emitTestEvent("provider cli hosted mail control missing config")
    const bundlesRoot = makeTempDir("provider-cli-hosted-missing-config-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-missing-config-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeRuntimeConfig("Slugger", {
      workSubstrate: {
        mode: "hosted",
      },
    })

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("requires url and token")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("stops hosted Mail setup before network calls when the runtime vault is locked", async () => {
    emitTestEvent("provider cli hosted mail control locked vault")
    const bundlesRoot = makeTempDir("provider-cli-hosted-locked-vault-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-locked-vault-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const originalGet = mockVaultDeps.rawSecrets.get.bind(mockVaultDeps.rawSecrets)
    mockVaultDeps.rawSecrets.get = ((key: string) => {
      if (key === "Slugger:runtime/config") throw new Error("vault locked for runtime/config")
      return originalGet(key)
    }) as typeof mockVaultDeps.rawSecrets.get

    try {
      await expect(runOuroCli([
        "connect",
        "mail",
        "--agent",
        "Slugger",
        "--owner-email",
        "ari@mendelow.me",
        "--source",
        "hey",
      ], makeCliDeps(homeDir, bundlesRoot, {
        now: () => Date.parse(NOW),
        detectMode: () => "production",
      }))).rejects.toThrow("vault locked for runtime/config")
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      mockVaultDeps.rawSecrets.get = originalGet as typeof mockVaultDeps.rawSecrets.get
    }
  })

  it("uses the hosted Mail Control admin token fallback for native-only setup", async () => {
    emitTestEvent("provider cli hosted mail control admin token")
    const bundlesRoot = makeTempDir("provider-cli-hosted-admin-token-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-admin-token-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeRuntimeConfig("Slugger", {
      workSubstrate: {
        mode: "hosted",
        mailControl: {
          url: `${HOSTED_MAIL_CONTROL_URL}///`,
          adminToken: HOSTED_MAIL_CONTROL_TOKEN,
        },
      },
    })
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      expectHostedEnsureRequest(input, init, {
        agentId: "Slugger",
      })
      return mockJsonResponse({
        ok: true,
        generatedPrivateKeys: {
          mail_slugger_native: HOSTED_NATIVE_KEY,
        },
        mailbox: {
          keyId: "mail_slugger_native",
          canonicalAddress: "slugger@ouro.bot",
        },
        publicRegistry: {
          kind: "azure-blob",
          azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
          container: "mailroom",
          blob: "registry/mailroom.json",
          domain: "ouro.bot",
          revision: "1:0:601",
        },
        blobStore: {
          kind: "azure-blob",
          azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
          container: "mailroom",
        },
      })
    })

    const result = await runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--no-delegated-source",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    expect(result).toContain("mailbox: slugger@ouro.bot")
    expect(result).not.toContain("delegated alias:")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readRuntimeSecret("Slugger").config.mailroom).toEqual(expect.objectContaining({
      mode: "hosted",
      sourceAlias: null,
      registryRevision: "1:0:601",
      privateKeys: {
        mail_slugger_native: HOSTED_NATIVE_KEY,
      },
    }))
  })

  it("surfaces hosted Mail Control outages with actor-runnable repair context", async () => {
    emitTestEvent("provider cli hosted mail control outage")
    const bundlesRoot = makeTempDir("provider-cli-hosted-outage-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-outage-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      ok: false,
      error: "registry offline",
    }, {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    }))

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("hosted Mail Control ensure failed (503): registry offline")
  })

  it("uses Mail Control status text when hosted errors omit a response body reason", async () => {
    emitTestEvent("provider cli hosted mail control status text")
    const bundlesRoot = makeTempDir("provider-cli-hosted-status-text-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-status-text-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ ok: false }, {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    }))

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("hosted Mail Control ensure failed (502): Bad Gateway")
  })

  it("rejects malformed hosted Mail Control responses before storing partial config", async () => {
    emitTestEvent("provider cli hosted mail control malformed")
    const bundlesRoot = makeTempDir("provider-cli-hosted-malformed-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-malformed-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      ok: true,
      mailboxAddress: "slugger@ouro.bot",
      generatedPrivateKeys: {
        mail_slugger_native: HOSTED_NATIVE_KEY,
      },
      mailbox: {
        keyId: "mail_slugger_native",
        canonicalAddress: "slugger@ouro.bot",
      },
    }))

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--no-delegated-source",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("publicRegistry")
    expect(readRuntimeSecret("Slugger").config.mailroom).toBeUndefined()
  })

  it("rejects hosted Mail Control responses missing the mailbox record before storing partial config", async () => {
    emitTestEvent("provider cli hosted mail control missing mailbox")
    const bundlesRoot = makeTempDir("provider-cli-hosted-missing-mailbox-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-missing-mailbox-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse(hostedEnsureResponse({
      mailboxAddress: undefined,
      mailbox: undefined,
      sourceAlias: undefined,
      sourceGrant: undefined,
      generatedPrivateKeys: {},
    })))

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--no-delegated-source",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("mailbox")
    expect(readRuntimeSecret("Slugger").config.mailroom).toBeUndefined()
  })

  it("rejects hosted Mail Control responses missing required Blob text before storing partial config", async () => {
    emitTestEvent("provider cli hosted mail control missing blob text")
    const bundlesRoot = makeTempDir("provider-cli-hosted-missing-blob-text-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-missing-blob-text-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger")
    fetchMock.mockResolvedValueOnce(mockJsonResponse(hostedEnsureResponse({
      blobStore: {
        kind: "azure-blob",
        azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      },
    })))

    await expect(runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))).rejects.toThrow("blobStore.container")
    expect(readRuntimeSecret("Slugger").config.mailroom).toBeUndefined()
  })

  it("accepts native-only hosted repairs from public mailbox records when no new key map is returned", async () => {
    emitTestEvent("provider cli hosted mail control native-only repair")
    const bundlesRoot = makeTempDir("provider-cli-hosted-native-repair-bundles")
    const homeDir = makeTempDir("provider-cli-hosted-native-repair-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeHostedWorkSubstrateConfig("Slugger", {
      mode: "hosted",
      mailboxAddress: "slugger@ouro.bot",
      azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
      azureContainer: "mailroom",
      privateKeys: {
        mail_slugger_native: HOSTED_NATIVE_KEY,
      },
    })
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      ok: true,
      addedMailbox: false,
      addedSourceGrant: false,
      mailbox: {
        keyId: "mail_slugger_native",
        canonicalAddress: "slugger@ouro.bot",
      },
      publicRegistry: {
        kind: "azure-blob",
        azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        container: "mailroom",
        blob: "registry/mailroom.json",
        domain: "ouro.bot",
        revision: "1:0:600",
      },
      blobStore: {
        kind: "azure-blob",
        azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        container: "mailroom",
      },
    }))

    const result = await runOuroCli([
      "connect",
      "mail",
      "--agent",
      "Slugger",
      "--no-delegated-source",
    ], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      detectMode: () => "production",
    }))

    expect(result).toContain("mailbox: slugger@ouro.bot")
    expect(result).not.toContain("delegated alias:")
    const mailroom = readRuntimeSecret("Slugger").config.mailroom as Record<string, unknown>
    expect(mailroom).toEqual(expect.objectContaining({
      mailboxAddress: "slugger@ouro.bot",
      sourceAlias: null,
      registryRevision: "1:0:600",
      privateKeys: {
        mail_slugger_native: HOSTED_NATIVE_KEY,
      },
    }))
  })

  it("ensures the agent work substrate account through one command", async () => {
    emitTestEvent("provider cli account ensure")
    const bundlesRoot = makeTempDir("provider-cli-account-ensure-bundles")
    const homeDir = makeTempDir("provider-cli-account-ensure-home")
    writeAgentConfig(bundlesRoot, "Nova")
    const answers = ["owner@example.com", "hey"]

    const result = await runOuroCli(["account", "ensure", "--agent", "Nova"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => answers.shift() ?? "",
    }))

    expect(result).toContain("Ouro work substrate ready for Nova")
    expect(result).toContain("vault: runtime/config")
    expect(result).toContain("mailbox: nova@ouro.bot")
    expect(result).toContain("delegated alias: com.example.owner.nova@ouro.bot")
    const stored = readRuntimeSecret("Nova")
    expect(stored.config.mailroom).toEqual(expect.objectContaining({
      mailboxAddress: "nova@ouro.bot",
    }))
    expect(readAgentConfig(bundlesRoot, "Nova").senses).toMatchObject({
      mail: { enabled: true },
    })

    writeAgentConfig(bundlesRoot, "NoSource")
    updateAgentConfig(bundlesRoot, "NoSource", (config) => {
      config.sync = { enabled: true, remote: "origin" }
    })
    const noSource = await runOuroCli(["account", "ensure", "--agent", "NoSource"], makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptInput: async () => "",
    }))
    expect(noSource).toContain("mailbox: nosource@ouro.bot")
    expect(noSource).not.toContain("delegated alias:")
    expect(noSource).toContain("bundle sync: could not push bundle changes")
  })

  it("stops Mail setup before overwriting unreadable runtime credentials", async () => {
    emitTestEvent("provider cli connect mail unreadable runtime")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-unreadable-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-unreadable-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    mockVaultDeps.rawSecrets.set("Slugger:runtime/config", "{")
    const answers = ["ari@mendelow.me", "hey"]

    await expect(runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => answers.shift() ?? "",
    }))).rejects.toThrow("cannot read existing runtime credentials")
  })

  it("stops Mail setup when an existing registry is malformed", async () => {
    emitTestEvent("provider cli connect mail malformed registry")
    const bundlesRoot = makeTempDir("provider-cli-connect-mail-malformed-registry-bundles")
    const homeDir = makeTempDir("provider-cli-connect-mail-malformed-registry-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const registryPath = path.join(mailStateDir, "registry.json")
    fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, mailboxes: [] }), "utf-8")
    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath,
        storePath: mailStateDir,
        privateKeys: { mail_slugger_native: "secret" },
      },
    })

    await expect(runOuroCli(["connect", "mail", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot, {
      promptInput: async () => "",
    }))).rejects.toThrow("is not a valid Mailroom registry")
  })

  it("imports delegated HEY mail from an MBOX into the Mailroom store", async () => {
    emitTestEvent("provider cli mail import mbox")
    const bundlesRoot = makeTempDir("provider-cli-mail-import-bundles")
    const homeDir = makeTempDir("provider-cli-mail-import-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const provisioned = provisionMailboxRegistry({
      agentId: "Slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const registryPath = path.join(mailStateDir, "registry.json")
    fs.writeFileSync(registryPath, `${JSON.stringify(provisioned.registry, null, 2)}\n`, "utf-8")
    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath,
        storePath: mailStateDir,
        privateKeys: provisioned.keys,
      },
    })
    const mboxPath = path.join(mailStateDir, "hey.mbox")
    fs.writeFileSync(mboxPath, [
      "From ari@mendelow.me Sat Apr 20 12:00:00 2026",
      "From: Ari <ari@mendelow.me>",
      "To: Slugger <me.mendelow.ari.slugger@ouro.bot>",
      "Subject: Shadow imbox hello",
      "Message-ID: <hello@example.com>",
      "Date: Mon, 20 Apr 2026 12:00:00 -0700",
      "",
      "This is the first delegated thread.",
      "",
    ].join("\n"), "utf-8")

    const result = await runOuroCli([
      "mail",
      "import-mbox",
      "--agent",
      "Slugger",
      "--file",
      mboxPath,
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("Imported MBOX for Slugger")
    expect(result).toContain("grant:")
    expect(result).toContain("scanned: 1")
    expect(result).toContain("imported: 1")
    expect(result).toContain("source fresh through: 2026-04-20T19:00:00.000Z")
    expect(result).toContain("archive imports are historical; they do not create Screener wakeups")
    expect(result).toContain("body reads remain explicit")
    expect(fs.readdirSync(path.join(mailStateDir, "messages")).some((name) => name.endsWith(".json"))).toBe(true)
  })

  it("reports unknown source freshness when an imported MBOX has no dated messages", async () => {
    emitTestEvent("provider cli mail import mbox unknown freshness")
    const bundlesRoot = makeTempDir("provider-cli-mail-import-unknown-freshness-bundles")
    const homeDir = makeTempDir("provider-cli-mail-import-unknown-freshness-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const provisioned = provisionMailboxRegistry({
      agentId: "Slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const registryPath = path.join(mailStateDir, "registry.json")
    fs.writeFileSync(registryPath, `${JSON.stringify(provisioned.registry, null, 2)}\n`, "utf-8")
    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath,
        storePath: mailStateDir,
        privateKeys: provisioned.keys,
      },
    })
    const mboxPath = path.join(mailStateDir, "hey-undated.mbox")
    fs.writeFileSync(mboxPath, [
      "From ari@mendelow.me",
      "From: Ari <ari@mendelow.me>",
      "To: Slugger <me.mendelow.ari.slugger@ouro.bot>",
      "Subject: Undated archive note",
      "Message-ID: <undated@example.com>",
      "",
      "This archive export did not preserve a Date header.",
      "",
    ].join("\n"), "utf-8")

    const result = await runOuroCli([
      "mail",
      "import-mbox",
      "--agent",
      "Slugger",
      "--file",
      mboxPath,
      "--owner-email",
      "ari@mendelow.me",
      "--source",
      "hey",
    ], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("scanned: 1")
    expect(result).toContain("imported: 1")
    expect(result).toContain("source fresh through: unknown")
    expect(result).toContain("archive imports are historical; they do not create Screener wakeups")
  })

  it("explains Mail MBOX import setup failures before touching the store", async () => {
    emitTestEvent("provider cli mail import setup failures")
    const bundlesRoot = makeTempDir("provider-cli-mail-import-failures-bundles")
    const homeDir = makeTempDir("provider-cli-mail-import-failures-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const mboxPath = path.join(mailStateDir, "hey.mbox")
    fs.writeFileSync(mboxPath, "", "utf-8")
    const deps = makeCliDeps(homeDir, bundlesRoot)
    const command = ["mail", "import-mbox", "--agent", "Slugger", "--file", mboxPath]

    await expect(runOuroCli(command, deps)).rejects.toThrow("cannot read Mailroom config")

    writeRuntimeConfig("Slugger", { mailroom: null })
    resetRuntimeCredentialConfigCache()
    await expect(runOuroCli(command, deps)).rejects.toThrow("missing mailroom config for Slugger")

    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })
    resetRuntimeCredentialConfigCache()
    await expect(runOuroCli(command, deps)).rejects.toThrow("missing registryPath/storePath")

    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        azureContainer: "mailroom",
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })
    resetRuntimeCredentialConfigCache()
    await expect(runOuroCli(command, deps)).rejects.toThrow("missing hosted registry coordinates")

    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        azureContainer: "mailroom",
        registryAzureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })
    resetRuntimeCredentialConfigCache()
    await expect(runOuroCli(command, deps)).rejects.toThrow("missing hosted registry coordinates")

    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath: path.join(mailStateDir, "missing.json"),
        storePath: mailStateDir,
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })
    resetRuntimeCredentialConfigCache()
    await expect(runOuroCli(command, deps)).rejects.toThrow("no such file")
  })

  it("surfaces Mailroom reader resolution failures after config parsing", async () => {
    emitTestEvent("provider cli mail import reader resolution failure")
    const bundlesRoot = makeTempDir("provider-cli-mail-import-reader-bundles")
    const homeDir = makeTempDir("provider-cli-mail-import-reader-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const mboxPath = path.join(mailStateDir, "hey.mbox")
    const registryPath = path.join(mailStateDir, "registry.json")
    fs.writeFileSync(mboxPath, "", "utf-8")
    fs.writeFileSync(registryPath, JSON.stringify(provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    }).registry), "utf-8")
    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath,
        storePath: mailStateDir,
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })
    resetRuntimeCredentialConfigCache()

    const readerSpy = vi.spyOn(mailroomReader, "resolveMailroomReader").mockReturnValue({
      ok: false,
      agentName: "Slugger",
      reason: "misconfigured",
      error: "AUTH_REQUIRED:mailroom -- synthetic reader failure for coverage",
    })

    await expect(runOuroCli([
      "mail",
      "import-mbox",
      "--agent",
      "Slugger",
      "--file",
      mboxPath,
    ], makeCliDeps(homeDir, bundlesRoot))).rejects.toThrow("AUTH_REQUIRED:mailroom -- synthetic reader failure for coverage")

    readerSpy.mockRestore()
  })

  it("accepts complete hosted Mail import registry coordinates before reader resolution", async () => {
    emitTestEvent("provider cli mail import hosted reader resolution")
    const bundlesRoot = makeTempDir("provider-cli-mail-import-hosted-reader-bundles")
    const homeDir = makeTempDir("provider-cli-mail-import-hosted-reader-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const mailStateDir = path.join(agentRoot(bundlesRoot, "Slugger"), "state", "mailroom")
    fs.mkdirSync(mailStateDir, { recursive: true })
    const mboxPath = path.join(mailStateDir, "hey.mbox")
    fs.writeFileSync(mboxPath, "", "utf-8")
    writeRuntimeConfig("Slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        azureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        azureContainer: "mailroom",
        registryAzureAccountUrl: HOSTED_BLOB_ACCOUNT_URL,
        registryContainer: "mailroom",
        registryBlob: "registry/mailroom.json",
        privateKeys: { mail_slugger_primary: "secret" },
      },
    })
    resetRuntimeCredentialConfigCache()

    const readerSpy = vi.spyOn(mailroomReader, "resolveMailroomReader").mockReturnValue({
      ok: false,
      agentName: "Slugger",
      reason: "misconfigured",
      error: "AUTH_REQUIRED:mailroom -- hosted reader failure after coordinate validation",
    })

    await expect(runOuroCli([
      "mail",
      "import-mbox",
      "--agent",
      "Slugger",
      "--file",
      mboxPath,
    ], makeCliDeps(homeDir, bundlesRoot))).rejects.toThrow("AUTH_REQUIRED:mailroom -- hosted reader failure after coordinate validation")

    readerSpy.mockRestore()
  })

  it("ouro use writes local provider state after a successful live check", async () => {
    emitTestEvent("provider cli use writes provider state")
    const bundlesRoot = makeTempDir("provider-cli-bundles")
    const homeDir = makeTempDir("provider-cli-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeProviderState(agentRoot(bundlesRoot, "Slugger"), providerState())
    writeProviderCredentialPool(homeDir, credentialPool())
    mockPingProvider.mockImplementation(async (_provider, _config, options) => {
      await options?.onAttemptStart?.(1, 3)
      return { ok: true, message: "ok", attempts: 1 }
    })

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
    expect(output).toContain("checking minimax / MiniMax-M2.5 (attempt 1 of 3)")
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

    expect(result).toContain("___    _   _")
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

  it("vault item set stores ordinary items with notes and hidden fields", async () => {
    emitTestEvent("provider cli vault item set")
    const bundlesRoot = makeTempDir("provider-cli-vault-item-bundles")
    const homeDir = makeTempDir("provider-cli-vault-item-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const prompted: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        prompted.push(question)
        return question.includes("secretApiKey") ? "porkbun-secret-key" : "porkbun-api-key"
      },
    })

    const result = await runOuroCli(
      [
        "vault", "item", "set",
        "--agent", "Slugger",
        "--item", "ops/porkbun/ari@mendelow.me",
        "--secret-field", "apiKey",
        "--secret-field", "secretApiKey",
        "--public-field", "account=ari@mendelow.me",
        "--note", "Account-level Porkbun key; DNS workflow bindings live outside this note.",
      ],
      deps,
    )

    expect(prompted).toEqual([
      "Secret field apiKey for ops/porkbun/ari@mendelow.me: ",
      "Secret field secretApiKey for ops/porkbun/ari@mendelow.me: ",
    ])
    expect(result).toContain("stored ordinary vault item for Slugger")
    expect(result).toContain("item: vault:Slugger:ops/porkbun/ari@mendelow.me")
    expect(result).toContain("public fields: account")
    expect(result).toContain("secret fields: apiKey, secretApiKey")
    expect(result).toContain("notes: present")
    expect(result).toContain("secret values were not printed")
    expect(result).not.toContain("porkbun-api-key")
    expect(result).not.toContain("porkbun-secret-key")
    expect(mockVaultDeps.rawSecrets.has("Slugger:runtime/config")).toBe(false)

    const stored = mockVaultDeps.storedItems.get("Slugger:ops/porkbun/ari@mendelow.me")
    expect(stored?.notes).toBe("Account-level Porkbun key; DNS workflow bindings live outside this note.")
    const payload = JSON.parse(stored?.password ?? "{}") as Record<string, unknown>
    expect(payload).toMatchObject({
      schemaVersion: 1,
      updatedAt: NOW,
      publicFields: { account: "ari@mendelow.me" },
      secretFields: {
        apiKey: "porkbun-api-key",
        secretApiKey: "porkbun-secret-key",
      },
    })
    expect(payload).not.toHaveProperty("kind")

    const noPublicResult = await runOuroCli(
      [
        "vault", "item", "set",
        "--agent", "Slugger",
        "--item", "ops/custom/no-public",
        "--secret-field", "apiKey",
      ],
      makeCliDeps(homeDir, bundlesRoot, {
        now: () => Date.parse(NOW),
        promptSecret: async () => "no-public-secret",
      }),
    )
    expect(noPublicResult).toContain("public fields: none")
    expect(noPublicResult).toContain("secret fields: apiKey")
    expect(noPublicResult).not.toContain("no-public-secret")
  })

  it("vault item set supports templates without making provider-specific credential species", async () => {
    emitTestEvent("provider cli vault item template")
    const bundlesRoot = makeTempDir("provider-cli-vault-item-template-bundles")
    const homeDir = makeTempDir("provider-cli-vault-item-template-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const prompted: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        prompted.push(question)
        return question.includes("secretApiKey") ? "templated-secret-key" : "templated-api-key"
      },
    })

    const result = await runOuroCli(
      [
        "vault", "item", "set",
        "--agent", "Slugger",
        "--item", "ops/porkbun/template-account",
        "--template", "porkbun-api",
        "--secret-field", "apiKey",
        "--public-field", "account=ari@mendelow.me",
      ],
      deps,
    )

    expect(prompted).toEqual([
      "Secret field apiKey for ops/porkbun/template-account: ",
      "Secret field secretApiKey for ops/porkbun/template-account: ",
    ])
    expect(result).toContain("stored ordinary vault item")
    expect(result).toContain("notes: absent")
    const stored = mockVaultDeps.storedItems.get("Slugger:ops/porkbun/template-account")
    const payload = JSON.parse(stored?.password ?? "{}") as Record<string, unknown>
    expect(payload).toMatchObject({
      schemaVersion: 1,
      updatedAt: NOW,
      publicFields: { account: "ari@mendelow.me" },
      secretFields: {
        apiKey: "templated-api-key",
        secretApiKey: "templated-secret-key",
      },
    })
    expect(payload).not.toHaveProperty("kind")
  })

  it("vault item reports status and lists metadata without exposing secrets", async () => {
    emitTestEvent("provider cli vault item status list")
    const bundlesRoot = makeTempDir("provider-cli-vault-item-status-list-bundles")
    const homeDir = makeTempDir("provider-cli-vault-item-status-list-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    mockVaultDeps.credentialProbeGet.mockResolvedValueOnce({
      domain: "ops/custom/service",
      username: "agent@example.com",
      notes: "human context",
      createdAt: NOW,
    })
    const present = await runOuroCli(
      ["vault", "item", "status", "--agent", "Slugger", "--item", "ops/custom/service"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(present).toContain("item: vault:Slugger:ops/custom/service")
    expect(present).toContain("status: present")
    expect(present).toContain("username: agent@example.com")
    expect(present).toContain("notes: present")
    expect(present).toContain("secret values were not printed")
    expect(present).not.toContain("porkbun-api-key")

    mockVaultDeps.credentialProbeGet.mockResolvedValueOnce(null)
    const missing = await runOuroCli(
      ["vault", "item", "status", "--agent", "Slugger", "--item", "ops/missing/service"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(missing).toContain("status: missing")
    expect(missing).not.toContain("username:")

    mockVaultDeps.credentialProbeList.mockResolvedValueOnce([
      { domain: "runtime/config", createdAt: NOW },
      { domain: "ops/custom/z", createdAt: NOW },
      { domain: "ops/custom/a", createdAt: NOW },
    ])
    const listed = await runOuroCli(
      ["vault", "item", "list", "--agent", "Slugger", "--prefix", "ops/custom"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(listed).toContain("prefix: ops/custom")
    expect(listed).toContain("items: ops/custom/a, ops/custom/z")
    expect(listed).not.toContain("runtime/config")
    expect(listed).toContain("secret values were not printed")

    mockVaultDeps.credentialProbeList.mockResolvedValueOnce([
      { domain: "runtime/config", createdAt: NOW },
      { domain: "ops/custom/z", createdAt: NOW },
      { domain: "ops/custom/a", createdAt: NOW },
    ])
    const listedTrailingPrefix = await runOuroCli(
      ["vault", "item", "list", "--agent", "Slugger", "--prefix", "ops/custom/"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(listedTrailingPrefix).toContain("prefix: ops/custom/")
    expect(listedTrailingPrefix).toContain("items: ops/custom/a, ops/custom/z")
    expect(listedTrailingPrefix).not.toContain("runtime/config")

    mockVaultDeps.credentialProbeList.mockResolvedValueOnce([
      { domain: "runtime/config", createdAt: NOW },
      { domain: "ops/custom/z", createdAt: NOW },
      { domain: "ops/custom/a", createdAt: NOW },
    ])
    const listedWithoutPrefix = await runOuroCli(
      ["vault", "item", "list", "--agent", "Slugger"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(listedWithoutPrefix).not.toContain("prefix:")
    expect(listedWithoutPrefix).toContain("items: ops/custom/a, ops/custom/z, runtime/config")
    expect(listedWithoutPrefix).toContain("secret values were not printed")
  })

  it("vault item set guards hidden entry, blank secrets, SerpentGuide, and harness-managed item names", async () => {
    emitTestEvent("provider cli vault item guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-item-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-item-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(
      ["vault", "item", "set", "--agent", "Slugger", "--item", "ops/custom/service", "--secret-field", "apiKey"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("Vault item secret entry requires an interactive terminal")

    await expect(runOuroCli(
      ["vault", "item", "set", "--agent", "Slugger", "--item", "ops/custom/service", "--secret-field", "apiKey"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => "   ",
      }),
    )).rejects.toThrow("Secret field apiKey cannot be blank")

    await expect(runOuroCli(
      ["vault", "item", "set", "--agent", "SerpentGuide", "--item", "ops/custom/service", "--secret-field", "apiKey"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => "secret",
      }),
    )).rejects.toThrow("SerpentGuide has no persistent credential vault")

    const prompted: string[] = []
    await expect(runOuroCli(
      ["vault", "item", "set", "--agent", "Slugger", "--item", "runtime/config", "--secret-field", "apiKey"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async (question) => {
          prompted.push(question)
          return "secret"
        },
      }),
    )).rejects.toThrow("reserved for harness-managed workflows")
    expect(prompted).toEqual([])

    await expect(runOuroCli(
      ["vault", "item", "set", "--agent", "Slugger", "--item", "providers/openai-codex", "--secret-field", "apiKey"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => "secret",
      }),
    )).rejects.toThrow("Use ouro auth or ouro connect")

    const serpentStatus = await runOuroCli(
      ["vault", "item", "status", "--agent", "SerpentGuide", "--item", "ops/custom/service"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(serpentStatus).toContain("SerpentGuide has no persistent credential vault")

    const serpentList = await runOuroCli(
      ["vault", "item", "list", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(serpentList).toContain("SerpentGuide has no persistent credential vault")
  })

  it("vault ops porkbun is a deprecated compatibility alias for an ordinary vault item", async () => {
    emitTestEvent("provider cli vault ops porkbun")
    const bundlesRoot = makeTempDir("provider-cli-vault-ops-porkbun-bundles")
    const homeDir = makeTempDir("provider-cli-vault-ops-porkbun-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const prompted: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      promptSecret: async (question) => {
        prompted.push(question)
        return question.includes("Secret") ? "porkbun-secret-key" : "porkbun-api-key"
      },
    })

    const result = await runOuroCli(
      ["vault", "ops", "porkbun", "set", "--agent", "Slugger", "--account", "ari@mendelow.me"],
      deps,
    )

    expect(prompted).toEqual([
      "Porkbun API key for ari@mendelow.me: ",
      "Porkbun Secret API key for ari@mendelow.me: ",
    ])
    expect(result).toContain("deprecated compatibility alias")
    expect(result).toContain("ouro vault item set --template porkbun-api")
    expect(result).toContain("stored ordinary vault item for Slugger")
    expect(result).toContain("ops/registrars/porkbun/accounts/ari@mendelow.me")
    expect(result).toContain("account: ari@mendelow.me")
    expect(result).toContain("secret values were not printed")
    expect(result).not.toContain("authority:")
    expect(result).not.toContain("ops credentials")
    expect(result).not.toContain("porkbun-api-key")
    expect(result).not.toContain("porkbun-secret-key")
    expect(mockVaultDeps.rawSecrets.has("Slugger:runtime/config")).toBe(false)

    const stored = mockVaultDeps.storedItems.get("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me")
    const payload = JSON.parse(stored?.password ?? "{}") as Record<string, unknown>
    expect(payload).toMatchObject({
      schemaVersion: 1,
      updatedAt: NOW,
      publicFields: { account: "ari@mendelow.me" },
      secretFields: {
        apiKey: "porkbun-api-key",
        secretApiKey: "porkbun-secret-key",
      },
    })
    expect(payload).not.toHaveProperty("kind")
  })

  it("vault ops porkbun status reports presence without exposing secrets", async () => {
    emitTestEvent("provider cli vault ops porkbun status")
    const bundlesRoot = makeTempDir("provider-cli-vault-ops-porkbun-status-bundles")
    const homeDir = makeTempDir("provider-cli-vault-ops-porkbun-status-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    const itemName = "ops/registrars/porkbun/accounts/ari@mendelow.me"

    mockVaultDeps.credentialProbeGet.mockResolvedValueOnce({
      domain: itemName,
      username: "ari@mendelow.me",
      createdAt: NOW,
    })
    const present = await runOuroCli(
      ["vault", "ops", "porkbun", "status", "--agent", "Slugger", "--account", "ari@mendelow.me"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(present).toContain("deprecated compatibility alias")
    expect(present).toContain("agent: Slugger")
    expect(present).toContain(`ordinary vault item: vault:Slugger:${itemName}`)
    expect(present).toContain("status: present")
    expect(present).toContain("account: ari@mendelow.me")
    expect(present).toContain("secret values were not printed")
    expect(present).not.toContain("authority:")
    expect(present).not.toContain("porkbun-api-key")

    mockVaultDeps.credentialProbeGet.mockResolvedValueOnce(null)
    const missing = await runOuroCli(
      ["vault", "ops", "porkbun", "status", "--agent", "Slugger", "--account", "missing@example.com"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(missing).toContain("status: missing")
    expect(missing).not.toContain("account:")

    const emptyList = await runOuroCli(
      ["vault", "ops", "porkbun", "status", "--agent", "Slugger"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(emptyList).toContain("items: none stored")

    mockVaultDeps.credentialProbeList.mockResolvedValueOnce([
      { domain: "runtime/config", createdAt: NOW },
      { domain: "ops/registrars/porkbun/accounts/z@example.com", createdAt: NOW },
      { domain: "ops/registrars/porkbun/accounts/a@example.com", createdAt: NOW },
    ])
    const listed = await runOuroCli(
      ["vault", "ops", "porkbun", "status", "--agent", "Slugger"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(listed).toContain("items: ops/registrars/porkbun/accounts/a@example.com, ops/registrars/porkbun/accounts/z@example.com")
    expect(listed).not.toContain("runtime/config")
  })

  it("vault ops porkbun protects the owning vault boundary and hidden-entry validation", async () => {
    emitTestEvent("provider cli vault ops porkbun guards")
    const bundlesRoot = makeTempDir("provider-cli-vault-ops-porkbun-guards-bundles")
    const homeDir = makeTempDir("provider-cli-vault-ops-porkbun-guards-home")
    writeAgentConfig(bundlesRoot, "Slugger")

    await expect(runOuroCli(
      ["vault", "ops", "porkbun", "set", "--agent", "Slugger", "--account", "ari@mendelow.me"],
      makeCliDeps(homeDir, bundlesRoot),
    )).rejects.toThrow("Porkbun ops credential entry requires an interactive terminal")

    await expect(runOuroCli(
      ["vault", "ops", "porkbun", "set", "--agent", "Slugger", "--account", "ari@mendelow.me"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => "   ",
      }),
    )).rejects.toThrow("Porkbun API key cannot be blank")

    const answers = ["porkbun-api-key", "   "]
    await expect(runOuroCli(
      ["vault", "ops", "porkbun", "set", "--agent", "Slugger", "--account", "ari@mendelow.me"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => answers.shift() ?? "",
      }),
    )).rejects.toThrow("Porkbun Secret API key cannot be blank")

    await expect(runOuroCli(
      ["vault", "ops", "porkbun", "set", "--agent", "SerpentGuide", "--account", "ari@mendelow.me"],
      makeCliDeps(homeDir, bundlesRoot, {
        promptSecret: async () => "porkbun-api-key",
      }),
    )).rejects.toThrow("SerpentGuide has no persistent credential vault")

    const serpentStatus = await runOuroCli(
      ["vault", "ops", "porkbun", "status", "--agent", "SerpentGuide"],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(serpentStatus).toContain("SerpentGuide has no persistent credential vault")
    expect(serpentStatus).toContain("owning agent vault")
  })

  it("dns workflow plan resolves a binding-backed vault item without leaking secrets", async () => {
    emitTestEvent("provider cli dns workflow plan")
    const bundlesRoot = makeTempDir("provider-cli-dns-plan-bundles")
    const homeDir = makeTempDir("provider-cli-dns-plan-home")
    const repoRoot = makeTempDir("provider-cli-dns-plan-repo")
    writeAgentConfig(bundlesRoot, "Slugger")
    const bindingPath = path.join(repoRoot, "infra", "dns", "ouro.bot.binding.json")
    const outputPath = path.join(repoRoot, "artifacts", "dns-plan.json")
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true })
    fs.writeFileSync(bindingPath, `${JSON.stringify({
      workflow: "dns",
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      resources: { records: [{ type: "A", name: "mx1" }, { type: "MX", name: "@" }] },
      desired: {
        records: [
          { type: "A", name: "mx1", content: "20.10.114.197", ttl: 600 },
          { type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 },
        ],
      },
    }, null, 2)}\n`, "utf-8")
    mockVaultDeps.rawSecrets.set("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me", JSON.stringify({
      secretFields: {
        apiKey: "porkbun-api-key",
        secretApiKey: "porkbun-secret-key",
      },
    }))
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(fetchRequestUrl(input)).toBe("https://api.porkbun.com/api/json/v3/dns/retrieve/ouro.bot")
      expect(init?.method).toBe("GET")
      expect(fetchHeader(init, "X-API-Key")).toBe("porkbun-api-key")
      expect(fetchHeader(init, "X-Secret-API-Key")).toBe("porkbun-secret-key")
      return mockJsonResponse({
        status: "SUCCESS",
        records: [
          { id: "mx-old", type: "MX", name: "ouro.bot", content: "ouro-bot.mail.protection.outlook.com", prio: "0", ttl: "600" },
        ],
      })
    })

    const result = await runOuroCli(
      ["dns", "plan", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json", "--output", "artifacts/dns-plan.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )

    expect(result).toContain("dns plan for ouro.bot")
    expect(result).toContain("credential item: vault:Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me")
    expect(result).toContain("changes: 2")
    expect(result).toContain("secret values were not printed")
    const artifact = fs.readFileSync(outputPath, "utf-8")
    expect(artifact).toContain("mx1.ouro.bot")
    expect(artifact).not.toContain("porkbun-api-key")
    expect(artifact).not.toContain("porkbun-secret-key")

    mockVaultDeps.rawSecrets.set("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me", JSON.stringify({
      secretFields: { apiKey: "porkbun-api-key" },
    }))
    await expect(runOuroCli(
      ["dns", "plan", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )).rejects.toThrow("missing required secret field secretApiKey")

    mockVaultDeps.rawSecrets.set("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me", JSON.stringify({
      schemaVersion: 1,
      kind: "ops-credential/porkbun",
      account: "ari@mendelow.me",
      apiKey: "legacy-porkbun-api-key",
      secretApiKey: "legacy-porkbun-secret-key",
    }))
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(fetchRequestUrl(input)).toBe("https://api.porkbun.com/api/json/v3/dns/retrieve/ouro.bot")
      expect(fetchHeader(init, "X-API-Key")).toBe("legacy-porkbun-api-key")
      expect(fetchHeader(init, "X-Secret-API-Key")).toBe("legacy-porkbun-secret-key")
      return mockJsonResponse({ status: "SUCCESS", records: [] })
    })
    const legacyResult = await runOuroCli(
      ["dns", "plan", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )
    expect(legacyResult).toContain("dns plan for ouro.bot")
  })

  it("dns workflow certificate retrieves and stores the TLS bundle without leaking secrets", async () => {
    emitTestEvent("provider cli dns workflow certificate")
    const bundlesRoot = makeTempDir("provider-cli-dns-certificate-bundles")
    const homeDir = makeTempDir("provider-cli-dns-certificate-home")
    const repoRoot = makeTempDir("provider-cli-dns-certificate-repo")
    writeAgentConfig(bundlesRoot, "Slugger")
    const bindingPath = path.join(repoRoot, "infra", "dns", "ouro.bot.binding.json")
    const outputPath = path.join(repoRoot, "artifacts", "dns-certificate.json")
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true })
    fs.writeFileSync(bindingPath, `${JSON.stringify({
      workflow: "dns",
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      resources: { records: [{ type: "TXT", name: "_acme-challenge.mx1" }] },
      desired: { records: [] },
      certificate: {
        host: "mx1.ouro.bot",
        source: "porkbun-ssl",
        storeItem: "runtime/mail/certificates/mx1.ouro.bot",
      },
    }, null, 2)}\n`, "utf-8")
    mockVaultDeps.rawSecrets.set("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me", JSON.stringify({
      secretFields: {
        apiKey: "porkbun-api-key",
        secretApiKey: "porkbun-secret-key",
      },
    }))
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(fetchRequestUrl(input)).toBe("https://api.porkbun.com/api/json/v3/ssl/retrieve/ouro.bot")
      expect(init?.method).toBe("GET")
      expect(fetchHeader(init, "X-API-Key")).toBe("porkbun-api-key")
      expect(fetchHeader(init, "X-Secret-API-Key")).toBe("porkbun-secret-key")
      return mockJsonResponse({
        status: "SUCCESS",
        certificatechain: "-----BEGIN CERTIFICATE-----\npublic-chain\n-----END CERTIFICATE-----",
        publickey: "-----BEGIN CERTIFICATE-----\npublic-cert\n-----END CERTIFICATE-----",
        privatekey: "-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----",
      })
    })

    const result = await runOuroCli(
      ["dns", "certificate", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json", "--output", "artifacts/dns-certificate.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )

    expect(result).toContain("dns certificate for ouro.bot")
    expect(result).toContain("certificate item: vault:Slugger:runtime/mail/certificates/mx1.ouro.bot")
    expect(result).toContain("secret values were not printed")
    const stored = mockVaultDeps.storedItems.get("Slugger:runtime/mail/certificates/mx1.ouro.bot")
    expect(stored?.username).toBe("mx1.ouro.bot")
    expect(stored?.notes).toContain("workflow binding")
    const payload = JSON.parse(stored?.password ?? "{}") as {
      publicFields?: Record<string, string>
      secretFields?: Record<string, string>
    }
    expect(payload.publicFields).toEqual(expect.objectContaining({
      host: "mx1.ouro.bot",
      source: "porkbun-ssl",
      domain: "ouro.bot",
    }))
    expect(payload.secretFields).toEqual(expect.objectContaining({
      certificatechain: expect.stringContaining("public-chain"),
      publickey: expect.stringContaining("public-cert"),
      privatekey: expect.stringContaining("private-key"),
    }))
    const artifact = fs.readFileSync(outputPath, "utf-8")
    expect(artifact).toContain("public-cert")
    expect(artifact).not.toContain("private-key")
    expect(artifact).not.toContain("porkbun-secret-key")

    const noArtifactResult = await runOuroCli(
      ["dns", "certificate", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )
    expect(noArtifactResult).toContain("artifact: not written")

    fs.writeFileSync(bindingPath, `${JSON.stringify({
      workflow: "dns",
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      resources: { records: [{ type: "MX", name: "@" }] },
      desired: { records: [] },
    }, null, 2)}\n`, "utf-8")
    await expect(runOuroCli(
      ["dns", "certificate", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )).rejects.toThrow("DNS workflow binding does not define a certificate")

    fs.writeFileSync(bindingPath, `${JSON.stringify({
      workflow: "dns",
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      resources: { records: [{ type: "TXT", name: "_acme-challenge.mx1" }] },
      desired: { records: [] },
      certificate: {
        host: "mx1.ouro.bot",
        source: "acme-dns-01",
        storeItem: "runtime/mail/certificates/mx1.ouro.bot",
      },
    }, null, 2)}\n`, "utf-8")
    await expect(runOuroCli(
      ["dns", "certificate", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json"],
      makeCliDeps(homeDir, bundlesRoot, {
        fetchImpl: fetchMock as unknown as typeof fetch,
        getRepoCwd: () => repoRoot,
      }),
    )).rejects.toThrow("DNS workflow certificate source acme-dns-01 is not implemented")
  })

  it("dns workflow plan supports absolute paths and current-directory relative paths", async () => {
    emitTestEvent("provider cli dns workflow path resolution")
    const bundlesRoot = makeTempDir("provider-cli-dns-path-bundles")
    const homeDir = makeTempDir("provider-cli-dns-path-home")
    const repoRoot = makeTempDir("provider-cli-dns-path-repo")
    writeAgentConfig(bundlesRoot, "Slugger")
    const bindingPath = path.join(repoRoot, "infra", "dns", "ouro.bot.binding.json")
    const outputPath = path.join(repoRoot, "artifacts", "absolute-plan.json")
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true })
    fs.writeFileSync(bindingPath, `${JSON.stringify({
      workflow: "dns",
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      resources: { records: [{ type: "MX", name: "@" }] },
      desired: {
        records: [
          { type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 },
        ],
      },
    }, null, 2)}\n`, "utf-8")
    mockVaultDeps.rawSecrets.set("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me", JSON.stringify({
      secretFields: {
        apiKey: "porkbun-api-key",
        secretApiKey: "porkbun-secret-key",
      },
    }))
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      expect(fetchRequestUrl(input)).toBe("https://api.porkbun.com/api/json/v3/dns/retrieve/ouro.bot")
      return mockJsonResponse({
        status: "SUCCESS",
        records: [{ id: "mx-old", type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 }],
      })
    })

    const absoluteResult = await runOuroCli(
      ["dns", "plan", "--agent", "Slugger", "--binding", bindingPath, "--output", outputPath],
      makeCliDeps(homeDir, bundlesRoot),
    )
    expect(absoluteResult).toContain("changes: 0")
    expect(fs.readFileSync(outputPath, "utf-8")).not.toContain("porkbun-secret-key")

    const previousCwd = process.cwd()
    try {
      process.chdir(repoRoot)
      const relativeResult = await runOuroCli(
        ["dns", "verify", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json"],
        makeCliDeps(homeDir, bundlesRoot),
      )
      expect(relativeResult).toContain("dns verify for ouro.bot")
    } finally {
      process.chdir(previousCwd)
    }
  })

  it("dns workflow apply and rollback mutate only planned allowlisted records", async () => {
    emitTestEvent("provider cli dns workflow apply rollback")
    const bundlesRoot = makeTempDir("provider-cli-dns-apply-bundles")
    const homeDir = makeTempDir("provider-cli-dns-apply-home")
    const repoRoot = makeTempDir("provider-cli-dns-apply-repo")
    writeAgentConfig(bundlesRoot, "Slugger")
    const bindingPath = path.join(repoRoot, "infra", "dns", "ouro.bot.binding.json")
    const backupPath = path.join(repoRoot, "artifacts", "backup.json")
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true })
    fs.mkdirSync(path.dirname(backupPath), { recursive: true })
    fs.writeFileSync(bindingPath, `${JSON.stringify({
      workflow: "dns",
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
      resources: { records: [{ type: "A", name: "mx1" }, { type: "MX", name: "@" }, { type: "TXT", name: "_dmarc" }] },
      desired: {
        records: [
          { type: "A", name: "mx1", content: "20.10.114.197", ttl: 600 },
          { type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 },
          { type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none", ttl: 600 },
        ],
      },
    }, null, 2)}\n`, "utf-8")
    fs.writeFileSync(backupPath, `${JSON.stringify({
      plan: {
        backup: {
          records: [
            { id: "mx-old", type: "MX", name: "@", content: "ouro-bot.mail.protection.outlook.com", priority: 0, ttl: 600 },
          ],
        },
      },
    })}\n`, "utf-8")
    mockVaultDeps.rawSecrets.set("Slugger:ops/registrars/porkbun/accounts/ari@mendelow.me", JSON.stringify({
      secretFields: {
        apiKey: "porkbun-api-key",
        secretApiKey: "porkbun-secret-key",
      },
    }))
    let mode: "apply" | "rollback" = "apply"
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchRequestUrl(input)
      if (url.endsWith("/dns/retrieve/ouro.bot")) {
        return mockJsonResponse({
          status: "SUCCESS",
          records: mode === "apply"
            ? [{ id: "mx-old", type: "MX", name: "@", content: "ouro-bot.mail.protection.outlook.com", priority: 0, ttl: 600 }]
            : [
                { id: "mx1-a", type: "A", name: "mx1", content: "20.10.114.197", ttl: 600 },
                { id: "mx-new", type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 },
                { id: "dmarc", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none", ttl: 600 },
                { id: "www", type: "A", name: "www", content: "203.0.113.12", ttl: 600 },
              ],
        })
      }
      expect(init?.method).toBe("POST")
      expect(fetchHeader(init, "X-API-Key")).toBe("porkbun-api-key")
      expect(fetchHeader(init, "X-Secret-API-Key")).toBe("porkbun-secret-key")
      expect(String(init?.body ?? "")).not.toContain("porkbun-api-key")
      return mockJsonResponse(url.includes("/dns/create/") ? { status: "SUCCESS", id: "created" } : { status: "SUCCESS" })
    })
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      getRepoCwd: () => repoRoot,
    })

    const applied = await runOuroCli(
      ["dns", "apply", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json", "--yes"],
      deps,
    )
    expect(applied).toContain("applied: 3")
    expect(fetchMock.mock.calls.map(([input]) => fetchRequestUrl(input))).toEqual([
      "https://api.porkbun.com/api/json/v3/dns/retrieve/ouro.bot",
      "https://api.porkbun.com/api/json/v3/dns/create/ouro.bot",
      "https://api.porkbun.com/api/json/v3/dns/edit/ouro.bot/mx-old",
      "https://api.porkbun.com/api/json/v3/dns/create/ouro.bot",
    ])

    mode = "rollback"
    fetchMock.mockClear()
    const rolledBack = await runOuroCli(
      ["dns", "rollback", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json", "--backup", "artifacts/backup.json", "--yes"],
      deps,
    )
    expect(rolledBack).toContain("applied: 3")
    expect(fetchMock.mock.calls.map(([input]) => fetchRequestUrl(input))).toEqual([
      "https://api.porkbun.com/api/json/v3/dns/retrieve/ouro.bot",
      "https://api.porkbun.com/api/json/v3/dns/edit/ouro.bot/mx-new",
      "https://api.porkbun.com/api/json/v3/dns/delete/ouro.bot/mx1-a",
      "https://api.porkbun.com/api/json/v3/dns/delete/ouro.bot/dmarc",
    ])

    fs.writeFileSync(backupPath, "{\"not\":\"a backup\"}\n", "utf-8")
    await expect(runOuroCli(
      ["dns", "rollback", "--agent", "Slugger", "--binding", "infra/dns/ouro.bot.binding.json", "--backup", "artifacts/backup.json", "--yes"],
      deps,
    )).rejects.toThrow("dns rollback backup does not contain records")
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

  it("restarts a running daemon after connecting BlueBubbles so the local sense starts immediately", async () => {
    emitTestEvent("provider cli connect bluebubbles applies running daemon")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-daemon-restart-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-daemon-restart-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb_live")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    let nowMs = Date.parse(NOW)
    const cleanupStaleSocket = vi.fn()
    const startDaemonProcess = vi.fn(async () => ({ pid: 42 }))
    const sentCommands: string[] = []
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      startupPollIntervalMs: 1,
      startupTimeoutMs: 50,
      checkSocketAlive: async () => true,
      cleanupStaleSocket,
      startDaemonProcess,
      sendCommand: async (_socketPath, command) => {
        sentCommands.push(command.kind)
        if (command.kind === "daemon.stop") return { ok: true, message: "daemon stopped" }
        if (command.kind === "daemon.status") {
          return {
            ok: true,
            data: {
              overview: { daemon: "running", health: "ok", workerCount: 1, senseCount: 1 },
              workers: [{
                agent: "Slugger",
                worker: "inner-dialog",
                status: "running",
                pid: 42,
                restartCount: 0,
                startedAt: new Date(nowMs - 10_000).toISOString(),
                lastExitCode: null,
                lastSignal: null,
                errorReason: null,
                fixHint: null,
              }],
              senses: [{
                agent: "Slugger",
                sense: "bluebubbles",
                label: "BlueBubbles",
                enabled: true,
                status: "running",
                detail: ":18888 /bb-webhook",
              }],
              sync: [],
              agents: [{ name: "Slugger", enabled: true }],
              providers: [],
            },
          }
        }
        return { ok: true }
      },
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    })

    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)

    expect(result).toContain("runtime: restarted Ouro; BlueBubbles is loaded for Slugger")
    expect(sentCommands).toContain("daemon.stop")
    expect(sentCommands).toContain("daemon.status")
    expect(cleanupStaleSocket).toHaveBeenCalledWith("/tmp/test-socket")
    expect(startDaemonProcess).toHaveBeenCalledWith("/tmp/test-socket")
  })

  it("keeps BlueBubbles setup successful when live daemon apply cannot inspect the socket", async () => {
    emitTestEvent("provider cli connect bluebubbles daemon apply socket inspection failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-daemon-apply-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-daemon-apply-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb_socket_fail")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      checkSocketAlive: async () => {
        throw "socket unavailable"
      },
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    })

    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    expect(result).toContain("runtime: daemon restart skipped: socket unavailable")
  })

  it("keeps BlueBubbles setup successful when socket inspection throws an Error", async () => {
    emitTestEvent("provider cli connect bluebubbles daemon apply socket inspection error")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-daemon-apply-error-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-daemon-apply-error-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb_socket_error")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      checkSocketAlive: async () => {
        throw new Error("socket probe blew up")
      },
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    })

    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    expect(result).toContain("runtime: daemon restart skipped: socket probe blew up")
  })

  it.each([
    [{ ok: false, error: "stop refused" }, "stop refused"],
    [{ ok: false, message: "stop returned a message" }, "stop returned a message"],
    [{ ok: false }, "unknown daemon error"],
  ])("keeps BlueBubbles setup successful when daemon stop does not accept the restart (%s)", async (stopResponse, expectedReason) => {
    emitTestEvent(`provider cli connect bluebubbles daemon stop fallback ${expectedReason}`)
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-daemon-stop-fallback-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-daemon-stop-fallback-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb_stop_fallback")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    const startDaemonProcess = vi.fn(async () => ({ pid: 42 }))
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => Date.parse(NOW),
      checkSocketAlive: async () => true,
      startDaemonProcess,
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "daemon.stop") return stopResponse as any
        return { ok: true }
      },
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    })

    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    expect(result).toContain(`runtime: daemon restart skipped: ${expectedReason}`)
    expect(startDaemonProcess).not.toHaveBeenCalled()
  })

  it("keeps BlueBubbles setup successful when daemon restart begins but startup fails", async () => {
    emitTestEvent("provider cli connect bluebubbles daemon restart startup failure")
    const bundlesRoot = makeTempDir("provider-cli-connect-bluebubbles-daemon-startup-failure-bundles")
    const homeDir = makeTempDir("provider-cli-connect-bluebubbles-daemon-startup-failure-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_bb_startup_failure")

    const answers = [
      "http://127.0.0.1:1234",
      "18888",
      "/bb-webhook",
      "12000",
    ]
    let nowMs = Date.parse(NOW)
    let socketChecks = 0
    const deps = makeCliDeps(homeDir, bundlesRoot, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      startupPollIntervalMs: 1,
      startupTimeoutMs: 3,
      startupRetryLimit: 0,
      checkSocketAlive: async () => {
        socketChecks += 1
        return socketChecks === 1
      },
      startDaemonProcess: async () => ({ pid: 42 }),
      sendCommand: async (_socketPath, command) => {
        if (command.kind === "daemon.stop") return { ok: true, message: "daemon stopped" }
        return { ok: true }
      },
      promptInput: async () => answers.shift() ?? "",
      promptSecret: async () => "bb-password",
    })

    const result = await runOuroCli(["connect", "bluebubbles", "--agent", "Slugger"], deps)

    expect(result).toContain("BlueBubbles attached for Slugger on this machine")
    expect(result).toContain("runtime: daemon restart requested, but startup failed:")
    expect(result).toContain("new background service did not answer")
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

    expect(prompt).toContain("Connect Slugger")
    expect(prompt).toContain("Recommended next step")
    expect(prompt).toContain("Providers")
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
    mockPingProvider.mockImplementation(async (provider, _config, options) => {
      const maxAttempts = options?.attemptPolicy?.maxAttempts ?? 3
      await options?.onAttemptStart?.(1, maxAttempts)
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
    expect(output).toContain("Slugger: opening saved provider credentials in the vault")
    expect(output).toContain("checking openai-codex / gpt-5.4")
    expect(output).toContain("checking minimax / MiniMax-M2.5")
    expect(output).not.toContain("attempt 1 of 3")
    expectConnectStatus(prompt, 1, "Providers", "ready")
    expect(mockPingProvider).toHaveBeenCalledTimes(2)
    expect(mockPingProvider).toHaveBeenNthCalledWith(1, "openai-codex", { oauthAccessToken: "openai-secret" }, expect.objectContaining({
      model: "gpt-5.4",
      attemptPolicy: { maxAttempts: 1, baseDelayMs: 0, backoffMultiplier: 2 },
      timeoutMs: 5_000,
    }))
    expect(mockPingProvider).toHaveBeenNthCalledWith(2, "minimax", { apiKey: "minimax-secret" }, expect.objectContaining({
      model: "MiniMax-M2.5",
      attemptPolicy: { maxAttempts: 1, baseDelayMs: 0, backoffMultiplier: 2 },
      timeoutMs: 5_000,
    }))
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
    mockPingProvider.mockImplementation(async (provider, _config, options) => {
      await options?.onAttemptStart?.(1, options?.attemptPolicy?.maxAttempts ?? 3)
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
    expect(output).toContain("checking openai-codex / gpt-5.4")
    expect(output).toContain("✓ checking current connections — checked")
    expect(output).not.toContain("✓ checking current connections — ready")
    expectConnectStatus(prompt, 1, "Providers", "needs attention")
    expect(prompt).toContain("openai-codex / gpt-5.4")
    expect(prompt).toContain("failed live check: 400 status code (no body)")
    expect(prompt).not.toContain("Providers - needs credentials")
  })

  it("does not overwrite saved provider readiness when the root connect bay quick check fails", async () => {
    emitTestEvent("provider cli connect menu quick failure keeps saved readiness")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-quick-failure-readiness-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-quick-failure-readiness-home")
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
          status: "ready",
          provider: "openai-codex",
          model: "gpt-5.4",
          checkedAt: NOW,
          credentialRevision: "cred_openai_connect_saved",
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
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_openai_connect_saved",
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
    mockPingProvider.mockImplementation(async (provider, _config, options) => {
      const maxAttempts = options?.attemptPolicy?.maxAttempts ?? 3
      await options?.onAttemptStart?.(1, maxAttempts)
      if (provider === "openai-codex") {
        return {
          ok: false,
          classification: "network-error",
          message: "provider ping timed out after 5000ms",
          attempts: [1],
        }
      }
      return { ok: true, message: "ok", attempts: [1] }
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
    expectConnectStatus(prompt, 1, "Providers", "needs attention")
    expect(prompt).toContain("provider ping timed out after 5000ms")
    const stateResult = readProviderState(agentRoot(bundlesRoot, "Slugger"))
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.readiness.outward).toMatchObject({
      status: "ready",
      provider: "openai-codex",
      model: "gpt-5.4",
      credentialRevision: "cred_openai_connect_saved",
    })
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
        mail: { enabled: true },
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
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath: "/tmp/ouro-mailroom/registry.json",
        storePath: "/tmp/ouro-mailroom",
        privateKeys: {
          mail_slugger_test: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        },
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
    expect(joinedPrompt(prompts)).toContain("Everything here is already connected.")
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
    expect(output).toContain("Slugger: checking the providers this agent uses right now")
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
    expect(prompt).toContain("\x1b[38;2;30;61;40m─ \x1b[0m")
    expect(stripAnsi(prompt)).toContain("Connect Slugger")
  })

  it("renders the TTY connect bay as the shared wizard surface with humane provider lane labels", async () => {
    emitTestEvent("provider cli connect menu shared wizard")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-shared-wizard-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-shared-wizard-home")
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
    expect(prompt).toContain("Recommended next step")
    expect(prompt).toContain("Outward lane")
    expect(prompt).toContain("Inner lane")
    expect(prompt).toContain("Choose a number, or type the capability name.")
  })

  it("keeps the shared wizard stable on wide TTY terminals", async () => {
    emitTestEvent("provider cli connect menu wide tty wizard")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-wide-tty-wizard-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-wide-tty-wizard-home")
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
    expect(promptLines.some((line) => line.includes("Recommended next step"))).toBe(true)
    expect(promptLines.some((line) => line.includes("Providers"))).toBe(true)
    expect(promptLines.some((line) => line.includes("Portable"))).toBe(true)
    expect(promptLines.some((line) => line.includes("This machine"))).toBe(true)
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
    expectConnectStatus(prompt, 1, "Providers", "ready")
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
    expectConnectStatus(joinedPrompt(prompts), 1, "Providers", "ready")
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

  it("uses a bounded one-attempt provider check while the root connect bay verifies providers", async () => {
    emitTestEvent("provider cli connect menu bounded live provider check")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-provider-retry-progress-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-provider-retry-progress-home")
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
    }))
    writeProviderCredentialPool(homeDir, credentialPool({
      providers: {
        ...credentialPool().providers,
        "openai-codex": {
          provider: "openai-codex",
          revision: "cred_openai_live_progress",
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
    mockPingProvider.mockImplementation(async (provider, _config, options) => {
      if (provider === "minimax") {
        const maxAttempts = options?.attemptPolicy?.maxAttempts ?? 3
        await options?.onAttemptStart?.(1, maxAttempts)
      }
      return { ok: true, attempts: [] }
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

    expect(result).toBe("connect cancelled.")
    expect(output).toContain("checking minimax / MiniMax-M2.5")
    expect(output).not.toContain("attempt 1 of 3")
    expect(output).not.toContain("retrying now")
    expect(mockPingProvider).toHaveBeenCalledWith("minimax", { apiKey: "minimax-secret" }, expect.objectContaining({
      attemptPolicy: { maxAttempts: 1, baseDelayMs: 0, backoffMultiplier: 2 },
      timeoutMs: 5_000,
    }))
  })

  it("keeps connect menu fallbacks compact for noninteractive shells and alternate choices", async () => {
    emitTestEvent("provider cli connect menu fallbacks")
    const bundlesRoot = makeTempDir("provider-cli-connect-menu-fallbacks-bundles")
    const homeDir = makeTempDir("provider-cli-connect-menu-fallbacks-home")
    writeAgentConfig(bundlesRoot, "Slugger")
    writeMachineIdentity(homeDir, "machine_menu")

    const noninteractive = await runOuroCli(["connect", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))
    expect(noninteractive).toContain("Connect Slugger")
    expect(noninteractive).toContain("Recommended next step")
    expect(noninteractive).toContain("ouro connect providers --agent Slugger")
    expect(noninteractive).toContain("ouro connect perplexity --agent Slugger")
    expect(noninteractive).toContain("ouro connect embeddings --agent Slugger")
    expect(noninteractive).toContain("ouro connect teams --agent Slugger")
    expect(noninteractive).toContain("ouro connect bluebubbles --agent Slugger")
    expect(noninteractive).toContain("ouro connect mail --agent Slugger")

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
      promptInput: async () => "unknown",
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

  it("ouro status --agent distinguishes an unloaded local provider cache from missing vault credentials", async () => {
    emitTestEvent("provider cli status unloaded credential cache")
    const bundlesRoot = makeTempDir("provider-cli-status-unloaded-cache-bundles")
    const homeDir = makeTempDir("provider-cli-status-unloaded-cache-home")
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
      readiness: {
        outward: {
          status: "ready",
          provider: "minimax",
          model: "MiniMax-M2.5",
          checkedAt: NOW,
          credentialRevision: "cred_minimax_1",
          attempts: 1,
        },
      },
    }))
    writeMissingProviderCredentialPool("Slugger")

    const result = await runOuroCli(["status", "--agent", "Slugger"], makeCliDeps(homeDir, bundlesRoot))

    expect(result).toContain("readiness: ready")
    expect(result).toContain("credentials: not loaded in this process; run `ouro provider refresh --agent Slugger` to read the vault now")
    expect(result).not.toContain("credentials: missing")
    expect(result).not.toContain("warning: minimax has no credential record")
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
    mockPingProvider.mockImplementation(async (_provider, _config, options) => {
      await options?.onAttemptStart?.(1, 3)
      await options?.onRetry?.({
        attempt: 1,
        provider: "minimax",
        model: "MiniMax-M2.5",
        operation: "ping",
        ok: false,
        classification: "server-error",
        errorMessage: "provider busy",
        httpStatus: 529,
        willRetry: true,
        delayMs: 0,
      }, 3)
      await options?.onAttemptStart?.(2, 3)
      return {
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
      }
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
    expect(output).toContain("checking minimax / MiniMax-M2.5 (attempt 1 of 3)")
    expect(output).toContain("minimax / MiniMax-M2.5: provider is busy right now; retrying now (attempt 2 of 3)")
    expect(output).toContain("checking minimax / MiniMax-M2.5 (attempt 2 of 3)")
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
