import * as crypto from "node:crypto"
import * as os from "node:os"
import { emitNervesEvent } from "../nerves/runtime"
import { getCredentialStore } from "../repertoire/credential-access"
import type { AgentProvider } from "./identity"

export type ProviderCredentialProvenanceSource = "auth-flow" | "manual"

export interface ProviderCredentialProvenance {
  source: ProviderCredentialProvenanceSource
  updatedAt: string
}

export interface ProviderCredentialRecord {
  provider: AgentProvider
  revision: string
  updatedAt: string
  credentials: Record<string, string | number>
  config: Record<string, string | number>
  provenance: ProviderCredentialProvenance
}

export interface ProviderCredentialPool {
  schemaVersion: 1
  updatedAt: string
  providers: Partial<Record<AgentProvider, ProviderCredentialRecord>>
}

export type ProviderCredentialPoolReadResult =
  | { ok: true; poolPath: string; pool: ProviderCredentialPool }
  | { ok: false; reason: "missing" | "unavailable" | "invalid"; poolPath: string; error: string }

export type ProviderCredentialRecordReadResult =
  | { ok: true; poolPath: string; record: ProviderCredentialRecord }
  | { ok: false; reason: "missing" | "unavailable" | "invalid"; poolPath: string; error: string }

export interface ProviderCredentialInput {
  provider: AgentProvider
  credentials: Record<string, string | number>
  config: Record<string, string | number>
  provenance: {
    source: ProviderCredentialProvenanceSource
  }
}

export interface ProviderCredentialUpsertInput extends ProviderCredentialInput {
  agentName: string
  now?: Date
}

export interface ProviderCredentialRuntimeRecordInput extends ProviderCredentialInput {
  now?: Date
}

export interface ProviderCredentialPoolSummary {
  providers: Array<{
    provider: AgentProvider
    revision: string
    source: ProviderCredentialProvenanceSource
    updatedAt: string
    credentialFields: string[]
    configFields: string[]
  }>
}

export interface RefreshProviderCredentialPoolOptions {
  preserveCachedOnFailure?: boolean
}

interface ProviderCredentialVaultPayload {
  schemaVersion: 1
  kind: "provider-credential"
  provider: AgentProvider
  updatedAt: string
  credentials: Record<string, string | number>
  config: Record<string, string | number>
  provenance: {
    source: ProviderCredentialProvenanceSource
    updatedAt: string
  }
}

const VALID_PROVIDERS: AgentProvider[] = ["azure", "minimax", "anthropic", "openai-codex", "github-copilot"]
const VALID_PROVENANCE_SOURCES: ProviderCredentialProvenanceSource[] = ["auth-flow", "manual"]
const VAULT_ITEM_PREFIX = "providers/"

const PROVIDER_FIELD_SPLITS: Record<AgentProvider, { credentials: string[]; config: string[] }> = {
  anthropic: {
    credentials: ["setupToken", "refreshToken", "expiresAt"],
    config: [],
  },
  "openai-codex": {
    credentials: ["oauthAccessToken"],
    config: [],
  },
  azure: {
    credentials: ["apiKey"],
    config: ["endpoint", "deployment", "apiVersion", "managedIdentityClientId"],
  },
  minimax: {
    credentials: ["apiKey"],
    config: [],
  },
  "github-copilot": {
    credentials: ["githubToken"],
    config: ["baseUrl"],
  },
}

let cachedPools = new Map<string, ProviderCredentialPoolReadResult>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isAgentProvider(value: string): value is AgentProvider {
  return (VALID_PROVIDERS as string[]).includes(value)
}

function isProvenanceSource(value: unknown): value is ProviderCredentialProvenanceSource {
  return typeof value === "string" && (VALID_PROVENANCE_SOURCES as string[]).includes(value)
}

function isCredentialValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number"
}

function isPresentCredentialValue(value: unknown): value is string | number {
  if (!isCredentialValue(value)) return false
  if (typeof value === "string") return value.trim().length > 0
  return Number.isFinite(value) && value !== 0
}

function copyKnownFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, string | number> {
  const result: Record<string, string | number> = {}
  for (const field of fields) {
    const value = source[field]
    if (isPresentCredentialValue(value)) {
      result[field] = value
    }
  }
  return result
}

export function splitProviderCredentialFields(
  provider: AgentProvider,
  rawConfig: Record<string, unknown>,
): { credentials: Record<string, string | number>; config: Record<string, string | number> } {
  const fields = PROVIDER_FIELD_SPLITS[provider]
  return {
    credentials: copyKnownFields(rawConfig, fields.credentials),
    config: copyKnownFields(rawConfig, fields.config),
  }
}

export function providerCredentialsVaultPath(agentName: string): string {
  return `vault:${agentName}:${VAULT_ITEM_PREFIX}*`
}

export function providerCredentialItemName(provider: AgentProvider): string {
  return `${VAULT_ITEM_PREFIX}${provider}`
}

