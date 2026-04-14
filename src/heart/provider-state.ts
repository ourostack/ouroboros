import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "./identity"

export type ProviderLane = "outward" | "inner"
export type ProviderBindingSource = "bootstrap" | "local"
export type ProviderReadinessStatus = "ready" | "failed" | "stale" | "unknown"

export interface ProviderBinding {
  provider: AgentProvider
  model: string
  source: ProviderBindingSource
  updatedAt: string
}

export interface ProviderLaneReadiness {
  status: ProviderReadinessStatus
  provider: AgentProvider
  model: string
  checkedAt?: string
  credentialRevision?: string
  error?: string
  attempts?: number
}

export interface ProviderState {
  schemaVersion: 1
  machineId: string
  updatedAt: string
  lanes: Record<ProviderLane, ProviderBinding>
  readiness: Partial<Record<ProviderLane, ProviderLaneReadiness>>
}

export type ProviderStateReadResult =
  | { ok: true; statePath: string; state: ProviderState }
  | { ok: false; statePath: string; reason: "missing" | "invalid"; error: string }

export interface BootstrapProviderStateInput {
  machineId: string
  now: Date
  agentConfig: {
    humanFacing: { provider: AgentProvider; model: string }
    agentFacing: { provider: AgentProvider; model: string }
  }
}

const LANES: ProviderLane[] = ["outward", "inner"]
const VALID_SOURCES = new Set<ProviderBindingSource>(["bootstrap", "local"])
const VALID_READINESS = new Set<ProviderReadinessStatus>(["ready", "failed", "stale", "unknown"])

function isProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIALS, value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function validateBinding(value: unknown, label: string): ProviderBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (!isProvider(record.provider)) throw new Error(`${label}.provider must be a valid provider`)
  if (!isNonEmptyString(record.model)) throw new Error(`${label}.model must be a non-empty string`)
  if (!VALID_SOURCES.has(record.source as ProviderBindingSource)) {
    throw new Error(`${label}.source must be bootstrap or local`)
  }
  if (!isNonEmptyString(record.updatedAt)) throw new Error(`${label}.updatedAt must be a non-empty string`)

  return {
    provider: record.provider,
    model: record.model,
    source: record.source as ProviderBindingSource,
    updatedAt: record.updatedAt,
  }
}

function validateReadiness(value: unknown, label: string): ProviderLaneReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  if (!VALID_READINESS.has(record.status as ProviderReadinessStatus)) {
    throw new Error(`${label}.status must be ready, failed, stale, or unknown`)
  }
  if (!isProvider(record.provider)) throw new Error(`${label}.provider must be a valid provider`)
  if (!isNonEmptyString(record.model)) throw new Error(`${label}.model must be a non-empty string`)
  if (record.checkedAt !== undefined && typeof record.checkedAt !== "string") {
    throw new Error(`${label}.checkedAt must be a string when present`)
  }
  if (record.credentialRevision !== undefined && typeof record.credentialRevision !== "string") {
    throw new Error(`${label}.credentialRevision must be a string when present`)
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    throw new Error(`${label}.error must be a string when present`)
  }
  if (record.attempts !== undefined && typeof record.attempts !== "number") {
    throw new Error(`${label}.attempts must be a number when present`)
  }

  return {
    status: record.status as ProviderReadinessStatus,
    provider: record.provider,
    model: record.model,
    ...(record.checkedAt !== undefined ? { checkedAt: record.checkedAt as string } : {}),
    ...(record.credentialRevision !== undefined ? { credentialRevision: record.credentialRevision as string } : {}),
    ...(record.error !== undefined ? { error: record.error as string } : {}),
    ...(record.attempts !== undefined ? { attempts: record.attempts as number } : {}),
  }
}

export function validateProviderState(value: unknown): ProviderState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider state must be an object")
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new Error("schemaVersion must be 1")
  if (!isNonEmptyString(record.machineId)) throw new Error("machineId must be a non-empty string")
  if (!isNonEmptyString(record.updatedAt)) throw new Error("updatedAt must be a non-empty string")
  if (!record.lanes || typeof record.lanes !== "object" || Array.isArray(record.lanes)) {
    throw new Error("lanes must be an object")
  }

  const rawLanes = record.lanes as Record<string, unknown>
  const lanes = {
    outward: validateBinding(rawLanes.outward, "outward"),
    inner: validateBinding(rawLanes.inner, "inner"),
  }

  if (!record.readiness || typeof record.readiness !== "object" || Array.isArray(record.readiness)) {
    throw new Error("readiness must be an object")
  }
  const rawReadiness = record.readiness as Record<string, unknown>
  const readiness: Partial<Record<ProviderLane, ProviderLaneReadiness>> = {}
  for (const lane of LANES) {
    if (rawReadiness[lane] !== undefined) {
      readiness[lane] = validateReadiness(rawReadiness[lane], `${lane}.readiness`)
    }
  }

  return {
    schemaVersion: 1,
    machineId: record.machineId,
    updatedAt: record.updatedAt,
    lanes,
    readiness,
  }
}

export function getProviderStatePath(agentRoot: string): string {
  return path.join(agentRoot, "state", "providers.json")
}

export function readProviderState(agentRoot: string): ProviderStateReadResult {
  const statePath = getProviderStatePath(agentRoot)
  let raw: string
  try {
    if (!fs.existsSync(statePath)) {
      return { ok: false, reason: "missing", statePath, error: "provider state not found" }
    }
  } catch (error) {
    return { ok: false, reason: "invalid", statePath, error: String(error) }
  }
  try {
    raw = fs.readFileSync(statePath, "utf-8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { ok: false, reason: "missing", statePath, error: "provider state not found" }
    }
    return { ok: false, reason: "invalid", statePath, error: String(error) }
  }

  try {
    const state = validateProviderState(JSON.parse(raw) as unknown)
    emitNervesEvent({
      component: "config/identity",
      event: "config.provider_state_read",
      message: "read provider state",
      meta: { statePath, machineId: state.machineId },
    })
    return { ok: true, statePath, state }
  } catch (error) {
    return { ok: false, reason: "invalid", statePath, error: String(error) }
  }
}

export function writeProviderState(agentRoot: string, state: ProviderState): void {
  const statePath = getProviderStatePath(agentRoot)
  const validated = validateProviderState(state)
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(validated, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_state_written",
    message: "wrote provider state",
    meta: { statePath, machineId: validated.machineId },
  })
}

function binding(provider: AgentProvider, model: string, updatedAt: string): ProviderBinding {
  return {
    provider,
    model,
    source: "bootstrap",
    updatedAt,
  }
}

export function bootstrapProviderStateFromAgentConfig(input: BootstrapProviderStateInput): ProviderState {
  const updatedAt = input.now.toISOString()
  return {
    schemaVersion: 1,
    machineId: input.machineId,
    updatedAt,
    lanes: {
      outward: binding(input.agentConfig.humanFacing.provider, input.agentConfig.humanFacing.model, updatedAt),
      inner: binding(input.agentConfig.agentFacing.provider, input.agentConfig.agentFacing.model, updatedAt),
    },
    readiness: {},
  }
}
