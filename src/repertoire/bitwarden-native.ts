/**
 * Reads an agent's Bitwarden/Vaultwarden vault over HTTPS with Node's own crypto, so a daemon
 * reading its runtime config and provider credentials never runs the `bw` CLI.
 *
 * Protocol (Bitwarden security whitepaper): prelogin for the KDF, PBKDF2-SHA256 master key,
 * a password-grant login with the master password hash, the user key unwrapped with the
 * HKDF-stretched master key, then /api/sync and AES-256-CBC + HMAC-SHA256 decryption of each item.
 * It also creates, updates and trashes login items (POST/PUT /api/ciphers), re-encrypting only the
 * name, notes and login and replaying every other encrypted field from the last sync unchanged.
 * Anything this client does not handle (Argon2id, two-step login, other cipher types) raises
 * NativeVaultUnsupportedError so the caller can fall back to `bw`.
 */

import * as crypto from "node:crypto"
import * as http from "node:http"
import * as https from "node:https"
import * as os from "node:os"
import { emitNervesEvent } from "../nerves/runtime"
import { deriveMasterKey, deriveMasterPasswordHash, deriveStretchedMasterKey } from "./vault-setup"

/** A decrypted vault item, in the shape `bw list items` prints. */
export interface NativeVaultItem {
  id: string
  name: string
  login?: { username?: string; password?: string; uris?: Array<{ uri: string }> }
  notes?: string | null
  revisionDate?: string
}

/** The vault uses something this reader does not implement; `bw` may still read it. */
export class NativeVaultUnsupportedError extends Error {
  constructor(reason: string) {
    super(`native vault reads do not support ${reason}`)
    this.name = "NativeVaultUnsupportedError"
  }
}

export interface VaultHttpRequest {
  method: "GET" | "POST" | "PUT"
  headers: Record<string, string>
  body?: string
}

export interface VaultHttpResponse {
  status: number
  body: string
}

export interface NativeVaultReaderDeps {
  request: (url: string, init: VaultHttpRequest) => Promise<VaultHttpResponse>
  now: () => number
  hostname: () => string
  platform: NodeJS.Platform
}

const REQUEST_TIMEOUT_MS = 30_000

/** One request with node:http(s): global fetch would load undici, about 7 MB more per process. */
export function nodeVaultRequest(url: string, init: VaultHttpRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<VaultHttpResponse> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http
    const request = client.request(url, { method: init.method, headers: init.headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: Number(response.statusCode), body: Buffer.concat(chunks).toString("utf8") }))
      response.on("error", reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("request timed out"), { name: "TimeoutError" })))
    request.on("error", reject)
    request.end(init.body)
  })
}

const defaultDeps: NativeVaultReaderDeps = {
  request: (url, init) => nodeVaultRequest(url, init),
  now: () => Date.now(),
  hostname: () => os.hostname(),
  platform: process.platform,
}

const KDF_PBKDF2 = 0
/** How long one sync answers reads before the next read syncs again. */
export const NATIVE_VAULT_ITEMS_FRESH_MS = 30_000
/** A rejected secret is not retried against the server for this long, as the bw path does. */
export const NATIVE_VAULT_LOGIN_FAILURE_RETRY_MS = 5 * 60_000
const TOKEN_EXPIRY_MARGIN_MS = 60_000

type Json = Record<string, unknown>

/** Bitwarden answers some objects in PascalCase and Vaultwarden in camelCase; read either. */
function field(source: unknown, name: string): unknown {
  if (!source || typeof source !== "object") return undefined
  const record = source as Json
  return record[name] ?? record[name.charAt(0).toUpperCase() + name.slice(1)]
}

function stringField(source: unknown, name: string): string | undefined {
  const value = field(source, name)
  return typeof value === "string" ? value : undefined
}

function deviceType(platform: NodeJS.Platform): string {
  // Bitwarden's DeviceType: WindowsCLI 23, MacOsCLI 24, LinuxCLI 25.
  if (platform === "win32") return "23"
  if (platform === "darwin") return "24"
  return "25"
}

