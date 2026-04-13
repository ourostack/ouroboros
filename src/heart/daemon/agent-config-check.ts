import * as fs from "fs"
import * as path from "path"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { PingResult, ProviderPingOptions } from "../provider-ping"
import { getDefaultModelForProvider } from "../provider-models"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import {
  bootstrapProviderStateFromAgentConfig,
  readProviderState,
  writeProviderState,
  type ProviderLane,
  type ProviderState,
} from "../provider-state"
import {
  providerCredentialHomeDirFromSecretsRoot,
  readProviderCredentialPool,
  splitProviderCredentialFields,
  upsertProviderCredential,
  type ProviderCredentialPool,
  type ProviderCredentialPoolReadResult,
  type ProviderCredentialRecord,
} from "../provider-credential-pool"

export interface ConfigCheckResult {
  ok: boolean
  error?: string
  fix?: string
}

export type ProviderPing = (
  provider: AgentProvider,
  config: Record<string, unknown>,
  options?: ProviderPingOptions,
) => Promise<PingResult>

export interface LiveConfigCheckDeps {
  pingProvider?: ProviderPing
}

type FacingName = "humanFacing" | "agentFacing"
type SelectedProvider = { facing: FacingName | "provider"; provider: AgentProvider }

interface ConfigCheckContext {
  agentJsonPath: string
  secretsJsonPath: string
  providers: Record<string, Record<string, unknown>>
  selectedProviders: SelectedProvider[]
}

type ConfigCheckContextResult =
  | { ok: true; context: ConfigCheckContext }
  | { ok: false; result: ConfigCheckResult }

function isAgentProvider(value: string): value is AgentProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIALS, value)
}

function agentRootFor(agentName: string, bundlesRoot: string): string {
  return path.join(bundlesRoot, `${agentName}.ouro`)
}

function configPathFor(agentName: string, bundlesRoot: string): string {
  return path.join(agentRootFor(agentName, bundlesRoot), "agent.json")
}

function formatFacingList(facings: Array<FacingName | "provider">): string {
  if (facings.length === 1) return facings[0]!
  return `${facings.slice(0, -1).join(", ")} and ${facings[facings.length - 1]}`
}

function selectedProviderMap(selectedProviders: SelectedProvider[]): Map<AgentProvider, Array<FacingName | "provider">> {
  const byProvider = new Map<AgentProvider, Array<FacingName | "provider">>()
  for (const selected of selectedProviders) {
    const facings = byProvider.get(selected.provider) ?? []
    facings.push(selected.facing)
    byProvider.set(selected.provider, facings)
  }
  return byProvider
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

  return { ok: true, selected: { facing, provider } }
}

function resolveSelectedProviders(
  parsed: Record<string, unknown>,
  agentName: string,
  agentJsonPath: string,
): { ok: true; selectedProviders: SelectedProvider[] } | { ok: false; result: ConfigCheckResult } {
  const hasHumanFacing = parsed.humanFacing !== undefined
  const hasAgentFacing = parsed.agentFacing !== undefined

  if (!hasHumanFacing && !hasAgentFacing && typeof parsed.provider === "string") {
    if (!isAgentProvider(parsed.provider)) {
      return {
        ok: false,
        result: {
          ok: false,
          error: `Unknown provider '${parsed.provider}' in agent.json for '${agentName}'`,
          fix: `Set provider to one of: ${Object.keys(PROVIDER_CREDENTIALS).join(", ")}`,
        },
      }
    }
    return { ok: true, selectedProviders: [{ facing: "provider", provider: parsed.provider }] }
  }

  const human = resolveFacingProvider(parsed, "humanFacing", agentName, agentJsonPath)
  if (!human.ok) return human
  const agent = resolveFacingProvider(parsed, "agentFacing", agentName, agentJsonPath)
  if (!agent.ok) return agent

  return { ok: true, selectedProviders: [human.selected, agent.selected] }
}

