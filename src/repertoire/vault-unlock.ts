import { spawnSync as defaultSpawnSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

export type VaultUnlockStoreKind =
  | "auto"
  | "macos-keychain"
  | "windows-dpapi"
  | "linux-secret-service"
  | "plaintext-file"

export interface VaultUnlockConfig {
  agentName?: string
  email: string
  serverUrl: string
}

export interface VaultUnlockDeps {
  platform?: NodeJS.Platform
  spawnSync?: typeof defaultSpawnSync
  homeDir?: string
  store?: VaultUnlockStoreKind
}

export interface VaultUnlockStoreSelection {
  kind: Exclude<VaultUnlockStoreKind, "auto">
  secure: boolean
  location: string
}

export interface VaultUnlockReadResult {
  secret: string
  store: VaultUnlockStoreSelection
}

export interface VaultUnlockStatus {
  configured: boolean
  stored: boolean
  store?: VaultUnlockStoreSelection
  error?: string
  fix: string
}

const VAULT_UNLOCK_SERVICE = "ouro.vault"
const PLAINTEXT_UNLOCK_DIR = path.join(".ouro-cli", "vault-unlock")
const WINDOWS_DPAPI_UNLOCK_DIR = path.join(".ouro-cli", "vault-unlock-dpapi")
const SUPPORTED_STORES: VaultUnlockStoreKind[] = ["auto", "macos-keychain", "windows-dpapi", "linux-secret-service", "plaintext-file"]

function platform(deps: VaultUnlockDeps): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function spawnSync(deps: VaultUnlockDeps): typeof defaultSpawnSync {
  return deps.spawnSync ?? defaultSpawnSync
}

function homeDir(deps: VaultUnlockDeps): string {
  return deps.homeDir ?? os.homedir()
}

function vaultKey(config: VaultUnlockConfig): string {
  return `${config.serverUrl}:${config.email}`
}

function vaultLabel(config: VaultUnlockConfig): string {
  return `${config.email} at ${config.serverUrl}`
}

function plaintextUnlockPath(config: VaultUnlockConfig, deps: VaultUnlockDeps): string {
  const digest = crypto.createHash("sha256").update(vaultKey(config)).digest("hex").slice(0, 24)
  return path.join(homeDir(deps), PLAINTEXT_UNLOCK_DIR, `${digest}.secret`)
}

function windowsDpapiUnlockPath(config: VaultUnlockConfig, deps: VaultUnlockDeps): string {
  const digest = crypto.createHash("sha256").update(vaultKey(config)).digest("hex").slice(0, 24)
  const localAppData = process.env.LOCALAPPDATA
  const baseDir = localAppData && platform(deps) === "win32"
    ? path.join(localAppData, "Ouro")
    : path.join(homeDir(deps), WINDOWS_DPAPI_UNLOCK_DIR)
  return path.join(baseDir, "vault-unlock", `${digest}.dpapi`)
}

function commandExists(command: string, deps: VaultUnlockDeps): boolean {
  const result = spawnSync(deps)(command, ["--version"], { encoding: "utf8" })
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  return code !== "ENOENT"
}

function missingSecureStoreMessage(config: VaultUnlockConfig): string {
  const agentPart = config.agentName ? ` for ${config.agentName}` : ""
  return [
    `No supported secure local secret store was found on this machine${agentPart}.`,
    "",
    `Ouro knows the credential vault is ${vaultLabel(config)}, but it cannot cache the vault unlock secret here yet.`,
    "",
    "On macOS, Ouro uses Keychain automatically.",
    "On Windows, Ouro uses a CurrentUser DPAPI-encrypted local file automatically.",
    "On Linux/WSL, install and configure Secret Service/libsecret, or choose the explicit plaintext fallback on a trusted machine.",
    "",
    config.agentName
      ? `Run \`ouro vault unlock --agent ${config.agentName} --store plaintext-file\` to store the vault unlock secret in a chmod 0600 local file.`
      : "Run `ouro vault unlock --store plaintext-file` to store the vault unlock secret in a chmod 0600 local file.",
  ].join("\n")
}

function lockedMessage(config: VaultUnlockConfig, store: VaultUnlockStoreSelection): string {
  const agentPart = config.agentName ? ` for ${config.agentName}` : ""
  const command = config.agentName
    ? `ouro vault unlock --agent ${config.agentName}${store.kind === "plaintext-file" ? " --store plaintext-file" : ""}`
    : `ouro vault unlock${store.kind === "plaintext-file" ? " --store plaintext-file" : ""}`
  return [
    `Ouro credential vault is locked on this machine${agentPart}.`,
    "",
    `Vault: ${vaultLabel(config)}`,
    `Local unlock store: ${store.kind} (${store.location})`,
    "",
    "Provider credentials are still stored in the agent vault.",
    "This computer does not currently have usable local unlock material for that vault.",
    "This can happen on a new computer, after a local profile or hostname migration, or if the local unlock entry was removed.",
	    "",
	    `Run \`${command}\` and enter the saved agent vault unlock secret from the human/operator who controls that vault.`,
	    config.agentName
	      ? `If nobody saved that unlock secret, run \`ouro vault recover --agent ${config.agentName} --from <json>\` with a local credential export, or create a replacement vault and re-enter credentials.`
	      : "If nobody saved that unlock secret, run `ouro vault recover --agent <agent> --from <json>` with a local credential export, or create a replacement vault and re-enter credentials.",
	  ].join("\n")
	}

function validateStoreKind(store: VaultUnlockStoreKind | undefined): VaultUnlockStoreKind {
  const requested = store ?? "auto"
  if (!SUPPORTED_STORES.includes(requested)) {
    throw new Error(`unknown vault unlock store '${requested}'. Use auto|macos-keychain|windows-dpapi|linux-secret-service|plaintext-file.`)
  }
  return requested
}

export function resolveVaultUnlockStore(
  config: VaultUnlockConfig,
  deps: VaultUnlockDeps = {},
): VaultUnlockStoreSelection {
  const requested = validateStoreKind(deps.store)
  const currentPlatform = platform(deps)

  if (requested === "macos-keychain") {
    if (currentPlatform !== "darwin") {
      throw new Error(`macos-keychain unlock store is only available on macOS; this machine is ${currentPlatform}.`)
    }
    return { kind: "macos-keychain", secure: true, location: "macOS Keychain" }
  }

  if (requested === "linux-secret-service") {
    if (currentPlatform !== "linux") {
      throw new Error(`linux-secret-service unlock store is only available on Linux/WSL; this machine is ${currentPlatform}.`)
    }
    if (!commandExists("secret-tool", deps)) {
      throw new Error("linux-secret-service unlock store requires the `secret-tool` command from libsecret.")
    }
    return { kind: "linux-secret-service", secure: true, location: "Secret Service via secret-tool" }
  }

  if (requested === "windows-dpapi") {
    if (currentPlatform !== "win32") {
      throw new Error(`windows-dpapi unlock store is only available on Windows; this machine is ${currentPlatform}.`)
    }
    return { kind: "windows-dpapi", secure: true, location: windowsDpapiUnlockPath(config, deps) }
  }

  if (requested === "plaintext-file") {
    return { kind: "plaintext-file", secure: false, location: plaintextUnlockPath(config, deps) }
  }

  if (currentPlatform === "darwin") {
    return { kind: "macos-keychain", secure: true, location: "macOS Keychain" }
  }

  if (currentPlatform === "win32") {
    return { kind: "windows-dpapi", secure: true, location: windowsDpapiUnlockPath(config, deps) }
  }

  if (currentPlatform === "linux" && commandExists("secret-tool", deps)) {
    return { kind: "linux-secret-service", secure: true, location: "Secret Service via secret-tool" }
  }

  throw new Error(missingSecureStoreMessage(config))
}

function readFromMacosKeychain(config: VaultUnlockConfig, deps: VaultUnlockDeps): string | null {
  const result = spawnSync(deps)("security", [
    "find-generic-password",
    "-s",
    VAULT_UNLOCK_SERVICE,
    "-a",
    vaultKey(config),
    "-w",
  ], { encoding: "utf8" })

  const secret = typeof result.stdout === "string" ? result.stdout.trim() : ""
  return result.status === 0 && secret ? secret : null
}

function writeToMacosKeychain(config: VaultUnlockConfig, secret: string, deps: VaultUnlockDeps): void {
  const result = spawnSync(deps)("security", [
    "add-generic-password",
    "-U",
    "-s",
    VAULT_UNLOCK_SERVICE,
    "-a",
    vaultKey(config),
    "-w",
    secret,
  ], { encoding: "utf8" })

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    throw new Error(`failed to store vault unlock secret in macOS Keychain${stderr ? `: ${stderr}` : ""}`)
  }
}

