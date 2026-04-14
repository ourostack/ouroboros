/**
 * Shared provider discovery for repair.
 *
 * Runtime repair only trusts the agent vault. First-run conveniences may still
 * inspect env vars before credentials are stored, but once an agent exists the
 * vault is the source of truth.
 */

import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import type { PingResult } from "../provider-ping"
import type { DiscoveredCredential } from "./cli-types"
import {
  refreshProviderCredentialPool,
  type ProviderCredentialRecord,
} from "../provider-credentials"
import { emitNervesEvent } from "../../nerves/runtime"

export interface DiscoverWorkingProviderDeps {
  agentName: string
  pingProvider: (provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>
}

export interface DiscoverWorkingProviderResult {
  provider: AgentProvider
  credentials: Record<string, string>
  providerConfig: Record<string, string>
}

/**
 * Scan environment variables for API keys during first-run bootstrap.
 * This does not participate in runtime provider repair.
 */
export function scanEnvVarCredentials(
  env: Record<string, string | undefined>,
): DiscoveredCredential[] {
  const results: DiscoveredCredential[] = []
  for (const [provider, desc] of Object.entries(PROVIDER_CREDENTIALS) as Array<[AgentProvider, typeof PROVIDER_CREDENTIALS[AgentProvider]]>) {
    const cred: Record<string, string> = {}
    for (const [envVar, credKey] of Object.entries(desc.envVars)) {
      const value = env[envVar]
      if (value) {
        cred[credKey] = value
      }
    }
    const hasRequired = desc.required.some((key) => !!cred[key])
    if (hasRequired) {
      results.push({
        provider,
        agentName: "env",
        credentials: cred,
        providerConfig: { ...cred },
      })
    }
  }
  return results
}

function stringifyProviderFields(fields: Record<string, string | number>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    result[key] = String(value)
  }
  return result
}

function discoveredFromVaultRecord(record: ProviderCredentialRecord, agentName = "vault"): DiscoveredCredential {
  return {
    provider: record.provider,
    agentName,
    credentials: stringifyProviderFields(record.credentials),
    providerConfig: stringifyProviderFields(record.config),
  }
}

export async function discoverInstalledAgentCredentials(agentNames: string[]): Promise<DiscoveredCredential[]> {
  const discovered: DiscoveredCredential[] = []
  for (const agentName of agentNames) {
    if (agentName === "SerpentGuide") continue
    const poolResult = await refreshProviderCredentialPool(agentName, { preserveCachedOnFailure: true })
    if (!poolResult.ok) continue

    for (const record of Object.values(poolResult.pool.providers)) {
      if (!record) continue
      discovered.push(discoveredFromVaultRecord(record, agentName))
    }
  }
  return discovered
}

export function describeDiscoveredCredentialSource(credential: DiscoveredCredential, envVar?: string): string {
  if (credential.agentName === "env") {
    return envVar ? `from env: $${envVar}` : "from env"
  }
  return `from ${credential.agentName}'s vault`
}

export async function discoverWorkingProvider(
  deps: DiscoverWorkingProviderDeps,
): Promise<DiscoverWorkingProviderResult | null> {
  const poolResult = await refreshProviderCredentialPool(deps.agentName)
  if (!poolResult.ok) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.provider_discovery_none",
      message: "provider discovery could not read agent vault",
      meta: { agentName: deps.agentName, reason: poolResult.reason },
    })
    return null
  }

  const candidates = (Object.entries(poolResult.pool.providers) as Array<[AgentProvider, ProviderCredentialRecord]>)
    .map(([, record]) => discoveredFromVaultRecord(record))

  if (candidates.length === 0) {
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.provider_discovery_none",
      message: "no provider credentials found in agent vault",
      meta: { agentName: deps.agentName },
    })
    return null
  }

  for (const candidate of candidates) {
    const config = { ...candidate.providerConfig, ...candidate.credentials } as Record<string, string>
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.provider_discovery_ping",
      message: `pinging provider: ${candidate.provider}`,
      meta: { agentName: deps.agentName, provider: candidate.provider, source: candidate.agentName },
    })

    const result = await deps.pingProvider(candidate.provider, config)
    if (result.ok) {
      emitNervesEvent({
        level: "info",
        component: "daemon",
        event: "daemon.provider_discovery_ok",
        message: `provider discovery succeeded: ${candidate.provider}`,
        meta: { agentName: deps.agentName, provider: candidate.provider, source: candidate.agentName },
      })
      return {
        provider: candidate.provider,
        credentials: candidate.credentials as Record<string, string>,
        providerConfig: candidate.providerConfig,
      }
    }
  }

  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.provider_discovery_all_failed",
    message: "all vault provider candidates failed ping",
    meta: { agentName: deps.agentName, candidateCount: candidates.length },
  })
  return null
}
