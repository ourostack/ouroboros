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
})
