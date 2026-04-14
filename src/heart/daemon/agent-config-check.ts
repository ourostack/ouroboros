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
  providerCredentialMachineHomeDir,
  refreshProviderCredentialPool,
  type ProviderCredentialPool,
  type ProviderCredentialRecord,
} from "../provider-credentials"

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
  homeDir?: string
}

type FacingName = "humanFacing" | "agentFacing"
type SelectedProvider = { facing: FacingName; provider: AgentProvider }

function isAgentProvider(value: string): value is AgentProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIALS, value)
}

function agentRootFor(agentName: string, bundlesRoot: string): string {
  return path.join(bundlesRoot, `${agentName}.ouro`)
}

function configPathFor(agentName: string, bundlesRoot: string): string {
  return path.join(agentRootFor(agentName, bundlesRoot), "agent.json")
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
  parsed: Record<string, unknown>
  agentJsonPath: string
  homeDir?: string
}): BootstrapProviderStateResult {
  const outward = readFacingForBootstrap(input.parsed, "humanFacing", input.agentName, input.agentJsonPath)
  if (!outward.ok) return { ok: false, error: outward.result.error, fix: outward.result.fix }
  const inner = readFacingForBootstrap(input.parsed, "agentFacing", input.agentName, input.agentJsonPath)
  if (!inner.ok) return { ok: false, error: inner.result.error, fix: inner.result.fix }

  const now = new Date()
  const homeDir = providerCredentialMachineHomeDir(input.homeDir)
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
  deps: LiveConfigCheckDeps = {},
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
    parsed: configResult.parsed,
    agentJsonPath: configResult.agentJsonPath,
    homeDir: deps.homeDir,
  })
  if (!bootstrap.ok) return { ok: false, result: bootstrap }
  return { ok: true, disabled: false, agentRoot: bootstrap.agentRoot, state: bootstrap.state }
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
    fix: `Run 'ouro auth --agent ${agentName} --provider ${provider}' to authenticate this machine, or run 'ouro use --agent ${agentName} --lane ${lane} --provider <provider> --model <model>' to choose a working provider/model.`,
  }
}

function invalidPoolResult(
  agentName: string,
  lane: ProviderLane,
  provider: AgentProvider,
  model: string,
  pool: { ok: false; reason: "invalid" | "unavailable"; poolPath: string; error: string },
): ConfigCheckResult {
  return {
    ok: false,
    error: `${lane} provider ${provider} model ${model} cannot read provider credentials from ${agentName}'s vault at ${pool.poolPath}: ${pool.error}`,
    fix: `Run 'ouro vault unlock --agent ${agentName}', then run 'ouro auth --agent ${agentName} --provider ${provider}' if the credential is missing or stale.`,
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
 * Structural validation only. Live provider credential validation belongs to
 * checkAgentConfigWithProviderHealth(), which reads the agent vault and pings.
 */
export function checkAgentConfig(
  agentName: string,
  bundlesRoot: string,
): ConfigCheckResult {
  const configResult = readAgentConfigForProviderState(agentName, bundlesRoot)
  if (!configResult.ok) return configResult.result
  if (configResult.disabled) return { ok: true }
  const outward = readFacingForBootstrap(configResult.parsed, "humanFacing", agentName, configResult.agentJsonPath)
  if (!outward.ok) return outward.result
  const inner = readFacingForBootstrap(configResult.parsed, "agentFacing", agentName, configResult.agentJsonPath)
  if (!inner.ok) return inner.result
  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_valid",
    message: "agent config validation passed",
    meta: {
      agent: agentName,
      providers: [...new Set([outward.provider, inner.provider])],
      liveProviderCheck: false,
    },
  })
  return { ok: true }
}

export async function checkAgentConfigWithProviderHealth(
  agentName: string,
  bundlesRoot: string,
  secretsRootOrDeps: string | LiveConfigCheckDeps = {},
  maybeDeps: LiveConfigCheckDeps = {},
): Promise<ConfigCheckResult> {
  const deps = typeof secretsRootOrDeps === "string"
    ? {
      ...maybeDeps,
      homeDir: maybeDeps.homeDir ?? (path.basename(secretsRootOrDeps) === ".agentsecrets" ? path.dirname(secretsRootOrDeps) : undefined),
    }
    : secretsRootOrDeps
  const stateResult = readOrBootstrapProviderStateForCheck(agentName, bundlesRoot, deps)
  if (!stateResult.ok) return stateResult.result
  if (stateResult.disabled) return { ok: true }

  const ping = deps.pingProvider ?? ((await import("../provider-ping")).pingProvider as unknown as ProviderPing)
  const poolResult = await refreshProviderCredentialPool(agentName)

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
