import type { ProviderErrorClassification } from "./core"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "./identity"
import type { HealthInventoryResult, PingResult } from "./provider-ping"
import { pingProvider } from "./provider-ping"
import {
  getDefaultModelForProvider,
  getProviderModelMismatchMessage,
  resolveModelForProviderDisplay,
} from "./provider-models"
import {
  readProviderCredentialPool,
  type ProviderCredentialProvenanceSource,
  type ProviderCredentialRecord,
} from "./provider-credential-pool"
import type { ProviderLane } from "./provider-state"
import { emitNervesEvent } from "../nerves/runtime"

type FailedPingResult = Extract<PingResult, { ok: false }>
type PingProviderConfig = Parameters<typeof pingProvider>[1]

export interface FailoverReadyProvider {
  provider: AgentProvider
  model: string
  credentialRevision?: string
  source?: ProviderCredentialProvenanceSource
  contributedByAgent?: string
  result?: Extract<PingResult, { ok: true }>
}

export interface FailoverUnavailableProvider {
  provider: AgentProvider
  model?: string
  credentialRevision?: string
  source?: ProviderCredentialProvenanceSource
  contributedByAgent?: string
  result: FailedPingResult
}

export interface ProviderFailoverInventory {
  ready: FailoverReadyProvider[]
  unavailable: FailoverUnavailableProvider[]
  unconfigured: AgentProvider[]
}

export interface BuildFailoverContextOptions {
  currentLane?: ProviderLane
}

export interface FailoverContext {
  errorSummary: string
  classification: ProviderErrorClassification
  currentProvider: AgentProvider
  currentLane: ProviderLane
  agentName: string
  workingProviders: AgentProvider[]
  readyProviders: FailoverReadyProvider[]
  unconfiguredProviders: AgentProvider[]
  userMessage: string
}

export type FailoverAction =
  | {
    action: "switch"
    provider: AgentProvider
    model: string
    lane: ProviderLane
    credentialRevision?: string
    source?: ProviderCredentialProvenanceSource
    contributedByAgent?: string
  }
  | { action: "dismiss" }

const CLASSIFICATION_LABELS: Record<ProviderErrorClassification, string> = {
  "auth-failure": "authentication failed",
  "usage-limit": "hit its usage limit",
  "rate-limit": "is being rate limited",
  "server-error": "is experiencing an outage",
  "network-error": "is unreachable (network error)",
  "unknown": "encountered an error",
}

function formatProviderWithModel(provider: AgentProvider, model: string): string {
  if (!model) return provider
  if (getProviderModelMismatchMessage(provider, model)) {
    return `${provider} [configured model: ${model}]`
  }
  return `${provider} (${model})`
}

function formatErrorDetail(errorMessage: string, errorSummary: string): string {
  const detail = errorMessage.replace(/\s+/g, " ").trim()
  if (!detail || detail === errorSummary) return ""
  return detail.length > 300 ? `${detail.slice(0, 297)}...` : detail
}

export function formatCredentialProvenanceLabel(candidate: {
  source?: ProviderCredentialProvenanceSource
  contributedByAgent?: string
}): string | undefined {
  if (candidate.contributedByAgent && candidate.source) {
    return `credentials from ${candidate.contributedByAgent} via ${candidate.source}`
  }
  if (candidate.contributedByAgent) {
    return `credentials from ${candidate.contributedByAgent}`
  }
  if (candidate.source) {
    return `credentials from this machine via ${candidate.source}`
  }
  return undefined
}

export function formatReadyProviderLabel(candidate: FailoverReadyProvider): string {
  const provenance = formatCredentialProvenanceLabel(candidate)
  const provenanceSuffix = provenance ? `; ${provenance}` : ""
  return `${candidate.provider} (${candidate.model}${provenanceSuffix})`
}

function formatFailingProviderLine(
  provider: AgentProvider,
  classification: ProviderErrorClassification,
  agentName: string,
): string {
  const authCommand = `ouro auth --agent ${agentName} --provider ${provider}`
  switch (classification) {
    case "auth-failure":
      return `  - ${provider}: credentials need to be refreshed. Run \`${authCommand}\`.`
    case "network-error":
      return `  - ${provider}: could not be reached. Check network/provider availability; if credentials may be stale, run \`${authCommand}\`.`
    case "server-error":
      return `  - ${provider}: provider outage or server error. Retry later; if it keeps failing, run \`${authCommand}\`.`
    case "rate-limit":
      return `  - ${provider}: rate limited. Wait and retry, or switch to a ready provider below.`
    case "usage-limit":
      return `  - ${provider}: usage limit hit. Wait for quota reset, raise quota, or switch to a ready provider below.`
    case "unknown":
      return `  - ${provider}: could not be reached. Run \`${authCommand}\` if credentials may be stale.`
  }
}

