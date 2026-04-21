/**
 * Interactive repair flow for degraded agents detected during `ouro up`.
 *
 * Examines each degraded agent's errorReason and fixHint to detect common
 * issue patterns and prompt the user for repair actions.
 */

import { emitNervesEvent } from "../../nerves/runtime"
import { PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import type { AgentReadinessIssue, RepairAction } from "./readiness-repair"
import { renderTerminalWizard, type TerminalWizardStatus } from "./terminal-ui"

export interface DegradedAgent {
  agent: string
  errorReason: string
  fixHint: string
  issue?: AgentReadinessIssue
}

export interface InteractiveRepairDeps {
  promptInput: (prompt: string) => Promise<string>
  writeStdout: (msg: string) => void
  runAuthFlow: (agent: string, provider?: AgentProvider) => Promise<void>
  runVaultUnlock?: (agent: string) => Promise<void>
  recheckAgent?: (agent: string) => Promise<DegradedAgent | null>
  skipQueueSummary?: boolean
  isTTY?: boolean
  stdoutColumns?: number
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
  if (degraded.issue?.actions.some((action) => typedActionToRunnable(degraded, action) !== undefined)) {
    return true
  }
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

function uniqueCommands(commands: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  commands.forEach((command) => {
    if (!command) return
    if (seen.has(command)) return
    seen.add(command)
    unique.push(command)
  })
  return unique
}

function fallbackCommandsFor(degraded: DegradedAgent, primaryCommand: string): string[] {
  const issueCommands = degraded.issue?.actions.map((action) => action.command) ?? []
  return uniqueCommands([
    primaryCommand,
    ...issueCommands,
    extractRepairCommand(degraded.fixHint, "ouro vault replace"),
    extractRepairCommand(degraded.fixHint, "ouro vault recover"),
    extractRepairCommand(degraded.fixHint, "ouro use"),
  ])
}

function renderRepairChoices(prefix: "next" | "run", commands: string[]): string[] {
  return commands.map((command, index) => `  ${index === 0 ? prefix : "or"}: ${command}`)
}

function repairStatusFor(action: RunnableRepairAction): TerminalWizardStatus {
  return action.kind === "vault-unlock" ? "locked" : "needs credentials"
}

function renderRepairQueueSummaryLines(degraded: DegradedAgent[]): string[] {
  const repairable = degraded
    .map((entry) => ({ entry, action: runnableRepairActionFor(entry) }))
    .filter((item): item is { entry: DegradedAgent; action: RunnableRepairAction } => item.action !== undefined)

  if (repairable.length < 2) return []

  const lines = [
    "Repair queue",
    `${repairable.length} agents need attention before startup can finish.`,
    "",
  ]

  repairable.forEach(({ entry, action }, index) => {
    lines.push(`${entry.agent} - ${action.label}`)
    lines.push(`  ${action.command}`)
    if (index < repairable.length - 1) lines.push("")
  })

  return lines
}

function renderRepairQueueSummary(degraded: DegradedAgent[], deps: InteractiveRepairDeps): string {
  const repairable = degraded
    .map((entry) => ({ entry, action: runnableRepairActionFor(entry) }))
    .filter((item): item is { entry: DegradedAgent; action: RunnableRepairAction } => item.action !== undefined)

  if (!deps.isTTY) {
    return renderRepairQueueSummaryLines(degraded).join("\n")
  }

  return renderTerminalWizard({
    isTTY: true,
    columns: deps.stdoutColumns,
    masthead: {
      subtitle: "Repair paths ready.",
    },
    title: "Needs attention before startup can finish",
    summary: "Ouro found repair steps it can open right now. It will walk through them one at a time.",
    sections: [{
      title: "Repair queue",
      items: repairable.map(({ entry, action }) => ({
        label: entry.agent,
        status: repairStatusFor(action),
        summary: action.label,
        detailLines: [entry.errorReason],
        command: action.command,
      })),
    }],
    suppressEvent: true,
  }).trimEnd()
}

function renderActionPromptLines(agent: string, action: RunnableRepairAction): string[] {
  const lines = [
    `${agent}`,
    `  needs: ${action.label}`,
    `  run:   ${action.command}`,
  ]
  if (action.kind === "vault-unlock") {
    lines.push("  note:  use the saved vault unlock secret")
  }
  return lines
}

function renderActionPrompt(entry: DegradedAgent, action: RunnableRepairAction, deps: InteractiveRepairDeps): string {
  if (!deps.isTTY) return renderActionPromptLines(entry.agent, action).join("\n")

  const footer = action.kind === "vault-unlock"
    ? "Only say yes if you have the saved vault unlock secret."
    : "Say yes if you want Ouro to open the auth flow now."

  return renderTerminalWizard({
    isTTY: true,
    columns: deps.stdoutColumns,
    masthead: {
      subtitle: "One repair step at a time.",
    },
    title: `Repair ${entry.agent}`,
    summary: "Ouro found one clear next move for this agent.",
    nextStep: {
      label: action.kind === "vault-unlock"
        ? "Unlock the credential vault on this machine."
        : "Refresh provider authentication.",
      detail: action.kind === "vault-unlock"
        ? "Use the saved unlock secret if you have it. If not, leave this for later and choose a replacement or recovery path."
        : "This opens the provider login or refresh flow for the selected provider.",
      command: action.command,
    },
    sections: [{
      title: "Why startup paused",
      items: [{
        label: entry.agent,
        status: repairStatusFor(action),
        summary: entry.errorReason,
      }],
    }],
    footerLines: [footer],
    suppressEvent: true,
  }).trimEnd()
}

function renderDeferredRepair(agent: string, commands: string[], deps: InteractiveRepairDeps): string {
  if (!deps.isTTY) {
    return [
      `Leaving ${agent} for later.`,
      ...renderRepairChoices("next", commands),
    ].join("\n")
  }
  return renderTerminalWizard({
    isTTY: true,
    columns: deps.stdoutColumns,
    masthead: {
      subtitle: "Nothing changed yet.",
    },
    title: `Leaving ${agent} for later`,
    summary: "Ouro did not open this repair flow right now.",
    sections: [{
      title: "Next time",
      items: commands.map((command, index) => ({
        key: String(index + 1),
        label: index === 0 ? "Start here" : "Or try this",
        command,
      })),
    }],
    suppressEvent: true,
  }).trimEnd()
}

function renderManualRepairHint(agent: string, fixHint: string): string {
  return [
    `${agent}`,
    "  needs manual attention",
    `  next: ${fixHint}`,
  ].join("\n")
}

function renderUnknownRepair(agent: string, errorReason: string): string {
  return [
    `${agent}`,
    `  ${errorReason}`,
  ].join("\n")
}

function writeDeclinedRepair(degraded: DegradedAgent, command: string, deps: InteractiveRepairDeps): void {
  deps.writeStdout(renderDeferredRepair(degraded.agent, fallbackCommandsFor(degraded, command), deps))
}

function runnableRepairActionFor(degraded: DegradedAgent): RunnableRepairAction | undefined {
  const typedAction = degraded.issue?.actions
    .map((action) => typedActionToRunnable(degraded, action))
    .find((action): action is RunnableRepairAction => action !== undefined)
  if (typedAction) return typedAction

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

function typedActionToRunnable(degraded: DegradedAgent, action: RepairAction): RunnableRepairAction | undefined {
  if (action.executable === false || action.command.includes("<")) return undefined
  if (action.kind === "vault-unlock") {
    return { kind: "vault-unlock", label: "vault unlock", command: action.command }
  }
  if (action.kind === "provider-auth") {
    return {
      kind: "provider-auth",
      label: "provider auth",
      command: action.command || `ouro auth --agent ${degraded.agent}`,
      provider: action.provider,
    }
  }
  return undefined
}

function writeRepairQueueSummary(degraded: DegradedAgent[], deps: InteractiveRepairDeps): void {
  const lines = renderRepairQueueSummaryLines(degraded)
  if (lines.length > 0) deps.writeStdout(renderRepairQueueSummary(degraded, deps))
}

interface RepairStepOutcome {
  succeeded: boolean
  attempted: boolean
}

async function attemptVaultUnlock(
  entry: DegradedAgent,
  action: RunnableRepairAction,
  deps: InteractiveRepairDeps,
): Promise<RepairStepOutcome> {
  deps.writeStdout(renderActionPrompt(entry, action, deps))
  const answer = await deps.promptInput(
    `Unlock ${entry.agent}'s vault now? [y/N] `,
  )
  if (!isAffirmativeAnswer(answer)) {
    writeDeclinedRepair(entry, action.command, deps)
    return { succeeded: false, attempted: false }
  }
  try {
    if (!deps.runVaultUnlock) {
      deps.writeStdout(renderManualRepairHint(entry.agent, entry.fixHint))
      return { succeeded: false, attempted: false }
    }
    await deps.runVaultUnlock(entry.agent)
    return { succeeded: true, attempted: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    deps.writeStdout(`Vault unlock did not finish for ${entry.agent}.\n  ${msg}`)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.interactive_repair_vault_unlock_error",
      message: `vault unlock failed for ${entry.agent}`,
      meta: { agent: entry.agent, error: msg },
    })
    return { succeeded: false, attempted: true }
  }
}

async function attemptProviderAuth(
  entry: DegradedAgent,
  action: RunnableRepairAction & { kind: "provider-auth"; provider?: AgentProvider },
  deps: InteractiveRepairDeps,
): Promise<RepairStepOutcome> {
  deps.writeStdout(renderActionPrompt(entry, action, deps))
  const answer = await deps.promptInput(
    `Open the auth flow for ${entry.agent} now? [y/N] `,
  )
  if (!isAffirmativeAnswer(answer)) {
    writeDeclinedRepair(entry, action.command, deps)
    return { succeeded: false, attempted: false }
  }
  try {
    if (action.provider) {
      await deps.runAuthFlow(entry.agent, action.provider)
    } else {
      await deps.runAuthFlow(entry.agent)
    }
    return { succeeded: true, attempted: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    deps.writeStdout(`Auth did not finish for ${entry.agent}.\n  ${msg}`)
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.interactive_repair_auth_error",
      message: `auth flow failed for ${entry.agent}`,
      meta: { agent: entry.agent, error: msg },
    })
    return { succeeded: false, attempted: true }
  }
}

async function processEntry(
  entry: DegradedAgent,
  deps: InteractiveRepairDeps,
): Promise<{ attempted: boolean }> {
  let current: DegradedAgent | null = entry

  while (current) {
    const action = runnableRepairActionFor(current)

    let outcome: RepairStepOutcome | undefined

    if (action?.kind === "vault-unlock") {
      outcome = await attemptVaultUnlock(current, action, deps)
    } else if (action?.kind === "provider-auth") {
      outcome = await attemptProviderAuth(current, action, deps)
    } else if (isConfigError(current)) {
      deps.writeStdout(renderManualRepairHint(current.agent, current.fixHint))
      return { attempted: false }
    } else {
      deps.writeStdout(renderUnknownRepair(current.agent, current.errorReason))
      return { attempted: false }
    }

    if (!outcome.succeeded || !deps.recheckAgent) {
      return { attempted: outcome.attempted }
    }

    // Re-evaluate the agent after successful repair
    const recheckResult = await deps.recheckAgent(current.agent)
    if (recheckResult === null) {
      deps.writeStdout(`${current.agent} recovered.`)
      return { attempted: true }
    }

    // Agent still degraded with a new error -- loop to present the new action
    current = recheckResult
  }

  /* v8 ignore next -- unreachable: loop always returns from within @preserve */
  return { attempted: false }
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
  if (!deps.skipQueueSummary) {
    writeRepairQueueSummary(degraded, deps)
  }

  for (const entry of degraded) {
    const result = await processEntry(entry, deps)
    if (result.attempted) repairsAttempted = true
  }

  if (repairsAttempted) {
    deps.writeStdout("Repair flow complete.")
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
