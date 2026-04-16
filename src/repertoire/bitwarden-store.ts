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
import * as path from "node:path"
import type { CredentialMeta, CredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"
import { ensureBwCli } from "./bw-installer"

const MAX_ERROR_DETAIL_LENGTH = 500
const LONG_ENCODED_TOKEN_PATTERN = /[A-Za-z0-9+/=]{32,}/g

function uniqueSecrets(secrets: Array<string | undefined>): string[] {
  return [...new Set(
    secrets.filter((value): value is string => typeof value === "string" && value.length >= 4),
  )].sort((left, right) => right.length - left.length)
}

export function sanitizeCredentialErrorDetail(
  message: string,
  options: { secrets?: Array<string | undefined> } = {},
): string {
  const filtered = message
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith("Command failed:")) return false
      if (trimmed.includes("[input is hidden]")) return false
      return true
    })
    .join("\n")
    .trim()

  let sanitized = filtered || "command failed"
  for (const secret of uniqueSecrets(options.secrets ?? [])) {
    sanitized = sanitized.split(secret).join("[redacted]")
  }

  sanitized = sanitized.replace(LONG_ENCODED_TOKEN_PATTERN, "[redacted]")
  if (sanitized.replace(/\[redacted\]/g, "").trim().length === 0) {
    return "command failed"
  }

  return sanitized.slice(0, MAX_ERROR_DETAIL_LENGTH)
}

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

function isBwTimeoutError(err: Error): boolean {
  const timeoutErr = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }
  const message = err.message.toLowerCase()
  return (
    timeoutErr.code === "ETIMEDOUT" ||
    timeoutErr.killed === true ||
    timeoutErr.signal === "SIGTERM" ||
    message.includes("timed out")
  )
}

function formatBwOperation(args: string[]): string {
  const [command, target] = args
  /* v8 ignore next -- defensive: all execBw call sites pass a concrete bw subcommand @preserve */
  if (!command) return "bw command"
  return [command, target].filter(Boolean).join(" ")
}

function sanitizeBwErrorDetail(message: string): string {
  if (isBwInvalidUnlockSecretMessage(message)) {
    return "bw CLI rejected the saved vault unlock secret for this machine"
  }
  if (isBwSessionUnavailableMessage(message)) {
    return "bw CLI could not use the local Bitwarden session because it is locked, missing, or expired"
  }
  return sanitizeCredentialErrorDetail(message)
}

function formatBwCliError(err: Error, stderr = "", args: string[] = []): Error {
  const operation = formatBwOperation(args)
  if (isBwTimeoutError(err)) {
    return new Error(`bw CLI error: ${operation} timed out -- usually resolves on retry. If it persists, check network connectivity to the vault server.`)
  }
  const detail = sanitizeBwErrorDetail(stderr.trim() || err.message)
  if (detail === "command failed") {
    return new Error(`bw CLI error: ${operation} failed without error detail`)
  }
  return new Error(`bw CLI error: ${detail}`)
}

function isBwSessionAuthError(err: Error): boolean {
  return isBwSessionUnavailableMessage(err.message) || isBwInvalidUnlockSecretMessage(err.message)
}

function isBwConfigLogoutRequired(err: Error): boolean {
  const message = err.message.toLowerCase()
  return message.includes("logout") && message.includes("required")
}

// ---------------------------------------------------------------------------
// Cross-process bw CLI lock
// ---------------------------------------------------------------------------
// The bw CLI cannot handle concurrent access to the same app data directory.
// Two processes (e.g. daemon worker + ouro up CLI) hitting the same dir
// simultaneously corrupt bw's local state, producing empty/garbled output.
//
// We use two layers:
//   1. In-process async mutex: a Map<string, Promise<void>> keyed by appDataDir
//      serializes calls within a single Node.js process.
//   2. Cross-process file lock: fs.openSync(lockPath, 'wx') with PID stale
//      detection serializes across processes.
// ---------------------------------------------------------------------------

const BW_LOCK_FILENAME = ".ouro-bw.lock"
const BW_LOCK_TIMEOUT_MS = 30_000
const BW_LOCK_POLL_MS = 100