function readFromLinuxSecretService(config: VaultUnlockConfig, deps: VaultUnlockDeps): string | null {
  const result = spawnSync(deps)("secret-tool", [
    "lookup",
    "service",
    VAULT_UNLOCK_SERVICE,
    "account",
    vaultKey(config),
  ], { encoding: "utf8" })

  const secret = typeof result.stdout === "string" ? result.stdout.trim() : ""
  return result.status === 0 && secret ? secret : null
}

function writeToLinuxSecretService(config: VaultUnlockConfig, secret: string, deps: VaultUnlockDeps): void {
  const result = spawnSync(deps)("secret-tool", [
    "store",
    "--label",
    `Ouro credential vault ${vaultLabel(config)}`,
    "service",
    VAULT_UNLOCK_SERVICE,
    "account",
    vaultKey(config),
  ], { encoding: "utf8", input: secret })

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    throw new Error(`failed to store vault unlock secret in Linux Secret Service${stderr ? `: ${stderr}` : ""}`)
  }
}

function runWindowsDpapi(
  mode: "protect" | "unprotect",
  payload: Record<string, string>,
  deps: VaultUnlockDeps,
): string {
  const script = `
$ErrorActionPreference = "Stop"
$inputJson = [Console]::In.ReadToEnd()
$payload = $inputJson | ConvertFrom-Json
Add-Type -AssemblyName System.Security
if ($payload.mode -eq "protect") {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$payload.secret)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} elseif ($payload.mode -eq "unprotect") {
  $protected = [Convert]::FromBase64String([string]$payload.ciphertext)
  $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} else {
  throw "unknown DPAPI mode"
}
`
  const result = spawnSync(deps)("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], {
    encoding: "utf8",
    input: JSON.stringify({ mode, ...payload }),
  })
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : ""
    const error = result.error instanceof Error ? result.error.message : stderr
    throw new Error(`Windows DPAPI ${mode} failed${error ? `: ${error}` : ""}`)
  }
  return typeof result.stdout === "string" ? result.stdout : ""
}

