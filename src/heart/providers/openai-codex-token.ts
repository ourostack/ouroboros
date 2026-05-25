import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  readProviderCredentialRecord,
  upsertProviderCredential,
  type ProviderCredentialRecord,
  type ProviderCredentialRecordReadResult,
} from "../provider-credentials"

const OPENAI_CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_CODEX_REFRESH_MARGIN_MS = 5 * 60_000

type FetchLike = typeof fetch

export type OpenAICodexTokenRefreshActor = "agent-runnable" | "human-required"

export type OpenAICodexTokenRefreshResult =
  | { ok: true; refreshed: boolean; record: ProviderCredentialRecord }
  | { ok: false; actor: OpenAICodexTokenRefreshActor; message: string }

interface RefreshOpenAICodexCredentialOptions {
  force?: boolean
  reason?: string
  record?: ProviderCredentialRecord
  now?: Date
  fetchImpl?: FetchLike
  homeDir?: string
  readRecord?: typeof readProviderCredentialRecord
  upsertCredential?: typeof upsertProviderCredential
}

interface TokenRefreshResponse {
  access_token?: unknown
  refresh_token?: unknown
}

interface LocalCodexAuthTokens {
  accessToken: string
  refreshToken: string
}

type LocalCodexAuthReadResult =
  | { status: "ready"; tokens: LocalCodexAuthTokens }
  | { status: "missing" | "invalid" }

interface RefreshTokenSource {
  source: "vault" | "local-codex-auth"
  accessToken: string
  refreshToken: string
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length < 2 || !parts[1]) return null
  try {
    const base64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=")
    const parsed = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function readOpenAICodexJwtExpiresAt(token: string): number | undefined {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return undefined
  return Math.floor(exp * 1000)
}

function recordCredentialString(record: ProviderCredentialRecord, field: string): string {
  const value = record.credentials[field]
  return typeof value === "string" ? value.trim() : ""
}

function recordCredentialNumber(record: ProviderCredentialRecord, field: string): number | undefined {
  const value = record.credentials[field]
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function resolveExpiresAt(record: ProviderCredentialRecord): number | undefined {
  return recordCredentialNumber(record, "expiresAt")
    ?? readOpenAICodexJwtExpiresAt(recordCredentialString(record, "oauthAccessToken"))
}

function isRecordFresh(record: ProviderCredentialRecord, now: Date): boolean {
  const expiresAt = resolveExpiresAt(record)
  if (!expiresAt) return true
  return expiresAt > now.getTime() + OPENAI_CODEX_REFRESH_MARGIN_MS
}

function authCommand(agentName: string): string {
  return `ouro auth --agent ${agentName} --provider openai-codex`
}

function readProviderRecordFailure(result: Extract<ProviderCredentialRecordReadResult, { ok: false }>, agentName: string): OpenAICodexTokenRefreshResult {
  return {
    ok: false,
    actor: "human-required",
    message: `openai-codex credentials could not be loaded for ${agentName}: ${result.error}. Run '${authCommand(agentName)}'.`,
  }
}

function parseRefreshFailure(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body.trim()
    const record = parsed as Record<string, unknown>
    const error = record.error
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code
      const message = (error as Record<string, unknown>).message
      if (typeof message === "string" && message.trim()) return message.trim()
      if (typeof code === "string" && code.trim()) return code.trim()
    }
    if (typeof error === "string" && error.trim()) return error.trim()
    const code = record.code
    if (typeof code === "string" && code.trim()) return code.trim()
  } catch {
    // Plain-text bodies are useful as-is.
  }
  return body.trim() || "refresh endpoint returned an empty error body"
}

function readLocalCodexAuthTokens(homeDir: string): LocalCodexAuthReadResult {
  const authPath = path.join(homeDir, ".codex", "auth.json")
  let raw: string
  try {
    raw = fs.readFileSync(authPath, "utf8")
  } catch {
    return { status: "missing" }
  }

  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; refresh_token?: unknown } }
    if (!parsed.tokens || typeof parsed.tokens !== "object") return { status: "invalid" }
    const accessToken = typeof parsed.tokens.access_token === "string" ? parsed.tokens.access_token.trim() : ""
    const refreshToken = typeof parsed.tokens.refresh_token === "string" ? parsed.tokens.refresh_token.trim() : ""
    if (!accessToken || !refreshToken) return { status: "invalid" }
    return { status: "ready", tokens: { accessToken, refreshToken } }
  } catch {
    return { status: "invalid" }
  }
}

