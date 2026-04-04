import * as fs from "fs"
import * as path from "path"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

export interface ConfigCheckResult {
  ok: boolean
  error?: string
  fix?: string
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
  const agentJsonPath = path.join(bundlesRoot, `${agentName}.ouro`, "agent.json")

  let raw: string
  try {
    raw = fs.readFileSync(agentJsonPath, "utf-8")
  } catch {
    return {
      ok: false,
      error: `agent.json not found at ${agentJsonPath}`,
      fix: `Run 'ouro hatch ${agentName}' to create the agent bundle, or verify that ${bundlesRoot}/${agentName}.ouro/ exists.`,
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      error: `agent.json at ${agentJsonPath} contains invalid JSON`,
      fix: `Open ${agentJsonPath} and fix the JSON syntax.`,
    }
  }

  // Disabled agents are valid — they just won't run
  if (parsed.enabled === false) {
    return { ok: true }
  }

  // Resolve provider: humanFacing.provider > config.provider
  let provider: string | undefined
  const humanFacing = parsed.humanFacing as Record<string, unknown> | undefined
  if (humanFacing && typeof humanFacing.provider === "string") {
    provider = humanFacing.provider
  } else if (typeof parsed.provider === "string") {
    provider = parsed.provider
  }

  if (!provider) {
    return {
      ok: false,
      error: `agent.json for '${agentName}' has no provider configured`,
      fix: `Add humanFacing.provider to ${agentJsonPath}. Valid providers: ${Object.keys(PROVIDER_CREDENTIALS).join(", ")}`,
    }
  }

  const desc = PROVIDER_CREDENTIALS[provider as AgentProvider]
  if (!desc) {
    return {
      ok: false,
      error: `Unknown provider '${provider}' in agent.json for '${agentName}'`,
      fix: `Set humanFacing.provider to one of: ${Object.keys(PROVIDER_CREDENTIALS).join(", ")}`,
    }
  }

  // Azure with managed identity does not require apiKey — skip secrets check
  // when endpoint + deployment are present (managed identity auth)
  const secretsJsonPath = path.join(secretsRoot, agentName, "secrets.json")
  let secrets: Record<string, unknown>
  try {
    const secretsRaw = fs.readFileSync(secretsJsonPath, "utf-8")
    secrets = JSON.parse(secretsRaw) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      error: `secrets.json not found or unreadable at ${secretsJsonPath}`,
      fix: `Run 'ouro auth ${agentName}' to configure credentials, or create ${secretsJsonPath} with providers.${provider} credentials.`,
    }
  }

  const providers = secrets.providers as Record<string, Record<string, unknown>> | undefined
  const providerSecrets = providers?.[provider]

  if (!providerSecrets) {
    return {
      ok: false,
      error: `secrets.json for '${agentName}' is missing providers.${provider} section`,
      fix: `Run 'ouro auth ${agentName}' to configure ${provider} credentials.`,
    }
  }

  // Azure special case: managed identity only needs endpoint + deployment
  if (provider === "azure") {
    const hasEndpoint = typeof providerSecrets.endpoint === "string" && providerSecrets.endpoint.length > 0
    const hasDeployment = typeof providerSecrets.deployment === "string" && providerSecrets.deployment.length > 0
    const hasManagedId = typeof providerSecrets.managedIdentityClientId === "string" && providerSecrets.managedIdentityClientId.length > 0
    if (hasEndpoint && hasDeployment && hasManagedId) {
      return { ok: true }
    }
  }

  const missing = desc.required.filter((field: string) => {
    const val = providerSecrets[field]
    return typeof val !== "string" || val.length === 0
  })

  if (missing.length > 0) {
    return {
      ok: false,
      error: `secrets.json for '${agentName}' is missing required ${provider} credentials: ${missing.join(", ")}`,
      fix: `Run 'ouro auth ${agentName}' to set up ${provider} credentials, or add the missing fields to providers.${provider} in ${secretsJsonPath}.`,
    }
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.agent_config_valid",
    message: "agent config validation passed",
    meta: { agent: agentName, provider },
  })

  return { ok: true }
}