function readConfigCheckContext(
  agentName: string,
  bundlesRoot: string,
  secretsRoot: string,
): ConfigCheckContextResult {
  const agentJsonPath = path.join(bundlesRoot, `${agentName}.ouro`, "agent.json")

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

  // Disabled agents are valid — they just won't run
  if (parsed.enabled === false) {
    return {
      ok: true,
      context: {
        agentJsonPath,
        secretsJsonPath: path.join(secretsRoot, agentName, "secrets.json"),
        providers: {},
        selectedProviders: [],
      },
    }
  }

  const selected = resolveSelectedProviders(parsed, agentName, agentJsonPath)
  if (!selected.ok) return selected

  const secretsJsonPath = path.join(secretsRoot, agentName, "secrets.json")
  let secrets: Record<string, unknown>
  try {
    const secretsRaw = fs.readFileSync(secretsJsonPath, "utf-8")
    secrets = JSON.parse(secretsRaw) as Record<string, unknown>
  } catch {
    const firstProvider = selected.selectedProviders[0].provider
    return {
      ok: false,
      result: {
        ok: false,
        error: `secrets.json not found or unreadable at ${secretsJsonPath}`,
        fix: `Run 'ouro auth --agent ${agentName} --provider ${firstProvider}' to configure credentials, or create ${secretsJsonPath} with providers.${firstProvider} credentials.`,
      },
    }
  }

  const providers = secrets.providers as Record<string, Record<string, unknown>> | undefined
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    const firstProvider = selected.selectedProviders[0].provider
    return {
      ok: false,
      result: {
        ok: false,
        error: `secrets.json for '${agentName}' is missing providers object`,
        fix: `Run 'ouro auth --agent ${agentName} --provider ${firstProvider}' to configure credentials.`,
      },
    }
  }

  return {
    ok: true,
    context: {
      agentJsonPath,
      secretsJsonPath,
      providers,
      selectedProviders: selected.selectedProviders,
    },
  }
}

type AgentConfigReadResult =
  | { ok: true; disabled: false; agentJsonPath: string; parsed: Record<string, unknown> }
  | { ok: true; disabled: true; agentJsonPath: string; parsed: Record<string, unknown> }
  | { ok: false; result: ConfigCheckResult }

type BootstrapProviderStateResult =
  | { ok: true; agentRoot: string; state: ProviderState }
  | { ok: false; error?: string; fix?: string }

function readAgentConfigForProviderState(
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

function readFacingForBootstrap(
  parsed: Record<string, unknown>,
  facing: FacingName,
  agentName: string,
  agentJsonPath: string,
): { ok: true; provider: AgentProvider; model: string } | { ok: false; result: ConfigCheckResult } {
  const providerResult = resolveFacingProvider(parsed, facing, agentName, agentJsonPath)
  if (!providerResult.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        error: providerResult.result.error,
        fix: `Run 'ouro use --agent ${agentName} --lane ${facing === "humanFacing" ? "outward" : "inner"} --provider <provider> --model <model>' to configure this machine's provider binding.`,
      },
    }
  }
  const raw = parsed[facing] as Record<string, unknown>
  const model = typeof raw.model === "string" && raw.model.trim().length > 0
    ? raw.model.trim()
    : getDefaultModelForProvider(providerResult.selected.provider)
  return { ok: true, provider: providerResult.selected.provider, model }
}

function bootstrapMissingProviderState(input: {
  agentName: string
  bundlesRoot: string
  secretsRoot: string
  parsed: Record<string, unknown>
  agentJsonPath: string
}): BootstrapProviderStateResult {
  const outward = readFacingForBootstrap(input.parsed, "humanFacing", input.agentName, input.agentJsonPath)
  if (!outward.ok) return { ok: false, error: outward.result.error, fix: outward.result.fix }
  const inner = readFacingForBootstrap(input.parsed, "agentFacing", input.agentName, input.agentJsonPath)
  if (!inner.ok) return { ok: false, error: inner.result.error, fix: inner.result.fix }

  const now = new Date()
  const homeDir = providerCredentialHomeDirFromSecretsRoot(input.secretsRoot)
  const machine = loadOrCreateMachineIdentity({ homeDir, now: () => now })
  const state = bootstrapProviderStateFromAgentConfig({
    machineId: machine.machineId,
    now,
    agentConfig: {
      humanFacing: { provider: outward.provider, model: outward.model },
      agentFacing: { provider: inner.provider, model: inner.model },
    },
  })
  const agentRoot = agentRootFor(input.agentName, input.bundlesRoot)
  writeProviderState(agentRoot, state)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.provider_state_bootstrapped",
    message: "bootstrapped local provider state from agent config",
    meta: { agent: input.agentName, agentRoot },
  })
  return { ok: true, agentRoot, state }
}

type ProviderStateSetupResult =
  | { ok: true; disabled: false; agentRoot: string; state: ProviderState }
  | { ok: true; disabled: true }
  | { ok: false; result: ConfigCheckResult }

