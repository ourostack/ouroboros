import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "./identity"
import { readAgentConfigForAgent } from "./auth/auth-flow"
import type { ProviderLane, ProviderLaneSelector, ProviderReadinessStatus } from "./provider-lanes"
import {
  readProviderCredentialPool,
  isProviderCredentialPoolNotLoaded,
  type ProviderCredentialPoolReadResult,
  type ProviderCredentialRecord,
  type ProviderCredentialProvenanceSource,
} from "./provider-credentials"
import { readProviderLaneReadiness } from "./provider-readiness-cache"

export type { ProviderLaneSelector } from "./provider-lanes"

export interface EffectiveProviderBindingWarning {
  code: string
  message: string
}

export interface ProviderLaneResolution {
  lane: ProviderLane
  warnings: EffectiveProviderBindingWarning[]
}

export interface EffectiveProviderRepair {
  command: string
  message: string
}

export type EffectiveProviderCredentialStatus =
  | {
    status: "present"
    provider: AgentProvider
    revision: string
    source: ProviderCredentialProvenanceSource
    updatedAt: string
    credentialFields: string[]
    configFields: string[]
  }
  | {
    status: "missing"
    provider: AgentProvider
    poolPath: string
    repair: EffectiveProviderRepair
  }
  | {
    status: "invalid-pool"
    provider: AgentProvider
    poolPath: string
    error: string
    repair: EffectiveProviderRepair
  }
  | {
    status: "not-loaded"
    provider: AgentProvider
    poolPath: string
  }

export interface EffectiveProviderReadiness {
  status: ProviderReadinessStatus
  reason?: "credential-missing" | "credential-pool-invalid"
  checkedAt?: string
  error?: string
  attempts?: number
}

export interface EffectiveProviderBinding {
  lane: ProviderLane
  provider: AgentProvider
  model: string
  source: "agent.json"
  configPath: string
  credential: EffectiveProviderCredentialStatus
  readiness: EffectiveProviderReadiness
  warnings: EffectiveProviderBindingWarning[]
}

export type ResolveEffectiveProviderBindingResult =
  | { ok: true; binding: EffectiveProviderBinding }
  | {
    ok: false
    lane: ProviderLane
    reason: "agent-config-invalid"
    configPath: string
    error: string
    warnings: EffectiveProviderBindingWarning[]
    repair: EffectiveProviderRepair
  }

export interface ResolveEffectiveProviderBindingInput {
  agentName: string
  agentRoot: string
  homeDir?: string
  lane: ProviderLaneSelector
}

function legacyLaneWarning(selector: string, lane: ProviderLane): EffectiveProviderBindingWarning {
  return {
    code: "legacy-lane-selector",
    message: `${selector} is legacy provider wording; using ${lane} lane`,
  }
}

function facingKeyForProviderLane(lane: ProviderLane): "humanFacing" | "agentFacing" {
  return lane === "outward" ? "humanFacing" : "agentFacing"
}

export function normalizeProviderLane(selector: ProviderLaneSelector): ProviderLaneResolution {
  switch (selector) {
    case "outward":
      return { lane: "outward", warnings: [] }
    case "inner":
      return { lane: "inner", warnings: [] }
    case "human":
    case "humanFacing":
      return { lane: "outward", warnings: [legacyLaneWarning(selector, "outward")] }
    case "agent":
    case "agentFacing":
      return { lane: "inner", warnings: [legacyLaneWarning(selector, "inner")] }
  }
}

function buildUseRepair(agentName: string, lane: ProviderLane): EffectiveProviderRepair {
  return {
    command: `ouro use --agent ${agentName} --lane ${lane} --provider <provider> --model <model>`,
    message: `Choose the provider/model ${agentName}'s ${lane} lane should use in agent.json.`,
  }
}

function buildAuthRepair(agentName: string, provider: AgentProvider): EffectiveProviderRepair {
  return {
    command: `ouro auth --agent ${agentName} --provider ${provider}`,
    message: `Store ${provider} credentials in ${agentName}'s vault.`,
  }
}

function invalidAgentConfigWarning(agentName: string, error: string): EffectiveProviderBindingWarning {
  return {
    code: "agent-config-invalid",
    message: `agent.json provider selection for ${agentName} is invalid: ${error}`,
  }
}

function missingCredentialWarning(provider: AgentProvider): EffectiveProviderBindingWarning {
  return {
    code: "credential-missing",
    message: `${provider} has no credential record in the agent vault.`,
  }
}

function invalidCredentialPoolWarning(provider: AgentProvider): EffectiveProviderBindingWarning {
  return {
    code: "credential-pool-invalid",
    message: `${provider} cannot read credentials from the agent vault.`,
  }
}

function presentCredential(record: ProviderCredentialRecord): EffectiveProviderCredentialStatus {
  return {
    status: "present",
    provider: record.provider,
    revision: record.revision,
    source: record.provenance.source,
    updatedAt: record.updatedAt,
    credentialFields: Object.keys(record.credentials).sort(),
    configFields: Object.keys(record.config).sort(),
  }
}

