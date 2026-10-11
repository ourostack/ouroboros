/**
 * Credential access layer.
 *
 * Bitwarden/Vaultwarden is the sole runtime credential store. The only local
 * secret is the vault unlock material held by an explicit local unlock store.
 *
 * Each agent owns one credential vault. getCredentialStore() returns that
 * agent's vault directly; item names are not shared or namespaced across
 * agents.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import * as identity from "../heart/identity"
import { BitwardenCredentialStore } from "./bitwarden-store"
import {
  credentialVaultNotConfiguredError,
  noteVaultUnlockSelfHeal,
  readVaultUnlockSecret,
  storeVaultUnlockSecret,
} from "./vault-unlock"

export interface CredentialMeta {
  domain: string
  username?: string
  notes?: string
  createdAt: string
}

export interface CredentialStore {
  get(domain: string): Promise<CredentialMeta | null>
  /** INTERNAL ONLY — used by credential gateways to inject secrets into requests. */
  getRawSecret(domain: string, field: string): Promise<string>
  store(domain: string, data: { username?: string; password: string; notes?: string }): Promise<void>
  list(): Promise<CredentialMeta[]>
  delete(domain: string): Promise<boolean>
  isReady(): boolean
}

let stores = new Map<string, CredentialStore>()
let rejectedUnlocks = new Map<string, { fingerprint: string; reason: string }>()

function fingerprintUnlockSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex")
}

function rejectedUnlockMessage(agentName: string, reason: string): string {
  return [
    `The vault rejected the unlock secret saved on this machine for ${agentName} (${reason}).`,
    "The saved secret was kept. If the vault's unlock secret changed, run",
    `\`ouro vault unlock --agent ${agentName}\` once with the current secret.`,
  ].join(" ")
}

function loadVaultSectionForAgent(agentName: string): {
  configPath: string
  vault?: identity.AgentConfig["vault"]
} {
  const configPath = path.join(identity.getAgentRoot(agentName), "agent.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<identity.AgentConfig>
    return { configPath, vault: parsed.vault }
  } catch {
    return { configPath }
  }
}

function bitwardenAppDataDir(agentName: string, vaultConfig: { serverUrl: string; email: string }, homeDir = os.homedir()): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${agentName}:${vaultConfig.serverUrl}:${vaultConfig.email}`)
    .digest("hex")
    .slice(0, 24)
  return path.join(homeDir, ".ouro-cli", "bitwarden", digest)
}

export function getCredentialStore(agentNameInput?: string): CredentialStore {
  const agentName = agentNameInput ?? identity.getAgentName()
  if (agentName === "SerpentGuide") {
    throw new Error("SerpentGuide does not have a persistent credential vault; hatch bootstrap uses provider credentials in memory only.")
  }
  const { configPath, vault } = loadVaultSectionForAgent(agentName)
  if (!vault || typeof vault.email !== "string" || vault.email.trim().length === 0) {
    throw new Error(credentialVaultNotConfiguredError(agentName, configPath))
  }
  const vaultConfig = identity.resolveVaultConfig(agentName, vault)
  const cacheKey = `${agentName}:${vaultConfig.serverUrl}:${vaultConfig.email}`
  const cached = stores.get(cacheKey)
  if (cached) return cached

  const unlock = readVaultUnlockSecret({
    agentName,
    email: vaultConfig.email,
    serverUrl: vaultConfig.serverUrl,
  })
  const unlockConfig = { agentName, email: vaultConfig.email, serverUrl: vaultConfig.serverUrl }
  const unlockSource = unlock.source ?? unlockConfig
  const unlockFingerprint = fingerprintUnlockSecret(unlock.secret)
  const rejection = rejectedUnlocks.get(cacheKey)
  if (rejection && rejection.fingerprint === unlockFingerprint) {
    throw new Error(rejectedUnlockMessage(agentName, rejection.reason))
  }
  rejectedUnlocks.delete(cacheKey)
  let canonicalUnlockStored = false
  const store = new BitwardenCredentialStore(
    vaultConfig.serverUrl,
    vaultConfig.email,
    unlock.secret,
    {
      appDataDir: bitwardenAppDataDir(agentName, vaultConfig),
      onInvalidUnlockSecret: (error) => {
        // The vault server rejected the saved secret on a fresh bw profile.
        // Keep the saved secret: deleting the only durable copy turns any
        // misclassified bw or server error into a human prompt. Remember the
        // rejection in memory so this process does not retry the same secret
        // against the server; a new secret from `ouro vault unlock` clears it.
        rejectedUnlocks.set(cacheKey, { fingerprint: unlockFingerprint, reason: error.message })
        stores.delete(cacheKey)
        emitNervesEvent({
          level: "warn",
          event: "repertoire.credential_store_unlock_rejected",
          component: "repertoire",
          message: "vault rejected the saved local unlock secret; kept it and paused retries in this process",
          meta: {
            agentName,
            serverUrl: vaultConfig.serverUrl,
            email: vaultConfig.email,
            sourceServerUrl: unlockSource.serverUrl,
            error: error.message,
          },
        })
      },
      onLoginSuccess: () => {
        if (canonicalUnlockStored) return
        if (unlockSource.serverUrl === vaultConfig.serverUrl && unlockSource.email === vaultConfig.email) return
        canonicalUnlockStored = true
        try {
          storeVaultUnlockSecret(unlockConfig, unlock.secret)
          noteVaultUnlockSelfHeal(unlockConfig, unlock.store.kind, unlockSource.serverUrl)
        } catch (error) {
          emitNervesEvent({
            level: "warn",
            event: "repertoire.vault_unlock_self_heal_failed",
            component: "repertoire",
            message: "failed to rewrite local unlock material using canonical vault coordinates",
            meta: {
              store: unlock.store.kind,
              email: vaultConfig.email,
              sourceServerUrl: unlockSource.serverUrl,
              targetServerUrl: vaultConfig.serverUrl,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
      },
    },
  )
  stores.set(cacheKey, store)

  emitNervesEvent({
    event: "repertoire.credential_store_init",
    component: "repertoire",
    message: "credential store initialized",
    meta: {
      backend: "bitwarden",
      agentName,
      serverUrl: vaultConfig.serverUrl,
      email: vaultConfig.email,
    },
  })

  return store
}

export async function probeCredentialVaultAccess(
  agentNameInput: string,
  unlockSecret: string,
  options: { homeDir?: string } = {},
): Promise<void> {
  const agentName = agentNameInput
  const { configPath, vault } = loadVaultSectionForAgent(agentName)
  if (!vault || typeof vault.email !== "string" || vault.email.trim().length === 0) {
    throw new Error(credentialVaultNotConfiguredError(agentName, configPath))
  }
  const vaultConfig = identity.resolveVaultConfig(agentName, vault)
  const store = new BitwardenCredentialStore(
    vaultConfig.serverUrl,
    vaultConfig.email,
    unlockSecret,
    { appDataDir: bitwardenAppDataDir(agentName, vaultConfig, options.homeDir) },
  )
  await store.get("__ouro_vault_probe__")
}

export function resetCredentialStore(): void {
  stores = new Map()
  rejectedUnlocks = new Map()
}