function readOrBootstrapProviderStateForCheck(
  agentName: string,
  bundlesRoot: string,
  secretsRoot: string,
): ProviderStateSetupResult {
  const configResult = readAgentConfigForProviderState(agentName, bundlesRoot)
  if (!configResult.ok) return { ok: false, result: configResult.result }
  if (configResult.disabled) return { ok: true, disabled: true }

  const agentRoot = agentRootFor(agentName, bundlesRoot)
  const stateResult = readProviderState(agentRoot)
  if (stateResult.ok) {
    return { ok: true, disabled: false, agentRoot, state: stateResult.state }
  }
  if (stateResult.reason === "invalid") {
    return {
      ok: false,
      result: {
        ok: false,
        error: `provider state for ${agentName} is invalid at ${stateResult.statePath}: ${stateResult.error}`,
        fix: `Run 'ouro use --agent ${agentName} --lane outward --provider <provider> --model <model> --force' to rewrite this machine's provider binding.`,
      },
    }
  }

  const bootstrap = bootstrapMissingProviderState({
    agentName,
    bundlesRoot,
    secretsRoot,
    parsed: configResult.parsed,
    agentJsonPath: configResult.agentJsonPath,
  })
  if (!bootstrap.ok) return { ok: false, result: bootstrap }
  return { ok: true, disabled: false, agentRoot: bootstrap.agentRoot, state: bootstrap.state }
}

function validateSelectedProviderSecrets(agentName: string, context: ConfigCheckContext): ConfigCheckResult {
  for (const [provider, facings] of selectedProviderMap(context.selectedProviders)) {
    const desc = PROVIDER_CREDENTIALS[provider]
    const providerSecrets = context.providers[provider]
    const selectedBy = formatFacingList(facings)

    if (!providerSecrets) {
      return {
        ok: false,
        error: `secrets.json for '${agentName}' is missing providers.${provider} section selected by ${selectedBy}`,
        fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to configure ${provider} credentials.`,
      }
    }

    // Azure special case: managed identity only needs endpoint + deployment.
    if (provider === "azure") {
      const hasEndpoint = typeof providerSecrets.endpoint === "string" && providerSecrets.endpoint.length > 0
      const hasDeployment = typeof providerSecrets.deployment === "string" && providerSecrets.deployment.length > 0
      const hasManagedId = typeof providerSecrets.managedIdentityClientId === "string" && providerSecrets.managedIdentityClientId.length > 0
      if (hasEndpoint && hasDeployment && hasManagedId) {
        continue
      }
    }

    const missing = desc.required.filter((field: string) => {
      const val = providerSecrets[field]
      return typeof val !== "string" || val.length === 0
    })

    if (missing.length > 0) {
      return {
        ok: false,
        error: `secrets.json for '${agentName}' is missing required ${provider} credentials selected by ${selectedBy}: ${missing.join(", ")}`,
        fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to set up ${provider} credentials, or add the missing fields to providers.${provider} in ${context.secretsJsonPath}.`,
      }
    }
  }

  return { ok: true }
}

function emitConfigValid(agentName: string, context: ConfigCheckContext, liveProviderCheck: boolean): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_valid",
    message: "agent config validation passed",
    meta: {
      agent: agentName,
      providers: [...selectedProviderMap(context.selectedProviders).keys()],
      liveProviderCheck,
    },
  })
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

