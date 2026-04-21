import type { ProviderLane } from "../provider-state"
import type { AgentProviderVisibility, ProviderVisibilityLane } from "../provider-visibility"
import { emitNervesEvent } from "../../nerves/runtime"
import { renderTerminalWizard, type TerminalWizardItem, type TerminalWizardSection } from "./terminal-ui"
import { preferredConnectRepairAction, type AgentReadinessIssue } from "./readiness-repair"

export type ConnectMenuStatus =
  | "ready"
  | "needs attention"
  | "needs credentials"
  | "needs setup"
  | "missing"
  | "locked"
  | "attached"
  | "not attached"

export type ConnectMenuSection = "Providers" | "Portable" | "This machine"

export interface ConnectMenuEntry {
  option: "1" | "2" | "3" | "4" | "5"
  name: string
  section: ConnectMenuSection
  status: ConnectMenuStatus
  description?: string
  detailLines?: string[]
  nextAction?: string
  nextNote?: string
  laneSummaries?: ConnectProviderLaneSummary[]
}

export interface ConnectProviderLaneSummary {
  lane: ProviderLane
  status: ConnectMenuStatus
  title: string
  detail: string
  action?: string
}

export interface ConnectProviderSummary {
  status: ConnectMenuStatus
  detailLines: string[]
  laneSummaries: ConnectProviderLaneSummary[]
  nextAction?: string
  nextNote?: string
}

interface ConnectRenderOptions {
  agent: string
  isTTY: boolean
  columns?: number
  prompt: string
}

