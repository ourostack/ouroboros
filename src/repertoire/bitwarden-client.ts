/**
 * Bitwarden vault client for credential management.
 *
 * SDK-first approach: attempts dynamic import of @bitwarden/sdk-napi,
 * falls back to `bw` CLI with --session flag.
 *
 * Raw secrets are NEVER returned to callers except via getRawSecret(),
 * which is reserved for internal use by the credential gateway (apiRequest vaultKey).
 */

import { execFile as execFileCb } from "child_process"
import { emitNervesEvent } from "../nerves/runtime"

export interface VaultItem {
  id: string
  name: string
  type: number // 1=login, 2=secure-note, 3=card, 4=identity
  notes?: string
  fields?: Array<{ name: string; value: string }>
  login?: { username?: string; uris?: Array<{ uri: string }> }
  // Raw password intentionally excluded -- credential gateway handles injection
}

export interface VaultItemHandle {
  id: string
  name: string
  type: number
}

export interface VaultConfig {
  serverUrl?: string // Self-hosted Vaultwarden URL, or omit for cloud
  accessToken: string // SDK service account token or session key for CLI
  mode?: "sdk" | "cli" // Auto-detected if omitted: try SDK first, fall back to CLI
}

interface RawVaultItem {
  id: string
  name: string
  type: number
  notes?: string
  fields?: Array<{ name: string; value: string }>
  login?: {
    username?: string
    password?: string
    uris?: Array<{ uri: string }>
  }
}

export class BitwardenClient {
  private sessionKey: string | null = null
  private connected = false
  private clientMode: "sdk" | "cli" | null = null

