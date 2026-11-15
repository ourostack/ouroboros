import { emitNervesEvent } from "../nerves/runtime"
import type { ProviderErrorClassification } from "./core"
import type { AgentConfig, AgentProvider } from "./identity"
import type { ProviderLane } from "./provider-lanes"

/**
 * Automatic provider fallback within one turn (Ari, 2026-11-15: "never let human be bottleneck for anything ever").
 *
 * An agent opts in with `providerFallback` in agent.json. Its chain for a lane is that lane's own model, then the other
 * lane's, then each `providerFallback` entry in order. When a provider call fails with an error the agent cannot fix
 * (credit, auth, a throttle, an outage or the network, after the usual retries), the entry is benched for a while and
 * the same turn carries on with the next entry. It is never silent: every switch, cooldown and served turn is a nerves
 * event, and the owner hears once when a backup takes over.
 */
export interface ProviderChainEntry {
  provider: AgentProvider
  model: string
}

const FALLBACK_CLASSIFICATIONS: ReadonlySet<ProviderErrorClassification> = new Set([
  "auth-failure",
  "usage-limit",
  "rate-limit",
  "server-error",
  "network-error",
])

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const NOTICE_INTERVAL_MS = 24 * HOUR_MS

const REASON_TEXT: Record<ProviderErrorClassification, string> = {
  "auth-failure": "rejecting its key",
  "usage-limit": "out of credit or over its usage limit",
  "rate-limit": "rate limited",
  "server-error": "having an outage",
  "network-error": "unreachable",
  "unknown": "failing",
}

const PROVIDER_NAMES: Partial<Record<AgentProvider, string>> = {
  anthropic: "Claude",
  minimax: "MiniMax",
}

interface Cooldown {
  until: number
  classification: ProviderErrorClassification
}

interface BackupEpisode {
  since: number
}

const cooldowns = new Map<string, Cooldown>()
const episodes = new Map<string, BackupEpisode>()
const lastNoticeAt = new Map<string, number>()

export type ProviderFallbackOwnerNotifier = (agentRoot: string, agentName: string, notice: { noticeId: string; text: string }) => void

let ownerNotifier: ProviderFallbackOwnerNotifier | null = null

/** Replace how the owner is told a backup took over. Null restores the shared owner notice path. */
export function setProviderFallbackOwnerNotifier(notifier: ProviderFallbackOwnerNotifier | null): void {
  ownerNotifier = notifier
}

/** Forget cooldowns and backup episodes (tests, and a fresh process). */
export function resetProviderFallbackState(): void {
  cooldowns.clear()
  episodes.clear()
  lastNoticeAt.clear()
}

function sameEntry(a: ProviderChainEntry, b: ProviderChainEntry): boolean {
  return a.provider === b.provider && a.model === b.model
}

export function providerFallbackChain(
  config: Pick<AgentConfig, "humanFacing" | "agentFacing" | "providerFallback">,
  lane: ProviderLane,
): ProviderChainEntry[] {
  const fallbacks = config.providerFallback ?? []
  if (fallbacks.length === 0) return []
  const own = lane === "outward" ? config.humanFacing : config.agentFacing
  const other = lane === "outward" ? config.agentFacing : config.humanFacing
  const chain: ProviderChainEntry[] = []
  for (const entry of [own, other, ...fallbacks]) {
    const candidate = { provider: entry.provider, model: entry.model }
    if (!chain.some((existing) => sameEntry(existing, candidate))) chain.push(candidate)
  }
  return chain
}

export function fallsBackOn(classification: ProviderErrorClassification): boolean {
  return FALLBACK_CLASSIFICATIONS.has(classification)
}