function resolveCredential(
  poolResult: ProviderCredentialPoolReadResult,
  provider: AgentProvider,
  agentName: string,
): { credential: EffectiveProviderCredentialStatus; warnings: EffectiveProviderBindingWarning[] } {
  if (poolResult.ok) {
    const record = poolResult.pool.providers[provider]
    if (record) return { credential: presentCredential(record), warnings: [] }
    return {
      credential: {
        status: "missing",
        provider,
        poolPath: poolResult.poolPath,
        repair: buildAuthRepair(agentName, provider),
      },
      warnings: [missingCredentialWarning(provider)],
    }
  }

  if (isProviderCredentialPoolNotLoaded(poolResult)) {
    return {
      credential: {
        status: "not-loaded",
        provider,
        poolPath: poolResult.poolPath,
      },
      warnings: [],
    }
  }

  if (poolResult.reason === "invalid" || poolResult.reason === "unavailable") {
    return {
      credential: {
        status: "invalid-pool",
        provider,
        poolPath: poolResult.poolPath,
        error: poolResult.error,
        repair: buildAuthRepair(agentName, provider),
      },
      warnings: [invalidCredentialPoolWarning(provider)],
    }
  }

  return {
    credential: {
      status: "missing",
      provider,
      poolPath: poolResult.poolPath,
      repair: buildAuthRepair(agentName, provider),
    },
    warnings: [missingCredentialWarning(provider)],
  }
}

function resolveReadiness(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  credential: EffectiveProviderCredentialStatus,
): EffectiveProviderReadiness {
  if (credential.status === "missing") {
    return { status: "unknown", reason: "credential-missing" }
  }
  if (credential.status === "invalid-pool") {
    return { status: "unknown", reason: "credential-pool-invalid" }
  }
  if (credential.status === "present") {
    const cached = readProviderLaneReadiness({
      agentName,
      lane,
      provider,
      model,
      credentialRevision: credential.revision,
    })
    if (cached) {
      return {
        status: cached.status,
        checkedAt: cached.checkedAt,
        ...(cached.error ? { error: cached.error } : {}),
        ...(cached.attempts !== undefined ? { attempts: cached.attempts } : {}),
      }
    }
  }
  return { status: "unknown" }
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIALS, value)
}

function resolveAgentConfigLane(input: ResolveEffectiveProviderBindingInput, lane: ProviderLane): {
  ok: true
  configPath: string
  provider: AgentProvider
  model: string
} | {
  ok: false
  configPath: string
  error: string
} {
  const configPath = path.join(input.agentRoot, "agent.json")
  try {
    const { config, configPath: resolvedConfigPath } = readAgentConfigForAgent(input.agentName, path.dirname(input.agentRoot))
    const facingKey = facingKeyForProviderLane(lane)
    const binding = config[facingKey]
    /* v8 ignore next -- readAgentConfigForAgent rejects unsupported providers before this defensive guard @preserve */
    if (!isAgentProvider(binding.provider)) {
      return { ok: false, configPath: resolvedConfigPath, error: `${facingKey}.provider must be a supported provider` }
    }
    const model = typeof binding.model === "string" ? binding.model.trim() : ""
    if (model.length === 0) {
      return { ok: false, configPath: resolvedConfigPath, error: `${facingKey}.model must be a non-empty string` }
    }
    return {
      ok: true,
      configPath: resolvedConfigPath,
      provider: binding.provider,
      model,
    }
  } catch (error) {
    return {
      ok: false,
      configPath,
      /* v8 ignore next -- readAgentConfigForAgent/file IO failures are Error instances in supported runtimes @preserve */
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function resolveEffectiveProviderBinding(
  input: ResolveEffectiveProviderBindingInput,
): ResolveEffectiveProviderBindingResult {
  const laneResolution = normalizeProviderLane(input.lane)
  const agentConfigResult = resolveAgentConfigLane(input, laneResolution.lane)

  if (!agentConfigResult.ok) {
    const result: ResolveEffectiveProviderBindingResult = {
      ok: false,
      lane: laneResolution.lane,
      reason: "agent-config-invalid",
      configPath: agentConfigResult.configPath,
      error: agentConfigResult.error,
      warnings: [...laneResolution.warnings, invalidAgentConfigWarning(input.agentName, agentConfigResult.error)],
      repair: buildUseRepair(input.agentName, laneResolution.lane),
    }
    emitNervesEvent({
      component: "config/identity",
      event: "config.provider_binding_resolution_failed",
      message: "provider binding resolution failed",
      meta: { agentName: input.agentName, lane: laneResolution.lane, reason: result.reason },
    })
    return result
  }

  const poolResult = readProviderCredentialPool(input.agentName)
  const credentialResult = resolveCredential(poolResult, agentConfigResult.provider, input.agentName)
  const readiness = resolveReadiness(
    input.agentName,
    laneResolution.lane,
    agentConfigResult.provider,
    agentConfigResult.model,
    credentialResult.credential,
  )
  const warnings = [
    ...laneResolution.warnings,
    ...credentialResult.warnings,
  ]

  const binding: EffectiveProviderBinding = {
    lane: laneResolution.lane,
    provider: agentConfigResult.provider,
    model: agentConfigResult.model,
    source: "agent.json",
    configPath: agentConfigResult.configPath,
    credential: credentialResult.credential,
    readiness,
    warnings,
  }
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_binding_resolved",
    message: "resolved effective provider binding",
    meta: {
      agentName: input.agentName,
      lane: binding.lane,
      provider: binding.provider,
      model: binding.model,
      credentialStatus: binding.credential.status,
      readinessStatus: binding.readiness.status,
      warningCount: warnings.length,
    },
  })
  return { ok: true, binding }
}
