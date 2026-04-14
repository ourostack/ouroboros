import { emitNervesEvent } from "../nerves/runtime"
import type { AgentProvider } from "./identity"
import {
  resolveEffectiveProviderBinding,
  type EffectiveProviderBinding,
} from "./provider-binding-resolver"
import type {
  ProviderBindingSource,
  ProviderLane,
  ProviderReadinessStatus,
} from "./provider-state"

export type ProviderVisibilityStatus = "configured" | "unconfigured"

export interface ProviderVisibilityCredential {
  status: "present" | "missing" | "invalid-pool"
  source?: string
  revision?: string
  repairCommand?: string
}

export interface ProviderVisibilityReadiness {
  status: ProviderReadinessStatus | "unknown"
  checkedAt?: string
  error?: string
  reason?: string
  attempts?: number
}

interface ProviderVisibilityConfiguredLane {
  lane: ProviderLane
  status: "configured"
  provider: AgentProvider
  model: string
  source: ProviderBindingSource
  readiness: ProviderVisibilityReadiness
  credential: ProviderVisibilityCredential
  warnings: string[]
}

interface ProviderVisibilityUnconfiguredLane {
  lane: ProviderLane
  status: "unconfigured"
  provider: "unconfigured"
  model: "-"
  source: "missing"
  readiness: ProviderVisibilityReadiness
  credential: ProviderVisibilityCredential
  repairCommand: string
  reason: string
  warnings: string[]
}

export type ProviderVisibilityLane = ProviderVisibilityConfiguredLane | ProviderVisibilityUnconfiguredLane

export interface AgentProviderVisibility {
  agentName: string
  lanes: ProviderVisibilityLane[]
}

export interface BuildAgentProviderVisibilityInput {
  agentName: string
  agentRoot: string
  homeDir?: string
}

export interface ProviderStatusRow {
  agent: string
  lane: ProviderLane
  provider: string
  model: string
  source: string
  readiness: string
  detail?: string
  credential: string
}

const LANES: ProviderLane[] = ["outward", "inner"]

function credentialVisibility(binding: EffectiveProviderBinding): ProviderVisibilityCredential {
  const credential = binding.credential
  if (credential.status === "present") {
    return {
      status: "present",
      source: credential.source,
      revision: credential.revision,
    }
  }

  return {
    status: credential.status,
    repairCommand: credential.repair.command,
  }
}

function readinessVisibility(binding: EffectiveProviderBinding): ProviderVisibilityReadiness {
  return {
    status: binding.readiness.status,
    ...(binding.readiness.checkedAt ? { checkedAt: binding.readiness.checkedAt } : {}),
    ...(binding.readiness.error ? { error: binding.readiness.error } : {}),
    ...(binding.readiness.reason ? { reason: binding.readiness.reason } : {}),
    ...(binding.readiness.attempts !== undefined ? { attempts: binding.readiness.attempts } : {}),
  }
}

function visibilityForLane(input: BuildAgentProviderVisibilityInput, lane: ProviderLane): ProviderVisibilityLane {
  const resolved = resolveEffectiveProviderBinding({ ...input, lane })
  if (!resolved.ok) {
    return {
      lane,
      status: "unconfigured",
      provider: "unconfigured",
      model: "-",
      source: "missing",
      readiness: {
        status: "unknown",
        reason: resolved.reason,
      },
      credential: {
        status: "missing",
        repairCommand: resolved.repair.command,
      },
      repairCommand: resolved.repair.command,
      reason: resolved.reason,
      warnings: resolved.warnings.map((warning) => warning.message),
    }
  }

  return {
    lane,
    status: "configured",
    provider: resolved.binding.provider,
    model: resolved.binding.model,
    source: resolved.binding.source,
    readiness: readinessVisibility(resolved.binding),
    credential: credentialVisibility(resolved.binding),
    warnings: resolved.binding.warnings.map((warning) => warning.message),
  }
}

export function buildAgentProviderVisibility(input: BuildAgentProviderVisibilityInput): AgentProviderVisibility {
  const visibility = {
    agentName: input.agentName,
    lanes: LANES.map((lane) => visibilityForLane(input, lane)),
  }

  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_visibility_built",
    message: "built provider visibility summary",
    meta: {
      agentName: input.agentName,
      laneStatuses: visibility.lanes.map((lane) => `${lane.lane}:${lane.status}`).join(","),
    },
  })

  return visibility
}

