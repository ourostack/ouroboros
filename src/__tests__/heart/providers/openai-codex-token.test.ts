import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { ProviderCredentialRecord } from "../../../heart/provider-credentials"
import {
  readOpenAICodexJwtExpiresAt,
  refreshOpenAICodexProviderCredentials,
} from "../../../heart/providers/openai-codex-token"

const cleanup: string[] = []

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

function makeJwt(expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }), "utf8").toString("base64url")
  return `header.${payload}.sig`
}

function makeToken(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.sig`
}

function makeRecord(overrides: Partial<ProviderCredentialRecord> = {}): ProviderCredentialRecord {
  return {
    provider: "openai-codex",
    revision: "vault_old",
    updatedAt: "2026-05-24T00:00:00.000Z",
    credentials: {
      oauthAccessToken: makeJwt(Date.parse("2026-05-24T00:00:00.000Z")),
      refreshToken: "old-refresh",
      expiresAt: Date.parse("2026-05-24T00:00:00.000Z"),
    },
    config: {},
    provenance: { source: "auth-flow", updatedAt: "2026-05-24T00:00:00.000Z" },
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (!entry) continue
    fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("openai-codex token refresh", () => {
  it("decodes JWT expiry in milliseconds", () => {
    emitTestEvent("openai codex jwt expiry decode")
    const expiresAt = Date.parse("2026-05-25T12:00:00.000Z")
    expect(readOpenAICodexJwtExpiresAt(makeJwt(expiresAt))).toBe(expiresAt)
  })

  it("returns undefined for malformed or non-expiring JWT payloads", () => {
    emitTestEvent("openai codex jwt expiry invalid payloads")
    expect(readOpenAICodexJwtExpiresAt("not-a-jwt")).toBeUndefined()
    expect(readOpenAICodexJwtExpiresAt("header.not-json.sig")).toBeUndefined()
    expect(readOpenAICodexJwtExpiresAt(makeToken([]))).toBeUndefined()
    expect(readOpenAICodexJwtExpiresAt(makeToken({ exp: "soon" }))).toBeUndefined()
    expect(readOpenAICodexJwtExpiresAt(makeToken({ exp: 0 }))).toBeUndefined()
  })

  it("skips network refresh while the saved Codex access token is fresh", async () => {
    emitTestEvent("openai codex refresh skip fresh")
    const freshRecord = makeRecord({
      credentials: {
        oauthAccessToken: makeJwt(Date.parse("2026-05-25T12:00:00.000Z")),
        refreshToken: "fresh-refresh",
        expiresAt: Date.parse("2026-05-25T12:00:00.000Z"),
      },
    })
    const fetchImpl = vi.fn()
    const upsertCredential = vi.fn()

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: freshRecord,
      now: new Date("2026-05-25T11:00:00.000Z"),
      fetchImpl: fetchImpl as never,
      upsertCredential: upsertCredential as never,
    })

    expect(result).toEqual({ ok: true, refreshed: false, record: freshRecord })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(upsertCredential).not.toHaveBeenCalled()
  })

  it("skips network refresh for non-expiring opaque Codex access tokens", async () => {
    emitTestEvent("openai codex refresh skip non expiring opaque token")
    const freshRecord = makeRecord({
      credentials: {
        oauthAccessToken: "opaque-access-token",
        refreshToken: "fresh-refresh",
      },
    })
    const fetchImpl = vi.fn()
    const upsertCredential = vi.fn()

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: freshRecord,
      now: new Date("2026-05-25T11:00:00.000Z"),
      fetchImpl: fetchImpl as never,
      upsertCredential: upsertCredential as never,
    })

    expect(result).toEqual({ ok: true, refreshed: false, record: freshRecord })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(upsertCredential).not.toHaveBeenCalled()
  })

  it("loads the vault record when one is not supplied and skips a fresh JWT-derived expiry", async () => {
    emitTestEvent("openai codex refresh loads fresh record")
    const freshRecord = makeRecord({
      credentials: {
        oauthAccessToken: makeJwt(Date.parse("2026-05-25T13:00:00.000Z")),
        refreshToken: "fresh-refresh",
      },
    })
    const readRecord = vi.fn(async () => ({ ok: true as const, poolPath: "vault:slugger:providers/*", record: freshRecord }))
    const fetchImpl = vi.fn()

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      now: new Date("2026-05-25T12:00:00.000Z"),
      readRecord: readRecord as never,
      fetchImpl: fetchImpl as never,
    })

    expect(result).toEqual({ ok: true, refreshed: false, record: freshRecord })
    expect(readRecord).toHaveBeenCalledWith("slugger", "openai-codex", { refreshIfMissing: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("accepts string expiresAt metadata and falls back to JWT expiry when the string is invalid", async () => {
    emitTestEvent("openai codex refresh string expires metadata")
    const fetchImpl = vi.fn()

    await expect(refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({
        credentials: {
          oauthAccessToken: "opaque-access",
          refreshToken: "fresh-refresh",
          expiresAt: String(Date.parse("2026-05-25T13:00:00.000Z")),
        },
      }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({ ok: true, refreshed: false })

    await expect(refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({
        credentials: {
          oauthAccessToken: makeJwt(Date.parse("2026-05-25T13:00:00.000Z")),
          refreshToken: "fresh-refresh",
          expiresAt: "not-a-number",
        },
      }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({ ok: true, refreshed: false })

    await expect(refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({
        credentials: {
          oauthAccessToken: makeJwt(Date.parse("2026-05-25T13:00:00.000Z")),
          refreshToken: "fresh-refresh",
          expiresAt: "0",
        },
      }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
    })).resolves.toMatchObject({ ok: true, refreshed: false })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns human-required guidance when the vault record cannot be loaded", async () => {
    emitTestEvent("openai codex refresh read failure")
    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      readRecord: vi.fn(async () => ({
        ok: false as const,
        reason: "missing" as const,
        poolPath: "vault:slugger:providers/openai-codex",
        error: "no credential found",
      })) as never,
    })

    expect(result).toEqual({
      ok: false,
      actor: "human-required",
      message: "openai-codex credentials could not be loaded for slugger: no credential found. Run 'ouro auth --agent slugger --provider openai-codex'.",
    })
  })

  it("returns human-required guidance when stale credentials have no refresh token", async () => {
    emitTestEvent("openai codex refresh missing refresh token")
    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", expiresAt: Date.parse("2026-05-24T00:00:00.000Z") } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: vi.fn() as never,
      homeDir: makeTempDir("codex-auth-no-refresh-home"),
      force: true,
    })

    expect(result).toEqual({
      ok: false,
      actor: "human-required",
      message: "openai-codex has no saved refresh token for slugger and no usable local Codex login to import. Run 'ouro auth --agent slugger --provider openai-codex'.",
    })
  })

  it("uses a local Codex login when the vault record has no refresh token", async () => {
    emitTestEvent("openai codex refresh missing vault refresh local rescue")
    const homeDir = makeTempDir("codex-auth-local-only-home")
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".codex", "auth.json"), `${JSON.stringify({
      tokens: {
        access_token: "local-access",
        refresh_token: "local-refresh",
      },
    }, null, 2)}\n`, "utf8")
    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: newAccess,
      refresh_token: "new-refresh",
    }), { status: 200 }))
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", expiresAt: Date.parse("2026-05-24T00:00:00.000Z") } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
      upsertCredential: upsertCredential as never,
      homeDir,
      force: true,
    })

    expect(result).toMatchObject({ ok: true, refreshed: true })
    expect(fetchImpl).toHaveBeenCalledWith("https://auth.openai.com/oauth/token", expect.objectContaining({
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "local-refresh",
      }),
    }))
  })

  it("refreshes stale Codex credentials, updates the agent vault record, and keeps matching local Codex auth in sync", async () => {
    emitTestEvent("openai codex refresh stale credential")
    const homeDir = makeTempDir("codex-auth-home")
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".codex", "auth.json"), `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
      },
    }, null, 2)}\n`, "utf8")

    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      access_token: newAccess,
      refresh_token: "new-refresh",
    }), { status: 200 }))
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", refreshToken: "old-refresh" } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
      upsertCredential: upsertCredential as never,
      homeDir,
      force: true,
      reason: "test",
    })

    expect(result).toMatchObject({ ok: true, refreshed: true, record: { revision: "vault_new" } })
    expect(fetchImpl).toHaveBeenCalledWith("https://auth.openai.com/oauth/token", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      }),
    }))
    expect(upsertCredential).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "slugger",
      provider: "openai-codex",
      credentials: {
        oauthAccessToken: newAccess,
        refreshToken: "new-refresh",
        expiresAt: Date.parse("2026-05-25T13:00:00.000Z"),
      },
      provenance: { source: "auth-flow" },
    }))
    const localAuth = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "auth.json"), "utf8")) as {
      tokens: { access_token: string; refresh_token: string }
    }
    expect(localAuth.tokens.access_token).toBe(newAccess)
    expect(localAuth.tokens.refresh_token).toBe("new-refresh")
  })

  it("retries with the newer local Codex login when the vault refresh token has rotated", async () => {
    emitTestEvent("openai codex refresh rotated token local rescue")
    const homeDir = makeTempDir("codex-auth-rotated-home")
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".codex", "auth.json"), `${JSON.stringify({
      tokens: {
        access_token: "local-access",
        refresh_token: "local-refresh",
      },
    }, null, 2)}\n`, "utf8")
    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Your refresh token has already been used to generate a new access token. Please try signing in again." },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: newAccess,
        refresh_token: "new-refresh",
      }), { status: 200 }))
    vi.stubGlobal("fetch", fetchImpl)
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", refreshToken: "old-refresh" } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      upsertCredential: upsertCredential as never,
      homeDir,
      force: true,
    })

    expect(result).toMatchObject({ ok: true, refreshed: true })
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://auth.openai.com/oauth/token", expect.objectContaining({
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      }),
    }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://auth.openai.com/oauth/token", expect.objectContaining({
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "local-refresh",
      }),
    }))
    expect(upsertCredential).toHaveBeenCalledWith(expect.objectContaining({
      credentials: {
        oauthAccessToken: newAccess,
        refreshToken: "new-refresh",
        expiresAt: Date.parse("2026-05-25T13:00:00.000Z"),
      },
    }))
    const localAuth = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "auth.json"), "utf8")) as {
      tokens: { access_token: string; refresh_token: string }
    }
    expect(localAuth.tokens.access_token).toBe(newAccess)
    expect(localAuth.tokens.refresh_token).toBe("new-refresh")
  })

  it("retries local Codex rescue after a transport failure without an HTTP status", async () => {
    emitTestEvent("openai codex refresh transport local rescue")
    const homeDir = makeTempDir("codex-auth-transport-rescue-home")
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".codex", "auth.json"), `${JSON.stringify({
      tokens: {
        access_token: "local-access",
        refresh_token: "local-refresh",
      },
    }, null, 2)}\n`, "utf8")
    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: newAccess,
        refresh_token: "new-refresh",
      }), { status: 200 }))
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", refreshToken: "old-refresh" } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
      upsertCredential: upsertCredential as never,
      homeDir,
      force: true,
    })

    expect(result).toMatchObject({ ok: true, refreshed: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://auth.openai.com/oauth/token", expect.objectContaining({
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: "local-refresh",
      }),
    }))
  })

  it("refreshes with the previous refresh token when the endpoint returns only a new access token", async () => {
    emitTestEvent("openai codex refresh keeps previous refresh token")
    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", refreshToken: "old-refresh", expiresAt: "1" } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ access_token: newAccess }), { status: 200 })) as never,
      upsertCredential: upsertCredential as never,
      homeDir: makeTempDir("codex-auth-missing-home"),
      force: true,
    })

    expect(result).toMatchObject({ ok: true, refreshed: true })
    expect(upsertCredential).toHaveBeenCalledWith(expect.objectContaining({
      credentials: {
        oauthAccessToken: newAccess,
        refreshToken: "old-refresh",
        expiresAt: Date.parse("2026-05-25T13:00:00.000Z"),
      },
    }))
  })

  it("uses global fetch and the default home directory when overrides are absent", async () => {
    emitTestEvent("openai codex refresh default dependencies")
    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const globalFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: newAccess,
      refresh_token: "new-refresh",
    }), { status: 200 }))
    vi.stubGlobal("fetch", globalFetch)
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access-default-deps-test", refreshToken: "old-refresh-default-deps-test" } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      upsertCredential: upsertCredential as never,
      force: true,
    })

    expect(result).toMatchObject({ ok: true, refreshed: true })
    expect(globalFetch).toHaveBeenCalled()
  })

  it("does not overwrite a newer local Codex auth login", async () => {
    emitTestEvent("openai codex refresh skips mismatched local auth")
    const homeDir = makeTempDir("codex-auth-home-newer")
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".codex", "auth.json"), `${JSON.stringify({
      tokens: {
        access_token: "newer-access",
        refresh_token: "newer-refresh",
      },
    }, null, 2)}\n`, "utf8")
    const newAccess = makeJwt(Date.parse("2026-05-25T13:00:00.000Z"))
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord({ credentials: { oauthAccessToken: "old-access", refreshToken: "old-refresh" } }),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ access_token: newAccess, refresh_token: "new-refresh" }), { status: 200 })) as never,
      upsertCredential: upsertCredential as never,
      homeDir,
      force: true,
    })

    const localAuth = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "auth.json"), "utf8")) as {
      tokens: { access_token: string; refresh_token: string }
    }
    expect(localAuth.tokens.access_token).toBe("newer-access")
    expect(localAuth.tokens.refresh_token).toBe("newer-refresh")
  })

  it("skips malformed local Codex auth files after the vault refresh succeeds", async () => {
    emitTestEvent("openai codex refresh malformed local auth")
    const homeDir = makeTempDir("codex-auth-home-malformed")
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    const upsertCredential = vi.fn(async (input: {
      credentials: Record<string, string | number>
      config: Record<string, string | number>
      provenance: { source: "auth-flow" | "manual" }
    }) => ({
      provider: "openai-codex" as const,
      revision: "vault_new",
      updatedAt: "2026-05-25T12:00:00.000Z",
      credentials: input.credentials,
      config: input.config,
      provenance: { source: input.provenance.source, updatedAt: "2026-05-25T12:00:00.000Z" },
    }))

    const authPath = path.join(homeDir, ".codex", "auth.json")
    const malformedLocalAuthFiles = [
      "not-json",
      JSON.stringify({ auth_mode: "chatgpt" }),
      JSON.stringify({ tokens: { access_token: 123, refresh_token: false } }),
    ]

    for (const localAuth of malformedLocalAuthFiles) {
      fs.writeFileSync(authPath, localAuth, "utf8")
      const result = await refreshOpenAICodexProviderCredentials("slugger", {
        record: makeRecord({ credentials: { oauthAccessToken: "old-access", refreshToken: "old-refresh" } }),
        now: new Date("2026-05-25T12:00:00.000Z"),
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), { status: 200 })) as never,
        upsertCredential: upsertCredential as never,
        homeDir,
        force: true,
      })

      expect(result).toMatchObject({ ok: true, refreshed: true })
    }
  })

  it("returns human-required guidance when the saved refresh token is rejected", async () => {
    emitTestEvent("openai codex refresh token rejected")
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "refresh_token_expired", message: "refresh token expired" },
    }), { status: 401 }))
    const upsertCredential = vi.fn()

    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord(),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: fetchImpl as never,
      upsertCredential: upsertCredential as never,
      force: true,
    })

    expect(result).toEqual({
      ok: false,
      actor: "human-required",
      message: "openai-codex refresh token is no longer usable (refresh token expired). Run 'ouro auth --agent slugger --provider openai-codex'.",
    })
    expect(upsertCredential).not.toHaveBeenCalled()
  })

  it("returns human-required guidance when the refresh endpoint says browser sign-in is needed", async () => {
    emitTestEvent("openai codex refresh sign in required")
    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord(),
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: { message: "Your refresh token has already been used to generate a new access token. Please try signing in again." },
      }), { status: 400 })) as never,
      upsertCredential: vi.fn() as never,
      homeDir: makeTempDir("codex-auth-signin-required-home"),
      force: true,
    })

    expect(result).toEqual({
      ok: false,
      actor: "human-required",
      message: "openai-codex refresh token is no longer usable (Your refresh token has already been used to generate a new access token. Please try signing in again.). Run 'ouro auth --agent slugger --provider openai-codex'.",
    })
  })

  it("does not retry with unusable or non-rotated local Codex auth", async () => {
    emitTestEvent("openai codex refresh skips unusable local rescue")
    const localAuthFiles = [
      "not-json",
      JSON.stringify({ auth_mode: "chatgpt" }),
      JSON.stringify({ tokens: { access_token: 123, refresh_token: "local-refresh" } }),
      JSON.stringify({ tokens: { access_token: "local-access", refresh_token: false } }),
      JSON.stringify({ tokens: { access_token: "", refresh_token: "local-refresh" } }),
      JSON.stringify({ tokens: { access_token: "local-access", refresh_token: "" } }),
      JSON.stringify({ tokens: { access_token: "local-access", refresh_token: "old-refresh" } }),
    ]

    for (const localAuth of localAuthFiles) {
      const homeDir = makeTempDir("codex-auth-unusable-local-home")
      fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
      fs.writeFileSync(path.join(homeDir, ".codex", "auth.json"), localAuth, "utf8")
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        error: { message: "Your refresh token has already been used to generate a new access token. Please try signing in again." },
      }), { status: 400 }))

      const result = await refreshOpenAICodexProviderCredentials("slugger", {
        record: makeRecord(),
        now: new Date("2026-05-25T12:00:00.000Z"),
        fetchImpl: fetchImpl as never,
        upsertCredential: vi.fn() as never,
        homeDir,
        force: true,
      })

      expect(result).toMatchObject({ ok: false, actor: "human-required" })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it("returns agent-runnable guidance for transient refresh endpoint failures", async () => {
    emitTestEvent("openai codex refresh transient endpoint failure")
    const result = await refreshOpenAICodexProviderCredentials("slugger", {
      record: makeRecord(),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: { code: "server_busy" } }), { status: 503 })) as never,
      upsertCredential: vi.fn() as never,
      force: true,
    })

    expect(result).toEqual({
      ok: false,
      actor: "agent-runnable",
      message: "openai-codex token refresh failed (server_busy); retry refresh before asking for browser login.",
    })
  })

  it("parses refresh endpoint error body variants into actionable details", async () => {
    emitTestEvent("openai codex refresh parses error bodies")
    const cases = [
      {
        body: JSON.stringify({ error: "temporarily_unavailable" }),
        expected: "temporarily_unavailable",
      },
      {
        body: JSON.stringify({ code: "rate_limited" }),
        expected: "rate_limited",
      },
      {
        body: JSON.stringify({ error: { code: "" } }),
        expected: "{\"error\":{\"code\":\"\"}}",
      },
      {
        body: JSON.stringify({ code: "" }),
        expected: "{\"code\":\"\"}",
      },
      {
        body: JSON.stringify(["bad"]),
        expected: "[\"bad\"]",
      },
      {
        body: "plain failure",
        expected: "plain failure",
      },
      {
        body: "",
        expected: "refresh endpoint returned an empty error body",
      },
    ]

    for (const testCase of cases) {
      const result = await refreshOpenAICodexProviderCredentials("slugger", {
        record: makeRecord(),
        fetchImpl: vi.fn(async () => new Response(testCase.body, { status: 500 })) as never,
        upsertCredential: vi.fn() as never,
        force: true,
      })
      expect(result).toEqual({
        ok: false,
        actor: "agent-runnable",
        message: `openai-codex token refresh failed (${testCase.expected}); retry refresh before asking for browser login.`,
      })
    }
  })

  it("handles thrown fetches, unreadable error bodies, invalid success JSON, and missing access tokens", async () => {
    emitTestEvent("openai codex refresh transport and malformed success failures")
    const cases = [
      {
        fetchImpl: vi.fn(async () => {
          throw new Error("socket closed")
        }),
        expected: "socket closed",
      },
      {
        fetchImpl: vi.fn(async () => {
          throw "string transport failure"
        }),
        expected: "string transport failure",
      },
      {
        fetchImpl: vi.fn(async () => ({
          ok: false,
          status: 502,
          text: async () => {
            throw new Error("body gone")
          },
        })),
        expected: "refresh endpoint returned an empty error body",
      },
      {
        fetchImpl: vi.fn(async () => ({
          ok: true,
          json: async () => {
            throw new Error("bad json")
          },
        })),
        expected: "refresh endpoint returned invalid JSON: bad json",
      },
      {
        fetchImpl: vi.fn(async () => ({
          ok: true,
          json: async () => {
            throw "bad-json-value"
          },
        })),
        expected: "refresh endpoint returned invalid JSON: bad-json-value",
      },
      {
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ refresh_token: "new-refresh" }), { status: 200 })),
        expected: "refresh endpoint returned no access_token",
      },
    ]

    for (const testCase of cases) {
      const result = await refreshOpenAICodexProviderCredentials("slugger", {
        record: makeRecord(),
        fetchImpl: testCase.fetchImpl as never,
        upsertCredential: vi.fn() as never,
        force: true,
      })
      expect(result).toEqual({
        ok: false,
        actor: "agent-runnable",
        message: `openai-codex token refresh failed (${testCase.expected}); retry refresh before asking for browser login.`,
      })
    }
  })
})