/** In-process async mutex keyed by appDataDir. */
const inProcessLocks = new Map<string, Promise<void>>()

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireFileLock(lockPath: string): Promise<void> {
  const content = `${process.pid}\n`
  const deadline = Date.now() + BW_LOCK_TIMEOUT_MS

  while (true) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL)
      fs.writeSync(fd, content)
      fs.closeSync(fd)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err
      }
      // Lock file exists -- check for stale lock
      try {
        const existing = fs.readFileSync(lockPath, "utf8").trim()
        const pid = parseInt(existing, 10)
        if (!isNaN(pid) && !isPidAlive(pid)) {
          // Stale lock -- remove and retry immediately
          try { fs.unlinkSync(lockPath) } catch { /* race with another cleaner is fine */ }
          continue
        }
      } catch { /* v8 ignore next -- race: lock file disappeared between openSync and readFileSync @preserve */
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(`bw CLI lock timeout: could not acquire ${lockPath} within ${BW_LOCK_TIMEOUT_MS}ms`)
      }
      // Yield to the event loop before retrying
      await delay(BW_LOCK_POLL_MS)
    }
  }
}

function releaseFileLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath)
  } catch {
    // Already removed or never created -- safe to ignore
  }
}

async function withBwLock<T>(appDataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!appDataDir) {
    // No appDataDir means the default bw data location. Still need in-process
    // serialization but cannot do cross-process file lock without a dir.
    return fn()
  }

  const lockKey = appDataDir
  const lockPath = path.join(appDataDir, BW_LOCK_FILENAME)

  // In-process serialization: chain onto the previous promise for this key
  const previous = inProcessLocks.get(lockKey) ?? Promise.resolve()
  let releaseLock: () => void
  const current = new Promise<void>((resolve) => { releaseLock = resolve })
  inProcessLocks.set(lockKey, current)

  await previous

  let fileLockAcquired = false
  try {
    // Cross-process file lock
    await acquireFileLock(lockPath)
    fileLockAcquired = true

    return await fn()
  } finally {
    if (fileLockAcquired) {
      releaseFileLock(lockPath)
    }
    releaseLock!()
    // Clean up the map entry if we are the latest
    if (inProcessLocks.get(lockKey) === current) {
      inProcessLocks.delete(lockKey)
    }
  }
}

function execBw(args: string[], sessionToken?: string, appDataDir?: string, stdin?: string): Promise<string> {
  const env = {
    ...process.env,
    ...(sessionToken ? { BW_SESSION: sessionToken } : {}),
    ...(appDataDir ? { BITWARDENCLI_APPDATA_DIR: appDataDir } : {}),
  }

  const runCommand = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFileCb("bw", args, { timeout: 30_000, env }, (err, stdout, stderr) => {
        if (err) {
          if (isBwNotInstalled(err)) {
            reject(new Error("bw CLI not found. Install from https://bitwarden.com/help/cli/"))
            return
          }
          reject(formatBwCliError(err, stderr, args))
          return
        }
        resolve(stdout)
      })
      if (stdin !== undefined) {
        child?.stdin?.end(stdin)
      }
    })

  return withBwLock(appDataDir, runCommand)
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
    msg.includes("server unavailable") ||
    msg.includes("timed out")
  )
}

const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1000
const TRANSIENT_MAX_RETRIES = 3
const TRANSIENT_RETRY_BASE_MS = 500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isBwLoginItem(value: unknown): value is BwLoginItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (typeof item.id !== "string" || item.id.trim().length === 0) return false
  if (typeof item.name !== "string" || item.name.trim().length === 0) return false

  if (item.login !== undefined) {
    if (!item.login || typeof item.login !== "object" || Array.isArray(item.login)) return false
    const login = item.login as Record<string, unknown>
    if (login.username !== undefined && typeof login.username !== "string") return false
    if (login.password !== undefined && typeof login.password !== "string") return false
    if (login.uris !== undefined) {
      if (!Array.isArray(login.uris)) return false
      for (const uri of login.uris) {
        if (!uri || typeof uri !== "object" || Array.isArray(uri)) return false
        const uriRecord = uri as Record<string, unknown>
        if (uriRecord.uri !== undefined && typeof uriRecord.uri !== "string") return false
      }
    }
  }

  if (item.notes !== undefined && item.notes !== null && typeof item.notes !== "string") return false
  if (item.revisionDate !== undefined && typeof item.revisionDate !== "string") return false

  return true
}

function parseBwItems(stdout: string, context: string): BwLoginItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error("expected item array")
    }
    const items = parsed as unknown[]
    if (!items.every(isBwLoginItem)) {
      throw new Error("expected login items")
    }
    return items
  } catch {
    if (Array.isArray(parsed)) {
      throw new Error(`bw CLI error: invalid item from ${context}`)
    }
    throw new Error(`bw CLI error: invalid JSON from ${context}`)
  }
}

