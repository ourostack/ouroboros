import * as fs from "fs"
import * as path from "path"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { PingResult } from "../provider-ping"

export interface ConfigCheckResult {
  ok: boolean
  error?: string
  fix?: string
}

export type ProviderPing = (provider: AgentProvider, config: Record<string, unknown>) => Promise<PingResult>

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

function providerPingFailureResult(
  agentName: string,
  provider: AgentProvider,
  facings: Array<FacingName | "provider">,
  result: Exclude<PingResult, { ok: true }>,
): ConfigCheckResult {
  const selectedBy = formatFacingList(facings)
  const authFix = `Run 'ouro auth --agent ${agentName} --provider ${provider}' to refresh credentials.`
  const verifyFix = `Run 'ouro auth verify --agent ${agentName} --provider ${provider}' for details.`
  return {
    ok: false,
    error: `selected provider ${provider} for ${selectedBy} failed health check: ${result.message}`,
    fix: `${result.classification === "auth-failure" ? authFix : verifyFix} Or switch the affected facing to a working provider.`,
  }
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
  const contextResult = readConfigCheckContext(agentName, bundlesRoot, secretsRoot)
  if (!contextResult.ok) return contextResult.result
  const context = contextResult.context
  const structural = validateSelectedProviderSecrets(agentName, context)
  if (!structural.ok) return structural

  const ping = deps.pingProvider ?? ((await import("../provider-ping")).pingProvider as unknown as ProviderPing)
  for (const [provider, facings] of selectedProviderMap(context.selectedProviders)) {
    const result = await ping(provider, context.providers[provider]!)
    if (!result.ok) {
      return providerPingFailureResult(agentName, provider, facings, result)
    }
  }

  emitConfigValid(agentName, context, true)
  return { ok: true }
}
