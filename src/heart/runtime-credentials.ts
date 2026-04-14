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

let cachedRuntimeConfigs = new Map<string, RuntimeCredentialConfigReadResult>()

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

function runtimeConfigVaultPath(agentName: string): string {
  return `vault:${agentName}:${RUNTIME_CONFIG_ITEM_NAME}`
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

function missingRuntimeConfig(agentName: string): RuntimeCredentialConfigReadResult {
  return {
    ok: false,
    reason: "missing",
    itemPath: runtimeConfigVaultPath(agentName),
    error: `no runtime credentials stored at ${runtimeConfigVaultPath(agentName)}`,
  }
}

function cacheResult(agentName: string, result: RuntimeCredentialConfigReadResult): RuntimeCredentialConfigReadResult {
  cachedRuntimeConfigs.set(agentName, result)
  return result
}

export function readRuntimeCredentialConfig(agentName: string = getAgentName()): RuntimeCredentialConfigReadResult {
  return cachedRuntimeConfigs.get(agentName) ?? missingRuntimeConfig(agentName)
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

export async function refreshRuntimeCredentialConfig(
  agentName: string,
  options: RefreshRuntimeCredentialConfigOptions = {},
): Promise<RuntimeCredentialConfigReadResult> {
  try {
    const store = getCredentialStore(agentName)
    const raw = await store.getRawSecret(RUNTIME_CONFIG_ITEM_NAME, "password")
    const payload = validateRuntimeCredentialPayload(JSON.parse(raw) as unknown)
    const result = resultFromPayload(agentName, payload)
    emitNervesEvent({
      component: "config/identity",
      event: "config.runtime_credentials_loaded",
      message: "loaded runtime credentials from vault",
      meta: { agentName, itemPath: result.itemPath, revision: result.revision },
    })
    return cacheResult(agentName, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cached = cachedRuntimeConfigs.get(agentName)
    const reason = message.includes(`no credential found for domain "${RUNTIME_CONFIG_ITEM_NAME}"`)
      ? "missing"
      : message.includes("runtime credential payload")
        ? "invalid"
        : "unavailable"
    const result: RuntimeCredentialConfigReadResult = {
      ok: false,
      reason,
      itemPath: runtimeConfigVaultPath(agentName),
      error: reason === "missing" ? `no runtime credentials stored at ${runtimeConfigVaultPath(agentName)}` : message,
    }
    emitNervesEvent({
      level: reason === "missing" ? "warn" : "error",
      component: "config/identity",
      event: "config.runtime_credentials_unavailable",
      message: "runtime credentials unavailable",
      meta: { agentName, reason, itemPath: result.itemPath },
    })
    if (options.preserveCachedOnFailure && cached?.ok) return cached
    return cacheResult(agentName, result)
  }
}

export async function upsertRuntimeCredentialConfig(
  agentName: string,
  config: RuntimeCredentialConfig,
  now: Date = new Date(),
): Promise<RuntimeCredentialConfigReadResult> {
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
  return cacheResult(agentName, result)
}

export function resetRuntimeCredentialConfigCache(): void {
  cachedRuntimeConfigs = new Map()
}
