/**
 * Hosted Desk admin commands: `ouro desk invite`, `ouro desk access` and
 * `ouro desk delete-account`.
 *
 * Each command signs the person in to Ouro identity (Entra External ID) with
 * an authorization-code + PKCE flow on a loopback redirect (RFC 8252), then
 * calls the gateway's admin route with the access token. The gateway, not this
 * CLI, enforces the `ouro.admin` app role.
 *
 * The gateway publishes what the sign-in needs at `ADMIN_CONFIG_PATH`:
 * `{ tenantId, subdomain, clientId, scope }`. The CLI reads the tenant's
 * discovery document from `<subdomain>.ciamlogin.com` and requires the issuer
 * `https://<tenantId>.ciamlogin.com/<tenantId>/v2.0`, the same check the
 * gateway makes. The default gateway must name Ouro's production tenant. Any
 * other gateway receives an admin token, so it needs `--trust-gateway`.
 *
 * Nothing is cached: the token lives only for the one command, and it is never
 * printed or logged. An invite link is a single-use bearer credential, so
 * `--out` writes it to a new 0600 file instead of the screen.
 */

import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { emitNervesEvent } from "../../nerves/runtime"
import type { DeskAdminCliCommand, OuroCliCommand, OuroCliDeps } from "./cli-types"

export const DEFAULT_DESK_GATEWAY = "https://desk.ouro.bot"
/** Ouro's production External ID tenant (`ourobot`), which the default gateway must name. */
export const PRODUCTION_TENANT_ID = "de8841c3-7799-4523-bbad-44f8a2426eaa"
export const ADMIN_CONFIG_PATH = "/.well-known/ouro-desk-admin"
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** Server-supplied text made safe to print: no control characters, bounded length. */
export function shown(value: unknown, max = 200): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, max)
}

// ── Parsing ──

const GATEWAY_FLAGS = "[--gateway <url> --trust-gateway]"
const USAGE = {
  invite: `Usage: ouro desk invite --name <name> | --account <id> [--out <file>] ${GATEWAY_FLAGS}`,
  access: `Usage: ouro desk access <account> on|off ${GATEWAY_FLAGS}`,
  "delete-account": `Usage: ouro desk delete-account <account> --yes ${GATEWAY_FLAGS}`,
} as const

type AdminVerb = keyof typeof USAGE

function splitFlags(args: string[], valued: string[], boolean: string[], usage: string): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    if (boolean.includes(arg)) {
      flags[arg] = true
      continue
    }
    const value = args[i + 1]
    if (!valued.includes(arg) || value === undefined || value.startsWith("--")) throw new Error(usage)
    flags[arg] = value
    i++
  }
  return { positional, flags }
}

function accountIdOf(value: string): string {
  if (!ACCOUNT_ID.test(value)) throw new Error(`'${shown(value, 80)}' is not an account id: use the id Hosted Desk gave the account`)
  return value
}

function gatewayOf(flags: Record<string, string | true>): { gateway?: string; trustGateway?: true } {
  return {
    ...(typeof flags["--gateway"] === "string" ? { gateway: flags["--gateway"] } : {}),
    ...(flags["--trust-gateway"] === true ? { trustGateway: true as const } : {}),
  }
}

export function parseDeskAdminCommand(verb: AdminVerb, args: string[]): OuroCliCommand {
  const usage = USAGE[verb]
  if (verb === "invite") {
    const { positional, flags } = splitFlags(args, ["--name", "--account", "--out", "--gateway"], ["--trust-gateway"], usage)
    const displayName = typeof flags["--name"] === "string" ? flags["--name"].trim() : ""
    const account = typeof flags["--account"] === "string" ? flags["--account"] : undefined
    // --name invites a new person; --account re-invites an account whose invite went unused.
    if (positional.length > 0 || (!displayName) === (account === undefined)) throw new Error(usage)
    return {
      kind: "desk.admin",
      action: "invite",
      ...(account === undefined ? { displayName } : { accountId: accountIdOf(account) }),
      ...gatewayOf(flags),
      ...(typeof flags["--out"] === "string" ? { out: flags["--out"] } : {}),
    }
  }
  if (verb === "access") {
    const { positional, flags } = splitFlags(args, ["--gateway"], ["--trust-gateway"], usage)
    const [id, state] = positional
    if (positional.length !== 2 || (state !== "on" && state !== "off")) throw new Error(usage)
    return { kind: "desk.admin", action: "access", accountId: accountIdOf(id!), on: state === "on", ...gatewayOf(flags) }
  }
  const { positional, flags } = splitFlags(args, ["--gateway"], ["--yes", "--trust-gateway"], usage)
  if (positional.length !== 1) throw new Error(usage)
  const accountId = accountIdOf(positional[0]!)
  if (flags["--yes"] !== true) {
    throw new Error(`Deleting account ${accountId} removes its Hosted Desk account and sign-ins and cannot be undone; pass --yes to confirm.\n${usage}`)
  }
  return { kind: "desk.admin", action: "delete-account", accountId, ...gatewayOf(flags) }
}

