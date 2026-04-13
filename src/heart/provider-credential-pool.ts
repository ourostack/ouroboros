import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { AgentProvider } from "./identity"

export type ProviderCredentialProvenanceSource = "auth-flow" | "legacy-agent-secrets" | "manual"

export interface ProviderCredentialProvenance {
  source: ProviderCredentialProvenanceSource
  contributedByAgent?: string
  updatedAt: string
}

export interface ProviderCredentialRecord {
  provider: AgentProvider
  revision: string
  updatedAt: string
  credentials: Record<string, string | number | boolean>
  config: Record<string, string | number | boolean>
  provenance: ProviderCredentialProvenance
}

export interface ProviderCredentialPool {
  schemaVersion: 1
  updatedAt: string
  providers: Partial<Record<AgentProvider, ProviderCredentialRecord>>
}

export type ProviderCredentialPoolReadResult =
  | { ok: true; poolPath: string; pool: ProviderCredentialPool }
  | { ok: false; reason: "missing" | "invalid"; poolPath: string; error: string }

export interface ProviderCredentialInput {
  provider: AgentProvider
  credentials: Record<string, string | number | boolean>
  config: Record<string, string | number | boolean>
  provenance: {
    source: ProviderCredentialProvenanceSource
    contributedByAgent?: string
  }
}

export interface ProviderCredentialUpsertInput extends ProviderCredentialInput {
  homeDir?: string
  now?: Date
  makeRevision?: () => string
}

export interface LegacyProviderCredentialReadInput {
  homeDir?: string
  agentName: string
}

export interface LegacyProviderCredentialMigrationInput {
  homeDir?: string
  agentNames: string[]
  now?: Date
  makeRevision?: () => string
}

export interface LegacyProviderCredentialMigrationResult {
  poolPath: string
  migrated: Array<{ agentName: string; provider: AgentProvider; revision: string }>
}

export interface ProviderCredentialPoolSummary {
  providers: Array<{
    provider: AgentProvider
    revision: string
    source: ProviderCredentialProvenanceSource
    contributedByAgent?: string
    updatedAt: string
    credentialFields: string[]
    configFields: string[]
  }>
}

const VALID_PROVIDERS: AgentProvider[] = ["azure", "minimax", "anthropic", "openai-codex", "github-copilot"]
const VALID_PROVENANCE_SOURCES: ProviderCredentialProvenanceSource[] = ["auth-flow", "legacy-agent-secrets", "manual"]

const PROVIDER_FIELD_SPLITS: Record<AgentProvider, { credentials: string[]; config: string[]; meaningfulCredentials: string[] }> = {
  anthropic: {
    credentials: ["setupToken", "refreshToken", "expiresAt"],
    config: [],
    meaningfulCredentials: ["setupToken", "refreshToken"],
  },
  "openai-codex": {
    credentials: ["oauthAccessToken"],
    config: [],
    meaningfulCredentials: ["oauthAccessToken"],
  },
  azure: {
    credentials: ["apiKey"],
    config: ["endpoint", "deployment", "apiVersion", "managedIdentityClientId"],
    meaningfulCredentials: ["apiKey", "managedIdentityClientId"],
  },
  minimax: {
    credentials: ["apiKey"],
    config: [],
    meaningfulCredentials: ["apiKey"],
  },
  "github-copilot": {
    credentials: ["githubToken"],
    config: ["baseUrl"],
    meaningfulCredentials: ["githubToken"],
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isAgentProvider(value: string): value is AgentProvider {
  return (VALID_PROVIDERS as string[]).includes(value)
}

function isProvenanceSource(value: unknown): value is ProviderCredentialProvenanceSource {
  return typeof value === "string" && (VALID_PROVENANCE_SOURCES as string[]).includes(value)
}

function isCredentialValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function isPresentCredentialValue(value: unknown): value is string | number | boolean {
  if (!isCredentialValue(value)) return false
  if (typeof value === "string") return value.trim().length > 0
  if (typeof value === "number") return Number.isFinite(value) && value !== 0
  return true
}

function copyKnownFields(
  source: Record<string, unknown>,
  fields: string[],
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const value = source[field]
    if (isPresentCredentialValue(value)) {
      result[field] = value
    }
  }
  return result
}

function splitLegacyProviderConfig(
  provider: AgentProvider,
  rawConfig: Record<string, unknown>,
): { credentials: Record<string, string | number | boolean>; config: Record<string, string | number | boolean> } {
  const fields = PROVIDER_FIELD_SPLITS[provider]
  return {
    credentials: copyKnownFields(rawConfig, fields.credentials),
    config: copyKnownFields(rawConfig, fields.config),
  }
}

function legacyProviderHasCredentialData(provider: AgentProvider, rawConfig: Record<string, unknown>): boolean {
  const fields = PROVIDER_FIELD_SPLITS[provider]
  return fields.meaningfulCredentials.some((field) => isPresentCredentialValue(rawConfig[field]))
}

function makeEmptyProviderCredentialPool(now: Date): ProviderCredentialPool {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    providers: {},
  }
}

