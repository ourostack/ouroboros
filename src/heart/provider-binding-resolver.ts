import { emitNervesEvent } from "../nerves/runtime"
import type { AgentProvider } from "./identity"
import {
  readProviderCredentialPool,
  type ProviderCredentialPoolReadResult,
  type ProviderCredentialRecord,
  type ProviderCredentialProvenanceSource,
} from "./provider-credentials"
import {
  readProviderState,
  type ProviderBindingSource,
  type ProviderLane,
  type ProviderLaneReadiness,
  type ProviderReadinessStatus,
} from "./provider-state"

export type ProviderLaneSelector = ProviderLane | "human" | "agent" | "humanFacing" | "agentFacing"

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

export interface EffectiveProviderReadiness {
  status: ProviderReadinessStatus
  previousStatus?: ProviderReadinessStatus
  reason?: "credential-missing" | "credential-pool-invalid" | "credential-revision-changed" | "provider-model-changed"
  checkedAt?: string
  credentialRevision?: string
  error?: string
  attempts?: number
}

export interface EffectiveProviderBinding {
  lane: ProviderLane
  provider: AgentProvider
  model: string
  source: ProviderBindingSource
  machineId: string
  statePath: string
  credential: EffectiveProviderCredentialStatus
  readiness: EffectiveProviderReadiness
  warnings: EffectiveProviderBindingWarning[]
}

export type ResolveEffectiveProviderBindingResult =
  | { ok: true; binding: EffectiveProviderBinding }
  | {
    ok: false
    lane: ProviderLane
    reason: "provider-state-missing" | "provider-state-invalid"
    statePath: string
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

function buildUseRepair(agentName: string, lane: ProviderLane, force = false): EffectiveProviderRepair {
  return {
    command: `ouro use --agent ${agentName} --lane ${lane} --provider <provider> --model <model>${force ? " --force" : ""}`,
    message: force
      ? `Rewrite this machine's ${lane} provider binding for ${agentName}.`
      : `Choose the provider/model this machine should use for ${agentName}'s ${lane} lane.`,
  }
}

function buildAuthRepair(agentName: string, provider: AgentProvider): EffectiveProviderRepair {
  return {
    command: `ouro auth --agent ${agentName} --provider ${provider}`,
    message: `Store ${provider} credentials in ${agentName}'s vault.`,
  }
}

function missingProviderStateWarning(agentName: string): EffectiveProviderBindingWarning {
  return {
    code: "provider-state-missing",
    message: `No local provider binding exists for ${agentName} on this machine.`,
  }
}

function invalidProviderStateWarning(agentName: string): EffectiveProviderBindingWarning {
  return {
    code: "provider-state-invalid",
    message: `Local provider binding state for ${agentName} is invalid.`,
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

function readinessFromState(readiness: ProviderLaneReadiness): EffectiveProviderReadiness {
  return {
    status: readiness.status,
    checkedAt: readiness.checkedAt,
    credentialRevision: readiness.credentialRevision,
    error: readiness.error,
    attempts: readiness.attempts,
  }
}

function staleReadiness(
  readiness: ProviderLaneReadiness,
  reason: EffectiveProviderReadiness["reason"],
): EffectiveProviderReadiness {
  return {
    ...readinessFromState(readiness),
    status: "stale",
    previousStatus: readiness.status,
    reason,
  }
}

function resolveReadiness(input: {
  provider: AgentProvider
  model: string
  readiness?: ProviderLaneReadiness
  credential: EffectiveProviderCredentialStatus
}): { readiness: EffectiveProviderReadiness; warnings: EffectiveProviderBindingWarning[] } {
  if (!input.readiness) {
    if (input.credential.status === "missing") {
      return { readiness: { status: "unknown", reason: "credential-missing" }, warnings: [] }
    }
    if (input.credential.status === "invalid-pool") {
      return { readiness: { status: "unknown", reason: "credential-pool-invalid" }, warnings: [] }
    }
    return { readiness: { status: "unknown" }, warnings: [] }
  }

  if (input.readiness.provider !== input.provider || input.readiness.model !== input.model) {
    return {
      readiness: staleReadiness(input.readiness, "provider-model-changed"),
      warnings: [{
        code: "readiness-stale",
        message: `${input.provider}/${input.model} readiness is stale because the last check was for ${input.readiness.provider}/${input.readiness.model}.`,
      }],
    }
  }

  if (
    input.credential.status === "present"
    && input.readiness.credentialRevision !== undefined
    && input.readiness.credentialRevision !== input.credential.revision
  ) {
    return {
      readiness: staleReadiness(input.readiness, "credential-revision-changed"),
      warnings: [{
        code: "readiness-stale",
        message: `${input.provider}/${input.model} readiness is stale because credential revision changed from ${input.readiness.credentialRevision} to ${input.credential.revision}.`,
      }],
    }
  }

  if (input.credential.status === "missing") {
    return {
      readiness: staleReadiness(input.readiness, "credential-missing"),
      warnings: [],
    }
  }

  if (input.credential.status === "invalid-pool") {
    return {
      readiness: staleReadiness(input.readiness, "credential-pool-invalid"),
      warnings: [],
    }
  }

  return { readiness: readinessFromState(input.readiness), warnings: [] }
}

export function resolveEffectiveProviderBinding(
  input: ResolveEffectiveProviderBindingInput,
): ResolveEffectiveProviderBindingResult {
  const laneResolution = normalizeProviderLane(input.lane)
  const stateResult = readProviderState(input.agentRoot)

  if (!stateResult.ok) {
    const reason = stateResult.reason === "missing" ? "provider-state-missing" : "provider-state-invalid"
    const stateWarning = stateResult.reason === "missing"
      ? missingProviderStateWarning(input.agentName)
      : invalidProviderStateWarning(input.agentName)
    const result: ResolveEffectiveProviderBindingResult = {
      ok: false,
      lane: laneResolution.lane,
      reason,
      statePath: stateResult.statePath,
      warnings: [...laneResolution.warnings, stateWarning],
      repair: buildUseRepair(input.agentName, laneResolution.lane, stateResult.reason === "invalid"),
    }
    emitNervesEvent({
      component: "config/identity",
      event: "config.provider_binding_resolution_failed",
      message: "provider binding resolution failed",
      meta: { agentName: input.agentName, lane: laneResolution.lane, reason },
    })
    return result
  }

  const laneBinding = stateResult.state.lanes[laneResolution.lane]
  const poolResult = readProviderCredentialPool(input.agentName)
  const credentialResult = resolveCredential(poolResult, laneBinding.provider, input.agentName)
  const readinessResult = resolveReadiness({
    provider: laneBinding.provider,
    model: laneBinding.model,
    readiness: stateResult.state.readiness[laneResolution.lane],
    credential: credentialResult.credential,
  })
  const warnings = [
    ...laneResolution.warnings,
    ...credentialResult.warnings,
    ...readinessResult.warnings,
  ]

  const binding: EffectiveProviderBinding = {
    lane: laneResolution.lane,
    provider: laneBinding.provider,
    model: laneBinding.model,
    source: laneBinding.source,
    machineId: stateResult.state.machineId,
    statePath: stateResult.statePath,
    credential: credentialResult.credential,
    readiness: readinessResult.readiness,
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
