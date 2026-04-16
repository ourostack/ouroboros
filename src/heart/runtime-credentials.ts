import * as crypto from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { getCredentialStore } from "../repertoire/credential-access"
import { getAgentName } from "./identity"

export type RuntimeCredentialConfig = Record<string, unknown>

export type RuntimeCredentialConfigReadResult =
  | { ok: true; itemPath: string; config: RuntimeCredentialConfig; revision: string; updatedAt: string }
  | { ok: false; reason: "missing" | "unavailable" | "invalid"; itemPath: string; error: string }

type RuntimeCredentialConfigReadSuccess = Extract<RuntimeCredentialConfigReadResult, { ok: true }>

export interface RefreshRuntimeCredentialConfigOptions {
  preserveCachedOnFailure?: boolean
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
