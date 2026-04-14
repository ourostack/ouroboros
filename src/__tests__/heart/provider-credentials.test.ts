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
  providerCredentialItemName,
  readProviderCredentialRecord,
  refreshProviderCredentialPool,
  resetProviderCredentialCache,
  splitProviderCredentialFields,
  upsertProviderCredential,
} from "../../heart/provider-credentials"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
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
  })

  it("stores provider credentials as versioned vault items and reloads a redaction-safe pool", async () => {
    emitTestEvent("provider credential upsert and refresh")

    const record = await upsertProviderCredential({
      agentName: "slugger",
      provider: "minimax",
      credentials: { apiKey: "minimax-secret" },
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
      credentials: { apiKey: "minimax-secret" },
      config: {},
      provenance: { source: "auth-flow", updatedAt: "2026-04-13T12:00:00.000Z" },
    })

    const reloaded = await readProviderCredentialRecord("slugger", "minimax")
    expect(reloaded.ok ? reloaded.record.revision : undefined).toBe(record.revision)
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
})