  async connect(config: VaultConfig): Promise<void> {
    emitNervesEvent({
      event: "client.vault_connect_start",
      component: "clients",
      message: "connecting to Bitwarden vault",
      meta: { mode: config.mode ?? "auto" },
    })

    try {
      if (config.mode === "cli") {
        await this.connectCli(config)
      } else {
        // Try SDK first, fall back to CLI
        try {
          await this.connectSdk(config)
        } catch {
          emitNervesEvent({
            event: "client.vault_sdk_fallback",
            component: "clients",
            message: "SDK not available, falling back to bw CLI",
            meta: {},
          })
          await this.connectCli(config)
        }
      }

      emitNervesEvent({
        event: "client.vault_connect_end",
        component: "clients",
        message: "connected to Bitwarden vault",
        meta: { mode: this.clientMode },
      })
    } catch (err) {
      emitNervesEvent({
        level: "error",
        event: "client.vault_connect_error",
        component: "clients",
        message: "failed to connect to Bitwarden vault",
        meta: { reason: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.sessionKey = null
    this.connected = false
    this.clientMode = null

    emitNervesEvent({
      event: "client.vault_disconnect",
      component: "clients",
      message: "disconnected from Bitwarden vault",
      meta: {},
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  async getItem(id: string): Promise<VaultItem> {
    this.requireConnected()
    return this.withNervesEvents("getItem", { id }, async () => {
      const raw = await this.fetchRawItem(id)
      return this.stripSecrets(raw)
    })
  }

  async createItem(name: string, fields: Record<string, string>): Promise<VaultItemHandle> {
    this.requireConnected()
    return this.withNervesEvents("createItem", { name }, async () => {
      const itemFields = Object.entries(fields).map(([k, v]) => ({
        name: k,
        value: v,
        type: 0, // text type
      }))

      const itemTemplate = {
        type: 1, // login type
        name,
        fields: itemFields,
        login: {},
      }

      const encoded = Buffer.from(JSON.stringify(itemTemplate)).toString("base64")
      const stdout = await this.execCli(["create", "item", encoded])
      const parsed = this.parseCliResponse(stdout)
      return { id: parsed.id, name: parsed.name, type: parsed.type }
    })
  }

  async listItems(search?: string): Promise<VaultItemHandle[]> {
    this.requireConnected()
    return this.withNervesEvents("listItems", { search }, async () => {
      const args = ["list", "items"]
      if (search) {
        args.push("--search", search)
      }
      const stdout = await this.execCli(args)
      const parsed = this.parseCliResponse(stdout)
      const items: RawVaultItem[] = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : [])
      return items.map((item) => ({ id: item.id, name: item.name, type: item.type }))
    })
  }

  async deleteItem(id: string): Promise<void> {
    this.requireConnected()
    return this.withNervesEvents("deleteItem", { id }, async () => {
      await this.execCli(["delete", "item", id])
    })
  }

  /**
   * Internal: used by credential gateway (PR 5) to get raw secret for HTTP injection.
   * NOT exposed via tools -- only called by apiRequest() internally.
   */
  async getRawSecret(itemId: string, fieldName: string): Promise<string> {
    this.requireConnected()
    return this.withNervesEvents("getRawSecret", { itemId, fieldName }, async () => {
      const raw = await this.fetchRawItem(itemId)

      // Check custom fields first
      if (raw.fields) {
        const field = raw.fields.find((f) => f.name === fieldName)
        if (field) return field.value
      }

      // Check login.password
      if (fieldName === "password" && raw.login?.password) {
        return raw.login.password
      }

      throw new Error(`field "${fieldName}" not found on vault item "${itemId}"`)
    })
  }

  // --- Private methods ---

  private requireConnected(): void {
    if (!this.connected) {
      throw new Error("vault not connected -- call connect() first")
    }
  }

  private async withNervesEvents<T>(
    operation: string,
    meta: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    emitNervesEvent({
      event: "client.request_start",
      component: "clients",
      message: `vault ${operation} starting`,
      meta: { operation, ...meta },
    })

    try {
      const result = await fn()
      emitNervesEvent({
        event: "client.request_end",
        component: "clients",
        message: `vault ${operation} complete`,
        meta: { operation, ...meta },
      })
      return result
    } catch (err) {
      emitNervesEvent({
        level: "error",
        event: "client.error",
        component: "clients",
        message: `vault ${operation} failed`,
        meta: { operation, reason: err instanceof Error ? err.message : String(err), ...meta },
      })
      throw err
    }
  }

  private async connectSdk(_config: VaultConfig): Promise<void> {
    // Attempt dynamic import of SDK
    // This will throw if the package is not installed
    const sdk = await import("@bitwarden/sdk-napi" as string)
    const client = new sdk.BitwardenClient(
      { apiUrl: _config.serverUrl ?? "https://api.bitwarden.com" },
      0, // LogLevel.Info
    )
    await client.auth().loginAccessToken(_config.accessToken, "")
    this.connected = true
    this.clientMode = "sdk"
  }

  private async connectCli(config: VaultConfig): Promise<void> {
    this.sessionKey = config.accessToken
    // Verify CLI is available and session key works
    await this.execCli(["status"])
    this.connected = true
    this.clientMode = "cli"
  }

  private async fetchRawItem(id: string): Promise<RawVaultItem> {
    const stdout = await this.execCli(["get", "item", id])
    const parsed = this.parseCliResponse(stdout)
    return parsed as RawVaultItem
  }

  private stripSecrets(raw: RawVaultItem): VaultItem {
    const item: VaultItem = {
      id: raw.id,
      name: raw.name,
      type: raw.type,
    }
    if (raw.notes) item.notes = raw.notes
    if (raw.fields) item.fields = raw.fields
    if (raw.login) {
      item.login = {}
      if (raw.login.username) item.login.username = raw.login.username
      if (raw.login.uris) item.login.uris = raw.login.uris
      // password intentionally NOT copied
    }
    return item
  }

  private parseCliResponse(stdout: string): any {
    const parsed = JSON.parse(stdout)
    // bw CLI with --response wraps in { success, data }
    if (parsed.success !== undefined && parsed.data !== undefined) {
      return parsed.data
    }
    return parsed
  }

  private execCli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullArgs = [...args, "--session", this.sessionKey!, "--response"]
      execFileCb("bw", fullArgs, { timeout: 30_000 }, (err, stdout, _stderr) => {
        if (err) {
          reject(new Error(`bw CLI error: ${err.message}`))
          return
        }
        resolve(stdout)
      })
    })
  }
}

// Singleton accessor
let _client: BitwardenClient | null = null

export function getBitwardenClient(): BitwardenClient {
  if (!_client) {
    _client = new BitwardenClient()
  }
  return _client
}

export function resetBitwardenClient(): void {
  _client = null
}