function isProviderFailoverInventory(inventory: HealthInventoryResult | ProviderFailoverInventory): inventory is ProviderFailoverInventory {
  const candidate = inventory as Partial<ProviderFailoverInventory>
  return Array.isArray(candidate.ready) && Array.isArray(candidate.unavailable) && Array.isArray(candidate.unconfigured)
}

function normalizeLegacyInventory(
  inventory: HealthInventoryResult,
  providerModels: Partial<Record<AgentProvider, string>>,
): ProviderFailoverInventory {
  const ready: FailoverReadyProvider[] = []
  const unavailable: FailoverUnavailableProvider[] = []
  const unconfigured: AgentProvider[] = []

  for (const [provider, result] of Object.entries(inventory) as [AgentProvider, PingResult][]) {
    if (result.ok) {
      ready.push({
        provider,
        model: resolveModelForProviderDisplay(provider, providerModels[provider]),
        result,
      })
    } else if (result.classification === "auth-failure" && result.message === "no credentials configured") {
      unconfigured.push(provider)
    } else {
      // Configured but ping failed (expired token, provider also down, etc.)
      unavailable.push({
        provider,
        model: resolveModelForProviderDisplay(provider, providerModels[provider]),
        result,
      })
    }
  }

  return { ready, unavailable, unconfigured }
}

function normalizeFailoverInventory(
  inventory: HealthInventoryResult | ProviderFailoverInventory,
  providerModels: Partial<Record<AgentProvider, string>>,
): ProviderFailoverInventory {
  if (!isProviderFailoverInventory(inventory)) {
    return normalizeLegacyInventory(inventory, providerModels)
  }

  return {
    ready: inventory.ready.map((candidate) => ({
      ...candidate,
      model: resolveModelForProviderDisplay(candidate.provider, candidate.model),
    })),
    unavailable: inventory.unavailable.map((candidate) => ({
      ...candidate,
      model: candidate.model ? resolveModelForProviderDisplay(candidate.provider, candidate.model) : undefined,
    })),
    unconfigured: [...inventory.unconfigured],
  }
}

export function buildFailoverContext(
  errorMessage: string,
  classification: ProviderErrorClassification,
  currentProvider: AgentProvider,
  currentModel: string,
  agentName: string,
  inventory: HealthInventoryResult | ProviderFailoverInventory,
  providerModels: Partial<Record<AgentProvider, string>>,
  options: BuildFailoverContextOptions = {},
): FailoverContext {
  const currentLane = options.currentLane ?? "outward"
  const label = CLASSIFICATION_LABELS[classification]
  const providerWithModel = formatProviderWithModel(currentProvider, currentModel)
  const errorSummary = `${providerWithModel} ${label}`
  const errorDetail = formatErrorDetail(errorMessage, errorSummary)
  const modelMismatch = getProviderModelMismatchMessage(currentProvider, currentModel)
  const normalizedInventory = normalizeFailoverInventory(inventory, providerModels)
  const readyProviders = normalizedInventory.ready
  const workingProviders = readyProviders.map((candidate) => candidate.provider)
  const unconfiguredProviders = normalizedInventory.unconfigured
  const failingProviders = normalizedInventory.unavailable

  const lines: string[] = [`${errorSummary}.`]
  if (errorDetail) {
    lines.push(`provider detail: ${errorDetail}`)
  }

  if (classification === "auth-failure") {
    lines.push("")
    lines.push("To keep using the current provider:")
    lines.push(`  1. Run \`ouro auth --agent ${agentName} --provider ${currentProvider}\``)
  }

  if (modelMismatch) {
    const defaultModel = getDefaultModelForProvider(currentProvider)
    lines.push("")
    lines.push("Config warning:")
    lines.push(`  - ${modelMismatch}`)
    lines.push("  - Repair the configured model with:")
    lines.push(`    \`ouro use --agent ${agentName} --lane ${currentLane} --provider ${currentProvider} --model ${defaultModel}\``)
  }

  if (readyProviders.length > 0) {
    lines.push("")
    lines.push("Ready providers:")
    for (const candidate of readyProviders) {
      lines.push(`  - ${formatReadyProviderLabel(candidate)}: reply "switch to ${candidate.provider}"`)
    }
  }

  if (failingProviders.length > 0) {
    lines.push("")
    lines.push("Configured but unavailable:")
    for (const candidate of failingProviders) {
      lines.push(formatFailingProviderLine(candidate.provider, candidate.result.classification, agentName))
    }
  }

  if (unconfiguredProviders.length > 0) {
    lines.push("")
    lines.push("Not configured:")
    for (const provider of unconfiguredProviders) {
      lines.push(`  - ${provider}: run \`ouro auth --agent ${agentName} --provider ${provider}\``)
    }
  }

  if (workingProviders.length === 0 && unconfiguredProviders.length === 0 && failingProviders.length === 0) {
    lines.push("")
    lines.push(`No other providers are available. Run \`ouro auth --agent ${agentName}\` in terminal to configure one.`)
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.failover_context_built",
    message: "built provider failover context",
    meta: { currentProvider, currentLane, classification, workingProviders, unconfiguredProviders },
  })

  return {
    errorSummary,
    classification,
    currentProvider,
    currentLane,
    agentName,
    workingProviders,
    readyProviders,
    unconfiguredProviders,
    userMessage: lines.join("\n"),
  }
}

