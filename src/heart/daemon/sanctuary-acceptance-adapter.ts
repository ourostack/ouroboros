import { spawnSync } from "node:child_process"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"

import { emitNervesEvent } from "../../nerves/runtime"
import { createTelegramApprovalRuntime } from "../../senses/telegram-approval-runtime"
import { createTelegramBotApi, type TelegramUpdate } from "../../senses/telegram-client"
import { loadTelegramSenseCredentials, readOrCreateTelegramIdentityKey } from "../../senses/telegram"
import { createSanctuaryToolContext } from "../../senses/sanctuary-runtime"
import { getAgentRoot } from "../identity"
import {
  mergeMachineRuntimeCredentialConfig,
  mergeRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
} from "../runtime-credentials"
import type { RuntimeCredentialConfigReadResult } from "../runtime-credentials"

type JsonObject = Record<string, unknown>

export interface SanctuaryAcceptanceKeyMetadata {
  id: string
  name: string
  permissions: Array<{ resource: string; actions: string[] }>
  roles: string[]
}

export interface SanctuaryAcceptanceKeyRecord extends SanctuaryAcceptanceKeyMetadata {
  key: string
}

export interface SanctuaryAcceptanceAdapterDependencies {
  readKeyFiles(): SanctuaryAcceptanceKeyMetadata[]
  readKeyRecords?(): SanctuaryAcceptanceKeyRecord[]
  readDescriptor(): string
  execFile(executable: string, args: string[]): Promise<{ status: number; stdout: string }>
  fetch: typeof fetch
  readFixedFile?(path: string): string
  refreshRuntime?(): Promise<RuntimeCredentialConfigReadResult>
  mergeRuntime?(patch: JsonObject): Promise<RuntimeCredentialConfigReadResult>
  refreshMachine?(): Promise<RuntimeCredentialConfigReadResult>
  mergeMachine?(patch: JsonObject): Promise<RuntimeCredentialConfigReadResult>
  callbackProbe?(update: JsonObject, replay: boolean): Promise<{ settled: boolean; claimed: boolean; mutated: boolean }>
}

export interface SanctuaryAcceptanceVaultProbeDependencies {
  refresh(agentName: string, machineId: string): Promise<RuntimeCredentialConfigReadResult>
  readKeyRecords(): SanctuaryAcceptanceKeyRecord[]
  fetch: typeof fetch
}

const KEY_ID = /^[A-Za-z0-9._:-]+$/u
const AUTH_PROBE = "query AcceptanceAuthProbe { info { os { hostname } } }"
const WRITE_PROBE = "mutation AcceptanceWriteProbe($id: PrefixedID!) { docker { restart(id: $id) { id } } }"
const MISSING_CONTAINER_ID = "Docker:ouro-acceptance-guaranteed-missing"
const ADAPTER_TIMEOUT_MS = 15_000
const NETWORK_TIMEOUT_MS = 10_000
const KEY_DIRECTORY = "/boot/config/plugins/dynamix.my.servers/keys"
const SELECTED_KEY_RECORD = "/run/ouro-acceptance/unraid-key.json"
const TELEGRAM_OFFSET = "/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json"
const TELEGRAM_AUDIT = "/home/ouro/AgentBundles/sanctuary.ouro/state/daemon/logs/telegram.ndjson"
const IMAGE_DIGEST_FILE = "/run/ouro-acceptance/image-digest"
const CONTAINER_DIGEST_FILE = "/run/ouro-acceptance/container-digest"
const POSTBOOT_HEALTH_FILE = "/run/ouro-acceptance/postboot-health.json"
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id"
const TARGET_SERVER_ID = "sanctuary-unraid"
const TARGET_ID = "sanctuary"
const SHA256 = /^[0-9a-f]{64}$/u
const TELEGRAM_SUBJECT_DOMAIN = "ouroboros.telegram.subject.v1"
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

