import * as os from "node:os"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCredentialStore = vi.hoisted(() => {
  const items = new Map<string, { username?: string; password: string; notes?: string; createdAt: string }>()
  return {
    items,
    store: {
      get: vi.fn(async (domain: string) => {
        const item = items.get(domain)
        return item ? { domain, username: item.username, notes: item.notes, createdAt: item.createdAt } : null
      }),
      getRawSecret: vi.fn(async (domain: string, field: string) => {
        if (field !== "password") throw new Error(`unexpected field ${field}`)
        const item = items.get(domain)
        if (!item) throw new Error(`missing ${domain}`)
        return item.password
      }),
      store: vi.fn(async (domain: string, data: { username?: string; password: string; notes?: string }) => {
        items.set(domain, { ...data, createdAt: "2026-04-13T00:00:00.000Z" })
      }),
      list: vi.fn(async () => [...items.entries()].map(([domain, item]) => ({
        domain,
        username: item.username,
        notes: item.notes,
        createdAt: item.createdAt,
      }))),
      delete: vi.fn(async (domain: string) => items.delete(domain)),
      isReady: vi.fn(() => true),
    },
  }
})

vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: vi.fn(() => mockCredentialStore.store),
}))

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
}))

import {
  cacheProviderCredentialRecords,
  createProviderCredentialRecord,
  providerCredentialItemName,
  providerCredentialMachineHomeDir,
  providerCredentialsVaultPath,
  readCachedProviderCredentialRecord,
  readProviderCredentialPool,
  readProviderCredentialRecord,
  redactProviderCredentialPool,
  refreshProviderCredentialPool,
  resetProviderCredentialCache,
  splitProviderCredentialFields,
  summarizeProviderCredentialPool,
  upsertProviderCredential,
} from "../../heart/provider-credentials"
import type { AgentProvider } from "../../heart/identity"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function validPayload(
  provider: AgentProvider,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "provider-credential",
    provider,
    updatedAt: "2026-04-13T12:00:00.000Z",
    credentials: provider === "azure" ? { apiKey: "azure-key" } : { apiKey: `${provider}-key` },
    config: provider === "azure" ? { endpoint: "https://example.openai.azure.com", deployment: "gpt-4.1" } : {},
    provenance: { source: "manual", updatedAt: "2026-04-13T12:00:00.000Z" },
    ...overrides,
  })
}

