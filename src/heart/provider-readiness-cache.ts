import * as fs from "fs"
import * as path from "path"
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
  agentRoot?: string
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  model: string
  credentialRevision: string
}

type ProviderReadinessRecordInput = ProviderReadinessCacheEntry & { agentRoot?: string }

interface ProviderReadinessStore {
  schemaVersion: 1
  updatedAt: string
  lanes: Partial<Record<ProviderLane, ProviderReadinessCacheEntry>>
}

const readinessByLane = new Map<string, ProviderReadinessCacheEntry>()

function cacheKey(agentName: string, lane: ProviderLane): string {
  return `${agentName}\0${lane}`
}

function readinessStorePath(agentRoot: string): string {
  return path.join(agentRoot, "state", "providers", "readiness.json")
}

function defaultReadinessStore(): ProviderReadinessStore {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), lanes: {} }
}

function readReadinessStore(agentRoot: string): ProviderReadinessStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(readinessStorePath(agentRoot), "utf-8")) as ProviderReadinessStore
    if (parsed.schemaVersion === 1 && parsed.lanes && typeof parsed.lanes === "object") return parsed
  } catch {
    return defaultReadinessStore()
  }
  return defaultReadinessStore()
}

function writeReadinessStore(agentRoot: string, entry: ProviderReadinessCacheEntry): void {
  const storePath = readinessStorePath(agentRoot)
  const store = readReadinessStore(agentRoot)
  const updated: ProviderReadinessStore = {
    schemaVersion: 1,
    updatedAt: entry.checkedAt,
    lanes: { ...store.lanes, [entry.lane]: entry },
  }
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8")
}

function matchesLookup(entry: ProviderReadinessCacheEntry, input: ProviderReadinessCacheLookup): boolean {
  return entry.agentName === input.agentName
    && entry.lane === input.lane
    && entry.provider === input.provider
    && entry.model === input.model
    && entry.credentialRevision === input.credentialRevision
}

function isNewerReadiness(candidate: ProviderReadinessCacheEntry, existing: ProviderReadinessCacheEntry): boolean {
  return Date.parse(candidate.checkedAt) > Date.parse(existing.checkedAt)
}

export function recordProviderLaneReadiness(input: ProviderReadinessRecordInput): void {
  const { agentRoot, ...entry } = input
  readinessByLane.set(cacheKey(entry.agentName, entry.lane), { ...entry })
  if (agentRoot) writeReadinessStore(agentRoot, entry)
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
  if (!input.agentRoot) return entry && matchesLookup(entry, input) ? { ...entry } : null
  const durable = readReadinessStore(input.agentRoot).lanes[input.lane]
  const memoryMatch = entry && matchesLookup(entry, input) ? entry : null
  const durableMatch = durable && matchesLookup(durable, input) ? durable : null
  const selected = memoryMatch && durableMatch
    ? (isNewerReadiness(durableMatch, memoryMatch) ? durableMatch : memoryMatch)
    : (durableMatch ?? memoryMatch)
  if (!selected) return null
  readinessByLane.set(cacheKey(selected.agentName, selected.lane), { ...selected })
  return { ...selected }
}

export function clearProviderReadinessCache(): void {
  readinessByLane.clear()
}
