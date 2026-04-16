/**
 * Bitwarden CLI credential store — wraps `bw` CLI for the agent's own vault.
 *
 * This store authenticates directly as the agent using its own master password.
 * The agent owns the vault, so no human-in-the-loop is needed.
 *
 * Requires the `bw` CLI to be installed. Session tokens are cached process-local.
 */

import { execFile as execFileCb } from "node:child_process"
import * as fs from "node:fs"
import type { CredentialMeta, CredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"
import { ensureBwCli } from "./bw-installer"

// ---------------------------------------------------------------------------
// bw CLI wrapper
// ---------------------------------------------------------------------------

function isBwSessionUnavailableMessage(message: string): boolean {
  return (
    /master password/i.test(message) ||
    /vault is locked/i.test(message) ||
    /not logged in/i.test(message) ||
    /session key/i.test(message) ||
    /local bitwarden session/i.test(message)
  )
}

function isBwInvalidUnlockSecretMessage(message: string): boolean {
  return /invalid master password/i.test(message) || /saved vault unlock secret/i.test(message)
}

function sanitizeBwErrorDetail(message: string): string {
  if (isBwInvalidUnlockSecretMessage(message)) {
    return "bw CLI rejected the saved vault unlock secret for this machine"
  }
  if (isBwSessionUnavailableMessage(message)) {
    return "bw CLI could not use the local Bitwarden session because it is locked, missing, or expired"
  }
  const withoutCommandLine = message
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("Command failed:"))
    .join("\n")
    .trim()
  return (withoutCommandLine || "command failed")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]")
    .slice(0, 500)
}

function formatBwCliError(err: Error, stderr = ""): Error {
  const detail = sanitizeBwErrorDetail(stderr.trim() || err.message)
  return new Error(`bw CLI error: ${detail}`)
}

function isBwSessionAuthError(err: Error): boolean {
  return isBwSessionUnavailableMessage(err.message) || isBwInvalidUnlockSecretMessage(err.message)
}

function isBwConfigLogoutRequired(err: Error): boolean {
  const message = err.message.toLowerCase()
  return message.includes("logout") && message.includes("required")
}

function execBw(args: string[], sessionToken?: string, appDataDir?: string, stdin?: string): Promise<string> {
  const env = {
    ...process.env,
    ...(sessionToken ? { BW_SESSION: sessionToken } : {}),
    ...(appDataDir ? { BITWARDENCLI_APPDATA_DIR: appDataDir } : {}),
  }

  return new Promise((resolve, reject) => {
    const child = execFileCb("bw", args, { timeout: 30_000, env }, (err, stdout, stderr) => {
      if (err) {
        if (isBwNotInstalled(err)) {
          reject(new Error("bw CLI not found. Install from https://bitwarden.com/help/cli/"))
          return
        }
        reject(formatBwCliError(err, stderr))
        return
      }
      resolve(stdout)
    })
    if (stdin !== undefined) {
      child?.stdin?.end(stdin)
    }
  })
}

/** Check if the error indicates the bw CLI binary is not installed. */
function isBwNotInstalled(err: Error): boolean {
  const msg = err.message.toLowerCase()
  const code = (err as NodeJS.ErrnoException).code
  return code === "ENOENT" || msg.includes("enoent") || msg.includes("not found") || msg.includes("command not found")
}

/** Check if the error is transient (network/timeout) and worth retrying. */
function isTransientError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("503") ||
    msg.includes("server unavailable")
  )
}

const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseBwItems(stdout: string, context: string): BwLoginItem[] {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error("expected item array")
    }
    return parsed as BwLoginItem[]
  } catch {
    throw new Error(`bw CLI error: invalid JSON from ${context}`)
  }
}

// ---------------------------------------------------------------------------
// Bitwarden vault item types (subset of bw CLI output)
// ---------------------------------------------------------------------------

interface BwLoginItem {
  id: string
  name: string
  login?: {
    username?: string
    password?: string
    uris?: Array<{ uri: string }>
  }
  notes?: string | null
  revisionDate?: string
}

// ---------------------------------------------------------------------------
// BitwardenCredentialStore
// ---------------------------------------------------------------------------

export class BitwardenCredentialStore implements CredentialStore {
  private readonly serverUrl: string
  private readonly email: string
  private readonly masterPassword: string
  private readonly appDataDir?: string
  private sessionToken: string | null = null