/** One stable device per agent and host, so the server does not see a new device on every start. */
function deviceIdentifier(email: string, serverUrl: string, hostname: string): string {
  const hex = crypto.createHash("sha256").update(`ouro-native-vault\n${email.toLowerCase()}\n${serverUrl}\n${hostname}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Decrypt a type-2 cipher string ("2.<iv>|<ct>|<mac>") with a 64-byte key (32 enc + 32 mac). */
export function decryptCipherString(value: string, key: Buffer): Buffer {
  const dot = value.indexOf(".")
  const type = dot > 0 ? value.slice(0, dot) : ""
  if (type !== "2") throw new NativeVaultUnsupportedError(`cipher strings of type ${type || "unknown"}`)
  const parts = value.slice(dot + 1).split("|")
  if (parts.length !== 3) throw new Error("malformed cipher string")
  const [iv, ct, mac] = parts.map((part) => Buffer.from(part, "base64"))
  if (iv!.length !== 16 || mac!.length !== 32 || ct!.length === 0) throw new Error("malformed cipher string")
  const expected = crypto.createHmac("sha256", key.subarray(32, 64)).update(iv!).update(ct!).digest()
  if (!crypto.timingSafeEqual(expected, mac!)) throw new Error("cipher string failed its integrity check")
  const decipher = crypto.createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv!)
  return Buffer.concat([decipher.update(ct!), decipher.final()])
}

/** Encrypt into a type-2 cipher string with a 64-byte key (32 enc + 32 mac). */
export function encryptCipherString(data: Buffer | string, key: Buffer): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-256-cbc", key.subarray(0, 32), iv)
  const ct = Buffer.concat([cipher.update(typeof data === "string" ? Buffer.from(data, "utf8") : data), cipher.final()])
  const mac = crypto.createHmac("sha256", key.subarray(32, 64)).update(iv).update(ct).digest()
  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`
}

function decryptText(value: unknown, key: Buffer): string | undefined {
  return typeof value === "string" && value.length > 0 ? decryptCipherString(value, key).toString("utf8") : undefined
}

function decryptKey(value: string, key: Buffer, what: string): Buffer {
  const decrypted = decryptCipherString(value, key)
  if (decrypted.length !== 64) throw new NativeVaultUnsupportedError(`a ${decrypted.length}-byte ${what}`)
  return decrypted
}

/** Decrypt the personal, non-deleted items of a sync response; items in organizations are left out. */
export function decryptSyncItems(sync: unknown, userKey: Buffer): { items: NativeVaultItem[]; skipped: number; unreadable: number; raw: Map<string, Json> } {
  const ciphers = field(sync, "ciphers")
  if (!Array.isArray(ciphers)) throw new Error("vault sync returned no item list")
  const items: NativeVaultItem[] = []
  const raw = new Map<string, Json>()
  let skipped = 0
  let unreadable = 0
  for (const cipher of ciphers) {
    if (field(cipher, "organizationId") || field(cipher, "deletedDate")) {
      skipped += 1
      continue
    }
    try {
      const itemKeyString = stringField(cipher, "key")
      const key = itemKeyString ? decryptKey(itemKeyString, userKey, "item key") : userKey
      const login = field(cipher, "login")
      const uris = field(login, "uris")
      raw.set(String(field(cipher, "id")), cipher as Json)
      items.push({
        id: String(field(cipher, "id")),
        name: decryptText(field(cipher, "name"), key) ?? "",
        ...(login
          ? {
              login: {
                username: decryptText(field(login, "username"), key),
                password: decryptText(field(login, "password"), key),
                uris: Array.isArray(uris)
                  ? uris.map((entry) => decryptText(field(entry, "uri"), key)).filter((uri): uri is string => uri !== undefined).map((uri) => ({ uri }))
                  : [],
              },
            }
          : {}),
        notes: decryptText(field(cipher, "notes"), key) ?? null,
        revisionDate: stringField(cipher, "revisionDate"),
      })
    } catch (error) {
      if (error instanceof NativeVaultUnsupportedError) throw error
      unreadable += 1
    }
  }
  return { items, skipped, unreadable, raw }
}

interface NativeSession {
  accessToken: string
  expiresAt: number
  userKey: Buffer
  /** The account's id from the access token; writes need it, reads do not. */
  userId: string | null
}

/** A login item to write: the same fields `ouro`'s bw path writes. */
export interface NativeLoginWrite {
  name: string
  username: string
  password: string
  notes: string | null
  uri: string
}

/** The user id (`sub`) in a JWT access token, or null when the token is not a JWT. */
function tokenUserId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown
    const sub = field(payload, "sub")
    return typeof sub === "string" && sub.length > 0 ? sub : null
  } catch {
    return null
  }
}