// ── Gateway ──

/** The gateway's origin, or null when the value is not a bare https origin. */
export function gatewayOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (/[?#]/.test(value) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null
  return url.origin
}

// ── Sign-in ──

export interface DeskAdminSignInInput {
  gateway: string
  fetchImpl: typeof fetch
  openUrl: (url: string) => Promise<void> | void
  writeStdout: (text: string) => void
  /** The tenant the gateway must name; only set for the default gateway. */
  expectedTenantId?: string
  timeoutMs?: number
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

function isHttps(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:"
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

const CALLBACK_PAGE = (heading: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Ouro sign-in</title><body style="font-family:system-ui;margin:3rem"><h1>${heading}</h1><p>${detail}</p></body>`

interface Callback { code?: string; error?: string }

/**
 * Waits for the browser's redirect. Only a request carrying this sign-in's
 * state settles it, so a stray request to the loopback port can't end it.
 */
function listenForCallback(state: string, timeoutMs: number): Promise<{ redirectUri: string; result: Promise<Callback>; close: () => void }> {
  return new Promise((resolveListening, rejectListening) => {
    const { promise: result, resolve: settle, reject: fail } = Promise.withResolvers<Callback>()
    // Handled by the caller's await; this keeps an early timeout from becoming an unhandled rejection.
    result.catch(() => {})
    const server = createServer((request, response) => {
      const url = new URL(request.url as string, "http://127.0.0.1")
      if (url.pathname !== "/callback") {
        response.writeHead(404).end()
        return
      }
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(CALLBACK_PAGE("Not this sign-in", "This link does not belong to the sign-in the terminal is waiting for."))
        return
      }
      const code = url.searchParams.get("code")
      const error = url.searchParams.get("error")
      const callback: Callback = { ...(code ? { code } : {}), ...(error ? { error } : {}) }
      const page = code && !error
        ? CALLBACK_PAGE("Signed in to Ouro", "You can close this tab and go back to the terminal.")
        : CALLBACK_PAGE("Sign-in did not finish", "Go back to the terminal to see why.")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page)
      settle(callback)
    })
    const timer = setTimeout(() => fail(new Error(`Ouro sign-in timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs)
    const close = (): void => {
      clearTimeout(timer)
      // Idle only: the browser's own request may still be receiving its page.
      server.close()
      server.closeIdleConnections()
    }
    server.once("error", rejectListening)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolveListening({ redirectUri: `http://127.0.0.1:${port}/callback`, result, close })
    })
  })
}