function retryAfterSeconds(error: Error): number | null {
  const headers = (error as { headers?: unknown }).headers
  if (!headers) return null
  const raw = typeof (headers as Headers).get === "function"
    ? (headers as Headers).get("retry-after")
    : (headers as Record<string, string>)["retry-after"]
  const seconds = Number(raw)
  return raw && Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * Until when a failed entry is skipped: Retry-After when the provider gives one; an hour for spent credit or a rejected
 * key, so a dead entry costs one probe an hour rather than one a turn and comes back by itself after a top-up, a new
 * billing cycle or a re-stored key; five minutes for a throttle, an outage or the network.
 */
export function providerCooldownUntil(classification: ProviderErrorClassification, error: Error, now: number): number {
  const retryAfter = retryAfterSeconds(error)
  if (retryAfter !== null) return now + retryAfter * 1000
  if (classification === "usage-limit" || classification === "auth-failure") return now + HOUR_MS
  return now + 5 * MINUTE_MS
}

function providerKey(entry: ProviderChainEntry): string {
  return entry.provider
}

function modelKey(entry: ProviderChainEntry): string {
  return `${entry.provider}/${entry.model}`
}

/** Credit and keys belong to the provider account, so those bench every model on it; throttles and outages bench one model. */
export function coolDownProviderEntry(entry: ProviderChainEntry, classification: ProviderErrorClassification, error: Error, now: number = Date.now()): void {
  const until = providerCooldownUntil(classification, error, now)
  const scope = classification === "usage-limit" || classification === "auth-failure" ? "provider" : "model"
  cooldowns.set(scope === "provider" ? providerKey(entry) : modelKey(entry), { until, classification })
  emitNervesEvent({
    level: "warn",
    component: "engine",
    event: "engine.provider_cooldown",
    message: "provider entry benched after an error the agent cannot fix",
    meta: { provider: entry.provider, model: entry.model, classification, scope, until: new Date(until).toISOString() },
  })
}

export function clearProviderEntryCooldown(entry: ProviderChainEntry): void {
  cooldowns.delete(providerKey(entry))
  cooldowns.delete(modelKey(entry))
}

function activeCooldown(entry: ProviderChainEntry, now: number): Cooldown | null {
  for (const key of [modelKey(entry), providerKey(entry)]) {
    const cooldown = cooldowns.get(key)
    if (cooldown && cooldown.until > now) return cooldown
  }
  return null
}

export function providerEntryCoolingDown(entry: ProviderChainEntry, now: number = Date.now()): boolean {
  return activeCooldown(entry, now) !== null
}

/** The entry a turn starts on: the first one not cooling down, else the primary (a probe beats giving up). */
export function firstReadyChainIndex(chain: readonly ProviderChainEntry[], now: number = Date.now()): number {
  const index = chain.findIndex((entry) => !providerEntryCoolingDown(entry, now))
  return index === -1 ? 0 : index
}

export function nextReadyChainIndex(chain: readonly ProviderChainEntry[], after: number, now: number = Date.now()): number | null {
  for (let index = after + 1; index < chain.length; index += 1) {
    if (!providerEntryCoolingDown(chain[index], now)) return index
  }
  return null
}

function providerName(provider: AgentProvider): string {
  return PROVIDER_NAMES[provider] ?? provider
}

function entryLabel(entry: ProviderChainEntry): string {
  return entry.model ? `${providerName(entry.provider)} (${entry.model})` : providerName(entry.provider)
}

function backupNoticeText(primary: ProviderChainEntry, backup: ProviderChainEntry, now: number): string {
  const cooldown = activeCooldown(primary, now)
  const reason = cooldown ? `is ${REASON_TEXT[cooldown.classification]}` : "hit a provider problem"
  return `${providerName(primary.provider)} ${reason}, so I'm answering on ${entryLabel(backup)} as a backup. Nothing for you to do: I'll move back by myself once it recovers.`
}

function notifyOwner(agentRoot: string, agentName: string, notice: { noticeId: string; text: string }): void {
  if (ownerNotifier) {
    ownerNotifier(agentRoot, agentName, notice)
    return
  }
  void import("./sync").then(({ tellOwner }) => tellOwner(agentRoot, agentName, notice))
}

export interface ProviderServedInput {
  agentName: string
  agentRoot: string
  lane: ProviderLane
  chain: readonly ProviderChainEntry[]
  index: number
  now?: number
}

/** Record which entry served a turn; tell the owner once when a backup takes over, at most once a day. */
export function noteProviderServed(input: ProviderServedInput): void {
  const now = input.now ?? Date.now()
  const served = input.chain[input.index]
  const primary = input.chain[0]
  const fallback = input.index > 0
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_served",
    message: "provider served the turn",
    meta: { provider: served.provider, model: served.model, lane: input.lane, fallback, primaryProvider: primary.provider, primaryModel: primary.model },
  })
  const episode = episodes.get(input.agentName)
  if (!fallback) {
    clearProviderEntryCooldown(served)
    if (episode) {
      episodes.delete(input.agentName)
      emitNervesEvent({
        component: "engine",
        event: "engine.provider_fallback_recovered",
        message: "primary provider is serving again",
        meta: { agentName: input.agentName, provider: served.provider, model: served.model, lane: input.lane, backupSince: new Date(episode.since).toISOString() },
      })
    }
    return
  }
  if (episode) return
  episodes.set(input.agentName, { since: now })
  const last = lastNoticeAt.get(input.agentName)
  if (last !== undefined && now - last < NOTICE_INTERVAL_MS) return
  lastNoticeAt.set(input.agentName, now)
  notifyOwner(input.agentRoot, input.agentName, {
    noticeId: `provider-fallback:${input.agentName}:${now}`,
    text: backupNoticeText(primary, served, now),
  })
}
