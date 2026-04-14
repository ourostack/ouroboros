import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCredentialStore = vi.hoisted(() => {
  const items = new Map<string, { username?: string; password: string; notes?: string; createdAt: string }>()
  let rawFailure: unknown = null
  return {
    items,
    setRawFailure(error: unknown) {
      rawFailure = error
    },
    clearRawFailure() {
      rawFailure = null
    },
    store: {
      get: vi.fn(async (domain: string) => {
        const item = items.get(domain)
        return item ? { domain, username: item.username, notes: item.notes, createdAt: item.createdAt } : null
      }),
      getRawSecret: vi.fn(async (domain: string, field: string) => {
        if (rawFailure) throw rawFailure
        if (field !== "password") throw new Error(`unexpected field ${field}`)
        const item = items.get(domain)
        if (!item) throw new Error(`no credential found for domain "${domain}"`)
        return item.password
      }),
      store: vi.fn(async (domain: string, data: { username?: string; password: string; notes?: string }) => {
        items.set(domain, { ...data, createdAt: "2026-04-14T00:00:00.000Z" })
      }),
      list: vi.fn(async () => []),
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
  RUNTIME_CONFIG_ITEM_NAME,
  cacheRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
  resetRuntimeCredentialConfigCache,
  upsertRuntimeCredentialConfig,
} from "../../heart/runtime-credentials"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function runtimePayload(config: Record<string, unknown>, updatedAt = "2026-04-14T12:00:00.000Z"): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt,
    config,
  })
}

describe("runtime credentials vault config", () => {
  beforeEach(() => {
    mockCredentialStore.items.clear()
    mockCredentialStore.clearRawFailure()
    vi.clearAllMocks()
    resetRuntimeCredentialConfigCache()
  })

  it("returns a redaction-safe missing result before runtime/config is loaded", () => {
    emitTestEvent("runtime credentials missing cache")

    expect(readRuntimeCredentialConfig("slugger")).toEqual({
      ok: false,
      reason: "missing",
      itemPath: "vault:slugger:runtime/config",
      error: "no runtime credentials stored at vault:slugger:runtime/config",
    })
  })

  it("caches runtime config for the current process without touching the vault", () => {
    emitTestEvent("runtime credentials cache helper")

    const result = cacheRuntimeCredentialConfig("slugger", {
      bluebubbles: { password: "bb-secret" },
    }, new Date("2026-04-14T12:00:00.000Z"))

    expect(result).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/config",
      config: { bluebubbles: { password: "bb-secret" } },
      updatedAt: "2026-04-14T12:00:00.000Z",
    })
    expect(result.ok ? result.revision : "").toMatch(/^runtime_/)
    expect(readRuntimeCredentialConfig("slugger")).toEqual(result)
    expect(mockCredentialStore.store.getRawSecret).not.toHaveBeenCalled()
  })

  it("upserts runtime/config into the agent vault and refreshes it back into cache", async () => {
    emitTestEvent("runtime credentials upsert refresh")

    const stored = await upsertRuntimeCredentialConfig("slugger", {
      bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" },
      integrations: { perplexityApiKey: "pplx-secret" },
    }, new Date("2026-04-14T12:00:00.000Z"))
    expect(stored.ok).toBe(true)
    expect(mockCredentialStore.items.has(RUNTIME_CONFIG_ITEM_NAME)).toBe(true)

    const raw = mockCredentialStore.items.get(RUNTIME_CONFIG_ITEM_NAME)?.password
    expect(raw).toBe(runtimePayload({
      bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" },
      integrations: { perplexityApiKey: "pplx-secret" },
    }))

    resetRuntimeCredentialConfigCache()
    const refreshed = await refreshRuntimeCredentialConfig("slugger")
    expect(refreshed).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/config",
      config: {
        bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" },
        integrations: { perplexityApiKey: "pplx-secret" },
      },
      updatedAt: "2026-04-14T12:00:00.000Z",
    })
    expect(readRuntimeCredentialConfig("slugger")).toEqual(refreshed)
  })

  it("classifies missing and invalid vault payloads without leaking values", async () => {
    emitTestEvent("runtime credentials missing invalid")

    const missing = await refreshRuntimeCredentialConfig("slugger")
    expect(missing).toEqual({
      ok: false,
      reason: "missing",
      itemPath: "vault:slugger:runtime/config",
      error: "no runtime credentials stored at vault:slugger:runtime/config",
    })

    mockCredentialStore.items.set(RUNTIME_CONFIG_ITEM_NAME, {
      username: "runtime/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "wrong", updatedAt: "2026-04-14T12:00:00.000Z", config: { secret: "nope" } }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    const invalid = await refreshRuntimeCredentialConfig("slugger")
    expect(invalid).toMatchObject({
      ok: false,
      reason: "invalid",
      itemPath: "vault:slugger:runtime/config",
    })
    expect(invalid.error).toContain("kind must be runtime-config")
    expect(invalid.error).not.toContain("nope")
  })

  it("can preserve a cached runtime/config snapshot when the vault is temporarily unavailable", async () => {
    emitTestEvent("runtime credentials preserve cached")

    const cached = cacheRuntimeCredentialConfig("slugger", {
      teams: { clientId: "cached-client-id" },
    }, new Date("2026-04-14T12:00:00.000Z"))
    mockCredentialStore.setRawFailure(new Error("vault locked"))

    const preserved = await refreshRuntimeCredentialConfig("slugger", { preserveCachedOnFailure: true })
    expect(preserved).toEqual(cached)

    const unavailable = await refreshRuntimeCredentialConfig("slugger")
    expect(unavailable).toEqual({
      ok: false,
      reason: "unavailable",
      itemPath: "vault:slugger:runtime/config",
      error: "vault locked",
    })
    expect(readRuntimeCredentialConfig("slugger")).toEqual(unavailable)
  })
})
