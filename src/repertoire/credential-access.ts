/**
 * Credential access layer — store-agnostic credential management.
 *
 * Two backends, one interface:
 *   - BuiltInCredentialStore: AES-256-GCM encrypted files, zero npm deps
 *   - AacCredentialStore: delegates to the `aac` CLI (Bitwarden Agent Access)
 *
 * Raw secrets are NEVER returned to callers except via getRawSecret(),
 * which is reserved for internal use by the credential gateway (apiRequest).
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFile as execFileCb } from "node:child_process"
import { emitNervesEvent } from "../nerves/runtime"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialMeta {
  domain: string
  username?: string
  notes?: string
  createdAt: string
}

export interface CredentialStore {
  get(domain: string): Promise<CredentialMeta | null>
  /** INTERNAL ONLY — used by credential gateway to inject secrets into requests */
  getRawSecret(domain: string, field: string): Promise<string>
  store(domain: string, data: { username?: string; password: string; notes?: string }): Promise<void>
  list(): Promise<CredentialMeta[]>
  delete(domain: string): Promise<boolean>
  isReady(): boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a domain string to a filesystem-safe slug. */
export function domainToSlug(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// ---------------------------------------------------------------------------
// BuiltInCredentialStore — AES-256-GCM encrypted files
// ---------------------------------------------------------------------------

interface EncryptedPayload {
  iv: string   // hex
  tag: string  // hex
  data: string // hex (encrypted JSON)
}

interface StoredCredential {
  domain: string
  username?: string
  password: string
  notes?: string
  createdAt: string
}

export class BuiltInCredentialStore implements CredentialStore {
  private readonly vaultDir: string
  private readonly keyPath: string
  private masterKey: Buffer | null = null

  constructor(agentName: string, vaultDir?: string, keyDir?: string) {
    const homeBase = process.env.WEBSITE_SITE_NAME ? "/home" : os.homedir()
    this.vaultDir = vaultDir ?? path.join(homeBase, "AgentBundles", `${agentName}.ouro`, "vault")
    const effectiveKeyDir = keyDir ?? path.join(homeBase, ".agentsecrets", agentName)
    this.keyPath = path.join(effectiveKeyDir, "vault.key")
  }

  isReady(): boolean {
    return true
  }

  async get(domain: string): Promise<CredentialMeta | null> {
    emitNervesEvent({
      event: "repertoire.credential_get_start",
      component: "repertoire",
      message: `getting credential for ${domain}`,
      meta: { domain },
    })

    const stored = this.readEncrypted(domain)
    if (!stored) {
      emitNervesEvent({
        event: "repertoire.credential_get_end",
        component: "repertoire",
        message: `no credential found for ${domain}`,
        meta: { domain, found: false },
      })
      return null
    }

    emitNervesEvent({
      event: "repertoire.credential_get_end",
      component: "repertoire",
      message: `credential found for ${domain}`,
      meta: { domain, found: true },
    })

    return {
      domain: stored.domain,
      username: stored.username,
      notes: stored.notes,
      createdAt: stored.createdAt,
    }
  }

  async getRawSecret(domain: string, field: string): Promise<string> {
    const stored = this.readEncrypted(domain)
    if (!stored) {
      emitNervesEvent({
        level: "error",
        event: "repertoire.credential_get_error",
        component: "repertoire",
        message: `no credential found for domain "${domain}"`,
        meta: { domain, field, reason: `no credential found for domain "${domain}"` },
      })
      throw new Error(`no credential found for domain "${domain}"`)
    }

    const value = (stored as unknown as Record<string, unknown>)[field]
    if (value === undefined || value === null) {
      emitNervesEvent({
        level: "error",
        event: "repertoire.credential_get_error",
        component: "repertoire",
        message: `field "${field}" not found for domain "${domain}"`,
        meta: { domain, field, reason: `field "${field}" not found for domain "${domain}"` },
      })
      throw new Error(`field "${field}" not found for domain "${domain}"`)
    }

    return String(value)
  }

  async store(
    domain: string,
    data: { username?: string; password: string; notes?: string },
  ): Promise<void> {
    emitNervesEvent({
      event: "repertoire.credential_store_start",
      component: "repertoire",
      message: `storing credential for ${domain}`,
      meta: { domain },
    })

    this.ensureDirs()
    const key = this.getOrCreateKey()

    const credential: StoredCredential = {
      domain,
      username: data.username,
      password: data.password,
      notes: data.notes,
      createdAt: new Date().toISOString(),
    }

    const plaintext = JSON.stringify(credential)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()])
    const tag = cipher.getAuthTag()

    const payload: EncryptedPayload = {
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: encrypted.toString("hex"),
    }

    const slug = domainToSlug(domain)
    const encPath = path.join(this.vaultDir, `${slug}.enc`)
    fs.writeFileSync(encPath, JSON.stringify(payload), "utf-8")

    emitNervesEvent({
      event: "repertoire.credential_store_end",
      component: "repertoire",
      message: `credential stored for ${domain}`,
      meta: { domain },
    })
  }

  async list(): Promise<CredentialMeta[]> {
    emitNervesEvent({
      event: "repertoire.credential_list_start",
      component: "repertoire",
      message: "listing credentials",
      meta: {},
    })

    if (!fs.existsSync(this.vaultDir)) {
      emitNervesEvent({
        event: "repertoire.credential_list_end",
        component: "repertoire",
        message: "credential list complete (no vault dir)",
        meta: { count: 0 },
      })
      return []
    }

    const files = fs.readdirSync(this.vaultDir).filter((f) => f.endsWith(".enc"))
    const results: CredentialMeta[] = []

    for (const file of files) {
      const slug = file.replace(/\.enc$/, "")
      let stored: StoredCredential | null = null
      try {
        stored = this.readEncryptedBySlug(slug)
      } catch {
        // Skip corrupt/unreadable files
      }
      if (stored) {
        results.push({
          domain: stored.domain,
          username: stored.username,
          notes: stored.notes,
          createdAt: stored.createdAt,
        })
      }
    }

    emitNervesEvent({
      event: "repertoire.credential_list_end",
      component: "repertoire",
      message: "credential list complete",
      meta: { count: results.length },
    })

    return results
  }

  async delete(domain: string): Promise<boolean> {
    emitNervesEvent({
      event: "repertoire.credential_delete_start",
      component: "repertoire",
      message: `deleting credential for ${domain}`,
      meta: { domain },
    })

    const slug = domainToSlug(domain)
    const encPath = path.join(this.vaultDir, `${slug}.enc`)

    if (!fs.existsSync(encPath)) {
      emitNervesEvent({
        event: "repertoire.credential_delete_end",
        component: "repertoire",
        message: `no credential to delete for ${domain}`,
        meta: { domain, deleted: false },
      })
      return false
    }

    fs.unlinkSync(encPath)

    emitNervesEvent({
      event: "repertoire.credential_delete_end",
      component: "repertoire",
      message: `credential deleted for ${domain}`,
      meta: { domain, deleted: true },
    })

    return true
  }

  // --- Private ---

  private ensureDirs(): void {
    if (!fs.existsSync(this.vaultDir)) {
      fs.mkdirSync(this.vaultDir, { recursive: true })
    }
    const keyDir = path.dirname(this.keyPath)
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 })
    }
  }

  private getOrCreateKey(): Buffer {
    if (this.masterKey) return this.masterKey

    if (fs.existsSync(this.keyPath)) {
      this.masterKey = fs.readFileSync(this.keyPath)
      return this.masterKey
    }

    // Generate new 256-bit key
    const key = crypto.randomBytes(32)
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 })
    this.masterKey = key
    return key
  }

  private readEncrypted(domain: string): StoredCredential | null {
    return this.readEncryptedBySlug(domainToSlug(domain))
  }

  private readEncryptedBySlug(slug: string): StoredCredential | null {
    const encPath = path.join(this.vaultDir, `${slug}.enc`)
    if (!fs.existsSync(encPath)) return null

    const key = this.getOrCreateKey()
    const raw = fs.readFileSync(encPath, "utf-8")
    const payload: EncryptedPayload = JSON.parse(raw)

    const iv = Buffer.from(payload.iv, "hex")
    const tag = Buffer.from(payload.tag, "hex")
    const encrypted = Buffer.from(payload.data, "hex")

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

    return JSON.parse(decrypted.toString("utf-8")) as StoredCredential
  }
}

