import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"

const mockCredentialStore = vi.hoisted(() => {
  const items = new Map<string, { username?: string; password: string; notes?: string; createdAt: string }>()
  let rawFailure: unknown = null
  let rawFailureCall: number | null = null
  let rawCallCount = 0
  let rawMutation: { call: number; mutate: () => void } | null = null
  let storeFailureDomain: string | null = null
  let droppedStoreDomain: string | null = null
  return {
    items,
    setRawFailure(error: unknown) {
      rawFailure = error
    },
    clearRawFailure() {
      rawFailure = null
      rawFailureCall = null
      rawCallCount = 0
      rawMutation = null
    },
    failRawOnCall(call: number) {
      rawFailureCall = call
    },
    mutateRawOnCall(call: number, mutate: () => void) {
      rawMutation = { call, mutate }
    },
    failNextStoreFor(domain: string) {
      storeFailureDomain = domain
    },
    clearStoreFailure() {
      storeFailureDomain = null
      droppedStoreDomain = null
    },
    dropNextStoreFor(domain: string) {
      droppedStoreDomain = domain
    },
    store: {
      get: vi.fn(async (domain: string) => {
        const item = items.get(domain)
        return item ? { domain, username: item.username, notes: item.notes, createdAt: item.createdAt } : null
      }),
      getRawSecret: vi.fn(async (domain: string, field: string) => {
        rawCallCount += 1
        if (rawMutation?.call === rawCallCount) {
          rawMutation.mutate()
          rawMutation = null
        }
        if (rawFailureCall === rawCallCount) throw new Error("vault readback unavailable")
        if (rawFailure) throw rawFailure
        if (field !== "password") throw new Error(`unexpected field ${field}`)
        const item = items.get(domain)
        if (!item) throw new Error(`no credential found for domain "${domain}"`)
        return item.password
      }),
      store: vi.fn(async (domain: string, data: { username?: string; password: string; notes?: string }) => {
        if (storeFailureDomain === domain) {
          storeFailureDomain = null
          throw new Error(`vault write unavailable for ${domain}`)
        }
        if (droppedStoreDomain === domain) {
          droppedStoreDomain = null
          return
        }
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
  MACHINE_RUNTIME_CONFIG_ITEM_PREFIX,
  RUNTIME_CONFIG_ITEM_NAME,
  applyRuntimeCredentialBootstrapMessage,
  cacheMachineRuntimeCredentialConfig,
  cacheRuntimeCredentialConfig,
  machineRuntimeConfigItemName,
  mergeRuntimeCredentialConfig,
  mergeMachineRuntimeCredentialConfig,
  persistRuntimeCredentialBootstrapMessage,
  readMachineRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
  resetRuntimeCredentialConfigCache,
  upsertMachineRuntimeCredentialConfig,
  upsertRuntimeCredentialConfig,
  waitForRuntimeCredentialBootstrap,
} from "../../heart/runtime-credentials"
import {
  createProviderCredentialRecord,
  readProviderCredentialPool,
  resetProviderCredentialCache,
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

function runtimePayload(config: Record<string, unknown>, updatedAt = "2026-04-14T12:00:00.000Z"): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt,
    config,
  })
}

function listProductionTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") return []
      return listProductionTsFiles(fullPath)
    }
    if (!entry.isFile()) return []
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) return []
    return [fullPath]
  })
}

