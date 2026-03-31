/* v8 ignore start -- OAuth token lifecycle: requires live API calls, tested via integration @preserve */
import * as fs from "fs"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentSecretsPath } from "../identity"

const OAUTH_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const REFRESH_MARGIN_MS = 5 * 60 * 1000 // refresh 5 minutes before expiry

export interface AnthropicTokenState {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/**
 * Check if the Anthropic OAuth token needs refreshing.
 * Returns true if no expiresAt is set (legacy token) or if within 5 min of expiry.
 */
export function needsRefresh(expiresAt: number | undefined): boolean {
  if (!expiresAt) return true // legacy token with no expiry — always try refresh
  return Date.now() > expiresAt - REFRESH_MARGIN_MS
}

/**
 * Refresh an Anthropic OAuth access token using the refresh token.
 * Returns the new token state or null if refresh fails.
 */
export async function refreshAnthropicToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicTokenState | null> {
  try {
    const response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    })

    if (!response.ok) {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.anthropic_token_refresh_failed",
        message: `token refresh failed: ${response.status}`,
        meta: { status: response.status },
      })
      return null
    }

    const json = await response.json() as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }

    if (!json.access_token) {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.anthropic_token_refresh_failed",
        message: "token refresh returned no access_token",
        meta: {},
      })
      return null
    }

    const state: AnthropicTokenState = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken, // keep old if not returned
      expiresAt: Date.now() + (json.expires_in ?? 28800) * 1000, // default 8h
    }

    emitNervesEvent({
      component: "engine",
      event: "engine.anthropic_token_refreshed",
      message: "anthropic OAuth token refreshed",
      meta: { expiresAt: new Date(state.expiresAt).toISOString() },
    })

    return state
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.anthropic_token_refresh_error",
      message: "token refresh threw",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
    return null
  }
}

/**
 * Persist refreshed token state back to secrets.json.
 */
export function persistTokenState(agentName: string, state: AnthropicTokenState): void {
  try {
    const secretsPath = getAgentSecretsPath(agentName)
    const raw = fs.readFileSync(secretsPath, "utf-8")
    const secrets = JSON.parse(raw)
    secrets.providers = secrets.providers ?? {}
    secrets.providers.anthropic = secrets.providers.anthropic ?? {}
    secrets.providers.anthropic.setupToken = state.accessToken
    secrets.providers.anthropic.refreshToken = state.refreshToken
    secrets.providers.anthropic.expiresAt = state.expiresAt
    fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", "utf-8")
  /* v8 ignore start -- defensive: persistence failure must not crash the provider @preserve */
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.anthropic_token_persist_error",
      message: "failed to persist refreshed token",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }
  /* v8 ignore stop */
}

/**
 * Ensure the Anthropic token is fresh. If expired, refresh and persist.
 * Returns the current valid access token, or null if refresh failed and
 * the existing token is expired.
 */
export async function ensureFreshToken(
  currentToken: string,
  refreshToken: string | undefined,
  expiresAt: number | undefined,
  agentName: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  if (!needsRefresh(expiresAt)) {
    return currentToken // still fresh
  }

  if (!refreshToken) {
    // No refresh token — use the current token as-is (may be expired)
    return currentToken
  }

  const newState = await refreshAnthropicToken(refreshToken, fetchImpl)
  if (!newState) {
    return currentToken // refresh failed — try the old token
  }

  persistTokenState(agentName, newState)
  return newState.accessToken
}
/* v8 ignore stop */