function readRawKeyDirectory(keyDirectory: string): JsonObject[] {
  return readdirSync(keyDirectory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("unexpected key directory entry")
      return entry
    })
    .map((entry) => object(JSON.parse(readFileSync(`${keyDirectory}/${entry.name}`, "utf8")) as unknown, "Unraid key file"))
}

function readKeyDirectory(keyDirectory: string): SanctuaryAcceptanceKeyMetadata[] {
  return readRawKeyDirectory(keyDirectory).map(normalizeKey)
}

function readKeyRecords(keyDirectory: string): SanctuaryAcceptanceKeyRecord[] {
  return readRawKeyDirectory(keyDirectory).map((raw) => ({
    ...normalizeKey(raw),
    key: text(raw.key, "Unraid key descriptor"),
  }))
}

function readSelectedKeyRecord(keyRecordPath: string): SanctuaryAcceptanceKeyRecord {
  const raw = object(JSON.parse(readFileSync(keyRecordPath, "utf8")) as unknown, "selected Unraid key file")
  return { ...normalizeKey(raw), key: text(raw.key, "Unraid key descriptor") }
}

export function createSanctuaryAcceptanceVaultProbeDependencies(
  options: { keyRecordPath: string },
): SanctuaryAcceptanceVaultProbeDependencies {
  const keyRecordPath = options.keyRecordPath
  return {
    refresh: refreshMachineRuntimeCredentialConfig,
    readKeyRecords: () => [readSelectedKeyRecord(keyRecordPath)],
    fetch,
  }
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
    readKeyRecords: () => readKeyRecords(keyDirectory),
    readDescriptor: () => readFileSync(secretFd, "utf8"),
    execFile: (executable, args) => defaultExecFile(executable, args, adapterTimeoutMs),
    fetch,
    readFixedFile: (filePath) => readFileSync(filePath, "utf8"),
    refreshRuntime: () => refreshRuntimeCredentialConfig(TARGET_ID),
    mergeRuntime: (patch) => mergeRuntimeCredentialConfig(TARGET_ID, patch),
    refreshMachine: () => refreshMachineRuntimeCredentialConfig(TARGET_ID, TARGET_ID),
    mergeMachine: (patch) => mergeMachineRuntimeCredentialConfig(TARGET_ID, TARGET_ID, patch),
    callbackProbe: (update, replay) => executeSanctuaryAcceptanceCallbackProbe(update, replay),
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

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function exactLoopbackGraphqlEndpoint(value: unknown): URL {
  const endpoint = new URL(text(value, "endpoint"))
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== "::1")
    || endpoint.pathname !== "/graphql" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("probe endpoint must be an exact loopback GraphQL endpoint")
  }
  return endpoint
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
  const endpoint = exactLoopbackGraphqlEndpoint(payload.endpoint)
  const descriptorPayload = object(JSON.parse(deps.readDescriptor()) as unknown, "revoked-key descriptor")
  if (JSON.stringify(Object.keys(descriptorPayload).sort()) !== JSON.stringify(["descriptor", "keyId"])) throw new Error("revoked-key descriptor shape is invalid")
  if (keyId(descriptorPayload.keyId) !== id) throw new Error("revoked-key descriptor ID mismatch")
  const descriptor = text(descriptorPayload.descriptor, "revoked-key descriptor value")
  const signal = AbortSignal.timeout(NETWORK_TIMEOUT_MS)
  const response = await deps.fetch(endpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": descriptor },
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }),
    signal,
  })
  if (response.status !== 401 && response.status !== 403) throw new Error("revoked Unraid key did not receive an authentication rejection")
  return { rejected: true, id, status: response.status }
}

function dependency<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`${label} is unavailable`)
  return value
}