function parseBwItem(stdout: string, context: string): BwLoginItem {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
    if (!isBwLoginItem(parsed)) {
      throw new Error("expected login item")
    }
    return parsed
  } catch {
    if (parsed !== undefined) {
      throw new Error(`bw CLI error: invalid item from ${context}`)
    }
    throw new Error(`bw CLI error: invalid JSON from ${context}`)
  }
}

function parseBwItemId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const id = (parsed as Record<string, unknown>).id
    return typeof id === "string" && id.trim().length > 0 ? id : null
  } catch {
    return null
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
        const err = error as Error
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

    // Sync vault data after obtaining a fresh session token
    /* v8 ignore next -- defensive: loginAttempt always sets sessionToken before sync @preserve */
    await execBw(["sync"], this.sessionToken ?? undefined, this.appDataDir)
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
        const err = error as Error
        if (attemptedFreshSession || !isBwSessionAuthError(err)) {
          throw err
        }
        this.sessionToken = null
        attemptedFreshSession = true
      }
    }
  }

  private async withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt < TRANSIENT_MAX_RETRIES; attempt++) {
      try {
        return await operation()
      } catch (err) {
        /* v8 ignore next -- defensive: operation always throws Error instances @preserve */
        lastError = err instanceof Error ? err : new Error(String(err))

        if (!isTransientError(lastError)) {
          throw lastError
        }

        if (attempt === TRANSIENT_MAX_RETRIES - 1) break

        const backoffMs = TRANSIENT_RETRY_BASE_MS * Math.pow(2, attempt)
        emitNervesEvent({
          event: "repertoire.bw_transient_retry",
          component: "repertoire",
          message: `transient bw error, retrying in ${backoffMs}ms`,
          meta: { attempt: attempt + 1, backoffMs, reason: lastError.message },
        })

        await delay(backoffMs)
      }
    }

    throw lastError!
  }

  async get(domain: string): Promise<CredentialMeta | null> {
    emitNervesEvent({
      event: "repertoire.bw_credential_get_start",
      component: "repertoire",
      message: `getting credential via bw for ${domain}`,
      meta: { domain, backend: "bitwarden" },
    })

    const item = await this.withTransientRetry(() =>
      this.withSessionRetry((session) => this.findItemByDomain(domain, session)),
    )

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
    const item = await this.withTransientRetry(() =>
      this.withSessionRetry((session) => this.findItemByDomain(domain, session)),
    )

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
      let savedItem: BwLoginItem | null
      if (existing) {
        const stdout = await execBw(["edit", "item", existing.id], session, this.appDataDir, encoded)
        const savedItemId = parseBwItemId(stdout) ?? existing.id
        savedItem = await this.findItemById(savedItemId, session)
      } else {
        const stdout = await execBw(["create", "item"], session, this.appDataDir, encoded)
        const savedItemId = parseBwItemId(stdout)
        savedItem = savedItemId
          ? await this.findItemById(savedItemId, session)
          : await this.findItemByDomain(domain, session)
      }
      this.assertStoredCredentialMatches(domain, data, savedItem)
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

    const stdout = await this.withTransientRetry(() =>
      this.withSessionRetry((session) => execBw(["list", "items"], session, this.appDataDir)),
    )
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
    return items.find((item) => item.name === domain) ?? null
  }

  private async findItemById(id: string, session?: string): Promise<BwLoginItem> {
    const stdout = await execBw(["get", "item", id], session, this.appDataDir)
    return parseBwItem(stdout, "bw get item")
  }

  private assertStoredCredentialMatches(
    domain: string,
    data: { username?: string; password: string; notes?: string },
    item: BwLoginItem | null,
  ): void {
    if (!item) {
      throw new Error(`bw CLI error: credential save verification failed for ${domain}: saved item could not be read back after write`)
    }

    const mismatches: string[] = []
    if (item.name !== domain) mismatches.push("name")
    if ((item.login?.username ?? "") !== (data.username ?? "")) mismatches.push("username")
    if ((item.login?.password ?? "") !== data.password) mismatches.push("password")
    if ((item.notes ?? null) !== (data.notes ?? null)) mismatches.push("notes")

    if (mismatches.length > 0) {
      const label = mismatches.length === 1 ? "field" : "fields"
      throw new Error(
        `bw CLI error: credential save verification failed for ${domain}: saved item did not match requested ${label} ${mismatches.join(", ")}`,
      )
    }
  }
}