  constructor(
    serverUrl: string,
    email: string,
    masterPassword: string,
    options: { appDataDir?: string } = {},
  ) {
    this.serverUrl = serverUrl
    this.email = email
    this.masterPassword = masterPassword
    this.appDataDir = options.appDataDir
  }

  isReady(): boolean {
    return true
  }

  /**
   * Ensure the bw CLI is authenticated and unlocked.
   * Handles three states: logged out → login, locked → unlock, already unlocked → no-op.
   * Retries transient failures (network/timeout) up to MAX_RETRIES with exponential backoff.
   */
  async login(): Promise<void> {
    // Ensure bw CLI is installed before any bw commands
    await ensureBwCli()
    if (this.appDataDir) {
      fs.mkdirSync(this.appDataDir, { recursive: true, mode: 0o700 })
    }

    let lastError: Error | undefined

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await this.loginAttempt()
        return
      } catch (err) {
        /* v8 ignore next -- defensive: loginAttempt always throws Error instances @preserve */
        lastError = err instanceof Error ? err : new Error(String(err))

        // Don't retry non-transient errors (auth failures, bw not installed)
        if (!isTransientError(lastError)) {
          throw lastError
        }

        // Don't retry after final attempt
        if (attempt === MAX_RETRIES - 1) break

        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt)
        emitNervesEvent({
          event: "repertoire.bw_login_retry",
          component: "repertoire",
          message: `bw login attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`,
          meta: { attempt: attempt + 1, backoffMs, reason: lastError.message },
        })