// ---------------------------------------------------------------------------
// AacCredentialStore — delegates to `aac` CLI
// ---------------------------------------------------------------------------

function execAac(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb("aac", args, { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        reject(new Error(`aac CLI error: ${err.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

export class AacCredentialStore implements CredentialStore {
  private aacAvailable: boolean | null = null

  isReady(): boolean {
    // Synchronous check — returns last-known state or false if unchecked
    return this.aacAvailable === true
  }

  async checkReady(): Promise<boolean> {
    try {
      const stdout = await execAac(["connections", "list"])
      const parsed = JSON.parse(stdout)
      this.aacAvailable = Array.isArray(parsed) && parsed.length > 0
    } catch {
      this.aacAvailable = false
    }
    return this.aacAvailable
  }

  async get(domain: string): Promise<CredentialMeta | null> {
    emitNervesEvent({
      event: "repertoire.credential_get_start",
      component: "repertoire",
      message: `getting credential via aac for ${domain}`,
      meta: { domain, backend: "aac" },
    })

    try {
      const stdout = await execAac(["--domain", domain, "--output", "json"])
      const parsed = JSON.parse(stdout)
      if (!parsed.success) {
        emitNervesEvent({
          event: "repertoire.credential_get_end",
          component: "repertoire",
          message: `no aac credential for ${domain}`,
          meta: { domain, found: false, backend: "aac" },
        })
        return null
      }

      const cred = parsed.credential
      emitNervesEvent({
        event: "repertoire.credential_get_end",
        component: "repertoire",
        message: `aac credential found for ${domain}`,
        meta: { domain, found: true, backend: "aac" },
      })

      return {
        domain,
        username: cred.username,
        notes: cred.notes,
        createdAt: cred.createdAt ?? new Date().toISOString(),
      }
    } catch {
      emitNervesEvent({
        event: "repertoire.credential_get_end",
        component: "repertoire",
        message: `aac credential lookup failed for ${domain}`,
        meta: { domain, found: false, backend: "aac" },
      })
      return null
    }
  }

  async getRawSecret(domain: string, field: string): Promise<string> {
    const stdout = await execAac(["--domain", domain, "--output", "json"])
    const parsed = JSON.parse(stdout)
    if (!parsed.success) {
      throw new Error(`aac lookup failed for domain "${domain}": ${parsed.error ?? "unknown error"}`)
    }

    const value = parsed.credential[field]
    if (value === undefined || value === null) {
      throw new Error(`field "${field}" not found for domain "${domain}"`)
    }

    return String(value)
  }

  async store(
    _domain: string,
    _data: { username?: string; password: string; notes?: string },
  ): Promise<void> {
    throw new Error(
      "store() is not supported in aac mode — aac is read-from-vault only. " +
      "Use BuiltInCredentialStore for agent-owned credentials, or manage vault items " +
      "directly in Bitwarden.",
    )
  }

  async list(): Promise<CredentialMeta[]> {
    emitNervesEvent({
      event: "repertoire.credential_list_start",
      component: "repertoire",
      message: "listing aac connections",
      meta: { backend: "aac" },
    })

    try {
      const stdout = await execAac(["connections", "list"])
      const parsed = JSON.parse(stdout)

      const results: CredentialMeta[] = (Array.isArray(parsed) ? parsed : []).map(
        (item: Record<string, unknown>) => ({
          domain: String(item.domain ?? ""),
          username: item.username ? String(item.username) : undefined,
          notes: item.notes ? String(item.notes) : undefined,
          createdAt: item.createdAt ? String(item.createdAt) : new Date().toISOString(),
        }),
      )

      emitNervesEvent({
        event: "repertoire.credential_list_end",
        component: "repertoire",
        message: "aac connections listed",
        meta: { backend: "aac", count: results.length },
      })

      return results
    } catch {
      emitNervesEvent({
        event: "repertoire.credential_list_end",
        component: "repertoire",
        message: "aac connections list failed",
        meta: { backend: "aac", count: 0 },
      })
      return []
    }
  }

  async delete(_domain: string): Promise<boolean> {
    throw new Error(
      "delete() is not supported in aac mode — manage vault items directly in Bitwarden.",
    )
  }
}

// ---------------------------------------------------------------------------
// Singleton + auto-detection
// ---------------------------------------------------------------------------

let _store: CredentialStore | null = null

/**
 * Auto-add vault defaults to agent.json when no vault section exists.
 * Returns the vault config (either existing or freshly written defaults).
 */
export function ensureVaultDefaults(
  agentName: string,
  agentRoot: string,
  existingVault: { email: string; serverUrl?: string } | undefined,
): { email: string; serverUrl?: string } | undefined {
  if (existingVault) {
    return existingVault
  }

  const configPath = path.join(agentRoot, "agent.json")
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  } catch {
    // agent.json unreadable — cannot auto-configure
    return undefined
  }

  const defaults = {
    email: `${agentName}@ouro.bot`,
    serverUrl: "https://vault.ouro.bot",
  }

  raw.vault = defaults
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8")

  emitNervesEvent({
    event: "repertoire.vault_defaults_auto_configured",
    component: "repertoire",
    message: "auto-configured vault defaults in agent.json",
    meta: { agentName, email: defaults.email, serverUrl: defaults.serverUrl },
  })

  return defaults
}

/**
 * Get the credential store singleton.
 *
 * Priority:
 *   1. BitwardenCredentialStore — if vault config exists in agent.json + secrets.json
 *   2. BuiltInCredentialStore — fallback for agents without a vault (local-only, encrypted files)
 *
 * Future auth providers (1Password, etc.) would be added here as additional backends.
 */
export function getCredentialStore(): CredentialStore {
  if (_store) return _store

  let agentName: string
  let backend = "built-in"
  try {
    // Dynamic import to avoid circular dependency at module level
    const identity = require("../heart/identity")
    agentName = identity.getAgentName()
    const agentRoot = identity.getAgentRoot(agentName)

    // Try to load vault config from agent.json + secrets.json
    const config = identity.loadAgentConfig?.()

    // Auto-configure vault defaults if missing
    const vaultSection = ensureVaultDefaults(agentName, agentRoot, config?.vault)
    const vaultConfig = identity.resolveVaultConfig?.(agentName, vaultSection)
    const secretsPath = identity.getAgentSecretsPath?.(agentName)
    let vaultSecrets: { masterPassword?: string } | undefined
    /* v8 ignore start -- requires real agent secrets.json + vault config + bw CLI @preserve */
    if (secretsPath) {
      try {
        const fsSync = require("fs")
        const secrets = JSON.parse(fsSync.readFileSync(secretsPath, "utf-8"))
        vaultSecrets = secrets.vault
      } catch {
        // No secrets file or no vault section — fall through to built-in
      }
    }

    const serverUrl = vaultConfig?.serverUrl
    const email = vaultConfig?.email
    const masterPassword = vaultSecrets?.masterPassword
    if (serverUrl && email && masterPassword) {
      const { BitwardenCredentialStore } = require("./bitwarden-store")
      _store = new BitwardenCredentialStore(serverUrl, email, masterPassword)
      backend = "bitwarden"
    }
    /* v8 ignore stop */
  } catch {
    agentName = "default"
  }

  /* v8 ignore next -- false branch only reachable when BitwardenCredentialStore was created above @preserve */
  if (!_store) {
    _store = new BuiltInCredentialStore(agentName!)
  }

  emitNervesEvent({
    event: "repertoire.credential_store_init",
    component: "repertoire",
    message: "credential store initialized",
    meta: { backend, agentName: agentName! },
  })

  return _store
}

/** Reset the singleton — for tests only. */
export function resetCredentialStore(): void {
  _store = null
}