export function providerCredentialMachineHomeDir(homeDir?: string): string {
  return homeDir ?? os.homedir()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function makeRevision(payload: ProviderCredentialVaultPayload): string {
  const hash = crypto
    .createHash("sha256")
    .update(stableJson({
      provider: payload.provider,
      credentials: payload.credentials,
      config: payload.config,
      provenance: payload.provenance,
      updatedAt: payload.updatedAt,
    }))
    .digest("hex")
    .slice(0, 16)
  return `vault_${hash}`
}

function validateProviderCredentialPayload(value: unknown, expectedProvider?: AgentProvider): ProviderCredentialVaultPayload {
  if (!isRecord(value)) throw new Error("provider credential payload must be an object")
  if (value.schemaVersion !== 1) throw new Error("provider credential payload schemaVersion must be 1")
  if (value.kind !== "provider-credential") throw new Error("provider credential payload kind must be provider-credential")
  if (typeof value.provider !== "string" || !isAgentProvider(value.provider)) {
    throw new Error("provider credential payload provider must be valid")
  }
  if (expectedProvider && value.provider !== expectedProvider) {
    throw new Error(`provider credential payload provider must be ${expectedProvider}`)
  }
  if (typeof value.updatedAt !== "string" || value.updatedAt.length === 0) {
    throw new Error("provider credential payload updatedAt must be non-empty")
  }
  if (!isRecord(value.credentials)) throw new Error("provider credential payload credentials must be an object")
  if (!isRecord(value.config)) throw new Error("provider credential payload config must be an object")
  for (const [field, fieldValue] of Object.entries(value.credentials)) {
    if (!isCredentialValue(fieldValue)) throw new Error(`credentials.${field} must be a string or number`)
  }
  for (const [field, fieldValue] of Object.entries(value.config)) {
    if (!isCredentialValue(fieldValue)) throw new Error(`config.${field} must be a string or number`)
  }
  if (!isRecord(value.provenance)) throw new Error("provider credential payload provenance must be an object")
  if (!isProvenanceSource(value.provenance.source)) {
    throw new Error("provider credential payload provenance.source must be auth-flow or manual")
  }
  if (typeof value.provenance.updatedAt !== "string" || value.provenance.updatedAt.length === 0) {
    throw new Error("provider credential payload provenance.updatedAt must be non-empty")
  }
  return value as unknown as ProviderCredentialVaultPayload
}

function recordFromPayload(payload: ProviderCredentialVaultPayload): ProviderCredentialRecord {
  return {
    provider: payload.provider,
    revision: makeRevision(payload),
    updatedAt: payload.updatedAt,
    credentials: { ...payload.credentials },
    config: { ...payload.config },
    provenance: { ...payload.provenance },
  }
}

function missingPool(agentName: string, error = "provider credentials have not been loaded from vault"): ProviderCredentialPoolReadResult {
  return {
    ok: false,
    reason: "missing",
    poolPath: providerCredentialsVaultPath(agentName),
    error,
  }
}

function cacheResult(agentName: string, result: ProviderCredentialPoolReadResult): ProviderCredentialPoolReadResult {
  cachedPools.set(agentName, result)
  return result
}

function resultForProvider(
  poolResult: ProviderCredentialPoolReadResult,
  provider: AgentProvider,
): ProviderCredentialRecordReadResult {
  if (!poolResult.ok) return poolResult
  const record = poolResult.pool.providers[provider]
  if (!record) {
    return {
      ok: false,
      reason: "missing",
      poolPath: poolResult.poolPath,
      error: `${provider} credentials are missing from ${poolResult.poolPath}`,
    }
  }
  return { ok: true, poolPath: poolResult.poolPath, record }
}

export function readProviderCredentialPool(agentName: string): ProviderCredentialPoolReadResult {
  return cachedPools.get(agentName) ?? missingPool(agentName)
}

export async function refreshProviderCredentialPool(
  agentName: string,
  options: RefreshProviderCredentialPoolOptions = {},
): Promise<ProviderCredentialPoolReadResult> {
  try {
    const store = getCredentialStore(agentName)
    const items = await store.list()
    const providers: Partial<Record<AgentProvider, ProviderCredentialRecord>> = {}
    let updatedAt = new Date(0).toISOString()

    for (const item of items) {
      if (!item.domain.startsWith(VAULT_ITEM_PREFIX)) continue
      const provider = item.domain.slice(VAULT_ITEM_PREFIX.length)
      if (!isAgentProvider(provider)) continue
      const raw = await store.getRawSecret(item.domain, "password")
      const payload = validateProviderCredentialPayload(JSON.parse(raw) as unknown, provider)
      const record = recordFromPayload(payload)
      providers[provider] = record
      if (record.updatedAt > updatedAt) updatedAt = record.updatedAt
    }

    const pool: ProviderCredentialPool = {
      schemaVersion: 1,
      updatedAt,
      providers,
    }
    emitNervesEvent({
      component: "config/identity",
      event: "config.provider_credentials_loaded",
      message: "loaded provider credentials from vault",
      meta: { agentName, providerCount: Object.keys(providers).length },
    })
    return cacheResult(agentName, { ok: true, poolPath: providerCredentialsVaultPath(agentName), pool })
  } catch (error) {
    const cached = cachedPools.get(agentName)
    const result: ProviderCredentialPoolReadResult = {
      ok: false,
      reason: "unavailable",
      poolPath: providerCredentialsVaultPath(agentName),
      error: error instanceof Error ? error.message : String(error),
    }
    emitNervesEvent({
      level: "error",
      component: "config/identity",
      event: "config.provider_credentials_unavailable",
      message: "provider credentials unavailable",
      meta: { agentName, reason: result.error },
    })
    if (options.preserveCachedOnFailure && cached?.ok) return cached
    return cacheResult(agentName, result)
  }
}

export function createProviderCredentialRecord(input: ProviderCredentialRuntimeRecordInput): ProviderCredentialRecord {
  const updatedAt = (input.now ?? new Date()).toISOString()
  const payload: ProviderCredentialVaultPayload = {
    schemaVersion: 1,
    kind: "provider-credential",
    provider: input.provider,
    updatedAt,
    credentials: { ...input.credentials },
    config: { ...input.config },
    provenance: {
      source: input.provenance.source,
      updatedAt,
    },
  }
  return recordFromPayload(payload)
}

export function cacheProviderCredentialRecords(
  agentName: string,
  records: ProviderCredentialRecord[],
  now: Date = new Date(),
): ProviderCredentialPoolReadResult {
  const providers: Partial<Record<AgentProvider, ProviderCredentialRecord>> = {}
  let updatedAt = now.toISOString()
  for (const record of records) {
    providers[record.provider] = record
    if (record.updatedAt > updatedAt) updatedAt = record.updatedAt
  }
  const pool: ProviderCredentialPool = {
    schemaVersion: 1,
    updatedAt,
    providers,
  }
  return cacheResult(agentName, { ok: true, poolPath: providerCredentialsVaultPath(agentName), pool })
}

export function readCachedProviderCredentialRecord(
  agentName: string,
  provider: AgentProvider,
): ProviderCredentialRecordReadResult {
  return resultForProvider(readProviderCredentialPool(agentName), provider)
}

export async function readProviderCredentialRecord(
  agentName: string,
  provider: AgentProvider,
  options: { refreshIfMissing?: boolean } = {},
): Promise<ProviderCredentialRecordReadResult> {
  const cached = readCachedProviderCredentialRecord(agentName, provider)
  if (cached.ok || options.refreshIfMissing === false) return cached
  return resultForProvider(await refreshProviderCredentialPool(agentName), provider)
}

export async function upsertProviderCredential(input: ProviderCredentialUpsertInput): Promise<ProviderCredentialRecord> {
  const updatedAt = (input.now ?? new Date()).toISOString()
  const payload: ProviderCredentialVaultPayload = {
    schemaVersion: 1,
    kind: "provider-credential",
    provider: input.provider,
    updatedAt,
    credentials: { ...input.credentials },
    config: { ...input.config },
    provenance: {
      source: input.provenance.source,
      updatedAt,
    },
  }
  const record = recordFromPayload(payload)
  const store = getCredentialStore(input.agentName)
  await store.store(providerCredentialItemName(input.provider), {
    username: input.provider,
    password: JSON.stringify(payload),
    notes: "Ouro provider credentials. The vault item password is a versioned JSON payload.",
  })
  await refreshProviderCredentialPool(input.agentName)
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_credential_upserted",
    message: "upserted provider credential record in vault",
    meta: { agentName: input.agentName, provider: input.provider, revision: record.revision, source: record.provenance.source },
  })
  return record
}

