import { emitNervesEvent } from "../../nerves/runtime"
import type { ProviderErrorClassification } from "../core"
import type { AgentProvider } from "../identity"
import type { ProviderLane } from "../provider-state"
import {
  buildHumanReadinessSnapshot,
  readinessItemFromIssue,
} from "./human-readiness"
import { renderHumanReadinessBoard } from "./human-command-screens"

export type RepairActor = "agent-runnable" | "human-required" | "human-choice"
export type RepairSeverity = "blocked" | "degraded" | "advisory"

export type RepairActionKind =
  | "vault-create"
  | "vault-unlock"
  | "vault-replace"
  | "vault-recover"
  | "provider-auth"
  | "provider-retry"
  | "provider-use"

export type AgentReadinessIssueKind =
  | "vault-unconfigured"
  | "vault-locked"
  | "provider-credentials-missing"
  | "provider-live-check-failed"
  | "generic"

interface RepairActionBase {
  label: string
  command: string
  actor: RepairActor
  executable?: boolean
}

export interface ProviderAuthRepairAction extends RepairActionBase {
  kind: "provider-auth"
  provider: AgentProvider
}

export type RepairAction =
  | (RepairActionBase & { kind: "vault-create" })
  | (RepairActionBase & { kind: "vault-unlock" })
  | (RepairActionBase & { kind: "vault-replace" })
  | (RepairActionBase & { kind: "vault-recover" })
  | ProviderAuthRepairAction
  | (RepairActionBase & { kind: "provider-retry" })
  | (RepairActionBase & {
      kind: "provider-use"
      lane?: ProviderLane
    })

export interface AgentReadinessIssue {
  kind: AgentReadinessIssueKind
  severity: RepairSeverity
  actor: RepairActor
  summary: string
  detail?: string
  actions: RepairAction[]
}

export interface AgentReadinessReport {
  agent: string
  ok: boolean
  issues: AgentReadinessIssue[]
}

export interface GuidedReadinessRepairDeps {
  promptInput?: (prompt: string) => Promise<string>
  writeStdout: (text: string) => void
  runRepairAction?: (agentName: string, action: RepairAction, issue: AgentReadinessIssue) => Promise<void>
  onActionAttempted?: (agentName: string, action: RepairAction, issue: AgentReadinessIssue) => void
  isTTY?: boolean
  stdoutColumns?: number
}

export interface GuidedReadinessRepairResult {
  repairsAttempted: boolean
}

export function vaultLockedIssue(agentName: string): AgentReadinessIssue {
  return {
    kind: "vault-locked",
    severity: "blocked",
    actor: "human-required",
    summary: `${agentName}: vault locked`,
    detail: "Pick the path that matches what the human actually has. Ouro will not print or store the unlock secret as a portable file.",
    actions: [
      {
        kind: "vault-unlock",
        label: "Unlock with saved secret",
        command: `ouro vault unlock --agent ${agentName}`,
        actor: "human-required",
      },
      {
        kind: "vault-replace",
        label: "Create empty replacement vault",
        command: `ouro vault replace --agent ${agentName}`,
        actor: "human-required",
      },
      {
        kind: "vault-recover",
        label: "Recover from JSON export",
        command: `ouro vault recover --agent ${agentName} --from <json>`,
        actor: "human-required",
        executable: false,
      },
    ],
  }
}

export function vaultUnconfiguredIssue(agentName: string): AgentReadinessIssue {
  return {
    kind: "vault-unconfigured",
    severity: "blocked",
    actor: "human-required",
    summary: `${agentName}: vault not configured`,
    detail: "This bundle does not have a vault locator in agent.json yet. Create the agent vault before authenticating providers.",
    actions: [
      {
        kind: "vault-create",
        label: "Create this agent's vault",
        command: `ouro vault create --agent ${agentName}`,
        actor: "human-required",
      },
      {
        kind: "vault-recover",
        label: "Recover from JSON export",
        command: `ouro vault recover --agent ${agentName} --from <json>`,
        actor: "human-required",
        executable: false,
      },
    ],
  }
}

export function providerCredentialMissingIssue(input: {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  model: string
  credentialPath: string
}): AgentReadinessIssue {
  return {
    kind: "provider-credentials-missing",
    severity: "blocked",
    actor: "human-required",
    summary: `${input.agentName}: missing ${input.provider} credentials (${input.lane}, ${input.model})`,
    detail: `source: ${input.credentialPath}`,
    actions: [
      {
        kind: "provider-auth",
        label: `Authenticate ${input.provider}`,
        command: `ouro auth --agent ${input.agentName} --provider ${input.provider}`,
        actor: "human-required",
        provider: input.provider,
      },
      {
        kind: "provider-use",
        label: "Choose another provider/model",
        command: `ouro use --agent ${input.agentName} --lane ${input.lane} --provider <provider> --model <model>`,
        actor: "human-choice",
        executable: false,
        lane: input.lane,
      },
    ],
  }
}

