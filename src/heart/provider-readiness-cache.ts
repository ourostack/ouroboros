import type { AgentProvider } from "./identity"
import type { ProviderLane, ProviderReadinessStatus } from "./provider-lanes"
import { emitNervesEvent } from "../nerves/runtime"

export interface ProviderReadinessCacheEntry {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  model: string
  credentialRevision: string
  status: Extract<ProviderReadinessStatus, "ready" | "failed">
  checkedAt: string
  error?: string
  attempts?: number
}

export interface ProviderReadinessCacheLookup {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  model: string
  credentialRevision: string
}

const readinessByLane = new Map<string, ProviderReadinessCacheEntry>()

function cacheKey(agentName: string, lane: ProviderLane): string {
  return `${agentName}\0${lane}`
}

export function recordProviderLaneReadiness(entry: ProviderReadinessCacheEntry): void {
  readinessByLane.set(cacheKey(entry.agentName, entry.lane), { ...entry })
  emitNervesEvent({
    component: "config/identity",
    event: "config.provider_readiness_recorded",
    message: "recorded in-memory provider readiness",
    meta: {
      agentName: entry.agentName,
      lane: entry.lane,
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
    },
  })
}

export function readProviderLaneReadiness(input: ProviderReadinessCacheLookup): ProviderReadinessCacheEntry | null {
  const entry = readinessByLane.get(cacheKey(input.agentName, input.lane))
  if (!entry) return null
  if (entry.provider !== input.provider) return null
  if (entry.model !== input.model) return null
  if (entry.credentialRevision !== input.credentialRevision) return null
  return { ...entry }
}

export function clearProviderReadinessCache(): void {
  readinessByLane.clear()
}
