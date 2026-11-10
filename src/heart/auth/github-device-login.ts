import { emitNervesEvent } from "../../nerves/runtime"

/**
 * GitHub CLI's public OAuth app and its default scopes: the same client and
 * scopes `gh auth login` requests, so the token is the one the `gh` path
 * yields. Used on hosts without `gh`, such as an appliance.
 */
export const GITHUB_CLI_OAUTH_CLIENT_ID = "178c6fc778ccc68e1d6a"
export const GITHUB_CLI_DEFAULT_SCOPES = "repo read:org gist"

const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SLOW_DOWN_STEP_MS = 5_000

export interface GithubDeviceLoginDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const defaultDeps: GithubDeviceLoginDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

interface DeviceCodeResponse {
  device_code?: string
  user_code?: string
  verification_uri?: string
  expires_in?: number
  interval?: number
}

interface AccessTokenResponse {
  access_token?: string
  error?: string
  interval?: number
}

function postForm(deps: GithubDeviceLoginDeps, url: string, form: Record<string, string>): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  })
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    return {} as T
  }
}

/**
 * GitHub's OAuth device flow: shows a code to enter at github.com/login/device
 * on any device, then polls until it is approved. Needs no browser or `gh` on
 * this host. Returns the access token.
 */
export async function githubDeviceLogin(
  showCode: (message: string) => void,
  deps: GithubDeviceLoginDeps = defaultDeps,
): Promise<string> {
  const codeResponse = await postForm(deps, DEVICE_CODE_URL, { client_id: GITHUB_CLI_OAUTH_CLIENT_ID, scope: GITHUB_CLI_DEFAULT_SCOPES })
  if (!codeResponse.ok) throw new Error(`GitHub device login could not start (HTTP ${codeResponse.status}).`)
  const code = await readJson<DeviceCodeResponse>(codeResponse)
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new Error("GitHub device login returned no code to enter.")
  }

  showCode(`To sign in to GitHub, open ${code.verification_uri} on any device and enter code ${code.user_code}`)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_github_device_login_start",
    message: "waiting for GitHub device login approval",
    meta: { verificationUri: code.verification_uri, expiresInSeconds: code.expires_in ?? null },
  })

  try {
    return await pollForToken(code.device_code, code.interval, code.expires_in, deps)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.auth_github_device_login_error",
      message: "GitHub device login did not complete",
      meta: { error: (error as Error).message },
    })
    throw error
  }
}

async function pollForToken(deviceCode: string, interval: number | undefined, expiresIn: number | undefined, deps: GithubDeviceLoginDeps): Promise<string> {
  let intervalMs = (interval ?? 5) * 1000
  const deadline = deps.now() + (expiresIn ?? 900) * 1000
  while (deps.now() < deadline) {
    await deps.sleep(intervalMs)
    const response = await postForm(deps, ACCESS_TOKEN_URL, {
      client_id: GITHUB_CLI_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    })
    const result = await readJson<AccessTokenResponse>(response)
    if (result.access_token) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.auth_github_device_login_end",
        message: "GitHub device login approved",
        meta: {},
      })
      return result.access_token
    }
    if (result.error === "authorization_pending") continue
    if (result.error === "slow_down") {
      intervalMs = result.interval ? result.interval * 1000 : intervalMs + SLOW_DOWN_STEP_MS
      continue
    }
    if (result.error === "expired_token") break
    if (result.error === "access_denied") throw new Error("GitHub device login was denied.")
    throw new Error(`GitHub device login failed: ${result.error ?? `HTTP ${response.status}`}.`)
  }
  throw new Error("The GitHub device login code expired before it was approved. Run ouro auth again.")
}
