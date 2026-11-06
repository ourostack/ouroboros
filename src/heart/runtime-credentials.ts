import * as crypto from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { getCredentialStore } from "../repertoire/credential-access"
import { getAgentName } from "./identity"
import { cacheProviderCredentialRecords, type ProviderCredentialRecord } from "./provider-credentials"

export type RuntimeCredentialConfig = Record<string, unknown>

export type RuntimeCredentialConfigReadResult =
  | { ok: true; itemPath: string; config: RuntimeCredentialConfig; revision: string; updatedAt: string }
  | { ok: false; reason: "missing" | "unavailable" | "invalid"; itemPath: string; error: string }

type RuntimeCredentialConfigReadSuccess = Extract<RuntimeCredentialConfigReadResult, { ok: true }>

export interface RefreshRuntimeCredentialConfigOptions {
  preserveCachedOnFailure?: boolean
}

export interface RuntimeCredentialBootstrapMessage {
  type: "ouro.runtimeCredentialBootstrap"
  agentName: string
  runtimeConfig?: RuntimeCredentialConfig
  machineRuntimeConfig?: RuntimeCredentialConfig
  machineId?: string
  providerCredentialRecords?: ProviderCredentialRecord[]
}

interface RuntimeCredentialVaultPayload {
  schemaVersion: 1
  kind: "runtime-config"
  updatedAt: string
  config: RuntimeCredentialConfig
}

export const RUNTIME_CONFIG_ITEM_NAME = "runtime/config"
export const MACHINE_RUNTIME_CONFIG_ITEM_PREFIX = "runtime/machines"

let cachedRuntimeConfigs = new Map<string, RuntimeCredentialConfigReadResult>()
let cachedMachineRuntimeConfigs = new Map<string, RuntimeCredentialConfigReadResult>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isCredentialValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number"
}

function isCredentialRecord(value: unknown): value is Record<string, string | number> {
  if (!isRecord(value)) return false
  return Object.values(value).every(isCredentialValue)
}

function isProviderCredentialRecord(value: unknown): value is ProviderCredentialRecord {
  if (!isRecord(value)) return false
  if (typeof value.provider !== "string") return false
  if (typeof value.revision !== "string" || value.revision.trim().length === 0) return false
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim().length === 0) return false
  if (!isCredentialRecord(value.credentials)) return false
  if (!isCredentialRecord(value.config)) return false
  const provenance = value.provenance
  if (!isRecord(provenance)) return false
  if (provenance.source !== "auth-flow" && provenance.source !== "manual") return false
  if (typeof provenance.updatedAt !== "string" || provenance.updatedAt.trim().length === 0) return false
  return true
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function runtimeConfigVaultPath(agentName: string, itemName = RUNTIME_CONFIG_ITEM_NAME): string {
  return `vault:${agentName}:${itemName}`
}

export function machineRuntimeConfigItemName(machineId: string): string {
  const normalized = machineId.trim()
  if (!normalized) throw new Error("machineId must be non-empty")
  return `${MACHINE_RUNTIME_CONFIG_ITEM_PREFIX}/${normalized}/config`
}

function runtimeConfigRevision(payload: RuntimeCredentialVaultPayload): string {
  return `runtime_${crypto
    .createHash("sha256")
    .update(stableJson(payload))
    .digest("hex")
    .slice(0, 16)}`
}

function validateRuntimeCredentialPayload(value: unknown): RuntimeCredentialVaultPayload {
  if (!isRecord(value)) throw new Error("runtime credential payload must be an object")
  if (value.schemaVersion !== 1) throw new Error("runtime credential payload schemaVersion must be 1")
  if (value.kind !== "runtime-config") throw new Error("runtime credential payload kind must be runtime-config")
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim().length === 0) {
    throw new Error("runtime credential payload updatedAt must be non-empty")
  }
  if (!isRecord(value.config)) throw new Error("runtime credential payload config must be an object")
  return value as unknown as RuntimeCredentialVaultPayload
}

function resultFromPayload(agentName: string, payload: RuntimeCredentialVaultPayload): RuntimeCredentialConfigReadSuccess {
  return {
    ok: true,
    itemPath: runtimeConfigVaultPath(agentName),
    config: { ...payload.config },
    revision: runtimeConfigRevision(payload),
    updatedAt: payload.updatedAt,
  }
}

function resultFromPayloadForItem(
  agentName: string,
  itemName: string,
  payload: RuntimeCredentialVaultPayload,
): RuntimeCredentialConfigReadSuccess {
  return {
    ok: true,
    itemPath: runtimeConfigVaultPath(agentName, itemName),
    config: { ...payload.config },
    revision: runtimeConfigRevision(payload),
    updatedAt: payload.updatedAt,
  }
}