export function redactProviderCredentialPool(pool: ProviderCredentialPool): ProviderCredentialPool {
  const providers: Partial<Record<AgentProvider, ProviderCredentialRecord>> = {}
  for (const [provider, record] of Object.entries(pool.providers) as Array<[AgentProvider, ProviderCredentialRecord]>) {
    const redactedCredentials: Record<string, string> = {}
    for (const key of Object.keys(record.credentials)) {
      redactedCredentials[key] = "[redacted]"
    }
    providers[provider] = {
      ...record,
      credentials: redactedCredentials,
      config: { ...record.config },
      provenance: { ...record.provenance },
    }
  }
  return {
    ...pool,
    providers,
  }
}

export function summarizeProviderCredentialPool(pool: ProviderCredentialPool): ProviderCredentialPoolSummary {
  return {
    providers: (Object.entries(pool.providers) as Array<[AgentProvider, ProviderCredentialRecord]>).map(([, record]) => ({
      provider: record.provider,
      revision: record.revision,
      source: record.provenance.source,
      updatedAt: record.updatedAt,
      credentialFields: Object.keys(record.credentials).sort(),
      configFields: Object.keys(record.config).sort(),
    })),
  }
}

export function resetProviderCredentialCache(): void {
  cachedPools = new Map()
}