function writeLaneReadiness(input: {
  agentRoot: string
  state: ProviderState
  lane: ProviderLane
  status: "ready" | "failed"
  credentialRevision: string
  error?: string
  attempts?: number
}): void {
  const binding = input.state.lanes[input.lane]
  const checkedAt = new Date().toISOString()
  input.state.updatedAt = checkedAt
  input.state.readiness[input.lane] = {
    status: input.status,
    provider: binding.provider,
    model: binding.model,
    checkedAt,
    credentialRevision: input.credentialRevision,
    ...(input.error ? { error: input.error } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
  }
  writeProviderState(input.agentRoot, input.state)
}

function legacyProviderCredentialCandidates(
  agentName: string,
  secretsRoot: string,
): Array<{
  provider: AgentProvider
  credentials: Record<string, string | number>
  config: Record<string, string | number>
}> {
  const secretsPath = path.join(secretsRoot, agentName, "secrets.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(secretsPath, "utf-8")) as unknown
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const providers = (parsed as Record<string, unknown>).providers
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return []

  const candidates: Array<{
    provider: AgentProvider
    credentials: Record<string, string | number>
    config: Record<string, string | number>
  }> = []
  for (const [providerKey, rawConfig] of Object.entries(providers as Record<string, unknown>)) {
    if (!isAgentProvider(providerKey) || !rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue
    }
    const split = splitProviderCredentialFields(providerKey, rawConfig as Record<string, unknown>)
    if (Object.keys(split.credentials).length === 0 && Object.keys(split.config).length === 0) continue
    candidates.push({ provider: providerKey, credentials: split.credentials, config: split.config })
  }
  return candidates
}

function readPoolWithLegacyMigration(
  agentName: string,
  homeDir: string,
  secretsRoot: string,
): ProviderCredentialPoolReadResult {
  const initial = readProviderCredentialPool(homeDir)
  if (initial.ok || initial.reason === "invalid") return initial

  const candidates = legacyProviderCredentialCandidates(agentName, secretsRoot)
  for (const candidate of candidates) {
    upsertProviderCredential({
      homeDir,
      provider: candidate.provider,
      credentials: candidate.credentials,
      config: candidate.config,
      provenance: {
        source: "legacy-agent-secrets",
        contributedByAgent: agentName,
      },
    })
  }
  return candidates.length > 0 ? readProviderCredentialPool(homeDir) : initial
}

function missingCredentialResult(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  poolPath: string,
): ConfigCheckResult {
  return {
    ok: false,
    error: `${lane} provider ${provider} model ${model} has no credentials in the machine provider pool at ${poolPath}`,
    fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to authenticate this machine, or run 'ouro use --agent ${agentName} --lane ${lane} --provider <provider> --model <model>' to choose a working provider/model.`,
  }
}

function invalidPoolResult(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  pool: { ok: false; reason: "invalid"; poolPath: string; error: string },
): ConfigCheckResult {
  return {
    ok: false,
    error: `${lane} provider ${provider} model ${model} cannot read machine provider credentials at ${pool.poolPath}: ${pool.error}`,
    fix: `Fix ${pool.poolPath}, then run 'ouro auth --agent ${agentName} --provider ${provider}' or 'ouro use --agent ${agentName} --lane ${lane} --provider <provider> --model <model> --force'.`,
  }
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
    fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to refresh credentials, or run 'ouro use --agent ${agentName} --lane ${lane} --provider <provider> --model <model>' to switch this lane.`,
  }
}

function credentialRecordForLane(
  pool: ProviderCredentialPool,
  provider: AgentProvider,
): ProviderCredentialRecord | undefined {
  return pool.providers[provider]
}

/**
 * Pre-spawn validation: ensures agent.json exists and required secrets are present.
 * Returns `{ ok: true }` when the agent is ready to run, or a descriptive error
 * with an actionable fix message when something is missing.
 */
export function checkAgentConfig(
  agentName: string,
  bundlesRoot: string,
  secretsRoot: string,
): ConfigCheckResult {
  const contextResult = readConfigCheckContext(agentName, bundlesRoot, secretsRoot)
  if (!contextResult.ok) return contextResult.result
  const context = contextResult.context
  const structural = validateSelectedProviderSecrets(agentName, context)
  if (!structural.ok) return structural
  emitConfigValid(agentName, context, false)
  return { ok: true }
}

export async function checkAgentConfigWithProviderHealth(
  agentName: string,
  bundlesRoot: string,
  secretsRoot: string,
  deps: LiveConfigCheckDeps = {},
): Promise<ConfigCheckResult> {
  const stateResult = readOrBootstrapProviderStateForCheck(agentName, bundlesRoot, secretsRoot)
  if (!stateResult.ok) return stateResult.result
  if (stateResult.disabled) return { ok: true }

  const ping = deps.pingProvider ?? ((await import("../provider-ping")).pingProvider as unknown as ProviderPing)
  const homeDir = providerCredentialHomeDirFromSecretsRoot(secretsRoot)
  const poolResult = readPoolWithLegacyMigration(agentName, homeDir, secretsRoot)

  const pingGroups = new Map<string, {
    provider: AgentProvider
    model: string
    record: ProviderCredentialRecord
    lanes: ProviderLane[]
  }>()
  const lanes: ProviderLane[] = ["outward", "inner"]
  for (const lane of lanes) {
    const binding = stateResult.state.lanes[lane]
    if (!poolResult.ok) {
      if (poolResult.reason === "missing") {
        return missingCredentialResult(agentName, lane, binding.provider, binding.model, poolResult.poolPath)
      }
      return invalidPoolResult(agentName, lane, binding.provider, binding.model, {
        ...poolResult,
        reason: "invalid",
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

  for (const group of pingGroups.values()) {
    const result = await ping(group.provider, providerCredentialConfig(group.record), { model: group.model })
    if (!result.ok) {
      for (const lane of group.lanes) {
        writeLaneReadiness({
          agentRoot: stateResult.agentRoot,
          state: stateResult.state,
          lane,
          status: "failed",
          credentialRevision: group.record.revision,
          error: result.message,
          attempts: pingAttemptCount(result),
        })
      }
      return failedPingResult(agentName, group.lanes[0], group.provider, group.model, result)
    }
    for (const lane of group.lanes) {
      writeLaneReadiness({
        agentRoot: stateResult.agentRoot,
        state: stateResult.state,
        lane,
        status: "ready",
        credentialRevision: group.record.revision,
        attempts: pingAttemptCount(result),
      })
    }
  }

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