/** The fields of an item that a write keeps as they are: still encrypted, so never decrypted here. */
const PRESERVED_CIPHER_FIELDS = ["folderId", "favorite", "reprompt", "fields", "passwordHistory"] as const

export class NativeVaultReader {
  private readonly serverUrl: string
  private keys: { hash: string; stretched: Buffer } | null = null
  private session: NativeSession | null = null
  private cache: { items: NativeVaultItem[]; raw: Map<string, Json>; at: number } | null = null
  private loginFailure: { error: Error; at: number } | null = null

  constructor(
    serverUrl: string,
    private readonly email: string,
    private readonly masterPassword: string,
    private readonly deps: NativeVaultReaderDeps = defaultDeps,
  ) {
    this.serverUrl = serverUrl.replace(/\/+$/, "")
  }

  /** Forget the synced items, so the next read syncs (after this process wrote to the vault). */
  invalidate(): void {
    this.cache = null
  }

  async items(): Promise<NativeVaultItem[]> {
    if (this.cache && this.deps.now() - this.cache.at < NATIVE_VAULT_ITEMS_FRESH_MS) return this.cache.items
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.native_vault_sync_start",
      message: "reading the vault natively",
      meta: { email: this.email, serverUrl: this.serverUrl },
    })
    let session = await this.ensureSession()
    let sync = await this.requestSync(session)
    if (sync === null) {
      // The token was revoked or expired early: one fresh login, then give up.
      this.session = null
      session = await this.ensureSession()
      sync = await this.requestSync(session)
      if (sync === null) throw new Error("vault sync rejected a fresh access token (HTTP 401)")
    }
    const { items, skipped, unreadable, raw } = decryptSyncItems(sync, session.userKey)
    this.cache = { items, raw, at: this.deps.now() }
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.native_vault_sync_end",
      message: "read the vault natively",
      meta: { email: this.email, items: items.length, skipped, unreadable },
    })
    return items
  }

  /**
   * Create a login item, or update the item `existingId` names. An update needs that item in the
   * latest sync (read items() first): it keeps the item's own key, folder, favorite, custom fields,
   * password history and other login data exactly as stored, and the server refuses it if the item
   * changed since that sync. Returns the item id. Does not retry, so a lost answer never writes twice.
   */
  async saveLogin(write: NativeLoginWrite, existingId?: string): Promise<string> {
    const existing = existingId === undefined ? undefined : this.cache?.raw.get(existingId)
    if (existingId !== undefined && !existing) throw new Error(`vault item ${existingId} is not in the latest sync; read the vault before updating it`)
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.native_vault_write_start",
      message: existingId ? "updating a vault item natively" : "creating a vault item natively",
      meta: { email: this.email, update: existingId !== undefined },
    })
    const answer = await this.withSession(async (session) => {
      if (!session.userId) throw new NativeVaultUnsupportedError("writes with an access token that names no user")
      const itemKeyString = existing ? stringField(existing, "key") : undefined
      const key = itemKeyString ? decryptKey(itemKeyString, session.userKey, "item key") : session.userKey
      const login = field(existing, "login")
      const body: Json = {
        ...(existing ? Object.fromEntries(PRESERVED_CIPHER_FIELDS.map((name) => [name, field(existing, name) ?? null])) : { folderId: null, favorite: false, reprompt: 0, fields: null, passwordHistory: null }),
        type: 1,
        organizationId: null,
        key: itemKeyString ?? null,
        name: encryptCipherString(write.name, key),
        notes: write.notes === null ? null : encryptCipherString(write.notes, key),
        login: {
          ...(login && typeof login === "object" ? (login as Json) : {}),
          username: encryptCipherString(write.username, key),
          password: encryptCipherString(write.password, key),
          uris: [{ uri: encryptCipherString(write.uri, key), match: null }],
        },
        encryptedFor: session.userId,
        lastKnownRevisionDate: existing ? stringField(existing, "revisionDate") ?? null : null,
      }
      return this.request(existingId ? `/api/ciphers/${encodeURIComponent(existingId)}` : "/api/ciphers", {
        method: existingId ? "PUT" : "POST",
        headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    })
    this.cache = null
    if (!ok(answer)) throw new Error(`vault ${existingId ? "update" : "create"} for ${this.email} failed: HTTP ${answer.status}${serverMessage(answer)}`)
    const id = stringField(readJson(answer), "id")
    if (!id) throw new Error(`vault ${existingId ? "update" : "create"} for ${this.email} returned no item id`)
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.native_vault_write_end",
      message: "wrote a vault item natively",
      meta: { email: this.email, update: existingId !== undefined },
    })
    return id
  }

  /** Move an item to the trash, as `bw delete item` does. */
  async deleteItem(id: string): Promise<void> {
    const answer = await this.withSession((session) => this.request(`/api/ciphers/${encodeURIComponent(id)}/delete`, {
      method: "PUT",
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    this.cache = null
    if (!ok(answer)) throw new Error(`vault delete for ${this.email} failed: HTTP ${answer.status}${serverMessage(answer)}`)
  }

  /** Run one request with a session, logging in once more if the server rejects the access token. */
  private async withSession(send: (session: NativeSession) => Promise<VaultHttpResponse>): Promise<VaultHttpResponse> {
    const answer = await send(await this.ensureSession())
    if (answer.status !== 401) return answer
    this.session = null
    return send(await this.ensureSession())
  }

  private async ensureSession(): Promise<NativeSession> {
    if (this.session && this.deps.now() < this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return this.session
    if (this.loginFailure && this.deps.now() - this.loginFailure.at < NATIVE_VAULT_LOGIN_FAILURE_RETRY_MS) throw this.loginFailure.error
    this.loginFailure = null
    const keys = this.keys ?? (this.keys = await this.deriveKeys())
    const body = new URLSearchParams({
      grant_type: "password",
      username: this.email,
      password: keys.hash,
      scope: "api offline_access",
      client_id: "cli",
      deviceType: deviceType(this.deps.platform),
      deviceIdentifier: deviceIdentifier(this.email, this.serverUrl, this.deps.hostname()),
      deviceName: "ouro",
    })
    const response = await this.request("/identity/connect/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "auth-email": Buffer.from(this.email).toString("base64url"),
      },
      body: body.toString(),
    })
    const token = readJson(response)
    if (!ok(response)) {
      if (field(token, "twoFactorProviders") || field(token, "twoFactorProviders2")) throw new NativeVaultUnsupportedError("two-step login")
      const message = stringField(field(token, "errorModel"), "message") ?? stringField(token, "error_description") ?? stringField(token, "error") ?? ""
      if (/device/i.test(message)) throw new NativeVaultUnsupportedError("new-device verification")
      const error = response.status === 400 && (stringField(token, "error") === "invalid_grant" || /username or password is incorrect/i.test(message))
        ? new Error(`vault login for ${this.email} failed: username or password is incorrect (the saved vault unlock secret was rejected)`)
        : new Error(`vault login for ${this.email} failed: HTTP ${response.status}${message ? ` ${message}` : ""}`)
      if (response.status === 400) this.loginFailure = { error, at: this.deps.now() }
      throw error
    }
    const accessToken = stringField(token, "access_token")
    const protectedKey = stringField(token, "key")
    if (!accessToken || !protectedKey) throw new Error("vault login returned no access token or user key")
    const expiresIn = Number(field(token, "expires_in"))
    const userKey = decryptKey(protectedKey, keys.stretched, "user key")
    const userId = tokenUserId(accessToken)
    this.session = { accessToken, expiresAt: this.deps.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000, userKey, userId }
    return this.session
  }

  private async deriveKeys(): Promise<{ hash: string; stretched: Buffer }> {
    const response = await this.request("/identity/accounts/prelogin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.email }),
    })
    if (!ok(response)) throw new Error(`vault prelogin for ${this.email} failed: HTTP ${response.status}`)
    const prelogin = readJson(response)
    const kdf = Number(field(prelogin, "kdf"))
    const iterations = Number(field(prelogin, "kdfIterations"))
    if (kdf !== KDF_PBKDF2) throw new NativeVaultUnsupportedError(`KDF ${Number.isFinite(kdf) ? kdf : "unknown"} (only PBKDF2-SHA256)`)
    if (!Number.isInteger(iterations) || iterations < 1) throw new Error("vault prelogin returned no KDF iteration count")
    const masterKey = await deriveMasterKey(this.masterPassword, this.email, iterations)
    return { hash: await deriveMasterPasswordHash(masterKey, this.masterPassword), stretched: deriveStretchedMasterKey(masterKey) }
  }

  /** The sync body, or null when the server rejected the access token. */
  private async requestSync(session: NativeSession): Promise<unknown | null> {
    const response = await this.request("/api/sync?excludeDomains=true", {
      method: "GET",
      headers: { authorization: `Bearer ${session.accessToken}` },
    })
    if (response.status === 401) return null
    if (!ok(response)) throw new Error(`vault sync for ${this.email} failed: HTTP ${response.status}`)
    return readJson(response)
  }

  private async request(pathname: string, init: VaultHttpRequest): Promise<VaultHttpResponse> {
    const endpoint = pathname.split("?")[0]
    try {
      return await this.deps.request(`${this.serverUrl}${pathname}`, init)
    } catch (error) {
      // Worded so the store's transient-error check retries it.
      if (error instanceof Error && error.name === "TimeoutError") throw new Error(`vault request to ${endpoint} timed out`)
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ""
      throw new Error(`vault request to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}${cause}`)
    }
  }
}

function readJson(response: VaultHttpResponse): Json {
  try {
    const parsed: unknown = JSON.parse(response.body)
    return parsed && typeof parsed === "object" ? (parsed as Json) : {}
  } catch {
    return {}
  }
}

const ok = (response: VaultHttpResponse): boolean => response.status >= 200 && response.status < 300

/** The server's own explanation of a refused request, when it gave one. */
function serverMessage(response: VaultHttpResponse): string {
  const body = readJson(response)
  const message = stringField(field(body, "errorModel"), "message") ?? stringField(body, "message")
  return message ? ` ${message}` : ""
}

const sharedReaders = new Map<string, NativeVaultReader>()

/** One reader per vault account and secret in a process, so its stores share one login and one sync. */
export function sharedNativeVaultReader(serverUrl: string, email: string, masterPassword: string): NativeVaultReader {
  const key = crypto.createHash("sha256").update(`${serverUrl.replace(/\/+$/, "")}\n${email.toLowerCase()}\n${masterPassword}`).digest("hex")
  let reader = sharedReaders.get(key)
  if (!reader) {
    reader = new NativeVaultReader(serverUrl, email, masterPassword)
    sharedReaders.set(key, reader)
  }
  return reader
}