const CONNECT_STATUS_PRIORITY: Record<ConnectMenuStatus, number> = {
  "needs attention": 0,
  locked: 1,
  "needs credentials": 2,
  "needs setup": 3,
  missing: 4,
  "not attached": 5,
  ready: 6,
  attached: 6,
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function cleanExtractedCommand(command: string | undefined): string | undefined {
  const cleaned = command?.trim().replace(/[`'",;:.)]+$/g, "").trim()
  return cleaned && cleaned.length > 0 ? cleaned : undefined
}

function extractCommand(fixHint: string, commandPrefix: string): string | undefined {
  const escapedPrefix = escapeRegExp(commandPrefix)
  const commandBody = `${escapedPrefix}(?=\\s|$)[^\`'"]*`
  const quoted = fixHint.match(new RegExp(`[\`'"](${commandBody})[\`'"]`, "i"))?.[1]
  const unquoted = fixHint.match(new RegExp(`(${escapedPrefix}(?=\\s|$)[^\\n,;.]+)`, "i"))?.[1]
  return cleanExtractedCommand(quoted) ?? cleanExtractedCommand(unquoted)
}

function resolveProviderHealthStatus(
  providerHealth?: ProviderHealthSummary,
): ConnectMenuStatus | undefined {
  if (!providerHealth || providerHealth.ok) return undefined
  const issue = providerHealth.issue
  if (issue?.kind === "vault-locked") return "locked"
  if (issue?.kind === "vault-unconfigured") return "needs setup"
  if (issue?.kind === "provider-credentials-missing") return "needs credentials"
  if (issue?.kind === "provider-live-check-failed") return "needs attention"
  const error = String(providerHealth.error).toLowerCase()
  const fix = String(providerHealth.fix).toLowerCase()
  if (error.includes("failed live check")) return "needs attention"
  if (error.includes("has no credentials")) return "needs credentials"
  if (error.includes("missing") && error.includes("provider")) return "needs setup"
  if (error.includes("vault is locked") || error.includes("vault locked")) return "locked"
  if (fix.includes("ouro auth verify")) return "needs attention"
  if (fix.includes("ouro auth")) return "needs credentials"
  if (fix.includes("ouro use")) return "needs setup"
  if (fix.includes("vault unlock")) return "locked"
  return "needs attention"
}

function resolveProviderHealthCommand(
  providerHealth: ProviderHealthSummary | undefined,
  status: ConnectMenuStatus | undefined,
): string | undefined {
  const issueCommand = preferredConnectRepairAction(providerHealth?.issue)?.command
  if (issueCommand) return issueCommand
  const fixHint = providerHealth?.fix
  if (!fixHint) return undefined
  const prefixes = status === "locked"
    ? ["ouro vault unlock", "ouro vault replace", "ouro vault recover"]
    : status === "needs credentials"
      ? ["ouro auth", "ouro connect", "ouro provider refresh", "ouro up"]
      : status === "needs setup"
        ? ["ouro use", "ouro connect", "ouro auth", "ouro up"]
        : ["ouro auth verify", "ouro auth", "ouro provider refresh", "ouro use", "ouro connect", "ouro vault unlock", "ouro up"]
  for (const prefix of prefixes) {
    const command = extractCommand(fixHint, prefix)
    if (command) return command
  }
  return undefined
}

function providerHealthTargetLane(providerHealth: ProviderHealthSummary | undefined): ProviderLane | undefined {
  const issue = providerHealth?.issue
  const actionLane = issue?.actions
    .map((action) => "lane" in action && action.lane ? action.lane : undefined)
    .find((lane): lane is ProviderLane => lane === "outward" || lane === "inner")
  if (actionLane) return actionLane

  const text = [issue?.summary, issue?.detail, providerHealth?.error]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  if (/\boutward provider\b/.test(text) || /\boutward lane\b/.test(text)) return "outward"
  if (/\binner provider\b/.test(text) || /\binner lane\b/.test(text)) return "inner"
  return undefined
}

function providerHealthAppliesToLane(
  providerHealth: ProviderHealthSummary | undefined,
  lane: ProviderVisibilityLane,
): boolean {
  const targetLane = providerHealthTargetLane(providerHealth)
  return !targetLane || targetLane === lane.lane
}

function providerHealthDetail(
  providerHealth: ProviderHealthSummary | undefined,
  status: ConnectMenuStatus,
): string {
  if (status === "locked") return "vault locked on this machine"
  if (status === "needs credentials") return "credentials missing"
  if (status === "needs setup") {
    return providerHealth?.issue?.detail ?? providerHealth?.error ?? "needs setup"
  }
  const detail = providerHealth?.issue?.detail ?? providerHealth?.error
  if (!detail) return "live check needs attention"
  return /failed live check/i.test(detail) ? detail : `failed live check: ${detail}`
}

function isProblemStatus(status: ConnectMenuStatus): boolean {
  return status !== "ready" && status !== "attached"
}

function providerEntrySummary(entry: ConnectMenuEntry): string {
  return entry.description ?? "Selected provider lanes for this machine."
}

function providerEntryDetailLines(entry: ConnectMenuEntry): string[] {
  const lines: string[] = []
  if (entry.nextNote && !/^(Outward|Inner) lane: /.test(entry.nextNote)) {
    lines.push(entry.nextNote)
  }
  if (entry.laneSummaries && entry.laneSummaries.length > 0) {
    for (const lane of entry.laneSummaries) {
      const laneLabel = lane.lane === "outward" ? "Outward lane" : "Inner lane"
      lines.push(`${laneLabel}: ${lane.title} — ${lane.detail}`)
    }
    return lines
  }
  return [...lines, ...(entry.detailLines ?? [])]
}

function capabilityEntryDetailLines(entry: ConnectMenuEntry): string[] {
  return [
    ...(entry.detailLines ?? []),
    ...(entry.nextNote ? [entry.nextNote] : []),
  ]
}

function entryToWizardItem(entry: ConnectMenuEntry): TerminalWizardItem {
  return {
    key: entry.option,
    label: entry.name,
    status: entry.status,
    ...(entry.section === "Providers"
      ? { summary: providerEntrySummary(entry) }
      : entry.description
        ? { summary: entry.description }
        : {}),
    detailLines: entry.section === "Providers"
      ? providerEntryDetailLines(entry)
      : capabilityEntryDetailLines(entry),
    ...(entry.nextAction ? { command: entry.nextAction } : {}),
  }
}

function nextStepFor(entries: ConnectMenuEntry[]): { label: string; detail?: string; command?: string } {
  const nextEntry = entries.find((entry) => isProblemStatus(entry.status))
  if (!nextEntry) {
    return {
      label: "Everything here is already connected.",
      detail: "Pick any capability if you want to review it, refresh it, or change its setup.",
    }
  }
  return {
    label: `Start with ${nextEntry.name}.`,
    detail: nextEntry.nextNote ?? nextEntry.description ?? `Status: ${nextEntry.status}.`,
    command: nextEntry.nextAction,
  }
}

function sectionToWizard(entries: ConnectMenuEntry[], section: ConnectMenuSection, summary?: string): TerminalWizardSection {
  return {
    title: section,
    summary,
    items: entries.filter((entry) => entry.section === section).map((entry) => entryToWizardItem(entry)),
  }
}

export function summarizeProviderLane(
  agent: string,
  lane: ProviderVisibilityLane,
  providerHealth?: ProviderHealthSummary,
): ConnectProviderLaneSummary {
  const providerHealthStatus = resolveProviderHealthStatus(providerHealth)
  const providerHealthCommand = resolveProviderHealthCommand(providerHealth, providerHealthStatus)
  if (lane.status === "unconfigured") {
    return {
      lane: lane.lane,
      status: "needs setup",
      title: "choose provider and model",
      detail: "needs setup",
      action: lane.repairCommand,
    }
  }

  const fallbackAction = providerHealthCommand ?? lane.credential.repairCommand
  if (providerHealth?.ok) {
    return {
      lane: lane.lane,
      status: "ready",
      title: `${lane.provider} / ${lane.model}`,
      detail: "ready",
    }
  }
  if (providerHealthStatus && providerHealthAppliesToLane(providerHealth, lane)) {
    return {
      lane: lane.lane,
      status: providerHealthStatus,
      title: `${lane.provider} / ${lane.model}`,
      detail: providerHealthDetail(providerHealth, providerHealthStatus),
      action: fallbackAction,
    }
  }
  if (lane.credential.status === "missing") {
    return {
      lane: lane.lane,
      status: "needs credentials",
      title: `${lane.provider} / ${lane.model}`,
      detail: "credentials missing",
      action: fallbackAction,
    }
  }
  if (lane.credential.status === "invalid-pool") {
    return {
      lane: lane.lane,
      status: providerHealthStatus === "locked" ? "locked" : "needs attention",
      title: `${lane.provider} / ${lane.model}`,
      detail: providerHealthStatus === "locked" ? "vault locked on this machine" : "vault unavailable",
      action: fallbackAction,
    }
  }
  if (lane.readiness.status === "failed") {
    return {
      lane: lane.lane,
      status: "needs attention",
      title: `${lane.provider} / ${lane.model}`,
      detail: `failed live check: ${lane.readiness.error ?? "unknown error"}`,
      action: providerHealthCommand ?? providerHealth?.fix ?? `ouro auth --agent ${agent} --provider ${lane.provider}`,
    }
  }
  if (lane.readiness.status === "stale") {
    return {
      lane: lane.lane,
      status: "needs attention",
      title: `${lane.provider} / ${lane.model}`,
      detail: ["live check is stale", lane.readiness.reason].filter(Boolean).join(": "),
      action: providerHealth?.fix,
    }
  }
  if (lane.readiness.status === "ready") {
    return {
      lane: lane.lane,
      status: "ready",
      title: `${lane.provider} / ${lane.model}`,
      detail: "ready",
    }
  }
  return {
    lane: lane.lane,
    status: "needs attention",
    title: `${lane.provider} / ${lane.model}`,
    detail: "live check did not complete yet",
    action: providerHealth?.fix,
  }
}

export function summarizeProvidersForConnect(
  agent: string,
  visibility: AgentProviderVisibility,
  providerHealth?: ProviderHealthSummary,
): ConnectProviderSummary {
  const laneSummaries = visibility.lanes.map((lane) => summarizeProviderLane(agent, lane, providerHealth))
  const worstLaneStatus = laneSummaries.reduce<ConnectMenuStatus>(
    (worst, lane) => CONNECT_STATUS_PRIORITY[lane.status] < CONNECT_STATUS_PRIORITY[worst] ? lane.status : worst,
    "ready",
  )
  const providerHealthStatus = resolveProviderHealthStatus(providerHealth)
  const providerHealthCommand = resolveProviderHealthCommand(providerHealth, providerHealthStatus)
  const nextLane = laneSummaries.find((lane) => isProblemStatus(lane.status))
  return {
    status: providerHealthStatus ?? worstLaneStatus,
    laneSummaries,
    detailLines: laneSummaries.flatMap((lane) => [
      `${lane.lane === "outward" ? "Outward lane" : "Inner lane"}: ${lane.title}`,
      lane.detail,
    ]),
    nextAction: providerHealthCommand ?? nextLane?.action,
    nextNote: providerHealthStatus === "locked"
      ? "Unlock this agent's credential vault on this machine."
      : nextLane
        ? `${nextLane.lane === "outward" ? "Outward lane" : "Inner lane"}: ${nextLane.detail}`
        : undefined,
  }
}

export function connectEntryNeedsAttention(entry: ConnectMenuEntry): boolean {
  return isProblemStatus(entry.status)
}

export function renderConnectBay(entries: ConnectMenuEntry[], options: ConnectRenderOptions): string {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.connect_bay_rendered",
    message: "rendered connect bay",
    meta: {
      agent: options.agent,
      isTTY: options.isTTY,
      entryCount: entries.length,
      columns: options.columns ?? null,
    },
  })
  return renderTerminalWizard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: "Set up connections one step at a time.",
    },
    title: `Connect ${options.agent}`,
    summary: "Choose one capability to bring online. Each row tells you whether Ouro checked it live just now or is showing saved setup on this machine.",
    nextStep: nextStepFor(entries),
    sections: [
      sectionToWizard(entries, "Providers", "Selected outward and inner lanes for this machine."),
      sectionToWizard(entries, "Portable", "These travel with the agent bundle when their secrets are portable."),
      sectionToWizard(entries, "This machine", "These depend on local attachments or machine-specific setup."),
    ],
    footerLines: [
      "6. Not now",
      "Choose a number, or type the capability name.",
    ],
    prompt: options.prompt,
    suppressEvent: true,
  })
}
interface ProviderHealthSummary {
  ok: boolean
  fix?: string
  error?: string
  issue?: AgentReadinessIssue
}