export function handleFailoverReply(
  reply: string,
  context: FailoverContext,
): FailoverAction {
  const lower = reply.toLowerCase().trim()
  const readyProviders = context.readyProviders ?? context.workingProviders.map((provider) => ({
    provider,
    model: resolveModelForProviderDisplay(provider),
  }))
  const currentLane = context.currentLane ?? "outward"
  for (const candidate of readyProviders) {
    if (lower.includes(`switch to ${candidate.provider}`) || lower === candidate.provider) {
      return {
        action: "switch",
        provider: candidate.provider,
        model: candidate.model,
        lane: currentLane,
        ...(candidate.credentialRevision ? { credentialRevision: candidate.credentialRevision } : {}),
        ...(candidate.source ? { source: candidate.source } : {}),
        ...(candidate.contributedByAgent ? { contributedByAgent: candidate.contributedByAgent } : {}),
      }
    }
  }
  return { action: "dismiss" }
}

function candidateFromCredentialRecord(record: ProviderCredentialRecord): Omit<FailoverReadyProvider, "model" | "result"> {
  return {
    provider: record.provider,
    credentialRevision: record.revision,
    source: record.provenance.source,
    contributedByAgent: record.provenance.contributedByAgent,
  }
}

export interface MachineFailoverInventoryOptions {
  homeDir?: string
  ping?: typeof pingProvider
}

export async function runMachineProviderFailoverInventory(
  agentName: string,
  currentProvider: AgentProvider,
  options: MachineFailoverInventoryOptions = {},
): Promise<ProviderFailoverInventory> {
  const ping = options.ping ?? pingProvider
  const poolResult = readProviderCredentialPool(options.homeDir)
  const providers = (Object.keys(PROVIDER_CREDENTIALS) as AgentProvider[]).filter((provider) => provider !== currentProvider)
  const inventory: ProviderFailoverInventory = { ready: [], unavailable: [], unconfigured: [] }

  if (!poolResult.ok) {
    inventory.unconfigured.push(...providers)
    emitNervesEvent({
      component: "engine",
      event: "engine.machine_failover_inventory_built",
      message: "built machine provider failover inventory",
      meta: { agentName, currentProvider, credentialPoolStatus: poolResult.reason, readyCount: 0, unavailableCount: 0, unconfiguredCount: inventory.unconfigured.length },
    })
    return inventory
  }

  const results = await Promise.all(providers.map(async (provider) => {
    const record = poolResult.pool.providers[provider]
    if (!record) return { provider, record: undefined, result: undefined }
    const model = getDefaultModelForProvider(provider)
    const config = { ...record.credentials, ...record.config } as unknown as PingProviderConfig
    const result = await ping(provider, config, { model })
    return { provider, record, model, result }
  }))

  for (const entry of results) {
    if (!entry.record) {
      inventory.unconfigured.push(entry.provider)
    } else if (entry.result.ok) {
      inventory.ready.push({
        ...candidateFromCredentialRecord(entry.record),
        model: entry.model,
        result: entry.result,
      })
    } else {
      inventory.unavailable.push({
        ...candidateFromCredentialRecord(entry.record),
        model: entry.model,
        result: entry.result,
      })
    }
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.machine_failover_inventory_built",
    message: "built machine provider failover inventory",
    meta: {
      agentName,
      currentProvider,
      credentialPoolStatus: "present",
      readyCount: inventory.ready.length,
      unavailableCount: inventory.unavailable.length,
      unconfiguredCount: inventory.unconfigured.length,
    },
  })
  return inventory
}