function makeRevision(): string {
  return `cred_${crypto.randomUUID()}`
}

export function getProviderCredentialPoolPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".agentsecrets", "providers.json")
}

export function validateProviderCredentialPool(value: unknown): ProviderCredentialPool {
  if (!isRecord(value)) {
    throw new Error("provider credential pool must be an object")
  }
  if (value.schemaVersion !== 1) {
    throw new Error("provider credential pool schemaVersion must be 1")
  }
  if (typeof value.updatedAt !== "string" || value.updatedAt.length === 0) {
    throw new Error("provider credential pool updatedAt must be a non-empty string")
  }
  if (!isRecord(value.providers)) {
    throw new Error("provider credential pool providers must be an object")
  }

  const providers = value.providers
  for (const [providerKey, rawRecord] of Object.entries(providers)) {
    if (!isAgentProvider(providerKey)) {
      throw new Error(`provider credential pool has unsupported provider ${providerKey}`)
    }
    if (!isRecord(rawRecord)) {
      throw new Error(`${providerKey} credential record must be an object`)
    }
    if (rawRecord.provider !== providerKey) {
      throw new Error(`${providerKey}.provider must match its provider key`)
    }
    if (typeof rawRecord.revision !== "string" || rawRecord.revision.length === 0) {
      throw new Error(`${providerKey}.revision must be a non-empty string`)
    }
    if (typeof rawRecord.updatedAt !== "string" || rawRecord.updatedAt.length === 0) {
      throw new Error(`${providerKey}.updatedAt must be a non-empty string`)
    }
    if (!isRecord(rawRecord.credentials)) {
      throw new Error(`${providerKey}.credentials must be an object`)
    }
    if (!isRecord(rawRecord.config)) {
      throw new Error(`${providerKey}.config must be an object`)
    }
    for (const [field, fieldValue] of Object.entries(rawRecord.credentials)) {
      if (!isCredentialValue(fieldValue)) {
        throw new Error(`${providerKey}.credentials.${field} must be a string, number, or boolean`)
      }
    }
    for (const [field, fieldValue] of Object.entries(rawRecord.config)) {
      if (!isCredentialValue(fieldValue)) {
        throw new Error(`${providerKey}.config.${field} must be a string, number, or boolean`)
      }
    }
    if (!isRecord(rawRecord.provenance)) {
      throw new Error(`${providerKey}.provenance must be an object`)
    }
    if (!isProvenanceSource(rawRecord.provenance.source)) {
      throw new Error(`${providerKey}.provenance.source must be auth-flow, legacy-agent-secrets, or manual`)
    }
    const contributedByAgent = rawRecord.provenance.contributedByAgent
    if (contributedByAgent !== undefined && typeof contributedByAgent !== "string") {
      throw new Error(`${providerKey}.provenance.contributedByAgent must be a string when present`)
    }
    if (typeof rawRecord.provenance.updatedAt !== "string" || rawRecord.provenance.updatedAt.length === 0) {
      throw new Error(`${providerKey}.provenance.updatedAt must be a non-empty string`)
    }
  }

  return value as unknown as ProviderCredentialPool
}

