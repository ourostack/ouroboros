import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"

import { emitNervesEvent } from "../../nerves/runtime"
import { refreshMachineRuntimeCredentialConfig } from "../runtime-credentials"
import type { RuntimeCredentialConfigReadResult } from "../runtime-credentials"

type JsonObject = Record<string, unknown>

export interface SanctuaryAcceptanceKeyMetadata {
  id: string
  name: string
  permissions: Array<{ resource: string; actions: string[] }>
  roles: string[]
}

export interface SanctuaryAcceptanceAdapterDependencies {
  readKeyFiles(): SanctuaryAcceptanceKeyMetadata[]
  readDescriptor(): string
  execFile(executable: string, args: string[]): Promise<{ status: number; stdout: string }>
  fetch: typeof fetch
}

export interface SanctuaryAcceptanceVaultProbeDependencies {
  refresh(agentName: string, machineId: string): Promise<RuntimeCredentialConfigReadResult>
  fetch: typeof fetch
}

const KEY_ID = /^[A-Za-z0-9._:-]+$/u
const AUTH_PROBE = "query AcceptanceAuthProbe { info { os { hostname } } }"
const ADAPTER_TIMEOUT_MS = 15_000
const NETWORK_TIMEOUT_MS = 10_000
const KEY_DIRECTORY = "/boot/config/plugins/dynamix.my.servers/keys"
const PERMISSION_RESOURCES = new Set([
  "ACTIVATION_CODE", "API_KEY", "ARRAY", "CLOUD", "CONFIG", "CONNECT", "CONNECT__REMOTE_ACCESS",
  "CUSTOMIZATIONS", "DASHBOARD", "DISK", "DISPLAY", "DOCKER", "FLASH", "INFO", "LOGS", "ME",
  "NETWORK", "NOTIFICATIONS", "ONLINE", "OS", "OWNER", "PERMISSION", "REGISTRATION", "SERVERS",
  "SERVICES", "SHARE", "VARS", "VMS", "WELCOME",
])
const PERMISSION_ACTIONS = new Set(["CREATE_ANY", "CREATE_OWN", "READ_ANY", "READ_OWN", "UPDATE_ANY", "UPDATE_OWN", "DELETE_ANY", "DELETE_OWN"])
const RO_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => `${resource}:READ_ANY`).sort()

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`)
  return value.trim()
}

function keyId(value: unknown): string {
  const result = text(value, "keyId")
  if (!KEY_ID.test(result)) throw new Error("keyId is invalid")
  return result
}

function readKeyDirectory(keyDirectory: string): SanctuaryAcceptanceKeyMetadata[] {
  return readdirSync(keyDirectory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("unexpected key directory entry")
      return entry
    })
    .map((entry) => {
      const raw = object(JSON.parse(readFileSync(`${keyDirectory}/${entry.name}`, "utf8")) as unknown, "Unraid key file")
      const permissions = raw.permissions
      const roles = raw.roles
      if (!Array.isArray(roles) || !roles.every((item) => typeof item === "string")) throw new Error("Unraid key roles are invalid")
      return normalizeKey({ id: raw.id, name: raw.name, permissions, roles })
    })
}

async function defaultExecFile(executable: string, args: string[], timeoutMs: number): Promise<{ status: number; stdout: string }> {
  const result = spawnSync(executable, args, {
    cwd: "/",
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" },
    maxBuffer: 1_048_576,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") throw new Error("acceptance adapter subprocess timed out")
  if (result.error || result.status !== 0) throw new Error("acceptance adapter subprocess failed")
  return { status: result.status, stdout: result.stdout }
}

export function createSanctuaryAcceptanceAdapterDependencies(
  secretFd = 3,
  options: { keyDirectory?: string; adapterTimeoutMs?: number } = {},
): SanctuaryAcceptanceAdapterDependencies {
  const keyDirectory = options.keyDirectory ?? KEY_DIRECTORY
  const adapterTimeoutMs = options.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS
  return {
    readKeyFiles: () => readKeyDirectory(keyDirectory),
    readDescriptor: () => readFileSync(secretFd, "utf8"),
    execFile: (executable, args) => defaultExecFile(executable, args, adapterTimeoutMs),
    fetch,
  }
}

function normalizePermission(value: unknown): { resource: string; actions: string[] } {
  const permission = object(value, "Unraid key permission")
  if (JSON.stringify(Object.keys(permission).sort()) !== JSON.stringify(["actions", "resource"])) throw new Error("Unraid key permission fields are invalid")
  const resource = text(permission.resource, "Unraid key permission resource")
  if (!PERMISSION_RESOURCES.has(resource)) throw new Error("Unraid key permission resource is invalid")
  if (!Array.isArray(permission.actions) || permission.actions.length === 0) throw new Error("Unraid key permission actions are invalid")
  const actions = permission.actions.map((action) => text(action, "Unraid key permission action"))
  if (new Set(actions).size !== actions.length || actions.some((action) => !PERMISSION_ACTIONS.has(action))) throw new Error("Unraid key permission actions are invalid")
  return { resource, actions: [...actions].sort() }
}

function normalizeKey(value: SanctuaryAcceptanceKeyMetadata | JsonObject): SanctuaryAcceptanceKeyMetadata {
  const key = value as unknown as JsonObject
  if (!Array.isArray(key.permissions)) throw new Error("Unraid key permissions are invalid")
  if (!Array.isArray(key.roles) || !key.roles.every((role) => typeof role === "string")) throw new Error("Unraid key roles are invalid")
  return {
    id: keyId(key.id),
    name: text(key.name, "Unraid key name"),
    permissions: key.permissions.map(normalizePermission),
    roles: [...key.roles],
  }
}

function scope(key: SanctuaryAcceptanceKeyMetadata): "read-only" | "bounded-write" | "legacy-write" {
  const flattened = key.permissions.flatMap((permission) => permission.actions.map((action) => `${permission.resource}:${action}`)).sort()
  if (JSON.stringify(flattened) === JSON.stringify(RO_PERMISSIONS)) return "read-only"
  if (JSON.stringify(flattened) === JSON.stringify([...RO_PERMISSIONS, "DOCKER:UPDATE_ANY"].sort())) return "bounded-write"
  return "legacy-write"
}

function inventory(deps: SanctuaryAcceptanceAdapterDependencies): SanctuaryAcceptanceKeyMetadata[] {
  const keys = deps.readKeyFiles().map(normalizeKey)
  if (new Set(keys.map((key) => key.id)).size !== keys.length) throw new Error("Unraid key inventory contains duplicate IDs")
  if (new Set(keys.map((key) => key.name)).size !== keys.length) throw new Error("Unraid key inventory contains duplicate names")
  return keys
}

async function vaultBackedCapabilityVerify(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const id = keyId(payload.keyId)
  const capability = text(payload.capability, "capability")
  if (capability !== "read-only" && capability !== "bounded-write") throw new Error("capability is invalid")
  const args = [
    "exec", "-i", "ouro-butler-staging",
    "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    "vault-probe", id, capability,
  ]
  const result = await deps.execFile("/usr/bin/docker", args)
  const response = object(JSON.parse(result.stdout) as unknown, "vault probe result")
  if (response.valid !== true || response.keyId !== id || response.capability !== capability) throw new Error("vault-backed capability verification failed")
  return { verified: true, keyId: id, capability }
}

function closedInventory(deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  return {
    keys: inventory(deps).map((key) => ({
      id: key.id,
      scope: scope(key),
      roles: key.roles.length === 0 ? "none" : "present",
    })).sort((left, right) => left.id.localeCompare(right.id)),
  }
}

async function exactIdRevoke(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const id = keyId(payload.keyId)
  const matches = inventory(deps).filter((key) => key.id === id)
  if (matches.length !== 1) throw new Error("exact Unraid key ID is absent or ambiguous")
  const target = matches[0]!
  const result = await deps.execFile("/usr/local/sbin/unraid-api", ["apikey", "--name", target.name, "--delete", "--json"])
  const response = object(JSON.parse(result.stdout) as unknown, "Unraid revoke result")
  if (response.deleted !== 1 || !Array.isArray(response.keys) || response.keys.length !== 1) throw new Error("Unraid revoke result is invalid")
  const deleted = object(response.keys[0], "deleted Unraid key")
  if (deleted.id !== id || deleted.name !== target.name) throw new Error("Unraid revoke did not return the exact key ID")
  return { revoked: true, id }
}

async function revokedKeyAuthRejection(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const id = keyId(payload.keyId)
  const endpoint = new URL(text(payload.endpoint, "endpoint"))
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== "::1")
    || endpoint.pathname !== "/graphql" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("revoked-key probe endpoint must be an exact loopback GraphQL endpoint")
  }
  const descriptorPayload = object(JSON.parse(deps.readDescriptor()) as unknown, "revoked-key descriptor")
  if (JSON.stringify(Object.keys(descriptorPayload).sort()) !== JSON.stringify(["descriptor", "keyId"])) throw new Error("revoked-key descriptor shape is invalid")
  if (keyId(descriptorPayload.keyId) !== id) throw new Error("revoked-key descriptor ID mismatch")
  const descriptor = text(descriptorPayload.descriptor, "revoked-key descriptor value")
  const signal = AbortSignal.timeout(NETWORK_TIMEOUT_MS)
  const response = await deps.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": descriptor },
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }),
    signal,
  })
  if (response.status !== 401 && response.status !== 403) throw new Error("revoked Unraid key did not receive an authentication rejection")
  return { rejected: true, id, status: response.status }
}

export async function executeSanctuaryAcceptanceAdapter(
  rawPayload: unknown,
  deps: SanctuaryAcceptanceAdapterDependencies = createSanctuaryAcceptanceAdapterDependencies(),
): Promise<unknown> {
  const payload = object(rawPayload, "acceptance adapter payload")
  const operation = text(payload.operation, "operation")
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_adapter_start", message: "Sanctuary acceptance adapter started", meta: { operation } })
  try {
    let result: unknown
    switch (operation) {
      case "vault-backed-capability-verify": result = await vaultBackedCapabilityVerify(payload, deps); break
      case "closed-inventory": result = closedInventory(deps); break
      case "exact-id-revoke": result = await exactIdRevoke(payload, deps); break
      case "revoked-key-auth-rejection": result = await revokedKeyAuthRejection(payload, deps); break
      default: throw new Error("unknown Sanctuary acceptance adapter operation")
    }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_adapter_end", message: "Sanctuary acceptance adapter completed", meta: { operation } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "daemon", event: "daemon.sanctuary_acceptance_adapter_error", message: "Sanctuary acceptance adapter failed", meta: { operation, category: error instanceof Error ? error.name : "unknown" } })
    throw error
  }
}

export async function executeSanctuaryAcceptanceVaultProbe(
  keyIdValue: unknown,
  capabilityValue: unknown,
  deps: SanctuaryAcceptanceVaultProbeDependencies = { refresh: refreshMachineRuntimeCredentialConfig, fetch },
): Promise<unknown> {
  const id = keyId(keyIdValue)
  const capability = text(capabilityValue, "capability")
  if (capability !== "read-only" && capability !== "bounded-write") throw new Error("capability is invalid")
  const refreshed = await deps.refresh("sanctuary", "machine_sanctuary")
  if (!refreshed.ok) throw new Error("Sanctuary machine runtime credentials are unavailable")
  const endpoint = text(refreshed.config.unraidGraphqlUrl, "vault-backed Unraid endpoint")
  const field = capability === "read-only" ? "unraidReadApiKey" : "unraidWriteApiKey"
  const descriptor = text(refreshed.config[field], "vault-backed Unraid descriptor")
  const response = await deps.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": descriptor },
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error("vault-backed Unraid capability probe failed")
  const envelope = object(await response.json(), "vault-backed Unraid response")
  if (!envelope.data || envelope.errors) throw new Error("vault-backed Unraid capability probe was rejected")
  return { valid: true, keyId: id, capability }
}
