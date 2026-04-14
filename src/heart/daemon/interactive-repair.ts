/**
 * Interactive repair flow for degraded agents detected during `ouro up`.
 *
 * Examines each degraded agent's errorReason and fixHint to detect common
 * issue patterns and prompt the user for repair actions.
 */

import { emitNervesEvent } from "../../nerves/runtime"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"

export interface DegradedAgent {
  agent: string
  errorReason: string
  fixHint: string
}

export interface InteractiveRepairDeps {
  promptInput: (prompt: string) => Promise<string>
  writeStdout: (msg: string) => void
  runAuthFlow: (agent: string, provider?: AgentProvider) => Promise<void>
  runVaultUnlock?: (agent: string) => Promise<void>
}

export interface InteractiveRepairResult {
  repairsAttempted: boolean
}

function isCredentialIssue(degraded: DegradedAgent): boolean {
  const reason = degraded.errorReason.toLowerCase()
  const hint = degraded.fixHint.toLowerCase()
  return reason.includes("credentials") || hint.includes("ouro auth")
}

function isVaultUnlockIssue(degraded: DegradedAgent): boolean {
  const text = `${degraded.errorReason}\n${degraded.fixHint}`.toLowerCase()
  return text.includes("ouro vault unlock")
    || text.includes("credential vault is locked")
    || text.includes("vault is locked")
    || text.includes("vault locked")
}

function isConfigError(degraded: DegradedAgent): boolean {
  return degraded.fixHint.length > 0 && !isVaultUnlockIssue(degraded) && !isCredentialIssue(degraded)
}

function isAgentProvider(value: string): value is AgentProvider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CREDENTIALS, value)
}

function extractProviderFromFixHint(fixHint: string): AgentProvider | undefined {
  const provider = fixHint.match(/--provider\s+([a-z0-9-]+)/)?.[1]
    ?? fixHint.match(/providers\.([a-z0-9-]+)/)?.[1]
  if (!provider || !isAgentProvider(provider)) return undefined
  return provider
}

function authCommandFor(degraded: DegradedAgent): string {
  const command = degraded.fixHint.match(/ouro auth[^\n.]+/)?.[0]?.trim()
  return command && command.length > 0 ? command : `ouro auth --agent ${degraded.agent}`
}

function vaultUnlockCommandFor(degraded: DegradedAgent): string {
  const command = degraded.fixHint.match(/ouro vault unlock[^\n.]+/)?.[0]?.trim()
  return command && command.length > 0 ? command : `ouro vault unlock --agent ${degraded.agent}`
}

export async function runInteractiveRepair(
  degraded: DegradedAgent[],
  deps: InteractiveRepairDeps,
): Promise<InteractiveRepairResult> {
  emitNervesEvent({
    level: "info",
    component: "daemon",
    event: "daemon.interactive_repair_start",
    message: "interactive repair flow started",
    meta: { degradedCount: degraded.length },
  })

  if (degraded.length === 0) {
    return { repairsAttempted: false }
  }

  let repairsAttempted = false

  for (const entry of degraded) {
    if (isVaultUnlockIssue(entry)) {
      const unlockCommand = vaultUnlockCommandFor(entry)
      const answer = await deps.promptInput(
        `run \`${unlockCommand}\` now? [y/n] `,
      )
      if (answer.toLowerCase() === "y") {
        try {
          if (!deps.runVaultUnlock) {
            deps.writeStdout(`fix hint for ${entry.agent}: ${entry.fixHint}`)
          } else {
            await deps.runVaultUnlock(entry.agent)
            repairsAttempted = true
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          deps.writeStdout(`vault unlock error for ${entry.agent}: ${msg}`)
          repairsAttempted = true
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.interactive_repair_vault_unlock_error",
            message: `vault unlock failed for ${entry.agent}`,
            meta: { agent: entry.agent, error: msg },
          })
        }
      }
    } else if (isCredentialIssue(entry)) {
      const provider = extractProviderFromFixHint(entry.fixHint)
      const authCommand = authCommandFor(entry)
      const answer = await deps.promptInput(
        `run \`${authCommand}\` now? [y/n] `,
      )
      if (answer.toLowerCase() === "y") {
        try {
          if (provider) {
            await deps.runAuthFlow(entry.agent, provider)
          } else {
            await deps.runAuthFlow(entry.agent)
          }
          repairsAttempted = true
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          deps.writeStdout(`auth flow error for ${entry.agent}: ${msg}`)
          repairsAttempted = true
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.interactive_repair_auth_error",
            message: `auth flow failed for ${entry.agent}`,
            meta: { agent: entry.agent, error: msg },
          })
        }
      }
    } else if (isConfigError(entry)) {
      deps.writeStdout(`fix hint for ${entry.agent}: ${entry.fixHint}`)
    } else {
      // Unknown error with no actionable fix hint
      deps.writeStdout(`${entry.agent}: ${entry.errorReason}`)
    }
  }

  emitNervesEvent({
    level: "info",
    component: "daemon",
    event: "daemon.interactive_repair_end",
    message: "interactive repair flow completed",
    meta: { repairsAttempted },
  })

  return { repairsAttempted }
}
