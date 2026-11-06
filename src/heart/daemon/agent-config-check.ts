import * as fs from "fs"
import * as path from "path"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { PingResult, ProviderPingOptions } from "../provider-ping"
import { getDefaultModelForProvider } from "../provider-models"
import type { ProviderLane } from "../provider-lanes"
import {
  refreshProviderCredentialPool,
  type ProviderCredentialPool,
  type ProviderCredentialRecord,
} from "../provider-credentials"
import { recordProviderLaneReadiness } from "../provider-readiness-cache"
import { isCredentialVaultNotConfiguredError, vaultCreateRecoverFix, vaultUnlockReplaceRecoverFix } from "../../repertoire/vault-unlock"
import {
  providerLiveCheckFix,
  providerCredentialMissingIssue,
  providerLiveCheckFailedIssue,
  vaultLockedIssue,
  vaultUnconfiguredIssue,
  type AgentReadinessIssue,
} from "./readiness-repair"
import { createProviderPingProgressReporter } from "./provider-ping-progress"

export interface ConfigCheckResult {
  ok: boolean
  error?: string
  fix?: string
  issue?: AgentReadinessIssue
}

export type ProviderPing = (
  provider: AgentProvider,
  config: Record<string, unknown>,
  options?: ProviderPingOptions,
) => Promise<PingResult>

export interface LiveConfigCheckDeps {
  pingProvider?: ProviderPing
  homeDir?: string
  onProgress?: (message: string) => void
  providerPingOptions?: Pick<ProviderPingOptions, "attemptPolicy" | "timeoutMs">
  recordReadiness?: boolean
}

type FacingName = "humanFacing" | "agentFacing"
type SelectedProvider = { facing: FacingName; lane: ProviderLane; provider: AgentProvider; model: string }
type ProviderBindings = Record<ProviderLane, SelectedProvider>

const LANES: Array<{ lane: ProviderLane; facing: FacingName }> = [
  { lane: "outward", facing: "humanFacing" },
  { lane: "inner", facing: "agentFacing" },
]

function isAgentProvider(value: string): value is AgentProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIALS, value)
}

function agentRootFor(agentName: string, bundlesRoot: string): string {
  return path.join(bundlesRoot, `${agentName}.ouro`)
}

function configPathFor(agentName: string, bundlesRoot: string): string {
  return path.join(agentRootFor(agentName, bundlesRoot), "agent.json")
}

function laneForFacing(facing: FacingName): ProviderLane {
  return facing === "humanFacing" ? "outward" : "inner"
}

function resolveFacingProvider(
  parsed: Record<string, unknown>,
  facing: FacingName,
  agentName: string,
  agentJsonPath: string,
): { ok: true; selected: SelectedProvider } | { ok: false; result: ConfigCheckResult } {
  const raw = parsed[facing]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: `agent.json for '${agentName}' is missing ${facing}.provider`,
        fix: `Add ${facing}: { provider, model } to ${agentJsonPath}. Valid providers: ${Object.keys(PROVIDER_CREDENTIALS).join(", ")}`,
      },
    }
  }

  const provider = (raw as Record<string, unknown>).provider
  if (typeof provider !== "string" || provider.length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        error: `agent.json for '${agentName}' is missing ${facing}.provider`,
        fix: `Set ${facing}.provider in ${agentJsonPath}. Valid providers: ${Object.keys(PROVIDER_CREDENTIALS).join(", ")}`,
      },
    }
  }

  if (!isAgentProvider(provider)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: `Unknown provider '${provider}' in ${facing}.provider for '${agentName}'`,
        fix: `Set ${facing}.provider to one of: ${Object.keys(PROVIDER_CREDENTIALS).join(", ")}`,
      },
    }
  }

  const rawModel = (raw as Record<string, unknown>).model
  const model = typeof rawModel === "string" && rawModel.trim().length > 0
    ? rawModel.trim()
    : getDefaultModelForProvider(provider)

  return { ok: true, selected: { facing, lane: laneForFacing(facing), provider, model } }
}