describe("runtime credentials vault config", () => {
  beforeEach(() => {
    mockCredentialStore.items.clear()
    mockCredentialStore.clearRawFailure()
    mockCredentialStore.clearStoreFailure()
    vi.clearAllMocks()
    resetRuntimeCredentialConfigCache()
    resetProviderCredentialCache()
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
      enabledSenses: ["bluebubbles"],
    }, new Date("2026-04-14T12:00:00.000Z"))

    expect(result).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/config",
      config: { bluebubbles: { password: "bb-secret" }, enabledSenses: ["bluebubbles"] },
      updatedAt: "2026-04-14T12:00:00.000Z",
    })
    expect(result.ok ? result.revision : "").toMatch(/^runtime_/)
    expect(readRuntimeCredentialConfig("slugger")).toEqual(result)
    expect(mockCredentialStore.store.getRawSecret).not.toHaveBeenCalled()
  })

  it("applies daemon IPC runtime credential bootstrap into process memory", () => {
    emitTestEvent("runtime credentials daemon bootstrap")

    const applied = applyRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
      machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" } },
      machineId: "machine_test",
    })

    expect(applied).toBe(true)
    expect(readRuntimeCredentialConfig("slugger")).toMatchObject({
      ok: true,
      config: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
    })
    expect(readMachineRuntimeCredentialConfig("slugger")).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_test/config",
      config: { bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" } },
    })
    expect(mockCredentialStore.store.getRawSecret).not.toHaveBeenCalled()
  })

  it("applies daemon IPC provider credential bootstrap into process memory", () => {
    emitTestEvent("runtime credentials daemon provider bootstrap")

    const providerRecord = createProviderCredentialRecord({
      provider: "openai-codex",
      credentials: { oauthAccessToken: "codex-token", expiresAt: 123 },
      config: { retryBudget: 1 },
      provenance: { source: "manual" },
      now: new Date("2026-04-14T12:00:00.000Z"),
    })

    const applied = applyRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      providerCredentialRecords: [providerRecord],
    })

    expect(applied).toBe(true)
    expect(readProviderCredentialPool("slugger")).toMatchObject({
      ok: true,
      pool: {
        providers: {
          "openai-codex": expect.objectContaining({
            provider: "openai-codex",
            credentials: { oauthAccessToken: "codex-token", expiresAt: 123 },
            config: { retryBudget: 1 },
          }),
        },
      },
    })
    expect(mockCredentialStore.store.getRawSecret).not.toHaveBeenCalled()
  })

  it("durably imports every bootstrap credential class into canonical vault items", async () => {
    emitTestEvent("runtime credentials durable container bootstrap")
    const providerRecord = createProviderCredentialRecord({
      provider: "openai-compatible",
      credentials: { apiKey: "provider-secret" },
      config: { baseUrl: "https://api.z.ai/api/paas/v4/" },
      provenance: { source: "auth-flow" },
      now: new Date("2026-04-14T12:00:00.000Z"),
    })

    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "telegram-secret" },
      machineRuntimeConfig: { unraidReadApiKey: "read-secret", unraidWriteApiKey: "write-secret" },
      providerCredentialRecords: [providerRecord],
    }, {
      machineId: "machine_sanctuary",
      now: new Date("2026-04-14T13:00:00.000Z"),
    })).resolves.toBe(true)

    expect([...mockCredentialStore.items.keys()].sort()).toEqual([
      "providers/openai-compatible",
      "runtime/config",
      "runtime/machines/machine_sanctuary/config",
    ])
    expect(JSON.parse(mockCredentialStore.items.get("runtime/config")!.password)).toMatchObject({
      kind: "runtime-config",
      config: { telegramBotToken: "telegram-secret" },
    })
    expect(JSON.parse(mockCredentialStore.items.get("runtime/machines/machine_sanctuary/config")!.password)).toMatchObject({
      kind: "runtime-config",
      config: { unraidReadApiKey: "read-secret", unraidWriteApiKey: "write-secret" },
    })
    expect(JSON.parse(mockCredentialStore.items.get("providers/openai-compatible")!.password)).toMatchObject({
      kind: "provider-credential",
      provider: "openai-compatible",
      credentials: { apiKey: "provider-secret" },
      config: { baseUrl: "https://api.z.ai/api/paas/v4/" },
    })
  })

  it("rejects typo fields, top-level secrets, arbitrary providers, and malformed provider records before any vault write", async () => {
    emitTestEvent("runtime credentials strict bootstrap schema")
    const validProvider = createProviderCredentialRecord({
      provider: "openai-compatible",
      credentials: { apiKey: "provider-secret" },
      config: { baseUrl: "https://api.example" },
      provenance: { source: "auth-flow" },
      now: new Date("2026-04-14T12:00:00.000Z"),
    })
    const invalidMessages = [
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfg: { telegramBotToken: "secret" } },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", telegramBotToken: "top-level-secret" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: {} },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", machineRuntimeConfig: {} },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", runtimeConfig: { telegramBotToken: "secret" }, providerCredentialRecords: [] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, credentials: {} }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, config: {} }] },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "sanctuary",
        providerCredentialRecords: [{ ...validProvider, credentials: { baseUrl: "https://api.example" }, config: { apiKey: "secret" } }],
      },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, credentials: { apiKey: "   " } }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, credentials: { apiKey: 0 } }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, credentials: { apiKey: Number.NaN } }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, provider: "arbitrary-provider" }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, provider: "constructor" }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, typo: true }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, revision: 42 }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, revision: "not-a-revision" }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, updatedAt: 42 }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, updatedAt: "yesterday" }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, credentials: [] }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, config: [] }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, provenance: null }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, provenance: { ...validProvider.provenance, source: "other" } }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, provenance: { ...validProvider.provenance, typo: true } }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "sanctuary", providerCredentialRecords: [{ ...validProvider, provenance: { ...validProvider.provenance, updatedAt: 42 } }] },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "sanctuary",
        providerCredentialRecords: [{ ...validProvider, provenance: { ...validProvider.provenance, updatedAt: "2026-04-14T12:00:01.000Z" } }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "sanctuary",
        providerCredentialRecords: [validProvider, validProvider],
      },
    ]

    for (const message of invalidMessages) {
      await expect(persistRuntimeCredentialBootstrapMessage(message, { machineId: "machine_sanctuary" })).resolves.toBe(false)
      expect(applyRuntimeCredentialBootstrapMessage(message)).toBe(false)
    }
    expect(applyRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      providerCredentialRecords: [
        { ...validProvider, provenance: { ...validProvider.provenance, source: "manual" } },
        createProviderCredentialRecord({
          provider: "minimax",
          credentials: { apiKey: 1 },
          config: {},
          provenance: { source: "auth-flow" },
        }),
      ],
    })).toBe(true)
    expect(mockCredentialStore.store.store).not.toHaveBeenCalled()
  })

  it("reconciles equal and missing bootstrap fields without replacing canonical runtime, machine, or provider secrets", async () => {
    emitTestEvent("runtime credentials merge-only bootstrap reconciliation")
    await upsertRuntimeCredentialConfig("sanctuary", {
      telegramBotToken: "existing-telegram",
      nested: { keep: "canonical" },
    }, new Date("2026-04-14T11:00:00.000Z"))
    await upsertMachineRuntimeCredentialConfig("sanctuary", "machine_sanctuary", {
      unraidReadApiKey: "existing-read",
    }, new Date("2026-04-14T11:00:00.000Z"))
    await upsertProviderCredential({
      agentName: "sanctuary",
      provider: "openai-compatible",
      credentials: { apiKey: "existing-provider" },
      config: {},
      provenance: { source: "manual" },
      now: new Date("2026-04-14T11:00:00.000Z"),
    })
    const providerRecord = createProviderCredentialRecord({
      provider: "openai-compatible",
      credentials: { apiKey: "existing-provider" },
      config: { baseUrl: "https://api.z.ai/api/paas/v4/" },
      provenance: { source: "auth-flow" },
      now: new Date("2026-04-14T12:00:00.000Z"),
    })

    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "existing-telegram", nested: { added: "bootstrap" } },
      machineRuntimeConfig: { unraidReadApiKey: "existing-read", unraidWriteApiKey: "bootstrap-write" },
      machineId: "machine_sanctuary",
      providerCredentialRecords: [providerRecord],
    }, { machineId: "machine_sanctuary", now: new Date("2026-04-14T13:00:00.000Z") })).resolves.toBe(true)

    expect(JSON.parse(mockCredentialStore.items.get("runtime/config")!.password).config).toEqual({
      telegramBotToken: "existing-telegram",
      nested: { keep: "canonical", added: "bootstrap" },
    })
    expect(JSON.parse(mockCredentialStore.items.get("runtime/machines/machine_sanctuary/config")!.password).config).toEqual({
      unraidReadApiKey: "existing-read",
      unraidWriteApiKey: "bootstrap-write",
    })
    expect(JSON.parse(mockCredentialStore.items.get("providers/openai-compatible")!.password)).toMatchObject({
      credentials: { apiKey: "existing-provider" },
      config: { baseUrl: "https://api.z.ai/api/paas/v4/" },
      provenance: { source: "manual" },
    })
    expect(readRuntimeCredentialConfig("sanctuary")).toMatchObject({ ok: true, config: { nested: { keep: "canonical", added: "bootstrap" } } })
    expect(readMachineRuntimeCredentialConfig("sanctuary")).toMatchObject({ ok: true, config: { unraidWriteApiKey: "bootstrap-write" } })
    expect(readProviderCredentialPool("sanctuary")).toMatchObject({
      ok: true,
      pool: { providers: { "openai-compatible": { credentials: { apiKey: "existing-provider" } } } },
    })
  })

  it("rejects empty bootstrap classes and conflicts without replacing canonical secrets", async () => {
    emitTestEvent("runtime credentials empty and conflicting bootstrap reconciliation")
    await upsertRuntimeCredentialConfig("sanctuary", { telegramBotToken: "canonical-secret" })
    await upsertMachineRuntimeCredentialConfig("sanctuary", "machine_sanctuary", { unraidReadApiKey: "canonical-read" })
    await upsertProviderCredential({
      agentName: "sanctuary",
      provider: "openai-compatible",
      credentials: { apiKey: "canonical-provider" },
      config: {},
      provenance: { source: "manual" },
    })
    mockCredentialStore.store.store.mockClear()

    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: {},
    }, { machineId: "machine_sanctuary" })).resolves.toBe(false)
    expect(applyRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineRuntimeConfig: {},
    })).toBe(false)
    expect(mockCredentialStore.store.store).not.toHaveBeenCalled()
    expect(readRuntimeCredentialConfig("sanctuary")).toMatchObject({ ok: true, config: { telegramBotToken: "canonical-secret" } })

    let failure: unknown
    try {
      await persistRuntimeCredentialBootstrapMessage({
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "sanctuary",
        runtimeConfig: { telegramBotToken: "different-secret" },
      }, { machineId: "machine_sanctuary" })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("runtimeConfig.telegramBotToken")
    expect((failure as Error).message).not.toContain("canonical-secret")
    expect((failure as Error).message).not.toContain("different-secret")
    expect(mockCredentialStore.store.store).not.toHaveBeenCalled()

    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "machine_sanctuary",
      machineRuntimeConfig: { unraidReadApiKey: "different-read" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("machineRuntimeConfig.unraidReadApiKey")
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      providerCredentialRecords: [createProviderCredentialRecord({
        provider: "openai-compatible",
        credentials: { apiKey: "different-provider" },
        config: { baseUrl: "https://api.example" },
        provenance: { source: "auth-flow" },
      })],
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("providerCredentialRecords.openai-compatible.credentials.apiKey")
    expect(JSON.stringify([...mockCredentialStore.items])).not.toContain("different-read")
    expect(JSON.stringify([...mockCredentialStore.items])).not.toContain("different-provider")
  })

  it("fails closed on unreadable or invalid canonical state and safely retries after a partial write", async () => {
    emitTestEvent("runtime credentials fail-closed retry reconciliation")
    mockCredentialStore.setRawFailure(new Error("vault locked"))
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "bootstrap-secret" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("cannot reconcile runtimeConfig")
    expect(mockCredentialStore.store.store).not.toHaveBeenCalled()

    mockCredentialStore.clearRawFailure()
    mockCredentialStore.failNextStoreFor("providers/openai-compatible")
    const message = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "bootstrap-secret" },
      providerCredentialRecords: [createProviderCredentialRecord({
        provider: "openai-compatible" as const,
        credentials: { apiKey: "provider-secret" },
        config: { baseUrl: "https://api.example" },
        provenance: { source: "auth-flow" as const },
        now: new Date("2026-04-14T12:00:00.000Z"),
      })],
    }
    await expect(persistRuntimeCredentialBootstrapMessage(message, { machineId: "machine_sanctuary" }))
      .rejects.toThrow("vault write unavailable")
    expect(mockCredentialStore.items.has("runtime/config")).toBe(true)

    await expect(persistRuntimeCredentialBootstrapMessage(message, { machineId: "machine_sanctuary" })).resolves.toBe(true)
    expect(mockCredentialStore.store.store.mock.calls.filter(([domain]) => domain === "runtime/config")).toHaveLength(1)
    expect(mockCredentialStore.items.has("providers/openai-compatible")).toBe(true)
  })

  it("fails closed on machine mismatch and invalid canonical machine or provider state", async () => {
    emitTestEvent("runtime credentials machine and provider reconciliation failures")
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "machine_other",
      machineRuntimeConfig: { unraidReadApiKey: "secret" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("machineId does not match this machine")

    mockCredentialStore.items.set("runtime/machines/machine_sanctuary/config", {
      username: "runtime/machines/machine_sanctuary/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "wrong", updatedAt: "2026-04-14T12:00:00.000Z", config: {} }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineRuntimeConfig: { unraidReadApiKey: "secret" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("cannot reconcile machineRuntimeConfig")

    mockCredentialStore.items.set("providers/openai-compatible", {
      username: "openai-compatible",
      password: JSON.stringify({ schemaVersion: 1, kind: "wrong" }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      providerCredentialRecords: [createProviderCredentialRecord({
        provider: "openai-compatible",
        credentials: { apiKey: "secret" },
        config: { baseUrl: "https://api.example" },
        provenance: { source: "auth-flow" },
      })],
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("cannot reconcile providerCredentialRecords.openai-compatible")
  })

  it("requires canonical runtime, machine, and provider readback after writes", async () => {
    emitTestEvent("runtime credentials canonical readback failures")
    mockCredentialStore.failRawOnCall(2)
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "secret" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("cannot read back runtimeConfig")

    mockCredentialStore.items.clear()
    mockCredentialStore.clearRawFailure()
    resetRuntimeCredentialConfigCache()
    mockCredentialStore.failRawOnCall(2)
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineRuntimeConfig: { unraidReadApiKey: "secret" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("cannot read back machineRuntimeConfig")

    mockCredentialStore.items.clear()
    mockCredentialStore.clearRawFailure()
    resetProviderCredentialCache()
    mockCredentialStore.failRawOnCall(3)
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      providerCredentialRecords: [createProviderCredentialRecord({
        provider: "azure",
        credentials: { apiKey: "secret" },
        config: { endpoint: "https://azure.example", deployment: "deployment" },
        provenance: { source: "auth-flow" },
      })],
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("cannot read back providerCredentialRecords")
  })

  it("rejects stale successful readback when a vault write silently fails to land", async () => {
    emitTestEvent("runtime credentials readback attestation")
    await upsertRuntimeCredentialConfig("sanctuary", { existing: "runtime" })
    await upsertMachineRuntimeCredentialConfig("sanctuary", "machine_sanctuary", { existing: "machine" })
    await upsertProviderCredential({
      agentName: "sanctuary",
      provider: "openai-compatible",
      credentials: { apiKey: "canonical-provider" },
      config: {},
      provenance: { source: "manual" },
    })

    mockCredentialStore.dropNextStoreFor("runtime/config")
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { added: "runtime-bootstrap" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("runtimeConfig.added")

    mockCredentialStore.dropNextStoreFor("runtime/machines/machine_sanctuary/config")
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineRuntimeConfig: { added: "machine-bootstrap" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("machineRuntimeConfig.added")

    mockCredentialStore.dropNextStoreFor("providers/openai-compatible")
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      providerCredentialRecords: [createProviderCredentialRecord({
        provider: "openai-compatible",
        credentials: { apiKey: "canonical-provider" },
        config: { baseUrl: "https://bootstrap.example" },
        provenance: { source: "auth-flow" },
      })],
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("providerCredentialRecords.openai-compatible.config.baseUrl")
  })

  it("rejects mismatched or missing canonical readback after an apparently successful write", async () => {
    emitTestEvent("runtime credentials exact readback attestation")
    mockCredentialStore.mutateRawOnCall(2, () => {
      mockCredentialStore.items.set("runtime/config", {
        username: "runtime/config",
        password: runtimePayload({ telegramBotToken: "tampered" }),
        createdAt: "2026-04-14T00:00:00.000Z",
      })
    })
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramBotToken: "bootstrap-secret" },
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("runtimeConfig.telegramBotToken")

    mockCredentialStore.items.clear()
    mockCredentialStore.clearRawFailure()
    resetProviderCredentialCache()
    mockCredentialStore.mutateRawOnCall(3, () => {
      mockCredentialStore.items.delete("providers/openai-compatible")
    })
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      providerCredentialRecords: [createProviderCredentialRecord({
        provider: "openai-compatible",
        credentials: { apiKey: "provider-secret" },
        config: { baseUrl: "https://api.example" },
        provenance: { source: "auth-flow" },
      })],
    }, { machineId: "machine_sanctuary" })).rejects.toThrow("providerCredentialRecords.openai-compatible")
  })

  it("uses a matching explicit message machine id and rejects invalid bootstrap without vault writes", async () => {
    emitTestEvent("runtime credentials durable bootstrap validation")

    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      machineId: "machine_from_envelope",
      machineRuntimeConfig: { unraidReadApiKey: "read-secret" },
    }, { machineId: "machine_from_envelope" })).resolves.toBe(true)
    expect(mockCredentialStore.items.has("runtime/machines/machine_from_envelope/config")).toBe(true)

    mockCredentialStore.items.clear()
    mockCredentialStore.store.store.mockClear()
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "sanctuary",
      runtimeConfig: { telegramAuthorizedUserId: "123" },
    }, { machineId: "machine_fallback" })).resolves.toBe(true)
    expect(mockCredentialStore.items.has("runtime/config")).toBe(true)

    mockCredentialStore.items.clear()
    mockCredentialStore.store.store.mockClear()
    await expect(persistRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "",
      runtimeConfig: {},
    }, { machineId: "machine_fallback" })).resolves.toBe(false)
    expect(mockCredentialStore.store.store).not.toHaveBeenCalled()
  })

  it("rejects malformed runtime credential bootstrap messages without touching cache", () => {
    emitTestEvent("runtime credentials reject malformed daemon bootstrap")

    for (const message of [
      null,
      [],
      { type: "other", agentName: "slugger" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", runtimeConfig: [] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", machineRuntimeConfig: "bad" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", machineId: "" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", providerCredentialRecords: "bad" },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", providerCredentialRecords: [null] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", providerCredentialRecords: [{ provider: 42 }] },
      { type: "ouro.runtimeCredentialBootstrap", agentName: "slugger", providerCredentialRecords: [{ provider: "openai-codex" }] },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "",
          credentials: {},
          config: {},
          provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: "bad",
          config: {},
          provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: { oauthAccessToken: false },
          config: {},
          provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: {},
          config: "bad",
          provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: {},
          config: { retryBudget: false },
          provenance: { source: "auth-flow", updatedAt: "2026-04-14T12:00:00.000Z" },
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: {},
          config: {},
          provenance: "bad",
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: {},
          config: {},
          provenance: { source: "other", updatedAt: "2026-04-14T12:00:00.000Z" },
        }],
      },
      {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        providerCredentialRecords: [{
          provider: "openai-codex",
          revision: "vault_0123456789abcdef",
          updatedAt: "2026-04-14T12:00:00.000Z",
          credentials: {},
          config: {},
          provenance: { source: "auth-flow", updatedAt: "" },
        }],
      },
    ]) {
      expect(applyRuntimeCredentialBootstrapMessage(message)).toBe(false)
    }

    expect(readRuntimeCredentialConfig("slugger")).toEqual({
      ok: false,
      reason: "missing",
      itemPath: "vault:slugger:runtime/config",
      error: "no runtime credentials stored at vault:slugger:runtime/config",
    })
  })

  it("uses this-machine when daemon IPC omits a machine id", () => {
    emitTestEvent("runtime credentials daemon bootstrap default machine")

    expect(applyRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" } },
    })).toBe(true)

    expect(readMachineRuntimeCredentialConfig("slugger")).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/<this-machine>/config",
      config: { bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" } },
    })
  })

  it("accepts daemon IPC bootstrap messages that only include shared runtime config", () => {
    emitTestEvent("runtime credentials daemon bootstrap runtime only")

    expect(applyRuntimeCredentialBootstrapMessage({
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
    })).toBe(true)

    expect(readRuntimeCredentialConfig("slugger")).toMatchObject({
      ok: true,
      config: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
    })
    expect(readMachineRuntimeCredentialConfig("slugger")).toMatchObject({
      ok: false,
      reason: "missing",
    })
  })

  it("waits briefly for daemon IPC runtime credential bootstrap", async () => {
    emitTestEvent("runtime credentials wait for daemon bootstrap")

    const waiting = waitForRuntimeCredentialBootstrap("slugger", { timeoutMs: 100 })
    process.emit("message", {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      machineRuntimeConfig: { bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" } },
      machineId: "machine_test",
    })

    await expect(waiting).resolves.toBe(true)
    expect(readMachineRuntimeCredentialConfig("slugger")).toMatchObject({
      ok: true,
      config: { bluebubbles: { serverUrl: "http://localhost:1234", password: "bb-secret" } },
    })
  })

  it("ignores unrelated daemon IPC messages and resolves false on timeout", async () => {
    emitTestEvent("runtime credentials daemon bootstrap timeout")
    vi.useFakeTimers()

    try {
      const waiting = waitForRuntimeCredentialBootstrap("slugger")
      process.emit("message", { type: "other", agentName: "slugger" })
      process.emit("message", {
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "ouroboros",
        runtimeConfig: { mailroom: { mailboxAddress: "ouroboros@ouro.bot" } },
      })

      await vi.advanceTimersByTimeAsync(1_500)

      await expect(waiting).resolves.toBe(false)
      expect(readRuntimeCredentialConfig("slugger")).toEqual({
        ok: false,
        reason: "missing",
        itemPath: "vault:slugger:runtime/config",
        error: "no runtime credentials stored at vault:slugger:runtime/config",
      })
    } finally {
      vi.useRealTimers()
    }
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

  it("merges partial runtime/config patches into the portable runtime vault item", async () => {
    emitTestEvent("runtime credentials portable merge")

    await upsertRuntimeCredentialConfig("slugger", {
      mailroom: { mailboxAddress: "slugger@ouro.bot" },
      rsvp: { existing: true },
    }, new Date("2026-04-14T12:00:00.000Z"))

    const merged = await mergeRuntimeCredentialConfig("slugger", {
      rsvp: {
        aisleplanner: {
          username: "ari@example.com",
          password: "rsvp-secret",
        },
      },
    }, new Date("2026-04-14T13:00:00.000Z"))

    expect(merged).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/config",
      config: {
        mailroom: { mailboxAddress: "slugger@ouro.bot" },
        rsvp: {
          existing: true,
          aisleplanner: {
            username: "ari@example.com",
            password: "rsvp-secret",
          },
        },
      },
      updatedAt: "2026-04-14T13:00:00.000Z",
    })
  })

  it("creates portable runtime/config when merging into a missing vault item", async () => {
    emitTestEvent("runtime credentials portable merge missing base")

    const merged = await mergeRuntimeCredentialConfig("slugger", {
      rsvp: {
        aisleplanner: {
          username: "ari@example.com",
          password: "rsvp-secret",
        },
      },
    }, new Date("2026-04-14T13:00:00.000Z"))

    expect(merged).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/config",
      config: {
        rsvp: {
          aisleplanner: {
            username: "ari@example.com",
            password: "rsvp-secret",
          },
        },
      },
    })
  })

  it("refuses portable runtime/config merge when the current vault payload is invalid", async () => {
    emitTestEvent("runtime credentials portable merge invalid base")

    mockCredentialStore.items.set(RUNTIME_CONFIG_ITEM_NAME, {
      username: "runtime/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "wrong", updatedAt: "2026-04-14T12:00:00.000Z", config: {} }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })

    await expect(mergeRuntimeCredentialConfig("slugger", {
      rsvp: { aisleplanner: { username: "ari@example.com", password: "rsvp-secret" } },
    })).rejects.toThrow("cannot merge runtime config at vault:slugger:runtime/config")

    mockCredentialStore.items.set(RUNTIME_CONFIG_ITEM_NAME, {
      username: "runtime/config",
      password: JSON.stringify({ schemaVersion: 2, kind: "runtime-config", updatedAt: "2026-04-14T12:00:00.000Z", config: {} }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    await expect(mergeRuntimeCredentialConfig("slugger", {
      rsvp: { aisleplanner: { username: "ari@example.com", password: "rsvp-secret" } },
    })).rejects.toThrow("schemaVersion must be 1")
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

    mockCredentialStore.items.set(RUNTIME_CONFIG_ITEM_NAME, {
      username: "runtime/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "runtime-config", updatedAt: "   ", config: {} }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    const blankUpdatedAt = await refreshRuntimeCredentialConfig("slugger")
    expect(blankUpdatedAt).toMatchObject({
      ok: false,
      reason: "invalid",
      itemPath: "vault:slugger:runtime/config",
    })
    expect(blankUpdatedAt.error).toContain("updatedAt must be non-empty")

    mockCredentialStore.items.set(RUNTIME_CONFIG_ITEM_NAME, {
      username: "runtime/config",
      password: JSON.stringify(null),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    const nonObject = await refreshRuntimeCredentialConfig("slugger")
    expect(nonObject).toMatchObject({ ok: false, reason: "invalid" })
    expect(nonObject.error).toContain("payload must be an object")

    mockCredentialStore.items.set(RUNTIME_CONFIG_ITEM_NAME, {
      username: "runtime/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "runtime-config", updatedAt: "2026-04-14T12:00:00.000Z", config: [] }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })
    const nonObjectConfig = await refreshRuntimeCredentialConfig("slugger")
    expect(nonObjectConfig).toMatchObject({ ok: false, reason: "invalid" })
    expect(nonObjectConfig.error).toContain("config must be an object")
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

    mockCredentialStore.setRawFailure("vault string failure")
    const stringFailure = await refreshRuntimeCredentialConfig("slugger")
    expect(stringFailure).toEqual({
      ok: false,
      reason: "unavailable",
      itemPath: "vault:slugger:runtime/config",
      error: "vault string failure",
    })
  })

  it("stores and refreshes current-machine runtime config in a machine-scoped vault item", async () => {
    emitTestEvent("runtime credentials machine scoped upsert refresh")

    expect(MACHINE_RUNTIME_CONFIG_ITEM_PREFIX).toBe("runtime/machines")
    expect(machineRuntimeConfigItemName("machine_local")).toBe("runtime/machines/machine_local/config")
    expect(() => machineRuntimeConfigItemName("   ")).toThrow("machineId must be non-empty")

    const stored = await upsertMachineRuntimeCredentialConfig("slugger", "machine_local", {
      bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-secret" },
      bluebubblesChannel: { port: "18790" },
    }, new Date("2026-04-14T12:00:00.000Z"))

    expect(stored).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_local/config",
      config: {
        bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-secret" },
        bluebubblesChannel: { port: "18790" },
      },
    })
    expect(mockCredentialStore.items.has("runtime/machines/machine_local/config")).toBe(true)

    resetRuntimeCredentialConfigCache()
    const missingBeforeRefresh = readMachineRuntimeCredentialConfig("slugger")
    expect(missingBeforeRefresh).toEqual({
      ok: false,
      reason: "missing",
      itemPath: "vault:slugger:runtime/machines/<this-machine>/config",
      error: "no machine runtime credentials loaded for slugger",
    })

    const refreshed = await refreshMachineRuntimeCredentialConfig("slugger", "machine_local")
    expect(refreshed).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_local/config",
      config: {
        bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-secret" },
        bluebubblesChannel: { port: "18790" },
      },
    })
    expect(readMachineRuntimeCredentialConfig("slugger")).toEqual(refreshed)
  })

  it("merges partial machine-runtime updates into the current vault item without replacing sibling attachments", async () => {
    emitTestEvent("runtime credentials machine scoped merge update")

    mockCredentialStore.items.set("runtime/machines/machine_local/config", {
      username: "runtime/machines/machine_local/config",
      password: runtimePayload({
        bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-secret" },
        bluebubblesChannel: { port: 18790, webhookPath: "/bluebubbles-webhook" },
        voice: { whisperCliPath: "/opt/whisper.cpp/main", whisperModelPath: "/models/base.bin" },
        a2a: { publicUrl: "https://agent.example" },
      }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })

    const merged = await mergeMachineRuntimeCredentialConfig("slugger", "machine_local", {
      a2a: { identity: { ed25519Seed: "seed-123" } },
    }, new Date("2026-04-14T13:00:00.000Z"))

    expect(merged).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_local/config",
      updatedAt: "2026-04-14T13:00:00.000Z",
      config: {
        bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-secret" },
        bluebubblesChannel: { port: 18790, webhookPath: "/bluebubbles-webhook" },
        voice: { whisperCliPath: "/opt/whisper.cpp/main", whisperModelPath: "/models/base.bin" },
        a2a: {
          publicUrl: "https://agent.example",
          identity: { ed25519Seed: "seed-123" },
        },
      },
    })
    const raw = mockCredentialStore.items.get("runtime/machines/machine_local/config")?.password
    expect(raw).toBe(runtimePayload({
      bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "bb-secret" },
      bluebubblesChannel: { port: 18790, webhookPath: "/bluebubbles-webhook" },
      voice: { whisperCliPath: "/opt/whisper.cpp/main", whisperModelPath: "/models/base.bin" },
      a2a: {
        publicUrl: "https://agent.example",
        identity: { ed25519Seed: "seed-123" },
      },
    }, "2026-04-14T13:00:00.000Z"))
  })

  it("keeps production machine-runtime partial writers behind the merge helper", () => {
    emitTestEvent("runtime credentials machine writer inventory")

    const srcRoot = path.join(process.cwd(), "src")
    const allowedRawWriter = path.join("src", "heart", "runtime-credentials.ts")
    const offenders = listProductionTsFiles(srcRoot)
      .filter((filePath) => path.relative(process.cwd(), filePath) !== allowedRawWriter)
      .filter((filePath) => fs.readFileSync(filePath, "utf-8").includes("upsertMachineRuntimeCredentialConfig("))
      .map((filePath) => path.relative(process.cwd(), filePath))

    expect(offenders).toEqual([])
  })

  it("creates a machine-runtime item from a partial merge when no item exists yet", async () => {
    emitTestEvent("runtime credentials machine scoped merge missing")

    const merged = await mergeMachineRuntimeCredentialConfig("slugger", "machine_first", {
      a2a: { identity: { ed25519Seed: "first-seed" } },
    }, new Date("2026-04-14T13:00:00.000Z"))

    expect(merged).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_first/config",
      config: { a2a: { identity: { ed25519Seed: "first-seed" } } },
    })
  })

  it("refuses partial machine-runtime merges when the current vault item is unreadable", async () => {
    emitTestEvent("runtime credentials machine scoped merge unreadable")

    mockCredentialStore.items.set("runtime/machines/machine_bad/config", {
      username: "runtime/machines/machine_bad/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "wrong", updatedAt: "2026-04-14T12:00:00.000Z", config: { password: "nope" } }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })

    await expect(
      mergeMachineRuntimeCredentialConfig("slugger", "machine_bad", {
        a2a: { identity: { ed25519Seed: "seed-123" } },
      }),
    ).rejects.toThrow(/cannot merge machine runtime config/i)

    const raw = mockCredentialStore.items.get("runtime/machines/machine_bad/config")?.password
    expect(raw).toContain('"kind":"wrong"')
  })

  it("classifies missing and invalid machine-scoped runtime config without leaking values", async () => {
    emitTestEvent("runtime credentials machine scoped missing invalid")

    const missing = await refreshMachineRuntimeCredentialConfig("slugger", "machine_absent")
    expect(missing).toEqual({
      ok: false,
      reason: "missing",
      itemPath: "vault:slugger:runtime/machines/machine_absent/config",
      error: "no runtime credentials stored at vault:slugger:runtime/machines/machine_absent/config",
    })

    mockCredentialStore.items.set("runtime/machines/machine_bad/config", {
      username: "runtime/machines/machine_bad/config",
      password: JSON.stringify({ schemaVersion: 1, kind: "wrong", updatedAt: "2026-04-14T12:00:00.000Z", config: { password: "nope" } }),
      createdAt: "2026-04-14T00:00:00.000Z",
    })

    const invalid = await refreshMachineRuntimeCredentialConfig("slugger", "machine_bad")
    expect(invalid).toMatchObject({
      ok: false,
      reason: "invalid",
      itemPath: "vault:slugger:runtime/machines/machine_bad/config",
    })
    expect(invalid.error).toContain("kind must be runtime-config")
    expect(invalid.error).not.toContain("nope")
  })

  it("caches machine-scoped runtime config for tests without touching the vault", async () => {
    emitTestEvent("runtime credentials machine scoped cache helper")

    const cached = cacheMachineRuntimeCredentialConfig("slugger", {
      bluebubbles: { password: "bb-secret" },
    }, new Date("2026-04-14T12:00:00.000Z"), "machine_test")

    expect(cached).toMatchObject({
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_test/config",
      config: { bluebubbles: { password: "bb-secret" } },
    })
    expect(readMachineRuntimeCredentialConfig("slugger")).toEqual(cached)
    expect(mockCredentialStore.store.getRawSecret).not.toHaveBeenCalled()
  })
})