/** Signs in to Ouro identity for the gateway's admin scope and returns the access token. */
export async function signInForDeskAdmin(input: DeskAdminSignInInput): Promise<string> {
  const configUrl = `${input.gateway}${ADMIN_CONFIG_PATH}`
  const config = (await getJson(input.fetchImpl, configUrl)) as { tenantId?: unknown; subdomain?: unknown; clientId?: unknown; scope?: unknown } | null
  if (
    !config
    || typeof config.tenantId !== "string" || !GUID.test(config.tenantId)
    || typeof config.subdomain !== "string" || !SUBDOMAIN.test(config.subdomain)
    || !nonEmpty(config.clientId) || !nonEmpty(config.scope)
  ) {
    throw new Error(`${configUrl} is not a valid admin sign-in configuration`)
  }
  // Entra's discovery names the tenant in lowercase.
  const tenantId = config.tenantId.toLowerCase()
  if (input.expectedTenantId && tenantId !== input.expectedTenantId.toLowerCase()) {
    throw new Error(`${input.gateway} names Ouro identity tenant ${tenantId}, not Ouro's production tenant ${input.expectedTenantId}`)
  }
  const issuer = `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`
  const discovery = (await getJson(input.fetchImpl, `https://${config.subdomain}.ciamlogin.com/${tenantId}/v2.0/.well-known/openid-configuration`)) as {
    issuer?: unknown
    authorization_endpoint?: unknown
    token_endpoint?: unknown
  } | null
  if (discovery?.issuer !== issuer) {
    throw new Error(`Ouro identity's discovery document names issuer ${shown(discovery?.issuer)}, but Hosted Desk expects ${issuer}`)
  }
  if (!isHttps(discovery.authorization_endpoint) || !isHttps(discovery.token_endpoint)) {
    throw new Error("Ouro identity's discovery document has no https authorization and token endpoints")
  }

  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(16).toString("base64url")
  const listener = await listenForCallback(state, input.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
  try {
    const authorize = new URL(discovery.authorization_endpoint)
    authorize.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: listener.redirectUri,
      scope: config.scope,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString()
    input.writeStdout(`Sign in to Ouro in your browser to manage ${new URL(input.gateway).host}. If it does not open, visit:\n${authorize.toString()}`)
    // Not awaited: some openers stay in the foreground until the browser exits.
    void Promise.resolve().then(() => input.openUrl(authorize.toString())).catch(() => {})

    const callback = await listener.result
    if (callback.error) throw new Error(`Ouro sign-in was cancelled: ${shown(callback.error, 80)}`)
    if (!callback.code) throw new Error("Ouro sign-in returned no code")

    const response = await input.fetchImpl(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: callback.code,
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const grant = (await response.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null
    if (!response.ok) throw new Error(`Ouro sign-in could not finish: ${nonEmpty(grant?.error) ? shown(grant.error, 80) : `token endpoint answered ${response.status}`}`)
    if (!nonEmpty(grant?.access_token)) throw new Error("Ouro sign-in could not finish: no access token")
    return grant.access_token
  } finally {
    listener.close()
  }
}

/* v8 ignore start -- production default: launches the platform's browser opener @preserve */
function openInBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]]
  // Detached and unreferenced: an opener that stays in the foreground must not keep the CLI from exiting.
  return new Promise((resolve, reject) => {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" })
    child.once("spawn", () => { child.unref(); resolve() })
    child.once("error", reject)
  })
}
/* v8 ignore stop */

// ── Executing ──

function requestFor(command: DeskAdminCliCommand): { method: "POST" | "DELETE"; path: string; body?: unknown } {
  if (command.action === "invite") {
    return { method: "POST", path: "/admin/invites", body: command.accountId ? { accountId: command.accountId } : { displayName: command.displayName } }
  }
  const account = `/admin/accounts/${encodeURIComponent(command.accountId)}`
  if (command.action === "access") return { method: "POST", path: `${account}/access`, body: { on: command.on } }
  return { method: "DELETE", path: account }
}

async function refusal(response: Response): Promise<string> {
  if (response.status === 401) return "Hosted Desk did not accept the Ouro sign-in (401). Sign in again; if it keeps failing, the gateway's admin sign-in settings are wrong."
  if (response.status === 403) return "Hosted Desk refused the request (403): the signed-in Ouro account needs the ouro.admin role."
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
  const reason = nonEmpty(body?.message) ? body.message : nonEmpty(body?.error) ? body.error : null
  return reason ? `Hosted Desk refused the request (${response.status}): ${shown(reason)}` : `Hosted Desk refused the request (${response.status}).`
}