type AgentConfigReadResult =
  | { ok: true; disabled: false; agentJsonPath: string; parsed: Record<string, unknown> }
  | { ok: true; disabled: true; agentJsonPath: string; parsed: Record<string, unknown> }
  | { ok: false; result: ConfigCheckResult }

function readAgentConfigForProviderCheck(
  agentName: string,
  bundlesRoot: string,
): AgentConfigReadResult {
  const agentJsonPath = configPathFor(agentName, bundlesRoot)
  let raw: string
  try {
    raw = fs.readFileSync(agentJsonPath, "utf-8")
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        error: `agent.json not found at ${agentJsonPath}`,
        fix: `Run 'ouro hatch ${agentName}' to create the agent bundle, or verify that ${bundlesRoot}/${agentName}.ouro/ exists.`,
      },
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        error: `agent.json at ${agentJsonPath} contains invalid JSON`,
        fix: `Open ${agentJsonPath} and fix the JSON syntax.`,
      },
    }
  }

  if (parsed.enabled === false) {
    return { ok: true, disabled: true, agentJsonPath, parsed }
  }

  return { ok: true, disabled: false, agentJsonPath, parsed }
}

type ProviderSelectionResult =
  | { ok: true; disabled: false; agentRoot: string; bindings: ProviderBindings }
  | { ok: true; disabled: true }
  | { ok: false; result: ConfigCheckResult }

function readProviderSelectionForCheck(
  agentName: string,
  bundlesRoot: string,
): ProviderSelectionResult {
  const configResult = readAgentConfigForProviderCheck(agentName, bundlesRoot)
  if (!configResult.ok) return { ok: false, result: configResult.result }
  if (configResult.disabled) return { ok: true, disabled: true }

  const bindings = {} as ProviderBindings
  for (const { lane, facing } of LANES) {
    const selected = resolveFacingProvider(configResult.parsed, facing, agentName, configResult.agentJsonPath)
    if (!selected.ok) return { ok: false, result: selected.result }
    bindings[lane] = selected.selected
  }

  return {
    ok: true,
    disabled: false,
    agentRoot: agentRootFor(agentName, bundlesRoot),
    bindings,
  }
}

function providerCredentialConfig(record: ProviderCredentialRecord): Record<string, unknown> {
  return {
    ...record.credentials,
    ...record.config,
  }
}

function pingAttemptCount(result: PingResult): number | undefined {
  if (Array.isArray(result.attempts)) return result.attempts.length
  return undefined
}

function missingCredentialResult(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  credentialPath: string,
): ConfigCheckResult {
  return {
    ok: false,
    error: `${lane} provider ${provider} model ${model} has no credentials in ${agentName}'s vault at ${credentialPath}`,
    fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to authenticate.`,
    issue: providerCredentialMissingIssue({
      agentName,
      lane,
      provider,
      model,
      credentialPath,
    }),
  }
}

function isTransientVaultError(error: string): boolean {
  const normalized = error.toLowerCase()
  return (
    normalized.includes("timed out") ||
    normalized.includes("econnrefused") ||
    normalized.includes("socket hang up") ||
    normalized.includes("etimedout")
  )
}

function invalidPoolResult(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  pool: { ok: false; reason: "invalid" | "unavailable"; poolPath: string; error: string },
): ConfigCheckResult {
  if (pool.reason === "unavailable" && isTransientVaultError(pool.error)) {
    return {
      ok: false,
      error: `${lane} provider ${provider} model ${model} cannot read provider credentials from ${agentName}'s vault: ${pool.error}`,
      fix: `Vault read timed out -- this usually resolves on retry. Run 'ouro up' again.`,
    }
  }
  if (pool.reason === "unavailable" && isVaultLockedError(pool.error)) {
    return {
      ok: false,
      error: `${lane} provider ${provider} model ${model} cannot read provider credentials because ${agentName}'s credential vault is locked on this machine.`,
      fix: vaultUnlockOrRecoverFix(agentName),
      issue: vaultLockedIssue(agentName),
    }
  }
  if (pool.reason === "unavailable" && isCredentialVaultNotConfiguredError(pool.error)) {
    return {
      ok: false,
      error: `${lane} provider ${provider} model ${model} cannot read provider credentials because ${agentName}'s credential vault is not configured in agent.json.`,
      fix: vaultCreateRecoverFix(
        agentName,
        `Then run 'ouro auth --agent ${agentName} --provider ${provider}' and rerun 'ouro up'.`,
      ),
      issue: vaultUnconfiguredIssue(agentName),
    }
  }
  if (pool.reason === "invalid") {
    return {
      ok: false,
      error: `${lane} provider ${provider} model ${model} cannot read provider credentials from ${agentName}'s vault at ${pool.poolPath}: ${pool.error}`,
      fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to rewrite this provider credential, then run 'ouro up' again.`,
    }
  }
  return {
    ok: false,
    error: `${lane} provider ${provider} model ${model} cannot read provider credentials from ${agentName}'s vault at ${pool.poolPath}: ${pool.error}`,
    fix: vaultUnlockOrRecoverFix(agentName, `Then run 'ouro up' again. If the credential is missing or stale after unlock or recovery, run 'ouro auth --agent ${agentName} --provider ${provider}'.`),
  }
}