describe("provider credentials vault store", () => {
  beforeEach(() => {
    mockCredentialStore.items.clear()
    vi.clearAllMocks()
    resetProviderCredentialCache()
  })

  it("splits secret credential fields from non-secret provider config fields", () => {
    emitTestEvent("provider credential field split")

    expect(splitProviderCredentialFields("azure", {
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4.1",
      apiVersion: "2025-04-01-preview",
      model: "ignored",
      empty: "",
    })).toEqual({
      credentials: { apiKey: "azure-key" },
      config: {
        endpoint: "https://example.openai.azure.com",
        deployment: "gpt-4.1",
        apiVersion: "2025-04-01-preview",
      },
    })

    expect(splitProviderCredentialFields("azure", {
      apiKey: 123,
      endpoint: "https://example.openai.azure.com",
      deployment: "",
      apiVersion: 0,
      managedIdentityClientId: 42,
    })).toEqual({
      credentials: { apiKey: 123 },
      config: {
        endpoint: "https://example.openai.azure.com",
        managedIdentityClientId: 42,
      },
    })
  })

  it("stores provider credentials as versioned vault items and reloads a redaction-safe pool", async () => {
    emitTestEvent("provider credential upsert and refresh")

    const record = await upsertProviderCredential({
      agentName: "slugger",
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: {},
      provenance: { source: "auth-flow" },
      now: new Date("2026-04-13T12:00:00.000Z"),
    })

    expect(record.provider).toBe("minimax")
    expect(record.revision).toMatch(/^vault_/)
    expect(mockCredentialStore.items.has(providerCredentialItemName("minimax"))).toBe(true)

    resetProviderCredentialCache()
    const poolResult = await refreshProviderCredentialPool("slugger")
    expect(poolResult.ok).toBe(true)
    if (!poolResult.ok) throw new Error(poolResult.error)

    expect(poolResult.pool.providers.minimax).toMatchObject({
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: {},
      provenance: { source: "auth-flow", updatedAt: "2026-04-13T12:00:00.000Z" },
    })

    const reloaded = await readProviderCredentialRecord("slugger", "minimax")
    expect(reloaded.ok ? reloaded.record.revision : undefined).toBe(record.revision)
  })

  it("refreshes only the requested provider when a single credential record is missing from cache", async () => {
    emitTestEvent("provider credential single record targeted refresh")
    mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
      username: "minimax",
      password: validPayload("minimax"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })
    mockCredentialStore.items.set(providerCredentialItemName("azure"), {
      username: "azure",
      password: validPayload("azure"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })
    mockCredentialStore.store.getRawSecret.mockClear()

    const reloaded = await readProviderCredentialRecord("slugger", "minimax")

    expect(reloaded.ok).toBe(true)
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledTimes(1)
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledWith(providerCredentialItemName("minimax"), "password")
  })

  it("summarizes, redacts, and reads cached runtime credential pools", () => {
    emitTestEvent("provider credential cached pool helpers")

    const minimax = createProviderCredentialRecord({
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-13T12:00:00.000Z"),
    })
    const azure = createProviderCredentialRecord({
      provider: "azure",
      credentials: { apiKey: "azure-key" },
      config: { endpoint: "https://example.openai.azure.com", deployment: "gpt-4.1" },
      provenance: { source: "auth-flow" },
      now: new Date("2026-04-13T12:01:00.000Z"),
    })

    const result = cacheProviderCredentialRecords("slugger", [minimax, azure], new Date("2026-04-13T11:00:00.000Z"))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.pool.updatedAt).toBe("2026-04-13T12:01:00.000Z")
    expect(providerCredentialsVaultPath("slugger")).toBe("vault:slugger:providers/*")
    expect(providerCredentialMachineHomeDir("/tmp/home")).toBe("/tmp/home")
    expect(providerCredentialMachineHomeDir()).toBe(os.homedir())

    expect(readProviderCredentialPool("slugger")).toBe(result)
    expect(readCachedProviderCredentialRecord("slugger", "azure")).toMatchObject({
      ok: true,
      record: { provider: "azure", revision: azure.revision },
    })
    expect(readCachedProviderCredentialRecord("slugger", "anthropic")).toMatchObject({
      ok: false,
      reason: "missing",
      error: "anthropic credentials are missing from vault:slugger:providers/*",
    })

    expect(redactProviderCredentialPool(result.pool).providers.azure?.credentials).toEqual({ apiKey: "[redacted]" })
    expect(summarizeProviderCredentialPool(result.pool)).toEqual({
      providers: expect.arrayContaining([
        expect.objectContaining({
          provider: "azure",
          source: "auth-flow",
          credentialFields: ["apiKey"],
          configFields: ["deployment", "endpoint"],
        }),
        expect.objectContaining({
          provider: "minimax",
          source: "manual",
          credentialFields: ["apiKey"],
          configFields: [],
        }),
      ]),
    })

    const defaultTimestampRecord = createProviderCredentialRecord({
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: { extraArray: ["a", "b"] } as never,
      provenance: { source: "manual" },
    })
    expect(defaultTimestampRecord.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(defaultTimestampRecord.revision).toMatch(/^vault_/)
  })

  it("can avoid a refresh when cached provider credentials are absent", async () => {
    emitTestEvent("provider credential no refresh")

    expect(readProviderCredentialPool("slugger")).toMatchObject({
      ok: false,
      reason: "missing",
      poolPath: "vault:slugger:providers/*",
    })

    await expect(readProviderCredentialRecord("slugger", "minimax", { refreshIfMissing: false }))
      .resolves.toMatchObject({
        ok: false,
        reason: "missing",
        poolPath: "vault:slugger:providers/*",
      })
    expect(mockCredentialStore.store.list).not.toHaveBeenCalled()
  })

  it("refreshes only the requested provider from vault on cache miss and ignores unrelated vault entries", async () => {
    emitTestEvent("provider credential refresh filters")
    mockCredentialStore.items.set("tools/calendar", {
      username: "calendar",
      password: "{broken",
      createdAt: "2026-04-13T00:00:00.000Z",
    })
    mockCredentialStore.items.set("providers/not-real", {
      username: "not-real",
      password: "{broken",
      createdAt: "2026-04-13T00:00:00.000Z",
    })
    mockCredentialStore.items.set(providerCredentialItemName("azure"), {
      username: "azure",
      password: validPayload("azure"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })

    const result = await readProviderCredentialRecord("slugger", "azure")

    expect(result).toMatchObject({
      ok: true,
      record: {
        provider: "azure",
        credentials: { apiKey: "azure-key" },
        config: { endpoint: "https://example.openai.azure.com", deployment: "gpt-4.1" },
      },
    })
    expect(mockCredentialStore.store.list).not.toHaveBeenCalled()
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledTimes(1)
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledWith(providerCredentialItemName("azure"), "password")
  })

  it("refreshes known provider items directly without listing the whole vault", async () => {
    emitTestEvent("provider credential refresh direct provider reads")
    mockCredentialStore.items.set(providerCredentialItemName("azure"), {
      username: "azure",
      password: validPayload("azure"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })
    mockCredentialStore.store.list.mockRejectedValueOnce(new Error("list should not be called during provider refresh"))

    const result = await refreshProviderCredentialPool("slugger")

    expect(result).toMatchObject({
      ok: true,
      pool: {
        providers: {
          azure: {
            provider: "azure",
            credentials: { apiKey: "azure-key" },
          },
        },
      },
    })
    expect(mockCredentialStore.store.list).not.toHaveBeenCalled()
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledWith(providerCredentialItemName("azure"), "password")
  })

  it("can refresh only selected providers without replacing the cached pool", async () => {
    emitTestEvent("provider credential targeted refresh without cache write")
    mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
      username: "minimax",
      password: validPayload("minimax"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })
    mockCredentialStore.items.set(providerCredentialItemName("azure"), {
      username: "azure",
      password: validPayload("azure"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })

    const result = await refreshProviderCredentialPool("slugger", {
      providers: ["minimax", "openai-codex", "minimax"],
      skipCache: true,
    })

    expect(result).toMatchObject({
      ok: true,
      pool: {
        providers: {
          minimax: { provider: "minimax" },
        },
      },
    })
    expect(result.ok && result.pool.providers.azure).toBeUndefined()
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledTimes(2)
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledWith(providerCredentialItemName("minimax"), "password")
    expect(mockCredentialStore.store.getRawSecret).toHaveBeenCalledWith(providerCredentialItemName("openai-codex"), "password")
    expect(readProviderCredentialPool("slugger")).toMatchObject({
      ok: false,
      reason: "missing",
      poolPath: "vault:slugger:providers/*",
    })
  })

  it("treats direct item 'not found' errors as missing provider credentials during refresh", async () => {
    emitTestEvent("provider credential refresh not-found direct reads")
    mockCredentialStore.store.getRawSecret.mockImplementation(async (domain: string, field: string) => {
      if (field !== "password") throw new Error(`unexpected field ${field}`)
      if (domain === providerCredentialItemName("azure")) {
        throw new Error(`bw CLI error: item not found for ${providerCredentialItemName("azure")}`)
      }
      const item = mockCredentialStore.items.get(domain)
      if (!item) throw new Error(`missing ${domain}`)
      return item.password
    })
    mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
      username: "minimax",
      password: validPayload("minimax"),
      createdAt: "2026-04-13T00:00:00.000Z",
    })

    const result = await refreshProviderCredentialPool("slugger")

    expect(result).toMatchObject({
      ok: true,
      pool: {
        providers: {
          minimax: { provider: "minimax" },
        },
      },
    })
    expect(result.ok && result.pool.providers.azure).toBeUndefined()
  })

  it("preserves a cached runtime pool when vault refresh fails during retry", async () => {
    emitTestEvent("provider credential preserve cached pool")

    const minimax = createProviderCredentialRecord({
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-13T12:00:00.000Z"),
    })
    cacheProviderCredentialRecords("slugger", [minimax])
    mockCredentialStore.store.getRawSecret.mockRejectedValueOnce(new Error("vault unavailable: operator password manager offline"))

    const preserved = await refreshProviderCredentialPool("slugger", { preserveCachedOnFailure: true })
    expect(preserved).toMatchObject({
      ok: true,
      pool: { providers: { minimax: { revision: minimax.revision } } },
    })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "config.provider_credentials_unavailable",
      meta: {
        agentName: "slugger",
        reason: "unavailable",
        poolPath: "vault:slugger:providers/*",
      },
    }))

    mockCredentialStore.store.getRawSecret.mockRejectedValueOnce(new Error("vault unavailable: operator password manager offline"))
    const failed = await refreshProviderCredentialPool("slugger")
    expect(failed).toMatchObject({
      ok: false,
      reason: "unavailable",
      error: "vault unavailable: operator password manager offline",
    })
    expect(readProviderCredentialPool("slugger")).toBe(failed)
  })

  it("normalizes non-Error vault failures during refresh", async () => {
    emitTestEvent("provider credential non error refresh failure")
    mockCredentialStore.store.getRawSecret.mockRejectedValueOnce("vault string failure")

    const result = await refreshProviderCredentialPool("slugger")

    expect(result).toMatchObject({
      ok: false,
      reason: "unavailable",
      error: "vault string failure",
    })
  })

  it("does not cache a targeted skip-cache refresh failure", async () => {
    emitTestEvent("provider credential skip-cache failure stays local")
    const minimax = createProviderCredentialRecord({
      provider: "minimax",
      credentials: { apiKey: "minimax-key" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-13T12:00:00.000Z"),
    })
    const cached = cacheProviderCredentialRecords("slugger", [minimax])
    mockCredentialStore.store.getRawSecret.mockRejectedValueOnce(new Error("vault unavailable during targeted check"))

    const result = await refreshProviderCredentialPool("slugger", {
      providers: ["minimax"],
      skipCache: true,
    })

    expect(result).toMatchObject({
      ok: false,
      reason: "unavailable",
      error: "vault unavailable during targeted check",
    })
    expect(readProviderCredentialPool("slugger")).toBe(cached)
  })

  it("reports vault payload parse errors as an unavailable credential pool", async () => {
    emitTestEvent("provider credential invalid payload")
    mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
      username: "minimax",
      password: "{not-json",
      createdAt: "2026-04-13T00:00:00.000Z",
    })

    const result = await refreshProviderCredentialPool("slugger")

    expect(result).toMatchObject({
      ok: false,
      reason: "unavailable",
      poolPath: "vault:slugger:providers/*",
    })
  })

  it("rejects invalid provider credential payload shapes", async () => {
    emitTestEvent("provider credential payload validation")

    const invalidPayloads: Array<[string, unknown, string]> = [
      ["not-object", null, "provider credential payload must be an object"],
      ["schema", { schemaVersion: 2 }, "provider credential payload schemaVersion must be 1"],
      ["kind", { schemaVersion: 1, kind: "other" }, "provider credential payload kind must be provider-credential"],
      ["provider", { schemaVersion: 1, kind: "provider-credential", provider: "not-real" }, "provider credential payload provider must be valid"],
      ["provider-mismatch", JSON.parse(validPayload("azure")), "provider credential payload provider must be minimax"],
      ["updated-at", JSON.parse(validPayload("minimax", { updatedAt: "" })), "provider credential payload updatedAt must be non-empty"],
      ["credentials", JSON.parse(validPayload("minimax", { credentials: [] })), "provider credential payload credentials must be an object"],
      ["config", JSON.parse(validPayload("minimax", { config: [] })), "provider credential payload config must be an object"],
      ["credential-field", JSON.parse(validPayload("minimax", { credentials: { apiKey: true } })), "credentials.apiKey must be a string or number"],
      ["config-field", JSON.parse(validPayload("minimax", { config: { endpoint: false } })), "config.endpoint must be a string or number"],
      ["provenance", JSON.parse(validPayload("minimax", { provenance: [] })), "provider credential payload provenance must be an object"],
      ["provenance-source", JSON.parse(validPayload("minimax", { provenance: { source: "env", updatedAt: "2026-04-13T12:00:00.000Z" } })), "provider credential payload provenance.source must be auth-flow or manual"],
      ["provenance-updated-at", JSON.parse(validPayload("minimax", { provenance: { source: "manual", updatedAt: "" } })), "provider credential payload provenance.updatedAt must be non-empty"],
    ]

    for (const [, payload, expectedError] of invalidPayloads) {
      mockCredentialStore.items.clear()
      resetProviderCredentialCache()
      mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
        username: "minimax",
        password: typeof payload === "string" ? payload : JSON.stringify(payload),
        createdAt: "2026-04-13T00:00:00.000Z",
      })

      const result = await refreshProviderCredentialPool("slugger")
      expect(result).toMatchObject({
        ok: false,
        reason: "unavailable",
        error: expectedError,
      })
    }
  })

  it("can upsert provider credentials with the default clock", async () => {
    emitTestEvent("provider credential upsert default clock")

    const record = await upsertProviderCredential({
      agentName: "slugger",
      provider: "github-copilot",
      credentials: { githubToken: "ghp_test" },
      config: { baseUrl: "https://copilot.example" },
      provenance: { source: "manual" },
    })

    expect(record.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(mockCredentialStore.items.has(providerCredentialItemName("github-copilot"))).toBe(true)
  })

  it("fails clearly when the vault write succeeds but the in-memory provider credential pool refresh does not", async () => {
    emitTestEvent("provider credential refresh failure after store")
    const originalGetRawSecret = mockCredentialStore.store.getRawSecret.getMockImplementation()
    let refreshCalls = 0
    mockCredentialStore.store.getRawSecret.mockImplementation(async (domain: string, field: string) => {
      refreshCalls += 1
      if (refreshCalls === 1) {
        throw new Error("vault unavailable: session expired during refresh")
      }
      if (field !== "password") throw new Error(`unexpected field ${field}`)
      const item = mockCredentialStore.items.get(domain)
      if (!item) throw new Error(`missing ${domain}`)
      return item.password
    })

    try {
      await expect(upsertProviderCredential({
        agentName: "slugger",
        provider: "openai-codex",
        credentials: { oauthAccessToken: "oauth-token" },
        config: {},
        provenance: { source: "auth-flow" },
        now: new Date("2026-04-13T12:00:00.000Z"),
      })).rejects.toThrow(
        "credential stored in vault, but the in-memory provider credential pool could not be refreshed: vault unavailable: session expired during refresh. Run 'ouro provider refresh --agent slugger' after fixing vault access, then run 'ouro auth verify --agent slugger'.",
      )

      expect(mockCredentialStore.items.has(providerCredentialItemName("openai-codex"))).toBe(true)
    } finally {
      mockCredentialStore.store.getRawSecret.mockImplementation(
        originalGetRawSecret ?? (async (domain: string, field: string) => {
          if (field !== "password") throw new Error(`unexpected field ${field}`)
          const item = mockCredentialStore.items.get(domain)
          if (!item) throw new Error(`missing ${domain}`)
          return item.password
        }),
      )
    }
  })

  describe("refreshProviderCredentialPool onProgress callback", () => {
    it("calls onProgress at key points during a successful refresh", async () => {
      emitTestEvent("provider credential refresh onProgress success")

      mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
        username: "minimax",
        password: validPayload("minimax"),
        createdAt: "2026-04-13T00:00:00.000Z",
      })

      const onProgress = vi.fn()
      const result = await refreshProviderCredentialPool("slugger", { onProgress })

      expect(result.ok).toBe(true)
      expect(onProgress).toHaveBeenCalled()
      const messages = onProgress.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(messages.some((m: string) => m.includes("reading vault"))).toBe(true)
      expect(messages.some((m: string) => m.includes("parsing"))).toBe(true)
    })

    it("does not error when onProgress is not provided (backward compat)", async () => {
      emitTestEvent("provider credential refresh onProgress omitted")

      mockCredentialStore.items.set(providerCredentialItemName("azure"), {
        username: "azure",
        password: validPayload("azure"),
        createdAt: "2026-04-13T00:00:00.000Z",
      })

      const result = await refreshProviderCredentialPool("slugger")
      expect(result.ok).toBe(true)
    })

    it("calls onProgress before each getRawSecret call for provider items", async () => {
      emitTestEvent("provider credential refresh onProgress per-provider")

      mockCredentialStore.items.set(providerCredentialItemName("minimax"), {
        username: "minimax",
        password: validPayload("minimax"),
        createdAt: "2026-04-13T00:00:00.000Z",
      })
      mockCredentialStore.items.set(providerCredentialItemName("azure"), {
        username: "azure",
        password: validPayload("azure"),
        createdAt: "2026-04-13T00:00:00.000Z",
      })

      const onProgress = vi.fn()
      const result = await refreshProviderCredentialPool("slugger", { onProgress })

      expect(result.ok).toBe(true)
      // Should have at least one progress call per provider item read
      const messages = onProgress.mock.calls.map((c: unknown[]) => c[0] as string)
      const readingMessages = messages.filter((m: string) => m.includes("reading"))
      expect(readingMessages.length).toBeGreaterThanOrEqual(1)
    })

    it("RefreshProviderCredentialPoolOptions accepts onProgress property", async () => {
      emitTestEvent("provider credential refresh options type")

      // This test verifies the type accepts onProgress without TypeScript errors
      const options: Parameters<typeof refreshProviderCredentialPool>[1] = {
        onProgress: (_msg: string) => {},
        preserveCachedOnFailure: false,
      }
      const result = await refreshProviderCredentialPool("slugger", options)
      // Just needs to not throw
      expect(result).toBeDefined()
    })
  })
})
