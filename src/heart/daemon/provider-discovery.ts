/**
 * Shared provider discovery — single path for finding a working LLM provider.
 *
 * Scans disk credentials and environment variables, deduplicates by provider
 * (disk first), then pings each candidate to validate credentials actually work.
 */

import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import type { PingResult } from "../provider-ping"
import type { DiscoveredCredential } from "./cli-types"
import { emitNervesEvent } from "../../nerves/runtime"

export interface DiscoverWorkingProviderDeps {
  discoverExistingCredentials: (secretsRoot: string) => DiscoveredCredential[]
  pingProvider: (provider: AgentProvider, config: Record<string, string>) => Promise<PingResult>
  env: Record<string, string | undefined>
  secretsRoot: string
}

export interface DiscoverWorkingProviderResult {
  provider: AgentProvider
  credentials: Record<string, string>
  providerConfig: Record<string, string>
}

/**
 * Scan environment variables for API keys using the canonical PROVIDER_CREDENTIALS descriptor.
 * Returns one DiscoveredCredential per provider that has at least one required field set.
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
    // Only register if at least one required field was found
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

/**
 * Discover the first working provider by scanning disk credentials and env vars,
 * deduplicating by provider (disk first), and pinging each candidate.
 */
export async function discoverWorkingProvider(
  deps: DiscoverWorkingProviderDeps,
): Promise<DiscoverWorkingProviderResult | null> {
  const diskCreds = deps.discoverExistingCredentials(deps.secretsRoot)
  const envCreds = scanEnvVarCredentials(deps.env)

  // Deduplicate: disk credentials first, env vars as fallback for providers not on disk
  const seenProviders = new Set<AgentProvider>()
  const candidates: DiscoveredCredential[] = []

  for (const cred of diskCreds) {
    if (!seenProviders.has(cred.provider)) {
      seenProviders.add(cred.provider)
      candidates.push(cred)
    }
  }
  for (const cred of envCreds) {
    if (!seenProviders.has(cred.provider)) {
      seenProviders.add(cred.provider)
      candidates.push(cred)
    }
  }

  if (candidates.length === 0) {
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.provider_discovery_none",
      message: "no provider credentials found on disk or in environment",
      meta: {},
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
      meta: { provider: candidate.provider, source: candidate.agentName },
    })

    const result = await deps.pingProvider(candidate.provider, config)
    if (result.ok) {
      emitNervesEvent({
        level: "info",
        component: "daemon",
        event: "daemon.provider_discovery_ok",
        message: `provider discovery succeeded: ${candidate.provider}`,
        meta: { provider: candidate.provider, source: candidate.agentName },
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
    message: "all provider candidates failed ping",
    meta: { candidateCount: candidates.length },
  })
  return null
}