function normalizeProviderLiveCheckClassification(
  classification: ProviderErrorClassification | string,
): ProviderErrorClassification {
  switch (classification) {
    case "auth-failure":
    case "usage-limit":
    case "rate-limit":
    case "server-error":
    case "network-error":
    case "unknown":
      return classification
    default:
      return "unknown"
  }
}

function providerUseAction(input: {
  agentName: string
  lane: ProviderLane
}): RepairAction {
  return {
    kind: "provider-use",
    label: "Choose a different working provider/model",
    command: `ouro use --agent ${input.agentName} --lane ${input.lane} --provider <provider> --model <model>`,
    actor: "human-choice",
    executable: false,
    lane: input.lane,
  }
}

function providerAuthAction(input: {
  agentName: string
  provider: AgentProvider
}): RepairAction {
  return {
    kind: "provider-auth",
    label: `Refresh ${input.provider} credentials`,
    command: `ouro auth --agent ${input.agentName} --provider ${input.provider}`,
    actor: "human-required",
    provider: input.provider,
  }
}

function providerRetryAction(input: {
  agentName: string
  label: string
}): RepairAction {
  return {
    kind: "provider-retry",
    label: input.label,
    command: `ouro repair --agent ${input.agentName}`,
    actor: "human-choice",
    executable: false,
  }
}

export function providerLiveCheckFix(input: {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  classification: ProviderErrorClassification | string
}): string {
  const classification = normalizeProviderLiveCheckClassification(input.classification)
  const authCommand = `ouro auth --agent ${input.agentName} --provider ${input.provider}`
  const useCommand = `ouro use --agent ${input.agentName} --lane ${input.lane} --provider <provider> --model <model>`
  switch (classification) {
    case "auth-failure":
      return `Run '${authCommand}' to refresh credentials, or run '${useCommand}' to choose another provider/model for this lane.`
    case "usage-limit":
      return `This usually means ${input.provider} hit a usage limit. Restore quota, then run 'ouro up' again. Or run '${useCommand}' to choose another provider/model for this lane.`
    case "rate-limit":
      return `Run 'ouro up' again after a short wait. Or run '${useCommand}' to choose another provider/model for this lane.`
    case "server-error":
      return `Run 'ouro up' again in a moment. If ${input.provider} keeps failing, run '${useCommand}' to choose another provider/model for this lane.`
    case "network-error":
      return `Check the network or provider availability, then run 'ouro up' again. Or run '${useCommand}' to choose another provider/model for this lane.`
    case "unknown":
      return `Run 'ouro up' again. If it keeps failing, run '${authCommand}' to refresh credentials or '${useCommand}' to choose another provider/model for this lane.`
  }
}

function providerLiveCheckActions(input: {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  classification: ProviderErrorClassification | string
}): RepairAction[] {
  const classification = normalizeProviderLiveCheckClassification(input.classification)
  const useAction = providerUseAction(input)
  const authAction = providerAuthAction(input)
  switch (classification) {
    case "auth-failure":
      return [authAction, useAction]
    case "usage-limit":
      return [
        providerRetryAction({ agentName: input.agentName, label: "After restoring quota, check again" }),
        useAction,
      ]
    case "rate-limit":
      return [
        providerRetryAction({ agentName: input.agentName, label: "Give it a minute, then check again" }),
        useAction,
      ]
    case "server-error":
      return [
        providerRetryAction({ agentName: input.agentName, label: "Check again in a moment" }),
        useAction,
      ]
    case "network-error":
      return [
        providerRetryAction({ agentName: input.agentName, label: "Check again after the network settles" }),
        useAction,
        authAction,
      ]
    case "unknown":
      return [
        providerRetryAction({ agentName: input.agentName, label: "Check again" }),
        authAction,
        useAction,
      ]
  }
}

export function preferredConnectRepairAction(issue: AgentReadinessIssue | undefined): RepairAction | undefined {
  if (!issue) return undefined
  if (issue.kind === "provider-live-check-failed" && issue.actions[0]?.kind === "provider-retry") {
    return issue.actions.find((action) => action.kind !== "provider-retry") ?? issue.actions[0]
  }
  return issue.actions[0]
}

export function providerLiveCheckFailedIssue(input: {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  model: string
  classification: ProviderErrorClassification | string
  message: string
}): AgentReadinessIssue {
  return {
    kind: "provider-live-check-failed",
    severity: "blocked",
    actor: "human-choice",
    summary: `${input.agentName}: ${input.lane} provider ${input.provider} / ${input.model} failed live check`,
    detail: input.message,
    actions: providerLiveCheckActions(input),
  }
}