function missingRuntimeConfig(agentName: string, itemName = RUNTIME_CONFIG_ITEM_NAME): RuntimeCredentialConfigReadResult {
  return {
    ok: false,
    reason: "missing",
    itemPath: runtimeConfigVaultPath(agentName, itemName),
    error: `no runtime credentials stored at ${runtimeConfigVaultPath(agentName, itemName)}`,
  }
}

function cacheResult(agentName: string, result: RuntimeCredentialConfigReadResult): RuntimeCredentialConfigReadResult {
  cachedRuntimeConfigs.set(agentName, result)
  return result
}

function cacheMachineResult(agentName: string, result: RuntimeCredentialConfigReadResult): RuntimeCredentialConfigReadResult {
  cachedMachineRuntimeConfigs.set(agentName, result)
  return result
}

function missingMachineRuntimeConfig(agentName: string): RuntimeCredentialConfigReadResult {
  return {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:${MACHINE_RUNTIME_CONFIG_ITEM_PREFIX}/<this-machine>/config`,
    error: `no machine runtime credentials loaded for ${agentName}`,
  }
}

export function readRuntimeCredentialConfig(agentName: string = getAgentName()): RuntimeCredentialConfigReadResult {
  return cachedRuntimeConfigs.get(agentName) ?? missingRuntimeConfig(agentName)
}

export function readMachineRuntimeCredentialConfig(agentName: string = getAgentName()): RuntimeCredentialConfigReadResult {
  return cachedMachineRuntimeConfigs.get(agentName) ?? missingMachineRuntimeConfig(agentName)
}

export function cacheRuntimeCredentialConfig(
  agentName: string,
  config: RuntimeCredentialConfig,
  now: Date = new Date(),
): RuntimeCredentialConfigReadResult {
  const payload: RuntimeCredentialVaultPayload = {
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt: now.toISOString(),
    config: { ...config },
  }
  return cacheResult(agentName, resultFromPayload(agentName, payload))
}

export function cacheMachineRuntimeCredentialConfig(
  agentName: string,
  config: RuntimeCredentialConfig,
  now: Date = new Date(),
  machineId = "<this-machine>",
): RuntimeCredentialConfigReadResult {
  const payload: RuntimeCredentialVaultPayload = {
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt: now.toISOString(),
    config: { ...config },
  }
  return cacheMachineResult(agentName, resultFromPayloadForItem(agentName, machineRuntimeConfigItemName(machineId), payload))
}

function isRuntimeCredentialBootstrapMessage(value: unknown): value is RuntimeCredentialBootstrapMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.type !== "ouro.runtimeCredentialBootstrap") return false
  if (typeof record.agentName !== "string" || record.agentName.trim().length === 0) return false
  if (record.runtimeConfig !== undefined && !isRecord(record.runtimeConfig)) return false
  if (record.machineRuntimeConfig !== undefined && !isRecord(record.machineRuntimeConfig)) return false
  if (record.machineId !== undefined && (typeof record.machineId !== "string" || record.machineId.trim().length === 0)) return false
  if (
    record.providerCredentialRecords !== undefined
    && (
      !Array.isArray(record.providerCredentialRecords)
      || !record.providerCredentialRecords.every(isProviderCredentialRecord)
    )
  ) return false
  return true
}

export function applyRuntimeCredentialBootstrapMessage(message: unknown): boolean {
  if (!isRuntimeCredentialBootstrapMessage(message)) return false
  const agentName = message.agentName.trim()
  const now = new Date()
  if (message.runtimeConfig) {
    cacheRuntimeCredentialConfig(agentName, message.runtimeConfig, now)
  }
  if (message.machineRuntimeConfig) {
    cacheMachineRuntimeCredentialConfig(agentName, message.machineRuntimeConfig, now, message.machineId ?? "<this-machine>")
  }
  if (message.providerCredentialRecords && message.providerCredentialRecords.length > 0) {
    cacheProviderCredentialRecords(agentName, message.providerCredentialRecords, now)
  }
  emitNervesEvent({
    component: "config/identity",
    event: "config.runtime_credentials_bootstrapped",
    message: "loaded runtime credentials from daemon bootstrap",
    meta: {
      agentName,
      runtimeConfig: !!message.runtimeConfig,
      machineRuntimeConfig: !!message.machineRuntimeConfig,
      providerCredentialRecords: message.providerCredentialRecords?.length ?? 0,
    },
  })
  return true
}

export function waitForRuntimeCredentialBootstrap(
  agentName: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1_500
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (value: boolean): void => {
      /* v8 ignore next -- defensive: listener cleanup and timer cleanup prevent double settlement @preserve */
      if (settled) return
      settled = true
      /* v8 ignore next -- defensive: timer is assigned immediately after listener registration @preserve */
      if (timer) clearTimeout(timer)
      process.off?.("message", onMessage)
      resolve(value)
    }

    const onMessage = (message: unknown): void => {
      if (!isRuntimeCredentialBootstrapMessage(message)) return
      if (message.agentName.trim() !== agentName.trim()) return
      finish(applyRuntimeCredentialBootstrapMessage(message))
    }

    process.on?.("message", onMessage)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

async function refreshRuntimeCredentialConfigItem(
  agentName: string,
  itemName: string,
  cache: (agentName: string, result: RuntimeCredentialConfigReadResult) => RuntimeCredentialConfigReadResult,
  options: RefreshRuntimeCredentialConfigOptions = {},
): Promise<RuntimeCredentialConfigReadResult> {
  try {
    const store = getCredentialStore(agentName)
    const raw = await store.getRawSecret(itemName, "password")
    const payload = validateRuntimeCredentialPayload(JSON.parse(raw) as unknown)
    const result = resultFromPayloadForItem(agentName, itemName, payload)
    emitNervesEvent({
      component: "config/identity",
      event: "config.runtime_credentials_loaded",
      message: "loaded runtime credentials from vault",
      meta: { agentName, itemPath: result.itemPath, revision: result.revision },
    })
    return cache(agentName, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const existing = cache === cacheMachineResult
      ? cachedMachineRuntimeConfigs.get(agentName)
      : cachedRuntimeConfigs.get(agentName)
    const reason = message.includes(`no credential found for domain "${itemName}"`)
      ? "missing"
      : message.includes("runtime credential payload")
        ? "invalid"
        : "unavailable"
    const result: RuntimeCredentialConfigReadResult = {
      ok: false,
      reason,
      itemPath: runtimeConfigVaultPath(agentName, itemName),
      error: reason === "missing" ? `no runtime credentials stored at ${runtimeConfigVaultPath(agentName, itemName)}` : message,
    }
    emitNervesEvent({
      level: reason === "missing" ? "warn" : "error",
      component: "config/identity",
      event: "config.runtime_credentials_unavailable",
      message: "runtime credentials unavailable",
      meta: { agentName, reason, itemPath: result.itemPath },
    })
    if (options.preserveCachedOnFailure && existing?.ok) return existing
    return cache(agentName, result)
  }
}

export async function refreshRuntimeCredentialConfig(
  agentName: string,
  options: RefreshRuntimeCredentialConfigOptions = {},
): Promise<RuntimeCredentialConfigReadResult> {
  return refreshRuntimeCredentialConfigItem(agentName, RUNTIME_CONFIG_ITEM_NAME, cacheResult, options)
}

export async function refreshMachineRuntimeCredentialConfig(
  agentName: string,
  machineId: string,
  options: RefreshRuntimeCredentialConfigOptions = {},
): Promise<RuntimeCredentialConfigReadResult> {
  return refreshRuntimeCredentialConfigItem(agentName, machineRuntimeConfigItemName(machineId), cacheMachineResult, options)
}

export async function upsertRuntimeCredentialConfig(
  agentName: string,
  config: RuntimeCredentialConfig,
  now: Date = new Date(),
): Promise<RuntimeCredentialConfigReadSuccess> {
  const payload: RuntimeCredentialVaultPayload = {
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt: now.toISOString(),
    config: { ...config },
  }
  const store = getCredentialStore(agentName)
  await store.store(RUNTIME_CONFIG_ITEM_NAME, {
    username: "runtime/config",
    password: JSON.stringify(payload),
    notes: "Ouro runtime credentials for senses and integrations. Provider credentials live in providers/* items.",
  })
  const result = resultFromPayload(agentName, payload)
  emitNervesEvent({
    component: "config/identity",
    event: "config.runtime_credentials_upserted",
    message: "upserted runtime credential config in vault",
    meta: { agentName, itemPath: result.itemPath, revision: result.revision },
  })
  cacheResult(agentName, result)
  return result
}

export async function upsertMachineRuntimeCredentialConfig(
  agentName: string,
  machineId: string,
  config: RuntimeCredentialConfig,
  now: Date = new Date(),
): Promise<RuntimeCredentialConfigReadSuccess> {
  const payload: RuntimeCredentialVaultPayload = {
    schemaVersion: 1,
    kind: "runtime-config",
    updatedAt: now.toISOString(),
    config: { ...config },
  }
  const itemName = machineRuntimeConfigItemName(machineId)
  const store = getCredentialStore(agentName)
  await store.store(itemName, {
    username: itemName,
    password: JSON.stringify(payload),
    notes: "Ouro machine-local runtime credentials for senses attached to one machine. Portable runtime credentials live in runtime/config.",
  })
  const result = resultFromPayloadForItem(agentName, itemName, payload)
  emitNervesEvent({
    component: "config/identity",
    event: "config.runtime_credentials_upserted",
    message: "upserted machine runtime credential config in vault",
    meta: { agentName, itemPath: result.itemPath, revision: result.revision },
  })
  cacheMachineResult(agentName, result)
  return result
}

export function resetRuntimeCredentialConfigCache(): void {
  cachedRuntimeConfigs = new Map()
  cachedMachineRuntimeConfigs = new Map()
}