function exactKeys(value: JsonObject, keys: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} shape is invalid`)
}

function positiveDecimal(value: unknown, label: string): string {
  const result = text(value, label)
  if (!/^[1-9][0-9]*$/u.test(result)) throw new Error(`${label} is invalid`)
  return result
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function fixedFile(deps: SanctuaryAcceptanceAdapterDependencies, filePath: string): string {
  return dependency(deps.readFixedFile, "fixed file reader")(filePath)
}

async function runtimeConfig(
  reader: (() => Promise<RuntimeCredentialConfigReadResult>) | undefined,
  label: string,
): Promise<JsonObject> {
  const result = await dependency(reader, label)()
  if (!result.ok) throw new Error(`${label} is unavailable`)
  return result.config
}

async function sendTelegramNonce(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const nonce = text(payload.nonce, "nonce")
  if (!/^[0-9a-f]{32}$/u.test(nonce)) throw new Error("nonce is invalid")
  const config = await runtimeConfig(deps.refreshRuntime, "Sanctuary runtime config")
  const token = text(config.telegramBotToken, "Telegram bot credential")
  const chatId = positiveDecimal(config.telegramAuthorizedChatId, "Telegram authorized chat")
  let response: Response
  try {
    response = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `Reply with this one-time acceptance nonce: ${nonce}` }),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
  } catch { throw new Error("Telegram nonce delivery failed") }
  const envelope = object(await response.json(), "Telegram nonce response")
  if (!response.ok || envelope.ok !== true) throw new Error("Telegram nonce delivery failed")
  return { sent: true }
}

async function storeTelegramBootstrap(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const patch = {
    telegramBotToken: text(payload.botToken, "Telegram bot credential"),
    telegramAuthorizedUserId: positiveDecimal(payload.authorizedUserId, "Telegram authorized user"),
    telegramAuthorizedChatId: positiveDecimal(payload.authorizedChatId, "Telegram authorized chat"),
  }
  const stored = await dependency(deps.mergeRuntime, "runtime vault writer")(patch)
  if (!stored.ok || Object.entries(patch).some(([key, value]) => stored.config[key] !== value)) {
    throw new Error("Telegram bootstrap vault readback failed")
  }
  return { stored: true }
}

function cursorSnapshot(deps: SanctuaryAcceptanceAdapterDependencies): { offsetDigest: string; auditCursorDigest: string } {
  const offsetRaw = fixedFile(deps, TELEGRAM_OFFSET)
  const offset = object(JSON.parse(offsetRaw) as unknown, "Telegram offset")
  if (!Number.isSafeInteger(offset.nextUpdateId) || (offset.nextUpdateId as number) < 0) throw new Error("Telegram offset is invalid")
  return {
    offsetDigest: sha256(JSON.stringify({ nextUpdateId: offset.nextUpdateId })),
    auditCursorDigest: sha256(fixedFile(deps, TELEGRAM_AUDIT)),
  }
}

function callbackUpdate(value: unknown): JsonObject {
  const update = object(value, "callback update")
  object(update.callback_query, "callback update callback_query")
  return update
}

async function concurrentCallbackProbe(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const update = callbackUpdate(payload.update)
  if (!Number.isSafeInteger(payload.concurrency) || (payload.concurrency as number) < 2 || (payload.concurrency as number) > 16) {
    throw new Error("callback concurrency is invalid")
  }
  const probe = dependency(deps.callbackProbe, "callback probe")
  const results = await Promise.all(Array.from({ length: payload.concurrency as number }, () => probe(update, false)))
  return { results }
}

async function callbackReplay(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  return dependency(deps.callbackProbe, "callback probe")(callbackUpdate(payload.update), true)
}

function requireTargetServer(payload: JsonObject): void {
  if (text(payload.targetServerId, "targetServerId") !== TARGET_SERVER_ID) throw new Error("targetServerId is invalid")
}

function flattenedPermissions(record: SanctuaryAcceptanceKeyMetadata): string[] {
  return record.permissions.flatMap((permission) => permission.actions.map((action) => `${permission.resource}:${action}`)).sort()
}

function keyInventory(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  requireTargetServer(payload)
  return { keys: inventory(deps).map((record) => ({
    id: record.id, name: record.name, permissions: flattenedPermissions(record), roles: [...record.roles].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id)) }
}

function permissionStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("permissions are invalid")
  const result = value.map((permission) => text(permission, "permission"))
  if (new Set(result).size !== result.length || result.some((permission) => !/^[A-Z_]+:(?:CREATE|READ|UPDATE|DELETE)_(?:ANY|OWN)$/u.test(permission))) {
    throw new Error("permissions are invalid")
  }
  return [...result].sort()
}

async function createKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const name = text(payload.name, "Unraid key name")
  if (!/^Butler (?:RO|RW)(?: [A-Za-z0-9._-]{1,48})?$/u.test(name)) throw new Error("Unraid key name is invalid")
  const permissions = permissionStrings(payload.permissions)
  const field = name.startsWith("Butler RO") ? "unraidReadApiKey" : "unraidWriteApiKey"
  const expected = field === "unraidReadApiKey" ? RO_PERMISSIONS : [...RO_PERMISSIONS, "DOCKER:UPDATE_ANY"].sort()
  if (JSON.stringify(permissions) !== JSON.stringify(expected)) throw new Error("Unraid key scope is invalid")
  const result = await deps.execFile("/usr/local/sbin/unraid-api", ["apikey", "--name", name, "--create", "--permissions", permissions.join(","), "--json"])
  const created = object(JSON.parse(result.stdout) as unknown, "created Unraid key")
  const id = keyId(created.id)
  const key = text(created.key, "created Unraid key credential")
  if (created.name !== name || JSON.stringify(permissionStrings(created.permissions)) !== JSON.stringify(permissions)
    || !Array.isArray(created.roles) || created.roles.length !== 0) throw new Error("created Unraid key scope mismatch")
  const stored = await dependency(deps.mergeMachine, "machine vault writer")({
    [field]: key,
    sanctuaryAcceptanceKeyHandles: { [id]: key },
  })
  if (!stored.ok || stored.config[field] !== key) throw new Error("created Unraid key vault readback failed")
  return { id, name, key: `unraid-key:${id}:${field}`, permissions, roles: [] }
}

async function storeKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.keyId)
  const field = text(payload.vaultField, "vaultField")
  if (field !== "unraidReadApiKey" && field !== "unraidWriteApiKey") throw new Error("vaultField is invalid")
  const handle = text(payload.key, "Unraid key handle")
  if (handle !== `unraid-key:${id}:${field}`) throw new Error("Unraid key handle is invalid")
  const stored = await runtimeConfig(deps.refreshMachine, "Sanctuary machine runtime config")
  const handles = object(stored.sanctuaryAcceptanceKeyHandles, "vault-backed acceptance key handles")
  if (text(handles[id], "vault-backed Unraid credential") !== text(stored[field], "vault-backed Unraid credential")) {
    throw new Error("Unraid key handle does not bind to the active vault field")
  }
  return { stored: true, keyId: id }
}

async function probeKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const handle = text(payload.key, "Unraid key handle")
  const config = await runtimeConfig(deps.refreshMachine, "Sanctuary machine runtime config")
  const handleMatch = /^unraid-key:([A-Za-z0-9._:-]+):(unraidReadApiKey|unraidWriteApiKey)$/u.exec(handle)
  if (!handleMatch || handleMatch[1] !== id) throw new Error("Unraid key handle is invalid")
  const handles = object(config.sanctuaryAcceptanceKeyHandles, "vault-backed acceptance key handles")
  const key = text(handles[id], "vault-backed Unraid credential")
  const endpoint = exactLoopbackGraphqlEndpoint(config.unraidGraphqlUrl)
  let response: Response
  try {
    response = await deps.fetch(endpoint.href, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: AUTH_PROBE, variables: {} }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
  } catch { throw new Error("Unraid key readiness probe failed") }
  const envelope = object(await response.json(), "Unraid key readiness response")
  if (!response.ok || !envelope.data || envelope.errors) throw new Error("Unraid key readiness probe failed")
  return { valid: true }
}

function keyRecords(deps: SanctuaryAcceptanceAdapterDependencies): SanctuaryAcceptanceKeyRecord[] {
  return dependency(deps.readKeyRecords, "Unraid key record reader")().map((record) => ({ ...normalizeKey(record), key: text(record.key, "Unraid key credential") }))
}

async function readOldKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const matches = keyRecords(deps).filter((record) => record.id === id)
  if (matches.length !== 1) throw new Error("old Unraid key ID is absent or ambiguous")
  const stored = await dependency(deps.mergeMachine, "machine vault writer")({ sanctuaryAcceptanceKeyHandles: { [id]: matches[0]!.key } })
  if (!stored.ok) throw new Error("old Unraid key recovery storage failed")
  return { key: `unraid-key:${id}:legacy` }
}

async function revokeKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  return exactIdRevoke({ keyId: payload.id }, deps)
}

async function probeRevokedKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const handle = text(payload.key, "revoked Unraid key handle")
  if (handle !== `unraid-key:${id}:legacy` && !handle.startsWith(`unraid-key:${id}:unraid`)) throw new Error("revoked Unraid key handle is invalid")
  const config = await runtimeConfig(deps.refreshMachine, "Sanctuary machine runtime config")
  const handles = object(config.sanctuaryAcceptanceKeyHandles, "vault-backed acceptance key handles")
  const key = text(handles[id], "revoked Unraid key credential")
  const endpoint = exactLoopbackGraphqlEndpoint(config.unraidGraphqlUrl)
  const response = await deps.fetch(endpoint.href, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (response.status !== 401 && response.status !== 403) throw new Error("revoked Unraid key still authenticates")
  const cleared = await dependency(deps.mergeMachine, "machine vault writer")({ sanctuaryAcceptanceKeyHandles: { [id]: "" } })
  if (!cleared.ok) throw new Error("revoked Unraid key recovery cleanup failed")
  return { valid: false, status: response.status, id }
}

function provenance(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (payload.schema !== "sanctuary-unit-16-provenance-v1") throw new Error("provenance schema is invalid")
  const imageDigest = fixedFile(deps, IMAGE_DIGEST_FILE).trim()
  const containerDigest = fixedFile(deps, CONTAINER_DIGEST_FILE).trim()
  if (!SHA256.test(imageDigest) || !SHA256.test(containerDigest)) throw new Error("live provenance digest is invalid")
  const cursor = cursorSnapshot(deps)
  return { imageDigest, containerDigest, cursorDigest: sha256(`${cursor.offsetDigest}\0${cursor.auditCursorDigest}`) }
}

function evidenceSnapshot(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (payload.schema !== "postboot-health-v1") throw new Error("evidence schema is invalid")
  const health = object(JSON.parse(fixedFile(deps, POSTBOOT_HEALTH_FILE)) as unknown, "postboot health")
  exactKeys(health, ["healthy"], "postboot health")
  if (typeof health.healthy !== "boolean") throw new Error("postboot health is invalid")
  const imageDigest = fixedFile(deps, IMAGE_DIGEST_FILE).trim()
  if (!SHA256.test(imageDigest)) throw new Error("container image digest is invalid")
  return { healthy: health.healthy, containerImageDigest: imageDigest, telegramOffsetDigest: cursorSnapshot(deps).offsetDigest }
}

function bootId(deps: SanctuaryAcceptanceAdapterDependencies): string {
  const value = fixedFile(deps, BOOT_ID_FILE).trim()
  if (!/^[A-Za-z0-9-]{4,128}$/u.test(value)) throw new Error("boot identity is invalid")
  return value
}

async function requestReboot(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  if (text(payload.targetId, "targetId") !== TARGET_ID) throw new Error("targetId is invalid")
  const idempotencyKey = text(payload.idempotencyKey, "idempotencyKey")
  if (!/^[0-9a-f]{32}$/u.test(idempotencyKey)) throw new Error("idempotencyKey is invalid")
  const prebootId = bootId(deps)
  await deps.execFile("/sbin/reboot", [])
  return { accepted: true, targetId: TARGET_ID, requestId: sha256(`sanctuary-reboot\0${idempotencyKey}`), prebootId }
}

function pollReboot(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (text(payload.targetId, "targetId") !== TARGET_ID) throw new Error("targetId is invalid")
  const requestId = text(payload.requestId, "requestId")
  if (!SHA256.test(requestId)) throw new Error("requestId is invalid")
  return { targetId: TARGET_ID, requestId, state: "ready", bootId: bootId(deps) }
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
      case "send_telegram_nonce": result = await sendTelegramNonce(payload, deps); break
      case "store_telegram_bootstrap": result = await storeTelegramBootstrap(payload, deps); break
      case "snapshot": result = cursorSnapshot(deps); break
      case "inject_callbacks_concurrently": result = await concurrentCallbackProbe(payload, deps); break
      case "inject_callback_replay": result = await callbackReplay(payload, deps); break
      case "inventory_keys": result = keyInventory(payload, deps); break
      case "create_key": result = await createKey(payload, deps); break
      case "store_key": result = await storeKey(payload, deps); break
      case "probe_new_key": result = await probeKey(payload, deps); break
      case "read_old_key": result = await readOldKey(payload, deps); break
      case "revoke_key": result = await revokeKey(payload, deps); break
      case "probe_revoked_key": result = await probeRevokedKey(payload, deps); break
      case "evidence_snapshot": result = evidenceSnapshot(payload, deps); break
      case "capture_evidence_provenance": result = provenance(payload, deps); break
      case "request_reboot": result = await requestReboot(payload, deps); break
      case "poll_reboot": result = pollReboot(payload, deps); break
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
  deps: SanctuaryAcceptanceVaultProbeDependencies = createSanctuaryAcceptanceVaultProbeDependencies({ keyRecordPath: SELECTED_KEY_RECORD }),
): Promise<unknown> {
  const id = keyId(keyIdValue)
  const capability = text(capabilityValue, "capability")
  if (capability !== "read-only" && capability !== "bounded-write") throw new Error("capability is invalid")
  const refreshed = await deps.refresh("sanctuary", "sanctuary")
  if (!refreshed.ok) throw new Error("Sanctuary machine runtime credentials are unavailable")
  const endpoint = exactLoopbackGraphqlEndpoint(refreshed.config.unraidGraphqlUrl)
  const field = capability === "read-only" ? "unraidReadApiKey" : "unraidWriteApiKey"
  const descriptor = text(refreshed.config[field], "vault-backed Unraid descriptor")
  const matches = deps.readKeyRecords().filter((record) => sameSecret(record.key, descriptor))
  if (matches.length !== 1 || matches[0]!.id !== id) throw new Error("vault descriptor does not bind to the exact key ID")
  const matched = matches[0]!
  const expectedName = capability === "read-only" ? "Butler RO" : "Butler RW"
  if (matched.name !== expectedName || matched.roles.length !== 0 || scope(matched) !== capability) {
    throw new Error("vault-backed Unraid key metadata scope is invalid")
  }
  const headers = { "content-type": "application/json", "x-api-key": descriptor }
  const readResponse = await deps.fetch(endpoint.href, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!readResponse.ok) throw new Error("vault-backed Unraid capability probe failed")
  const readEnvelope = object(await readResponse.json(), "vault-backed Unraid response")
  if (!readEnvelope.data || readEnvelope.errors) throw new Error("vault-backed Unraid capability probe was rejected")
  const writeResponse = await deps.fetch(endpoint.href, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: WRITE_PROBE, variables: { id: MISSING_CONTAINER_ID } }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  const writeEnvelope = object(await writeResponse.json(), "vault-backed Unraid write response")
  const errors = Array.isArray(writeEnvelope.errors) ? writeEnvelope.errors.map((value) => object(value, "GraphQL error")) : []
  const codes = errors.map((error) => {
    const extensions = error.extensions && typeof error.extensions === "object" && !Array.isArray(error.extensions)
      ? error.extensions as JsonObject
      : {}
    return typeof extensions.code === "string" ? extensions.code : ""
  })
  if (capability === "read-only") {
    if (writeEnvelope.data || (writeResponse.status !== 403 && !codes.includes("FORBIDDEN") && !codes.includes("PERMISSION_DENIED"))) {
      throw new Error("read-only Unraid key did not prove write permission denial")
    }
    return { valid: true, keyId: id, capability, proof: "read-authorized-write-denied" }
  }
  if (writeEnvelope.data || !writeResponse.ok || !codes.includes("NOT_FOUND")) {
    throw new Error("bounded-write Unraid key did not reach deterministic not-found")
  }
  return { valid: true, keyId: id, capability, proof: "read-authorized-write-reached-not-found" }
}

export async function executeSanctuaryAcceptanceRevokedProbe(
  keyIdValue: unknown,
  endpointValue: unknown,
  rawKeyFile: string,
  deps: Pick<SanctuaryAcceptanceAdapterDependencies, "fetch"> = { fetch },
): Promise<unknown> {
  const id = keyId(keyIdValue)
  const raw = object(JSON.parse(rawKeyFile) as unknown, "revoked Unraid key file")
  if (keyId(raw.id) !== id) throw new Error("revoked Unraid key file ID mismatch")
  const descriptor = text(raw.key, "revoked Unraid key descriptor")
  return revokedKeyAuthRejection({ keyId: id, endpoint: endpointValue }, {
    readKeyFiles: () => [],
    readDescriptor: () => JSON.stringify({ keyId: id, descriptor }),
    execFile: async () => ({ status: 0, stdout: "" }),
    fetch: deps.fetch,
  })
}

/* v8 ignore start -- live packaged boundary: exercised on the deployed approval journal with a saved Telegram callback */
export async function executeSanctuaryAcceptanceCallbackProbe(
  rawUpdate: unknown,
  _replay: boolean,
): Promise<{ settled: boolean; claimed: boolean; mutated: boolean }> {
  const update = callbackUpdate(rawUpdate) as unknown as TelegramUpdate
  const refreshed = await refreshRuntimeCredentialConfig(TARGET_ID)
  if (!refreshed.ok) throw new Error("Telegram runtime credentials are unavailable")
  const credentials = loadTelegramSenseCredentials(TARGET_ID)
  const identityKey = readOrCreateTelegramIdentityKey(getAgentRoot(TARGET_ID))
  const payload = [
    TELEGRAM_SUBJECT_DOMAIN,
    `user:${credentials.authorizedUserId.length}:${credentials.authorizedUserId}`,
    `chat:${credentials.authorizedChatId.length}:${credentials.authorizedChatId}`,
  ].join("\0")
  const subject = `tg_${createHmac("sha256", identityKey).update(payload, "utf8").digest("base64url")}`
  const api = createTelegramBotApi({ token: credentials.botToken })
  const runtime = createTelegramApprovalRuntime({
    agentName: TARGET_ID,
    api,
    authorizedUserId: credentials.authorizedUserId,
    authorizedChatId: credentials.authorizedChatId,
    subject,
    toolContext: createSanctuaryToolContext(TARGET_ID),
  })
  try {
    const result = await runtime.transport.handleUpdate(update)
    return {
      settled: result.handled,
      claimed: result.reason === "accepted" || result.reason === "decision_refused",
      mutated: result.accepted,
    }
  } finally {
    runtime.close()
    api.stop()
  }
}
/* v8 ignore stop */