        await delay(backoffMs)
      }
    }

    throw lastError!
  }

  /** Single login attempt — called by login() retry loop. */
  private async loginAttempt(): Promise<void> {
    // Check current status
    let status: { status?: string; serverUrl?: string; userEmail?: string } = {}
    try {
      const raw = await execBw(["status"], undefined, this.appDataDir)
      status = JSON.parse(raw)
    } catch (err) {
      // If bw CLI is not installed or a transient error, propagate it for retry
      if (err instanceof Error && (isBwNotInstalled(err) || isTransientError(err))) {
        throw err
      }
      // CLI not configured or broken — proceed with full setup
    }

    // Configure server URL if needed (only works when logged out)
    if (status.status === "unauthenticated" || !status.serverUrl) {
      try {
        await execBw(["config", "server", this.serverUrl], undefined, this.appDataDir)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        // "Logout required" means already logged in — that's fine, skip config.
        if (!isBwConfigLogoutRequired(err)) {
          throw err
        }
      }
    }

    if (status.status === "locked") {
      // Already logged in, just needs unlock
      const unlockOutput = await execBw(["unlock", this.masterPassword, "--raw"], undefined, this.appDataDir)
      this.sessionToken = unlockOutput.trim()
    } else if (status.status === "unauthenticated" || !status.status) {
      // Not logged in — full login
      const loginOutput = await execBw(["login", this.email, this.masterPassword, "--raw"], undefined, this.appDataDir)
      try {
        const parsed = JSON.parse(loginOutput)
        this.sessionToken = parsed.access_token ?? loginOutput.trim()
      } catch {
        this.sessionToken = loginOutput.trim()
      }
    } else {
      // Status is "unlocked" — already good, just need the session token
      const unlockOutput = await execBw(["unlock", this.masterPassword, "--raw"], undefined, this.appDataDir)
      this.sessionToken = unlockOutput.trim()
    }
  }

  private async ensureSession(): Promise<string | undefined> {
    if (!this.sessionToken) {
      await this.login()
    }
    /* v8 ignore next -- defensive: login() always sets sessionToken on success @preserve */
    return this.sessionToken ?? undefined
  }

  private async withSessionRetry<T>(operation: (session: string | undefined) => Promise<T>): Promise<T> {
    let attemptedFreshSession = false
    while (true) {
      const session = await this.ensureSession()
      try {
        return await operation(session)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        if (attemptedFreshSession || !isBwSessionAuthError(err)) {
          throw err
        }
        this.sessionToken = null
        attemptedFreshSession = true
      }
    }
  }

  async get(domain: string): Promise<CredentialMeta | null> {
    emitNervesEvent({
      event: "repertoire.bw_credential_get_start",
      component: "repertoire",
      message: `getting credential via bw for ${domain}`,
      meta: { domain, backend: "bitwarden" },
    })

    const item = await this.withSessionRetry((session) => this.findItemByDomain(domain, session))

    if (!item) {
      emitNervesEvent({
        event: "repertoire.bw_credential_get_end",
        component: "repertoire",
        message: `no bw credential for ${domain}`,
        meta: { domain, found: false, backend: "bitwarden" },
      })
      return null
    }

    emitNervesEvent({
      event: "repertoire.bw_credential_get_end",
      component: "repertoire",
      message: `bw credential found for ${domain}`,
      meta: { domain, found: true, backend: "bitwarden" },
    })

    return {
      domain: item.name,
      username: item.login?.username,
      notes: item.notes ?? undefined,
      createdAt: item.revisionDate ?? new Date().toISOString(),
    }
  }

  async getRawSecret(domain: string, field: string): Promise<string> {
    const item = await this.withSessionRetry((session) => this.findItemByDomain(domain, session))

    if (!item) {
      throw new Error(`no credential found for domain "${domain}"`)
    }

    // Map common field names to bw item structure
    let value: string | undefined | null
    if (field === "password") {
      value = item.login?.password
    } else if (field === "username") {
      value = item.login?.username
    } else {
      value = (item as unknown as Record<string, unknown>)[field] as string | undefined
    }

    if (value === undefined || value === null) {
      throw new Error(`field "${field}" not found for domain "${domain}"`)
    }

    return String(value)
  }

  async store(
    domain: string,
    data: { username?: string; password: string; notes?: string },
  ): Promise<void> {
    emitNervesEvent({
      event: "repertoire.bw_credential_store_start",
      component: "repertoire",
      message: `storing credential via bw for ${domain}`,
      meta: { domain, backend: "bitwarden" },
    })

    await this.withSessionRetry(async (session) => {
      const existing = await this.findItemByDomain(domain, session)
      const item = {
        ...(existing ?? {}),
        type: 1, // Login type
        name: domain,
        login: {
          username: data.username ?? "",
          password: data.password,
          uris: [{ match: null, uri: `https://${domain}` }],
        },
        notes: data.notes ?? null,
      }

      const encoded = Buffer.from(JSON.stringify(item)).toString("base64")
      if (existing) {
        await execBw(["edit", "item", existing.id], session, this.appDataDir, encoded)
      } else {
        await execBw(["create", "item"], session, this.appDataDir, encoded)
      }
    })

    emitNervesEvent({
      event: "repertoire.bw_credential_store_end",
      component: "repertoire",
      message: `credential stored via bw for ${domain}`,
      meta: { domain, backend: "bitwarden" },
    })
  }

  async list(): Promise<CredentialMeta[]> {
    emitNervesEvent({
      event: "repertoire.bw_credential_list_start",
      component: "repertoire",
      message: "listing bw credentials",
      meta: { backend: "bitwarden" },
    })

    const stdout = await this.withSessionRetry((session) => execBw(["list", "items"], session, this.appDataDir))
    const items = parseBwItems(stdout, "bw list items")

    const results: CredentialMeta[] = items.map((item) => ({
      domain: item.name,
      username: item.login?.username,
      notes: item.notes ?? undefined,
      createdAt: item.revisionDate ?? new Date().toISOString(),
    }))

    emitNervesEvent({
      event: "repertoire.bw_credential_list_end",
      component: "repertoire",
      message: "bw credentials listed",
      meta: { backend: "bitwarden", count: results.length },
    })

    return results
  }

  async delete(domain: string): Promise<boolean> {
    emitNervesEvent({
      event: "repertoire.bw_credential_delete_start",
      component: "repertoire",
      message: `deleting credential via bw for ${domain}`,
      meta: { domain, backend: "bitwarden" },
    })

    const item = await this.withSessionRetry((session) => this.findItemByDomain(domain, session))

    if (!item) {
      emitNervesEvent({
        event: "repertoire.bw_credential_delete_end",
        component: "repertoire",
        message: `no bw credential to delete for ${domain}`,
        meta: { domain, deleted: false, backend: "bitwarden" },
      })
      return false
    }

    await this.withSessionRetry((session) => execBw(["delete", "item", item.id], session, this.appDataDir))

    emitNervesEvent({
      event: "repertoire.bw_credential_delete_end",
      component: "repertoire",
      message: `credential deleted via bw for ${domain}`,
      meta: { domain, deleted: true, backend: "bitwarden" },
    })

    return true
  }

  // --- Private ---

  private async findItemByDomain(domain: string, session?: string): Promise<BwLoginItem | null> {
    const stdout = await execBw(["list", "items", "--search", domain], session, this.appDataDir)
    const items = parseBwItems(stdout, "bw list items --search")

    // Find exact match by name
    return items.find((item) => item.name === domain) ?? items[0] ?? null
  }
}