function isVaultLockedError(error: string): boolean {
  const normalized = error.toLowerCase()
  return /(?:ouro )?credential vault is locked|vault(?: is)? locked/.test(normalized)
}

export function vaultUnlockOrRecoverFix(agentName: string, nextStep = "Then run 'ouro up' again."): string {
  return vaultUnlockReplaceRecoverFix(agentName, nextStep)
}

function failedPingResult(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  result: Exclude<PingResult, { ok: true }>,
): ConfigCheckResult {
  return {
    ok: false,
    error: `${lane} provider ${provider} model ${model} failed live check: ${result.message}`,
    fix: providerLiveCheckFix({
      agentName,
      lane,
      provider,
      classification: result.classification,
    }),
    issue: providerLiveCheckFailedIssue({
      agentName,
      lane,
      provider,
      model,
      classification: result.classification,
      message: result.message,
    }),
  }
}

function credentialRecordForLane(
  pool: ProviderCredentialPool,
  provider: AgentProvider,
): ProviderCredentialRecord | undefined {
  return pool.providers[provider]
}

function laneAudienceLabel(lane: ProviderLane): string {
  return lane === "outward" ? "chat" : "inner dialog"
}

function bindingLabel(binding: { provider: AgentProvider; model: string }): string {
  return `${binding.provider} / ${binding.model}`
}

function selectedProviderPlan(agentName: string, bindings: ProviderBindings): string {
  return [
    `${agentName}: checking the providers in agent.json`,
    ...LANES.map(({ lane }) => `- ${laneAudienceLabel(lane)}: ${bindingLabel(bindings[lane])}`),
  ].join("\n")
}

function selectedProvidersForBindings(bindings: ProviderBindings): AgentProvider[] {
  return [...new Set(LANES.map(({ lane }) => bindings[lane].provider))]
}

function mapVaultRefreshProgress(
  agentName: string,
  onProgress: (message: string) => void,
): (message: string) => void {
  return (message: string) => {
    if (message.startsWith("reading vault items for ")) {
      onProgress(`${agentName}: opening saved provider credentials in the vault`)
      return
    }
    const providerRead = message.match(/^reading ([a-z0-9-]+) credentials\.\.\.$/i)
    if (providerRead) {
      onProgress(`${agentName}: reading saved ${providerRead[1]} credentials`)
      return
    }
    if (message === "parsing provider credentials...") {
      onProgress(`${agentName}: organizing saved provider credentials`)
    }
  }
}

function providerPingSubject(agentName: string, lanes: ProviderLane[]): string {
  const laneList = lanes.map((lane) => laneAudienceLabel(lane)).join(" + ")
  return `${agentName} (${laneList})`
}

/**
 * Structural validation only. Live provider credential validation belongs to
 * checkAgentConfigWithProviderHealth(), which reads the agent vault and pings.
 */