async function updateLocalCodexAuthIfUnchanged(input: {
  homeDir: string
  oldAccessToken: string
  oldRefreshToken: string
  newAccessToken: string
  newRefreshToken: string
  now: Date
}): Promise<"updated" | "skipped" | "missing" | "error"> {
  const authPath = path.join(input.homeDir, ".codex", "auth.json")
  let raw: string
  try {
    raw = fs.readFileSync(authPath, "utf8")
  } catch {
    return "missing"
  }

  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; refresh_token?: unknown }; last_refresh?: unknown }
    if (!parsed.tokens || typeof parsed.tokens !== "object") return "skipped"
    const currentAccess = typeof parsed.tokens.access_token === "string" ? parsed.tokens.access_token : ""
    const currentRefresh = typeof parsed.tokens.refresh_token === "string" ? parsed.tokens.refresh_token : ""
    if (currentAccess !== input.oldAccessToken && currentRefresh !== input.oldRefreshToken) {
      return "skipped"
    }

    parsed.tokens.access_token = input.newAccessToken
    parsed.tokens.refresh_token = input.newRefreshToken
    parsed.last_refresh = input.now.toISOString()
    fs.writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
    return "updated"
  } catch {
    return "error"
  }
}

async function requestOpenAICodexTokenRefresh(input: {
  refreshToken: string
  fetchImpl: FetchLike
}): Promise<{ ok: true; accessToken: string; refreshToken: string } | { ok: false; status?: number; detail: string }> {
  let response: Response
  try {
    response = await input.fetchImpl(OPENAI_CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: OPENAI_CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
    })
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    return { ok: false, status: response.status, detail: parseRefreshFailure(body) }
  }

  let body: TokenRefreshResponse
  try {
    body = await response.json() as TokenRefreshResponse
  } catch (error) {
    return { ok: false, detail: `refresh endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : ""
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token.trim() : input.refreshToken
  if (!accessToken) return { ok: false, detail: "refresh endpoint returned no access_token" }
  return { ok: true, accessToken, refreshToken }
}

function refreshFailureRequiresHuman(refresh: { status?: number; detail: string }): boolean {
  const detail = refresh.detail.toLowerCase()
  return refresh.status === 401
    || detail.includes("signing in again")
    || detail.includes("already been used")
    || detail.includes("invalid_grant")
    || detail.includes("refresh token expired")
}

export async function refreshOpenAICodexProviderCredentials(
  agentName: string,
  options: RefreshOpenAICodexCredentialOptions = {},
): Promise<OpenAICodexTokenRefreshResult> {
  const now = options.now ?? new Date()
  const readRecord = options.readRecord ?? readProviderCredentialRecord
  const upsertCredential = options.upsertCredential ?? upsertProviderCredential
  let record = options.record
  if (!record) {
    const result = await readRecord(agentName, "openai-codex", { refreshIfMissing: true })
    if (!result.ok) return readProviderRecordFailure(result, agentName)
    record = result.record
  }

  if (!options.force && isRecordFresh(record, now)) {
    emitNervesEvent({
      component: "engine",
      event: "engine.openai_codex_token_refresh_skipped",
      message: "openai-codex token refresh skipped because the credential is still fresh",
      meta: { agentName, reason: options.reason ?? "fresh" },
    })
    return { ok: true, refreshed: false, record }
  }

  const oldAccessToken = recordCredentialString(record, "oauthAccessToken")
  const oldRefreshToken = recordCredentialString(record, "refreshToken")
  const homeDir = options.homeDir ?? os.homedir()
  const fallbackLocalAuth = oldRefreshToken ? undefined : readLocalCodexAuthTokens(homeDir)
  let refreshSource: RefreshTokenSource | undefined = oldRefreshToken
    ? { source: "vault", accessToken: oldAccessToken, refreshToken: oldRefreshToken }
    : fallbackLocalAuth?.status === "ready"
      ? { source: "local-codex-auth", accessToken: fallbackLocalAuth.tokens.accessToken, refreshToken: fallbackLocalAuth.tokens.refreshToken }
      : undefined

  if (!refreshSource) {
    return {
      ok: false,
      actor: "human-required",
      message: `openai-codex has no saved refresh token for ${agentName} and no usable local Codex login to import. Run '${authCommand(agentName)}'.`,
    }
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.openai_codex_token_refresh_start",
    message: "refreshing openai-codex OAuth token",
    meta: { agentName, reason: options.reason ?? "unspecified", source: refreshSource.source },
  })

  let refresh = await requestOpenAICodexTokenRefresh({
    refreshToken: refreshSource.refreshToken,
    fetchImpl: options.fetchImpl ?? fetch,
  })

  if (!refresh.ok && oldRefreshToken) {
    const retryLocalAuth = readLocalCodexAuthTokens(homeDir)
    if (retryLocalAuth.status === "ready" && retryLocalAuth.tokens.refreshToken !== oldRefreshToken) {
      emitNervesEvent({
        component: "engine",
        event: "engine.openai_codex_token_refresh_local_rescue",
        message: "retrying openai-codex OAuth refresh with local Codex auth tokens",
        meta: { agentName, reason: options.reason ?? "unspecified", status: refresh.status ?? "none", detail: refresh.detail },
      })
      refreshSource = {
        source: "local-codex-auth",
        accessToken: retryLocalAuth.tokens.accessToken,
        refreshToken: retryLocalAuth.tokens.refreshToken,
      }
      refresh = await requestOpenAICodexTokenRefresh({
        refreshToken: refreshSource.refreshToken,
        fetchImpl: options.fetchImpl ?? fetch,
      })
    }
  }

  if (!refresh.ok) {
    const actor: OpenAICodexTokenRefreshActor = refreshFailureRequiresHuman(refresh) ? "human-required" : "agent-runnable"
    emitNervesEvent({
      level: actor === "human-required" ? "warn" : "error",
      component: "engine",
      event: "engine.openai_codex_token_refresh_error",
      message: "openai-codex OAuth token refresh failed",
      meta: {
        agentName,
        reason: options.reason ?? "unspecified",
        actor,
        source: refreshSource.source,
        ...(refresh.status ? { status: refresh.status } : {}),
        detail: refresh.detail,
      },
    })
    return {
      ok: false,
      actor,
      message: actor === "human-required"
        ? `openai-codex refresh token is no longer usable (${refresh.detail}). Run '${authCommand(agentName)}'.`
        : `openai-codex token refresh failed (${refresh.detail}); retry refresh before asking for browser login.`,
    }
  }

  const expiresAt = readOpenAICodexJwtExpiresAt(refresh.accessToken)
  const credentials: Record<string, string | number> = {
    oauthAccessToken: refresh.accessToken,
    refreshToken: refresh.refreshToken,
    ...(expiresAt ? { expiresAt } : {}),
  }
  const updated = await upsertCredential({
    agentName,
    provider: "openai-codex",
    credentials,
    config: { ...record.config },
    provenance: { source: record.provenance.source },
    now,
  })

  const localAuthSync = await updateLocalCodexAuthIfUnchanged({
    homeDir,
    oldAccessToken: refreshSource.accessToken,
    oldRefreshToken: refreshSource.refreshToken,
    newAccessToken: refresh.accessToken,
    newRefreshToken: refresh.refreshToken,
    now,
  })

  emitNervesEvent({
    component: "engine",
    event: "engine.openai_codex_token_refresh_end",
    message: "refreshed openai-codex OAuth token",
    meta: {
      agentName,
      reason: options.reason ?? "unspecified",
      credentialRevision: updated.revision,
      source: refreshSource.source,
      localCodexAuth: localAuthSync,
    },
  })
  return { ok: true, refreshed: true, record: updated }
}
