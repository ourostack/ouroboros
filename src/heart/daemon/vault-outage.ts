import { emitNervesEvent } from "../../nerves/runtime"
import type { ConfigCheckResult } from "./agent-config-check"

export interface ReadinessIssueSummary {
  summary: string
  actions: ReadonlyArray<{ actor: string; command: string }>
}

export interface VaultOutageDeps {
  /** One fresh vault read plus provider check for an agent; the daemon never caches credentials on disk. */
  check: (agent: string) => Promise<ConfigCheckResult>
  onDegraded: (agent: string, reason: string) => void
  onRecovered: (agent: string) => void
  schedule?: (run: () => void, delayMs: number) => { unref?: () => void } | undefined
  initialDelayMs?: number
  maxDelayMs?: number
}

const DEFAULT_INITIAL_DELAY_MS = 5_000
const DEFAULT_MAX_DELAY_MS = 5 * 60_000

/**
 * Boot-time provider readiness that tolerates an unreachable vault. A vault that
 * answers with a rejection (locked, missing, wrong credentials) is still a failure;
 * one that doesn't answer degrades that agent and retries with backoff instead of
 * taking the whole daemon down.
 */
export async function prepareProviderRuntimeTolerantOfVaultOutage(
  agents: readonly string[],
  deps: VaultOutageDeps,
): Promise<ReadinessIssueSummary[]> {
  const results = await Promise.all(agents.map(async (agent): Promise<ReadinessIssueSummary | null> => {
    const result = await deps.check(agent)
    if (result.ok) return null
    if (result.vaultUnreachable) {
      beginVaultOutageRecovery(agent, result.error ?? "vault unreachable", deps)
      return null
    }
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.provider_readiness_unavailable",
      message: "fresh provider readiness was unavailable before daemon startup",
      meta: { agent },
    })
    return result.issue ?? {
      summary: `${agent}: provider runtime unavailable`,
      actions: [{ actor: "agent-runnable", command: "ouro doctor" }],
    }
  }))
  return results.filter((entry): entry is ReadinessIssueSummary => entry !== null)
}

function beginVaultOutageRecovery(agent: string, reason: string, deps: VaultOutageDeps): void {
  const schedule = deps.schedule ?? ((run, delayMs) => setTimeout(run, delayMs))
  const maxDelayMs = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  let delayMs = deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS

  deps.onDegraded(agent, reason)
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.vault_unreachable_degraded",
    message: "vault unreachable at startup; daemon stays up in degraded mode and retries with backoff",
    meta: { agent, reason },
  })

  const attempt = (): void => {
    void deps.check(agent).then((result) => {
      if (result.ok) {
        deps.onRecovered(agent)
        emitNervesEvent({
          component: "daemon",
          event: "daemon.vault_recovered",
          message: "vault reachable again; agent left degraded mode",
          meta: { agent },
        })
        return
      }
      // A rejection (not just silence) needs a human; it stays degraded and visible while we keep retrying slowly.
      deps.onDegraded(agent, result.error ?? reason)
      scheduleNext()
    }).catch((error: unknown) => {
      deps.onDegraded(agent, error instanceof Error ? error.message : String(error))
      scheduleNext()
    })
  }
  const scheduleNext = (): void => {
    const handle = schedule(attempt, delayMs)
    handle?.unref?.()
    delayMs = Math.min(delayMs * 2, maxDelayMs)
  }
  scheduleNext()
}