function credentialLabel(credential: ProviderVisibilityCredential): string {
  if (credential.status === "present") return credential.source ?? "vault"
  if (credential.status === "invalid-pool") return "vault unavailable"
  return "missing"
}

function readinessLabel(readiness: ProviderVisibilityReadiness): string {
  if (readiness.status === "failed") {
    return readiness.error ? `failed: ${readiness.error}` : "failed"
  }
  if (readiness.status === "stale") {
    return readiness.reason ? `stale: ${readiness.reason}` : "stale"
  }
  if (readiness.status === "unknown") {
    return readiness.reason ? `unknown: ${readiness.reason}` : "unknown"
  }
  return readiness.status
}

function providerStatusDetail(lane: ProviderVisibilityConfiguredLane): string | undefined {
  if (lane.credential.status !== "present") return undefined
  return lane.readiness.error
}

export function formatProviderVisibilityLine(lane: ProviderVisibilityLane): string {
  if (lane.status === "unconfigured") {
    return `${lane.lane}: unconfigured (${lane.reason}); repair: ${lane.repairCommand}`
  }

  const parts = [
    readinessLabel(lane.readiness),
    `source: ${lane.source}`,
    `credentials: ${credentialLabel(lane.credential)}`,
  ]
  if (lane.credential.revision) parts.push(`revision: ${lane.credential.revision}`)
  if (lane.credential.repairCommand) parts.push(`repair: ${lane.credential.repairCommand}`)
  if (lane.warnings.length > 0) parts.push(`warnings: ${lane.warnings.join("; ")}`)
  return `${lane.lane}: ${lane.provider} / ${lane.model} [${parts.join("; ")}]`
}

export function formatAgentProviderVisibilityForPrompt(visibility: AgentProviderVisibility): string {
  if (visibility.lanes.every((lane) => lane.status === "unconfigured")) {
    return [
      "provider bindings are not configured on this machine.",
      ...visibility.lanes.map((lane) => `- ${formatProviderVisibilityLine(lane)}`),
    ].join("\n")
  }

  return [
    "runtime uses local provider bindings for this machine:",
    ...visibility.lanes.map((lane) => `- ${formatProviderVisibilityLine(lane)}`),
  ].join("\n")
}

export function formatAgentProviderVisibilityForStartOfTurn(visibility: AgentProviderVisibility): string {
  return visibility.lanes.map((lane) => `- ${formatProviderVisibilityLine(lane)}`).join("\n")
}

export function formatAgentProviderVisibilityForPulse(visibility: AgentProviderVisibility): string {
  return visibility.lanes.map((lane) => formatProviderVisibilityLine(lane)).join("; ")
}

export function providerVisibilityStatusRows(visibility: AgentProviderVisibility): ProviderStatusRow[] {
  return visibility.lanes.map((lane): ProviderStatusRow => {
    if (lane.status === "unconfigured") {
      return {
        agent: visibility.agentName,
        lane: lane.lane,
        provider: "unconfigured",
        model: "-",
        source: "missing",
        readiness: "unknown",
        detail: lane.repairCommand,
        credential: "missing",
      }
    }

    const detail = providerStatusDetail(lane)
    return {
      agent: visibility.agentName,
      lane: lane.lane,
      provider: lane.provider,
      model: lane.model,
      source: lane.source,
      readiness: lane.readiness.status,
      ...(detail ? { detail } : {}),
      credential: credentialLabel(lane.credential),
    }
  })
}

export function isAgentProviderVisibility(value: unknown): value is AgentProviderVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.agentName !== "string") return false
  if (!Array.isArray(record.lanes)) return false
  return record.lanes.every((lane) => {
    if (!lane || typeof lane !== "object" || Array.isArray(lane)) return false
    const laneRecord = lane as Record<string, unknown>
    return (laneRecord.lane === "outward" || laneRecord.lane === "inner")
      && (laneRecord.status === "configured" || laneRecord.status === "unconfigured")
  })
}