export function checkAgentConfig(
  agentName: string,
  bundlesRoot: string,
): ConfigCheckResult {
  const selectionResult = readProviderSelectionForCheck(agentName, bundlesRoot)
  if (!selectionResult.ok) return selectionResult.result
  if (selectionResult.disabled) return { ok: true }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_valid",
    message: "agent config validation passed",
    meta: {
      agent: agentName,
      providers: selectedProvidersForBindings(selectionResult.bindings),
      liveProviderCheck: false,
    },
  })
  return { ok: true }
}

export async function checkAgentConfigWithProviderHealth(
  agentName: string,
  bundlesRoot: string,
  deps: LiveConfigCheckDeps = {},
): Promise<ConfigCheckResult> {
  const selectionResult = readProviderSelectionForCheck(agentName, bundlesRoot)
  if (!selectionResult.ok) return selectionResult.result
  if (selectionResult.disabled) return { ok: true }

  deps.onProgress?.(selectedProviderPlan(agentName, selectionResult.bindings))

  const ping = deps.pingProvider ?? ((await import("../provider-ping")).pingProvider as unknown as ProviderPing)
  const providers = selectedProvidersForBindings(selectionResult.bindings)
  const poolResult = await refreshProviderCredentialPool(
    agentName,
    {
      ...(deps.onProgress ? { onProgress: mapVaultRefreshProgress(agentName, deps.onProgress) } : {}),
      providers,
      preserveCachedOnFailure: true,
    },
  )

  const pingGroups = new Map<string, {
    provider: AgentProvider
    model: string
    record: ProviderCredentialRecord
    lanes: ProviderLane[]
  }>()
  for (const { lane } of LANES) {
    const binding = selectionResult.bindings[lane]
    if (!poolResult.ok) {
      if (poolResult.reason === "missing") {
        return missingCredentialResult(agentName, lane, binding.provider, binding.model, poolResult.poolPath)
      }
      return invalidPoolResult(agentName, lane, binding.provider, binding.model, {
        ...poolResult,
        reason: poolResult.reason,
      })
    }
    const record = credentialRecordForLane(poolResult.pool, binding.provider)
    if (!record) {
      return missingCredentialResult(agentName, lane, binding.provider, binding.model, poolResult.poolPath)
    }
    const key = `${binding.provider}\0${binding.model}\0${record.revision}`
    const group = pingGroups.get(key)
    if (group) {
      group.lanes.push(lane)
    } else {
      pingGroups.set(key, {
        provider: binding.provider,
        model: binding.model,
        record,
        lanes: [lane],
      })
    }
  }

  const groups = [...pingGroups.values()]
  const pingResults = await Promise.all(groups.map(async (group) => {
    const result = await ping(group.provider, providerCredentialConfig(group.record), {
      model: group.model,
      ...(deps.providerPingOptions ?? {}),
      ...(deps.onProgress
        ? createProviderPingProgressReporter(
            {
              provider: group.provider,
              model: group.model,
              subject: providerPingSubject(agentName, group.lanes),
            },
            deps.onProgress,
          )
        : {}),
    })
    return { group, result }
  }))

  let firstFailure: ConfigCheckResult | null = null
  for (const { group, result } of pingResults) {
    if (!result.ok) {
      for (const lane of group.lanes) {
        recordProviderLaneReadiness({
          agentName,
          lane,
          provider: group.provider,
          model: group.model,
          credentialRevision: group.record.revision,
          status: "failed",
          checkedAt: new Date().toISOString(),
          error: result.message,
          attempts: pingAttemptCount(result),
        })
      }
      firstFailure ??= failedPingResult(agentName, group.lanes[0], group.provider, group.model, result)
      continue
    }
    for (const lane of group.lanes) {
      recordProviderLaneReadiness({
        agentName,
        lane,
        provider: group.provider,
        model: group.model,
        credentialRevision: group.record.revision,
        status: "ready",
        checkedAt: new Date().toISOString(),
        attempts: pingAttemptCount(result),
      })
    }
  }

  if (firstFailure) return firstFailure

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_valid",
    message: "agent config validation passed",
    meta: {
      agent: agentName,
      providers: [...new Set([...pingGroups.values()].map((group) => group.provider))],
      liveProviderCheck: true,
    },
  })
  return { ok: true }
}
