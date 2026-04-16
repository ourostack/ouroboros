import { emitNervesEvent } from "../../nerves/runtime"
import type { AgentProvider } from "../identity"
import type { ProviderLane } from "../provider-state"

export type RepairActor = "agent-runnable" | "human-required" | "human-choice"
export type RepairSeverity = "blocked" | "degraded" | "advisory"

export type RepairActionKind =
  | "vault-unlock"
  | "vault-replace"
  | "vault-recover"
  | "provider-auth"
  | "provider-use"

export type AgentReadinessIssueKind =
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
  | (RepairActionBase & { kind: "vault-unlock" })
  | (RepairActionBase & { kind: "vault-replace" })
  | (RepairActionBase & { kind: "vault-recover" })
  | ProviderAuthRepairAction
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
}

export interface GuidedReadinessRepairResult {
  repairsAttempted: boolean
}

export function vaultLockedIssue(agentName: string): AgentReadinessIssue {
  return {
    kind: "vault-locked",
    severity: "blocked",
    actor: "human-required",
    summary: `${agentName} needs its vault unlocked on this machine.`,
    detail: "Choose the path that matches what the human actually has. Ouro will not print or store a portable copy of the unlock secret.",
    actions: [
      {
        kind: "vault-unlock",
        label: "I have the saved vault unlock secret",
        command: `ouro vault unlock --agent ${agentName}`,
        actor: "human-required",
      },
      {
        kind: "vault-replace",
        label: "Nobody saved it; create an empty vault and re-enter credentials",
        command: `ouro vault replace --agent ${agentName}`,
        actor: "human-required",
      },
      {
        kind: "vault-recover",
        label: "I have an old JSON credential export",
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
    summary: `${input.agentName} is missing ${input.provider} credentials for the ${input.lane} lane.`,
    detail: `Selected model: ${input.model}. Credential source: ${input.credentialPath}.`,
    actions: [
      {
        kind: "provider-auth",
        label: `Authenticate ${input.provider} for ${input.agentName}`,
        command: `ouro auth --agent ${input.agentName} --provider ${input.provider}`,
        actor: "human-required",
        provider: input.provider,
      },
      {
        kind: "provider-use",
        label: "Choose a different working provider/model for this lane",
        command: `ouro use --agent ${input.agentName} --lane ${input.lane} --provider <provider> --model <model>`,
        actor: "human-choice",
        executable: false,
        lane: input.lane,
      },
    ],
  }
}

export function providerLiveCheckFailedIssue(input: {
  agentName: string
  lane: ProviderLane
  provider: AgentProvider
  model: string
  message: string
}): AgentReadinessIssue {
  return {
    kind: "provider-live-check-failed",
    severity: "blocked",
    actor: "human-choice",
    summary: `${input.agentName}'s ${input.lane} lane provider ${input.provider} / ${input.model} failed its live check.`,
    detail: input.message,
    actions: [
      {
        kind: "provider-auth",
        label: `Refresh ${input.provider} credentials`,
        command: `ouro auth --agent ${input.agentName} --provider ${input.provider}`,
        actor: "human-required",
        provider: input.provider,
      },
      {
        kind: "provider-use",
        label: "Choose a different working provider/model for this lane",
        command: `ouro use --agent ${input.agentName} --lane ${input.lane} --provider <provider> --model <model>`,
        actor: "human-choice",
        executable: false,
        lane: input.lane,
      },
    ],
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
  issue.actions.forEach((action, index) => {
    lines.push(`${index + 1}. ${action.label}`)
    lines.push(`   runs: ${action.command}`)
  })
  lines.push(`${issue.actions.length + 1}. Skip for now`)
  return lines.join("\n")
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
      deps.writeStdout(renderReadinessIssue(issue))
      if (!deps.promptInput) {
        deps.writeStdout(`manual repair required for ${report.agent}; run one of the commands above.`)
        continue
      }

      const answer = await deps.promptInput(`Choose [1-${issue.actions.length + 1}]: `)
      const action = selectedActionFor(answer, issue)
      if (action === "skip") {
        deps.writeStdout(`repair skipped for ${report.agent}.`)
        continue
      }
      if (!action) {
        deps.writeStdout(`invalid repair choice for ${report.agent}; no repair attempted.`)
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
        await deps.runRepairAction(report.agent, action, issue)
        repairsAttempted = true
        deps.writeStdout(`repair attempted for ${report.agent}`)
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