function readFromWindowsDpapi(config: VaultUnlockConfig, deps: VaultUnlockDeps): string | null {
  const filePath = windowsDpapiUnlockPath(config, deps)
  if (!fs.existsSync(filePath)) return null
  const ciphertext = fs.readFileSync(filePath, "utf8").trim()
  if (!ciphertext) return null
  const secret = runWindowsDpapi("unprotect", { ciphertext }, deps).trim()
  return secret || null
}

function writeToWindowsDpapi(config: VaultUnlockConfig, secret: string, deps: VaultUnlockDeps): void {
  const filePath = windowsDpapiUnlockPath(config, deps)
  const ciphertext = runWindowsDpapi("protect", { secret }, deps).trim()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${ciphertext}\n`, "utf8")
}

function readFromPlaintextFile(config: VaultUnlockConfig, deps: VaultUnlockDeps): string | null {
  const filePath = plaintextUnlockPath(config, deps)
  if (!fs.existsSync(filePath)) return null

  if (platform(deps) !== "win32") {
    const mode = fs.statSync(filePath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new Error(`refusing to read plaintext vault unlock file at ${filePath} because permissions are too broad; run chmod 600 ${filePath}`)
    }
  }

  const secret = fs.readFileSync(filePath, "utf8").trim()
  return secret || null
}

function writeToPlaintextFile(config: VaultUnlockConfig, secret: string, deps: VaultUnlockDeps): void {
  const filePath = plaintextUnlockPath(config, deps)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, secret, { encoding: "utf8", mode: 0o600 })
  if (platform(deps) !== "win32") {
    fs.chmodSync(path.dirname(filePath), 0o700)
    fs.chmodSync(filePath, 0o600)
  }
}

function readFromStore(
  config: VaultUnlockConfig,
  store: VaultUnlockStoreSelection,
  deps: VaultUnlockDeps,
): string | null {
  if (store.kind === "macos-keychain") return readFromMacosKeychain(config, deps)
  if (store.kind === "windows-dpapi") return readFromWindowsDpapi(config, deps)
  if (store.kind === "linux-secret-service") return readFromLinuxSecretService(config, deps)
  return readFromPlaintextFile(config, deps)
}

function writeToStore(
  config: VaultUnlockConfig,
  store: VaultUnlockStoreSelection,
  secret: string,
  deps: VaultUnlockDeps,
): void {
  if (store.kind === "macos-keychain") {
    writeToMacosKeychain(config, secret, deps)
    return
  }
  if (store.kind === "linux-secret-service") {
    writeToLinuxSecretService(config, secret, deps)
    return
  }
  if (store.kind === "windows-dpapi") {
    writeToWindowsDpapi(config, secret, deps)
    return
  }
  writeToPlaintextFile(config, secret, deps)
}

export function readVaultUnlockSecret(
  config: VaultUnlockConfig,
  deps: VaultUnlockDeps = {},
): VaultUnlockReadResult {
  const store = resolveVaultUnlockStore(config, deps)
  const secret = readFromStore(config, store, deps)
  if (!secret) {
    throw new Error(lockedMessage(config, store))
  }

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.vault_unlock_loaded",
    message: "loaded vault unlock material from local store",
    meta: { store: store.kind, secure: store.secure, hasAgentName: !!config.agentName },
  })
  return { secret, store }
}

export function storeVaultUnlockSecret(
  config: VaultUnlockConfig,
  secret: string,
  deps: VaultUnlockDeps = {},
): VaultUnlockStoreSelection {
  const trimmed = secret.trim()
  if (!trimmed) {
    throw new Error("vault unlock secret is required")
  }

  const store = resolveVaultUnlockStore(config, deps)
  writeToStore(config, store, trimmed, deps)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.vault_unlock_stored",
    message: "stored vault unlock material in local store",
    meta: { store: store.kind, secure: store.secure, hasAgentName: !!config.agentName },
  })
  return store
}

export function getVaultUnlockStatus(
  config: VaultUnlockConfig,
  deps: VaultUnlockDeps = {},
): VaultUnlockStatus {
  try {
    const store = resolveVaultUnlockStore(config, deps)
    const stored = !!readFromStore(config, store, deps)
    return {
      configured: true,
      stored,
      store,
      fix: stored
        ? "Vault unlock secret is available on this machine."
        : lockedMessage(config, store),
    }
  } catch (error) {
    return {
      configured: false,
      stored: false,
      error: error instanceof Error ? error.message : String(error),
      fix: error instanceof Error ? error.message : String(error),
    }
  }
}