export async function executeDeskAdminCommand(
  command: DeskAdminCliCommand,
  deps: OuroCliDeps,
  signIn: (input: DeskAdminSignInInput) => Promise<string> = signInForDeskAdmin,
): Promise<string> {
  const requested = command.gateway ?? DEFAULT_DESK_GATEWAY
  const gateway = gatewayOrigin(requested)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.desk_admin_start",
    message: `ouro desk ${command.action}`,
    meta: { action: command.action, gateway: gateway ?? "invalid" },
  })
  const fail = (message: string, status?: number): string => {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.desk_admin_error",
      message: `ouro desk ${command.action} failed`,
      meta: { action: command.action, gateway: gateway ?? "invalid", ...(status === undefined ? {} : { status }) },
    })
    deps.setExitCode?.(1)
    deps.writeStdout(message)
    return message
  }
  const done = (message: string, status: number): string => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.desk_admin_end",
      message: `ouro desk ${command.action} succeeded`,
      meta: { action: command.action, gateway, status },
    })
    deps.writeStdout(message)
    return message
  }

  if (!gateway) return fail(`The Hosted Desk gateway must be a bare https origin such as ${DEFAULT_DESK_GATEWAY}, not ${shown(requested, 120)}`)
  const isDefault = gateway === DEFAULT_DESK_GATEWAY
  if (!isDefault && command.trustGateway !== true) {
    return fail(`${gateway} is not ${DEFAULT_DESK_GATEWAY}. Signing in sends it an Ouro admin token, so pass --trust-gateway only for a Hosted Desk we run, such as staging.`)
  }

  // Claim the --out file before minting the invite, so a bad path costs no live link.
  const outPath = command.action === "invite" ? command.out : undefined
  if (outPath) {
    try {
      closeSync(openSync(outPath, "wx", 0o600))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return fail(code === "EEXIST" ? `${outPath} already exists; choose a new file for the invite link` : `Could not create ${outPath}: ${(error as Error).message}`)
    }
  }
  const releaseOut = (): void => {
    if (outPath) unlinkSync(outPath)
  }

  /* v8 ignore next -- production default: tests always inject fetchImpl @preserve */
  const fetchImpl = deps.fetchImpl ?? fetch
  let token: string
  try {
    token = await signIn({
      gateway,
      fetchImpl,
      /* v8 ignore next -- production default: tests inject openUrl or a sign-in @preserve */
      openUrl: deps.openUrl ?? openInBrowser,
      writeStdout: deps.writeStdout,
      ...(isDefault ? { expectedTenantId: PRODUCTION_TENANT_ID } : {}),
    })
  } catch (error) {
    releaseOut()
    return fail((error as Error).message)
  }

  const request = requestFor(command)
  let response: Response
  try {
    response = await fetchImpl(`${gateway}${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    releaseOut()
    return fail(`Could not reach Hosted Desk at ${gateway}: ${(error as Error).message}`)
  }
  if (!response.ok) {
    releaseOut()
    return fail(await refusal(response), response.status)
  }

  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (command.action === "access") {
    if (typeof result?.deskAccess !== "boolean") return fail("Hosted Desk sent an unexpected access response", response.status)
    return done(`Desk access for ${command.accountId} is now ${result.deskAccess ? "on" : "off"}.`, response.status)
  }
  if (command.action === "delete-account") {
    if (result?.deleted !== true) return fail("Hosted Desk sent an unexpected delete response", response.status)
    const leftover = result.deskRemoved === false ? " Its desk could not be removed from the gateway; the gateway logged why." : ""
    return done(`Deleted account ${command.accountId}.${leftover}`, response.status)
  }

  if (
    !isHttps(result?.inviteUrl) || !nonEmpty(result?.expiresAt)
    || typeof result?.accountId !== "string" || !ACCOUNT_ID.test(result.accountId)
    || (command.accountId !== undefined && result.accountId !== command.accountId)
  ) {
    releaseOut()
    return fail("Hosted Desk sent an unexpected invite response", response.status)
  }
  const link = new URL(result.inviteUrl).href
  const who = command.displayName ? `${command.displayName} (account ${result.accountId})` : `account ${result.accountId}`
  const lead = `Invite for ${who}, single use, expires ${shown(result.expiresAt, 40)}.`
  if (!outPath) return done(`${lead}\n${link}`, response.status)
  try {
    const fd = openSync(outPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
    try {
      writeSync(fd, `${link}\n`)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    releaseOut()
    return fail(`The invite for account ${result.accountId} was issued, but ${outPath} could not be written (${(error as Error).message}). Issue a new link with: ouro desk invite --account ${result.accountId}`)
  }
  return done(`${lead} The link is in ${outPath} (mode 0600).`, response.status)
}
