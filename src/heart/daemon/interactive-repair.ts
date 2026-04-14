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

type RunnableRepairAction =
  | { kind: "vault-unlock"; label: "vault unlock"; command: string }
  | { kind: "provider-auth"; label: "provider auth"; command: string; provider?: AgentProvider }

function isCredentialIssue(degraded: DegradedAgent): boolean {
  const reason = degraded.errorReason.toLowerCase()
  const hint = degraded.fixHint.toLowerCase()
  return reason.includes("credentials") || hint.includes("ouro auth")
}

function isVaultUnlockIssue(degraded: DegradedAgent): boolean {
  const text = `${degraded.errorReason}\n${degraded.fixHint}`.toLowerCase()
  return /ouro vault unlock|credential vault is locked|vault(?: is)? locked/.test(text)
}

function isConfigError(degraded: DegradedAgent): boolean {
  return degraded.fixHint.length > 0 && !isVaultUnlockIssue(degraded) && !isCredentialIssue(degraded)
}

export function hasRunnableInteractiveRepair(degraded: DegradedAgent): boolean {
  return isVaultUnlockIssue(degraded) || isCredentialIssue(degraded)
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function cleanExtractedCommand(command: string | undefined): string | undefined {
  const cleaned = command?.trim().replace(/[`'",;:.)]+$/g, "").trim()
  return cleaned && cleaned.length > 0 ? cleaned : undefined
}

function extractRepairCommand(fixHint: string, commandPrefix: string): string | undefined {
  const escapedPrefix = escapeRegExp(commandPrefix)
  const commandBody = `${escapedPrefix}(?=\\s|$)[^\`'"]*`
  const quoted = fixHint.match(new RegExp(`[\`'"](${commandBody})[\`'"]`, "i"))?.[1]
  const unquoted = fixHint.match(new RegExp(`(${escapedPrefix}(?=\\s|$)[^\\n,;.]+)`, "i"))?.[1]
  return cleanExtractedCommand(quoted) ?? cleanExtractedCommand(unquoted)
}

function authCommandFor(degraded: DegradedAgent): string {
  const command = extractRepairCommand(degraded.fixHint, "ouro auth")
  return command && command.length > 0 ? command : `ouro auth --agent ${degraded.agent}`
}

function vaultUnlockCommandFor(degraded: DegradedAgent): string {
  const command = extractRepairCommand(degraded.fixHint, "ouro vault unlock")
  return command && command.length > 0 ? command : `ouro vault unlock --agent ${degraded.agent}`
}

export function isAffirmativeAnswer(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim())
}

function writeDeclinedRepair(degraded: DegradedAgent, command: string, deps: InteractiveRepairDeps): void {
  deps.writeStdout(`repair skipped for ${degraded.agent}; run \`${command}\` later.`)
}

function runnableRepairActionFor(degraded: DegradedAgent): RunnableRepairAction | undefined {
  if (isVaultUnlockIssue(degraded)) {
    return { kind: "vault-unlock", label: "vault unlock", command: vaultUnlockCommandFor(degraded) }
  }

  if (isCredentialIssue(degraded)) {
    return {
      kind: "provider-auth",
      label: "provider auth",
      command: authCommandFor(degraded),
      provider: extractProviderFromFixHint(degraded.fixHint),
    }
  }

  return undefined
}

function writeRepairQueueSummary(degraded: DegradedAgent[], deps: InteractiveRepairDeps): void {
  const repairable = degraded
    .map((entry) => ({ entry, action: runnableRepairActionFor(entry) }))
    .filter((item): item is { entry: DegradedAgent; action: RunnableRepairAction } => item.action !== undefined)

  if (repairable.length < 2) return

  const lines = [
    "repair queue:",
    ...repairable.map(({ entry, action }) => `  - ${entry.agent}: ${action.label}: \`${action.command}\``),
  ]
  deps.writeStdout(lines.join("\n"))
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
  writeRepairQueueSummary(degraded, deps)

  for (const entry of degraded) {
    const action = runnableRepairActionFor(entry)

    if (action?.kind === "vault-unlock") {
      const answer = await deps.promptInput(
        `run \`${action.command}\` now? [y/n] `,
      )
      if (isAffirmativeAnswer(answer)) {
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
      } else {
        writeDeclinedRepair(entry, action.command, deps)
      }
    } else if (action?.kind === "provider-auth") {
      const answer = await deps.promptInput(
        `run \`${action.command}\` now? [y/n] `,
      )
      if (isAffirmativeAnswer(answer)) {
        try {
          if (action.provider) {
            await deps.runAuthFlow(entry.agent, action.provider)
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
      } else {
        writeDeclinedRepair(entry, action.command, deps)
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
