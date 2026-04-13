import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  getProviderCredentialPoolPath,
  migrateLegacyAgentProviderCredentials,
  providerCredentialHomeDirFromSecretsRoot,
  readLegacyAgentProviderCredentials,
  readProviderCredentialPool,
  redactProviderCredentialPool,
  summarizeProviderCredentialPool,
  upsertProviderCredential,
  validateProviderCredentialPool,
  writeProviderCredentialPool,
  type ProviderCredentialPool,
} from "../../heart/provider-credential-pool"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

describe("provider credential pool", () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-credentials-"))
    mockEmitNervesEvent.mockClear()
  })

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  function providerPool(overrides: Partial<ProviderCredentialPool> = {}): ProviderCredentialPool {
    return {
      schemaVersion: 1,
      updatedAt: "2026-04-12T18:00:00.000Z",
      providers: {
        anthropic: {
          provider: "anthropic",
          revision: "cred_anthropic_1",
          updatedAt: "2026-04-12T18:00:00.000Z",
          credentials: {
            setupToken: "sk-ant-oat01-secret-token",
            refreshToken: "refresh-secret",
            expiresAt: 1770000000000,
          },
          config: {},
          provenance: {
            source: "auth-flow",
            contributedByAgent: "slugger",
            updatedAt: "2026-04-12T18:00:00.000Z",
          },
        },
      },
      ...overrides,
    }
  }

  function writeLegacySecrets(agentName: string, secrets: Record<string, unknown>): string {
    const secretsPath = path.join(homeDir, ".agentsecrets", agentName, "secrets.json")
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true })
    fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf-8")
    return secretsPath
  }

  it("uses a machine-wide providers.json under .agentsecrets", () => {
    emitTestEvent("provider credential pool path")

    expect(getProviderCredentialPoolPath(homeDir)).toBe(path.join(homeDir, ".agentsecrets", "providers.json"))
  })

  it("derives provider credential home from configured secrets roots", () => {
    emitTestEvent("provider credential home from secrets root")

    expect(providerCredentialHomeDirFromSecretsRoot(path.join(homeDir, ".agentsecrets"))).toBe(homeDir)
    expect(providerCredentialHomeDirFromSecretsRoot(path.join(homeDir, "custom-secrets"))).toBe(path.join(homeDir, "custom-secrets"))
    expect(providerCredentialHomeDirFromSecretsRoot()).toBe(os.homedir())
  })

  it("reports a missing machine-wide pool without creating one", () => {
    emitTestEvent("provider credential pool missing")

    const result = readProviderCredentialPool(homeDir)

    expect(result).toEqual({
      ok: false,
      reason: "missing",
      poolPath: getProviderCredentialPoolPath(homeDir),
      error: "provider credential pool not found",
    })
    expect(fs.existsSync(getProviderCredentialPoolPath(homeDir))).toBe(false)
  })

  it("writes and reads the raw credential pool while redacting display output", () => {
    emitTestEvent("provider credential pool write read redact")
    const pool = providerPool()

    writeProviderCredentialPool(homeDir, pool)

    const raw = fs.readFileSync(getProviderCredentialPoolPath(homeDir), "utf-8")
    expect(JSON.parse(raw)).toEqual(pool)
    expect(readProviderCredentialPool(homeDir)).toEqual({
      ok: true,
      poolPath: getProviderCredentialPoolPath(homeDir),
      pool,
    })

    const redacted = redactProviderCredentialPool(pool)
    expect(JSON.stringify(redacted)).not.toContain("sk-ant-oat01-secret-token")
    expect(JSON.stringify(redacted)).not.toContain("refresh-secret")
    expect(redacted.providers.anthropic.credentials).toEqual({
      setupToken: "[redacted]",
      refreshToken: "[redacted]",
      expiresAt: "[redacted]",
    })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "config/identity",
      event: "config.provider_credential_pool_written",
    }))
  })

  it("keeps one active credential record per provider and generates new revisions on update", () => {
    emitTestEvent("provider credential upsert revision")
    const revisions = ["cred_minimax_1", "cred_minimax_2"]

    upsertProviderCredential({
      homeDir,
      provider: "minimax",
      credentials: { apiKey: "minimax-key-old" },
      config: {},
      provenance: { source: "auth-flow", contributedByAgent: "slugger" },
      now: new Date("2026-04-12T18:01:00.000Z"),
      makeRevision: () => revisions.shift() ?? "unexpected",
    })
    upsertProviderCredential({
      homeDir,
      provider: "minimax",
      credentials: { apiKey: "minimax-key-new" },
      config: {},
      provenance: { source: "auth-flow", contributedByAgent: "ouroboros" },
      now: new Date("2026-04-12T18:02:00.000Z"),
      makeRevision: () => revisions.shift() ?? "unexpected",
    })

    const result = readProviderCredentialPool(homeDir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(Object.keys(result.pool.providers)).toEqual(["minimax"])
    expect(result.pool.providers.minimax).toEqual({
      provider: "minimax",
      revision: "cred_minimax_2",
      updatedAt: "2026-04-12T18:02:00.000Z",
      credentials: { apiKey: "minimax-key-new" },
      config: {},
      provenance: {
        source: "auth-flow",
        contributedByAgent: "ouroboros",
        updatedAt: "2026-04-12T18:02:00.000Z",
      },
    })
  })

  it("generates default credential revisions and rejects updates when the pool is invalid", () => {
    emitTestEvent("provider credential default revision and invalid pool")
    const defaultTimestampRecord = upsertProviderCredential({
      homeDir,
      provider: "github-copilot",
      credentials: { githubToken: "gho_default_time" },
      config: { baseUrl: "https://copilot.default-time.test" },
      provenance: { source: "manual" },
      makeRevision: () => "cred_default_time",
    })
    expect(defaultTimestampRecord.updatedAt).toEqual(expect.any(String))

    const defaultRevisionRecord = upsertProviderCredential({
      homeDir,
      provider: "openai-codex",
      credentials: { oauthAccessToken: "oauth-secret" },
      config: {},
      provenance: { source: "auth-flow", contributedByAgent: "slugger" },
      now: new Date("2026-04-12T18:02:30.000Z"),
    })

    expect(defaultRevisionRecord.revision).toMatch(/^cred_[0-9a-f-]+$/)

    fs.writeFileSync(getProviderCredentialPoolPath(homeDir), "not json{{{", "utf-8")
    const readResult = readProviderCredentialPool(homeDir)
    expect(readResult.ok).toBe(false)
    if (readResult.ok) throw new Error("expected invalid pool")
    expect(readResult.reason).toBe("invalid")

    expect(() => upsertProviderCredential({
      homeDir,
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-12T18:02:31.000Z"),
      makeRevision: () => "cred_minimax_invalid",
    })).toThrow("Cannot update invalid provider credential pool")
  })

  it("preserves Azure credential and config fields including managed identity", () => {
    emitTestEvent("provider credential azure fields")

    const record = upsertProviderCredential({
      homeDir,
      provider: "azure",
      credentials: { apiKey: "azure-api-key" },
      config: {
        endpoint: "https://example.openai.azure.com",
        deployment: "gpt-5-4",
        apiVersion: "2025-04-01-preview",
        managedIdentityClientId: "client-id-123",
      },
      provenance: { source: "manual", contributedByAgent: "slugger" },
      now: new Date("2026-04-12T18:03:00.000Z"),
      makeRevision: () => "cred_azure_1",
    })

    expect(record).toEqual({
      provider: "azure",
      revision: "cred_azure_1",
      updatedAt: "2026-04-12T18:03:00.000Z",
      credentials: { apiKey: "azure-api-key" },
      config: {
        endpoint: "https://example.openai.azure.com",
        deployment: "gpt-5-4",
        apiVersion: "2025-04-01-preview",
        managedIdentityClientId: "client-id-123",
      },
      provenance: {
        source: "manual",
        contributedByAgent: "slugger",
        updatedAt: "2026-04-12T18:03:00.000Z",
      },
    })
  })

  it("preserves GitHub Copilot token and baseUrl separately", () => {
    emitTestEvent("provider credential github fields")

    const record = upsertProviderCredential({
      homeDir,
      provider: "github-copilot",
      credentials: { githubToken: "gho_secret" },
      config: { baseUrl: "https://api.githubcopilot.com" },
      provenance: { source: "auth-flow", contributedByAgent: "slugger" },
      now: new Date("2026-04-12T18:04:00.000Z"),
      makeRevision: () => "cred_github_1",
    })

    expect(record.credentials).toEqual({ githubToken: "gho_secret" })
    expect(record.config).toEqual({ baseUrl: "https://api.githubcopilot.com" })
  })

  it("reads legacy per-agent secrets as migration candidates with safe provenance", () => {
    emitTestEvent("provider credential legacy read")
    writeLegacySecrets("slugger", {
      providers: {
        azure: {
          apiKey: "legacy-azure-key",
          endpoint: "https://legacy.openai.azure.com",
          deployment: "legacy-deployment",
          apiVersion: "2025-04-01-preview",
          managedIdentityClientId: "legacy-client-id",
        },
        "github-copilot": {
          githubToken: "legacy-gh-token",
          baseUrl: "https://copilot.example.test",
        },
        anthropic: {
          setupToken: "",
        },
      },
    })

    const candidates = readLegacyAgentProviderCredentials({ homeDir, agentName: "slugger" })

    expect(candidates).toEqual([
      {
        provider: "azure",
        credentials: { apiKey: "legacy-azure-key" },
        config: {
          endpoint: "https://legacy.openai.azure.com",
          deployment: "legacy-deployment",
          apiVersion: "2025-04-01-preview",
          managedIdentityClientId: "legacy-client-id",
        },
        provenance: {
          source: "legacy-agent-secrets",
          contributedByAgent: "slugger",
        },
      },
      {
        provider: "github-copilot",
        credentials: { githubToken: "legacy-gh-token" },
        config: { baseUrl: "https://copilot.example.test" },
        provenance: {
          source: "legacy-agent-secrets",
          contributedByAgent: "slugger",
        },
      },
    ])
    expect(JSON.stringify(candidates.map((candidate) => candidate.provenance))).not.toContain("secrets.json")
  })

  it("handles missing, malformed, and unsupported legacy provider secrets", () => {
    emitTestEvent("provider credential legacy malformed")

    expect(readLegacyAgentProviderCredentials({ homeDir, agentName: "missing" })).toEqual([])

    writeLegacySecrets("noProviders", { teams: { clientId: "x" } })
    expect(readLegacyAgentProviderCredentials({ homeDir, agentName: "noProviders" })).toEqual([])

    writeLegacySecrets("badProviders", {
      providers: {
        fake: { apiKey: "fake-key" },
        minimax: "not-an-object",
        azure: { apiVersion: "2025-04-01-preview" },
      },
    })
    expect(readLegacyAgentProviderCredentials({ homeDir, agentName: "badProviders" })).toEqual([])

    writeLegacySecrets("partialAzure", {
      providers: {
        azure: {
          apiKey: "partial-azure-key",
          endpoint: "",
          deployment: "partial-deployment",
          apiVersion: 0,
          managedIdentityClientId: "",
        },
      },
    })
    expect(readLegacyAgentProviderCredentials({ homeDir, agentName: "partialAzure" })).toEqual([
      {
        provider: "azure",
        credentials: { apiKey: "partial-azure-key" },
        config: { deployment: "partial-deployment" },
        provenance: {
          source: "legacy-agent-secrets",
          contributedByAgent: "partialAzure",
        },
      },
    ])

    const badJsonPath = path.join(homeDir, ".agentsecrets", "badJson", "secrets.json")
    fs.mkdirSync(path.dirname(badJsonPath), { recursive: true })
    fs.writeFileSync(badJsonPath, "not json{{{", "utf-8")
    expect(() => readLegacyAgentProviderCredentials({ homeDir, agentName: "badJson" })).toThrow("Failed to read legacy provider credentials")
  })

  it("explicitly migrates legacy per-agent secrets into the machine-wide pool without deleting legacy files", () => {
    emitTestEvent("provider credential legacy migration")
    const sluggerSecretsPath = writeLegacySecrets("slugger", {
      providers: {
        minimax: { apiKey: "legacy-minimax-key" },
      },
    })
    const ouroborosSecretsPath = writeLegacySecrets("ouroboros", {
      providers: {
        anthropic: {
          setupToken: "legacy-anthropic-token",
          refreshToken: "legacy-refresh",
          expiresAt: 1770000000000,
        },
      },
    })
    const revisions = ["cred_minimax_legacy", "cred_anthropic_legacy"]

    const result = migrateLegacyAgentProviderCredentials({
      homeDir,
      agentNames: ["slugger", "ouroboros"],
      now: new Date("2026-04-12T18:05:00.000Z"),
      makeRevision: () => revisions.shift() ?? "unexpected",
    })

    expect(result.migrated).toEqual([
      { agentName: "slugger", provider: "minimax", revision: "cred_minimax_legacy" },
      { agentName: "ouroboros", provider: "anthropic", revision: "cred_anthropic_legacy" },
    ])
    expect(fs.existsSync(sluggerSecretsPath)).toBe(true)
    expect(fs.existsSync(ouroborosSecretsPath)).toBe(true)

    const pool = readProviderCredentialPool(homeDir)
    expect(pool.ok).toBe(true)
    if (!pool.ok) throw new Error(pool.error)
    expect(pool.pool.providers.minimax?.credentials).toEqual({ apiKey: "legacy-minimax-key" })
    expect(pool.pool.providers.anthropic?.credentials).toEqual({
      setupToken: "legacy-anthropic-token",
      refreshToken: "legacy-refresh",
      expiresAt: 1770000000000,
    })
  })

  it("summarizes provider availability without exposing credential values or secret paths", () => {
    emitTestEvent("provider credential safe summary")
    const pool = providerPool({
      providers: {
        ...providerPool().providers,
        minimax: {
          provider: "minimax",
          revision: "cred_minimax_1",
          updatedAt: "2026-04-12T18:06:00.000Z",
          credentials: { apiKey: "minimax-secret" },
          config: {},
          provenance: {
            source: "legacy-agent-secrets",
            contributedByAgent: "ouroboros",
            updatedAt: "2026-04-12T18:06:00.000Z",
          },
        },
      },
    })

    const summary = summarizeProviderCredentialPool(pool)
    const serialized = JSON.stringify(summary)

    expect(serialized).toContain("anthropic")
    expect(serialized).toContain("minimax")
    expect(serialized).toContain("slugger")
    expect(serialized).toContain("ouroboros")
    expect(serialized).toContain("setupToken")
    expect(serialized).toContain("apiKey")
    expect(serialized).not.toContain("sk-ant-oat01-secret-token")
    expect(serialized).not.toContain("minimax-secret")
    expect(serialized).not.toContain("secrets.json")
    expect(summary.providers).toEqual([
      {
        provider: "anthropic",
        revision: "cred_anthropic_1",
        source: "auth-flow",
        contributedByAgent: "slugger",
        updatedAt: "2026-04-12T18:00:00.000Z",
        credentialFields: ["expiresAt", "refreshToken", "setupToken"],
        configFields: [],
      },
      {
        provider: "minimax",
        revision: "cred_minimax_1",
        source: "legacy-agent-secrets",
        contributedByAgent: "ouroboros",
        updatedAt: "2026-04-12T18:06:00.000Z",
        credentialFields: ["apiKey"],
        configFields: [],
      },
    ])
  })

  it("validates pool shape and provider records", () => {
    emitTestEvent("provider credential validation")
    const base = providerPool()

    expect(() => validateProviderCredentialPool(null)).toThrow("provider credential pool must be an object")
    expect(() => validateProviderCredentialPool({ schemaVersion: 2 })).toThrow("schemaVersion")
    expect(() => validateProviderCredentialPool({ schemaVersion: 1, updatedAt: "" })).toThrow("updatedAt")
    expect(() => validateProviderCredentialPool({ schemaVersion: 1, updatedAt: "x", providers: [] })).toThrow("providers")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        fake: {
          provider: "fake",
          revision: "cred_fake",
          updatedAt: "x",
          credentials: {},
          config: {},
          provenance: { source: "manual", updatedAt: "x" },
        },
      },
    })).toThrow("unsupported provider")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: null,
      },
    })).toThrow("anthropic credential record")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        minimax: {
          provider: "anthropic",
          revision: "cred_wrong",
          updatedAt: "x",
          credentials: {},
          config: {},
          provenance: { source: "manual", updatedAt: "x" },
        },
      },
    })).toThrow("minimax.provider")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          revision: "",
        },
      },
    })).toThrow("revision")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          updatedAt: "",
        },
      },
    })).toThrow("updatedAt")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          credentials: [],
        },
      },
    })).toThrow("credentials")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          credentials: { setupToken: null },
        },
      },
    })).toThrow("credentials.setupToken")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          config: [],
        },
      },
    })).toThrow("config")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          config: { endpoint: null },
        },
      },
    })).toThrow("config.endpoint")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          provenance: null,
        },
      },
    })).toThrow("provenance")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          provenance: { source: "mystery", updatedAt: "x" },
        },
      },
    })).toThrow("provenance.source")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          provenance: { source: "manual", contributedByAgent: 1, updatedAt: "x" },
        },
      },
    })).toThrow("contributedByAgent")
    expect(() => validateProviderCredentialPool({
      ...base,
      providers: {
        anthropic: {
          ...base.providers.anthropic,
          provenance: { source: "manual", updatedAt: "" },
        },
      },
    })).toThrow("provenance.updatedAt")
  })

  it("can operate from the default home directory dependency", () => {
    emitTestEvent("provider credential default home")
    const previousHome = process.env.HOME
    process.env.HOME = homeDir
    try {
      const record = upsertProviderCredential({
        provider: "minimax",
        credentials: { apiKey: "default-home-key" },
        config: {},
        provenance: { source: "manual" },
        now: new Date("2026-04-12T18:07:00.000Z"),
        makeRevision: () => "cred_default_home",
      })
      writeLegacySecrets("defaultHomeAgent", {
        providers: {
          minimax: { apiKey: "legacy-default-home-key" },
        },
      })

      expect(getProviderCredentialPoolPath()).toBe(getProviderCredentialPoolPath(homeDir))
      expect(record.revision).toBe("cred_default_home")
      expect(readLegacyAgentProviderCredentials({ agentName: "defaultHomeAgent" })).toEqual([
        {
          provider: "minimax",
          credentials: { apiKey: "legacy-default-home-key" },
          config: {},
          provenance: {
            source: "legacy-agent-secrets",
            contributedByAgent: "defaultHomeAgent",
          },
        },
      ])
      expect(migrateLegacyAgentProviderCredentials({
        agentNames: ["defaultHomeAgent"],
        now: new Date("2026-04-12T18:08:00.000Z"),
        makeRevision: () => "cred_default_home_migrated",
      })).toEqual({
        poolPath: getProviderCredentialPoolPath(homeDir),
        migrated: [
          { agentName: "defaultHomeAgent", provider: "minimax", revision: "cred_default_home_migrated" },
        ],
      })
    } finally {
      process.env.HOME = previousHome
    }
  })
})
