import type { RepairActor, AgentReadinessIssue, RepairAction } from "./readiness-repair"
import { emitNervesEvent } from "../../nerves/runtime"

export type HumanReadinessStatus =
  | "ready"
  | "needs attention"
  | "needs credentials"
  | "needs setup"
  | "missing"
  | "locked"
  | "attached"
  | "not attached"

export interface HumanReadinessAction {
  label: string
  command: string
  actor: RepairActor
  executable?: boolean
  recommended?: boolean
}

export interface HumanReadinessItem {
  key: string
  title: string
  status: HumanReadinessStatus
  summary: string
  detailLines: string[]
  actions: HumanReadinessAction[]
}

export interface HumanReadinessSnapshot {
  agent: string
  title: string
  status: HumanReadinessStatus
  summary: string
  items: HumanReadinessItem[]
  primaryAction?: HumanReadinessAction
  nextActions: HumanReadinessAction[]
}

interface ReadinessItemFromIssueOptions {
  key: string
  title: string
}

interface BuildHumanReadinessSnapshotOptions {
  agent: string
  title: string
  items: HumanReadinessItem[]
}

const STATUS_PRIORITY: Record<HumanReadinessStatus, number> = {
  locked: 0,
  "needs credentials": 1,
  "needs attention": 2,
  "needs setup": 3,
  missing: 4,
  "not attached": 5,
  ready: 6,
  attached: 6,
}

function statusFromIssue(issue: AgentReadinessIssue): HumanReadinessStatus {
  switch (issue.kind) {
    case "vault-locked":
      return "locked"
    case "vault-unconfigured":
      return "needs setup"
    case "provider-credentials-missing":
      return "needs credentials"
    case "provider-live-check-failed":
      return "needs attention"
    case "generic":
      return "needs attention"
  }
}

function copyActions(actions: RepairAction[]): HumanReadinessAction[] {
  return actions.map((action) => ({
    label: action.label,
    command: action.command,
    actor: action.actor,
    ...(action.executable === undefined ? {} : { executable: action.executable }),
  }))
}

export function readinessItemFromIssue(
  issue: AgentReadinessIssue,
  options: ReadinessItemFromIssueOptions,
): HumanReadinessItem {
  return {
    key: options.key,
    title: options.title,
    status: statusFromIssue(issue),
    summary: issue.summary,
    detailLines: issue.detail ? [issue.detail] : [],
    actions: copyActions(issue.actions),
  }
}

function compareStatus(a: HumanReadinessItem, b: HumanReadinessItem): number {
  return STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
}

function uniqueActions(items: HumanReadinessItem[]): HumanReadinessAction[] {
  const seen = new Set<string>()
  const actions: HumanReadinessAction[] = []
  for (const item of [...items].sort(compareStatus)) {
    for (const [index, action] of item.actions.entries()) {
      if (seen.has(action.command)) continue
      seen.add(action.command)
      actions.push({
        ...action,
        ...(actions.length === 0 && index === 0 ? { recommended: true } : {}),
      })
    }
  }
  return actions
}

function overallStatus(items: HumanReadinessItem[]): HumanReadinessStatus {
  if (items.length === 0) return "ready"
  return [...items].sort(compareStatus)[0].status
}

function summaryFor(status: HumanReadinessStatus): string {
  if (status === "ready" || status === "attached") {
    return "Everything needed here is ready."
  }
  if (status === "locked") {
    return "Start by unlocking the vault on this machine, then continue through the remaining steps."
  }
  if (status === "needs credentials") {
    return "At least one credential is missing, so the next move is to authenticate it."
  }
  if (status === "needs attention") {
    return "Something is configured but not healthy yet, so verify or refresh it before moving on."
  }
  if (status === "needs setup") {
    return "This capability needs setup before it can be used."
  }
  return "This area still needs a little attention."
}

export function buildHumanReadinessSnapshot(
  options: BuildHumanReadinessSnapshotOptions,
): HumanReadinessSnapshot {
  const status = overallStatus(options.items)
  const nextActions = uniqueActions(options.items)
  const primaryAction = nextActions[0]

  emitNervesEvent({
    component: "daemon",
    event: "daemon.human_readiness_snapshot",
    message: "built human readiness snapshot",
    meta: {
      agent: options.agent,
      title: options.title,
      items: options.items.length,
      status,
    },
  })

  return {
    agent: options.agent,
    title: options.title,
    status,
    summary: summaryFor(status),
    items: [...options.items].sort(compareStatus),
    ...(primaryAction ? { primaryAction } : {}),
    nextActions,
  }
}