export function genericReadinessIssue(input: {
  summary: string
  detail?: string
  fix?: string
}): AgentReadinessIssue {
  return {
    kind: "generic",
    severity: "degraded",
    actor: "human-choice",
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    actions: input.fix
      ? [{
          kind: "provider-use",
          label: "Follow the printed fix",
          command: input.fix,
          actor: "human-choice",
          executable: false,
        }]
      : [],
  }
}

export function isKnownReadinessIssue(issue: AgentReadinessIssue | undefined): boolean {
  return !!issue && issue.kind !== "generic"
}

export function renderReadinessIssue(issue: AgentReadinessIssue): string {
  const lines = [issue.summary]
  if (issue.detail) {
    lines.push(`  ${issue.detail}`)
  }
  if (issue.actions.length > 0) {
    lines.push("")
  }
  issue.actions.forEach((action, index) => {
    if (index > 0) lines.push("")
    lines.push(`${index + 1}. ${action.label}`)
    lines.push(`   ${action.command}`)
  })
  if (issue.actions.length > 0) {
    lines.push("")
  }
  lines.push(`${issue.actions.length + 1}. Skip for now`)
  return lines.join("\n")
}

export function renderReadinessIssueNextSteps(issue: AgentReadinessIssue): string[] {
  const lines = [issue.summary]
  if (issue.detail && issue.kind !== "vault-locked") {
    lines.push(`  ${issue.detail}`)
  }
  issue.actions.forEach((action, index) => {
    lines.push(`  ${index === 0 ? "next" : "or"}: ${action.command}`)
  })
  return lines
}

function selectedActionFor(answer: string, issue: AgentReadinessIssue): RepairAction | "skip" | null {
  const selected = Number.parseInt(answer.trim(), 10)
  if (!Number.isFinite(selected)) return null
  if (selected === issue.actions.length + 1) return "skip"
  if (selected < 1 || selected > issue.actions.length) return null
  /* v8 ignore next -- defensive: bounds were checked above, but keep sparse arrays harmless @preserve */
  return issue.actions[selected - 1] ?? null
}

function isExecutableAction(action: RepairAction): boolean {
  if (action.executable === false) return false
  return !action.command.includes("<")
}

export async function runGuidedReadinessRepair(
  reports: AgentReadinessReport[],
  deps: GuidedReadinessRepairDeps,
): Promise<GuidedReadinessRepairResult> {
  emitNervesEvent({
    level: "info",
    component: "daemon",
    event: "daemon.readiness_repair_start",
    message: "guided readiness repair started",
    meta: { reportCount: reports.length },
  })

  let repairsAttempted = false

  for (const report of reports) {
    if (report.ok || report.issues.length === 0) continue
    for (const issue of report.issues) {
      if (deps.isTTY) {
        const snapshot = buildHumanReadinessSnapshot({
          agent: report.agent,
          title: `Repair ${report.agent}`,
          items: [
            readinessItemFromIssue(issue, {
              key: `${report.agent}:${issue.kind}`,
              title: issue.summary,
            }),
          ],
        })
        deps.writeStdout(renderHumanReadinessBoard({
          agent: report.agent,
          title: `Repair ${report.agent}`,
          subtitle: "Choose the path that matches what the human actually has.",
          snapshot,
          isTTY: true,
          columns: deps.stdoutColumns,
          prompt: `Choose [1-${issue.actions.length + 1}]: `,
        }).trimEnd())
      } else {
        deps.writeStdout(renderReadinessIssue(issue))
      }
      if (!deps.promptInput) {
        deps.writeStdout(`manual repair required for ${report.agent}; run one of the commands above.`)
        continue
      }

      const answer = await deps.promptInput(`Choose [1-${issue.actions.length + 1}]: `)
      const action = selectedActionFor(answer, issue)
      if (action === "skip") {
        deps.writeStdout(`skipped ${report.agent} for now.`)
        continue
      }
      if (!action) {
        deps.writeStdout(`invalid choice for ${report.agent}; no repair attempted.`)
        continue
      }
      if (!isExecutableAction(action)) {
        deps.writeStdout(`manual step for ${report.agent}: ${action.command}`)
        continue
      }

      if (!deps.runRepairAction) {
        deps.writeStdout(`repair runner unavailable for ${report.agent}; run \`${action.command}\` manually.`)
        continue
      }

      try {
        deps.onActionAttempted?.(report.agent, action, issue)
        await deps.runRepairAction(report.agent, action, issue)
        repairsAttempted = true
        deps.writeStdout(`repair step finished for ${report.agent}.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        repairsAttempted = true
        deps.writeStdout(`repair error for ${report.agent}: ${message}`)
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.readiness_repair_error",
          message: "guided readiness repair action failed",
          meta: { agent: report.agent, issue: issue.kind, action: action.kind, error: message },
        })
      }
    }
  }

  emitNervesEvent({
    level: "info",
    component: "daemon",
    event: "daemon.readiness_repair_end",
    message: "guided readiness repair completed",
    meta: { repairsAttempted },
  })

  return { repairsAttempted }
}