export function readProviderCredentialPool(homeDir = os.homedir()): ProviderCredentialPoolReadResult {
  const poolPath = getProviderCredentialPoolPath(homeDir)
  try {
    const raw = fs.readFileSync(poolPath, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    const pool = validateProviderCredentialPool(parsed)
    emitNervesEvent({
      component: "config/identity",
      event: "config.provider_credential_pool_read",
      message: "read provider credential pool",
      meta: { poolPath },
    })
    return { ok: true, poolPath, pool }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      emitNervesEvent({
        component: "config/identity",
        event: "config.provider_credential_pool_missing",
        message: "provider credential pool not found",
        meta: { poolPath },
      })
      return {
        ok: false,
        reason: "missing",
        poolPath,
        error: "provider credential pool not found",
      }
    }
    emitNervesEvent({
      level: "error",
      component: "config/identity",
      event: "config.provider_credential_pool_invalid",
      message: "provider credential pool invalid",
      meta: { poolPath, reason: error instanceof Error ? error.message : String(error) },
    })
    return {
      ok: false,
      reason: "invalid",
      poolPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function writeProviderCredentialPool(homeDir: string, pool: ProviderCredentialPool): void {
  const validated = validateProviderCredentialPool(pool)
  const poolPath = getProviderCredentialPoolPath(homeDir)
  fs.mkdirSync(path.dirname(poolPath), { recursive: true })
  fs.writeFileSync(poolPath, `${JSON.stringify(validated, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_credential_pool_written",
    message: "wrote provider credential pool",
    meta: { poolPath, providerCount: Object.keys(validated.providers).length },
  })
}

export function upsertProviderCredential(input: ProviderCredentialUpsertInput): ProviderCredentialRecord {
  const homeDir = input.homeDir ?? os.homedir()
  const now = input.now ?? new Date()
  const updatedAt = now.toISOString()
  const readResult = readProviderCredentialPool(homeDir)
  const pool = readResult.ok ? readResult.pool : makeEmptyProviderCredentialPool(now)
  if (!readResult.ok && readResult.reason === "invalid") {
    throw new Error(`Cannot update invalid provider credential pool at ${readResult.poolPath}: ${readResult.error}`)
  }

  const record: ProviderCredentialRecord = {
    provider: input.provider,
    revision: (input.makeRevision ?? makeRevision)(),
    updatedAt,
    credentials: { ...input.credentials },
    config: { ...input.config },
    provenance: {
      ...input.provenance,
      updatedAt,
    },
  }
  pool.updatedAt = updatedAt
  pool.providers[input.provider] = record
  writeProviderCredentialPool(homeDir, pool)
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_credential_upserted",
    message: "upserted provider credential record",
    meta: { provider: input.provider, revision: record.revision, source: record.provenance.source },
  })
  return record
}

export function redactProviderCredentialPool(pool: ProviderCredentialPool): ProviderCredentialPool {
  const validated = validateProviderCredentialPool(pool)
  const providers: Partial<Record<AgentProvider, ProviderCredentialRecord>> = {}
  for (const [provider, record] of Object.entries(validated.providers) as Array<[AgentProvider, ProviderCredentialRecord]>) {
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
    ...validated,
    providers,
  }
}

export function summarizeProviderCredentialPool(pool: ProviderCredentialPool): ProviderCredentialPoolSummary {
  const validated = validateProviderCredentialPool(pool)
  return {
    providers: (Object.entries(validated.providers) as Array<[AgentProvider, ProviderCredentialRecord]>).map(([, record]) => ({
      provider: record.provider,
      revision: record.revision,
      source: record.provenance.source,
      contributedByAgent: record.provenance.contributedByAgent,
      updatedAt: record.updatedAt,
      credentialFields: Object.keys(record.credentials).sort(),
      configFields: Object.keys(record.config).sort(),
    })),
  }
}

export function readLegacyAgentProviderCredentials(
  input: LegacyProviderCredentialReadInput,
): ProviderCredentialInput[] {
  const homeDir = input.homeDir ?? os.homedir()
  const secretsPath = path.join(homeDir, ".agentsecrets", input.agentName, "secrets.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(secretsPath, "utf-8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw new Error(`Failed to read legacy provider credentials for ${input.agentName}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    return []
  }

  const candidates: ProviderCredentialInput[] = []
  for (const [providerKey, rawProviderConfig] of Object.entries(parsed.providers)) {
    if (!isAgentProvider(providerKey) || !isRecord(rawProviderConfig)) {
      continue
    }
    if (!legacyProviderHasCredentialData(providerKey, rawProviderConfig)) {
      continue
    }
    const { credentials, config } = splitLegacyProviderConfig(providerKey, rawProviderConfig)
    candidates.push({
      provider: providerKey,
      credentials,
      config,
      provenance: {
        source: "legacy-agent-secrets",
        contributedByAgent: input.agentName,
      },
    })
  }

  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_credential_legacy_read",
    message: "read legacy provider credential candidates",
    meta: { agentName: input.agentName, providerCount: candidates.length },
  })
  return candidates
}

export function migrateLegacyAgentProviderCredentials(
  input: LegacyProviderCredentialMigrationInput,
): LegacyProviderCredentialMigrationResult {
  const homeDir = input.homeDir ?? os.homedir()
  const migrated: LegacyProviderCredentialMigrationResult["migrated"] = []
  for (const agentName of input.agentNames) {
    const candidates = readLegacyAgentProviderCredentials({ homeDir, agentName })
    for (const candidate of candidates) {
      const record = upsertProviderCredential({
        homeDir,
        provider: candidate.provider,
        credentials: candidate.credentials,
        config: candidate.config,
        provenance: candidate.provenance,
        now: input.now,
        makeRevision: input.makeRevision,
      })
      migrated.push({ agentName, provider: candidate.provider, revision: record.revision })
    }
  }
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_credential_legacy_migrated",
    message: "migrated legacy provider credentials",
    meta: { migratedCount: migrated.length },
  })
  return {
    poolPath: getProviderCredentialPoolPath(homeDir),
    migrated,
  }
}
