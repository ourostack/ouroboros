import type { ProviderLane } from "../provider-state"
import type { AgentProviderVisibility, ProviderVisibilityLane } from "../provider-visibility"
import { emitNervesEvent } from "../../nerves/runtime"
import { renderOuroMasthead } from "./terminal-ui"
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

export type ConnectMenuSection = "Provider core" | "Portable" | "This machine"

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

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const TEAL = "\x1b[38;2;78;201;176m"
const GREEN = "\x1b[38;2;46;204;64m"
const GOLD = "\x1b[38;2;230;190;50m"
const BONE = "\x1b[38;2;238;242;234m"
const MIST = "\x1b[38;2;165;184;168m"

const ANSI_RE = /\x1b\[[0-9;]*m/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

function visibleLength(text: string): number {
  return stripAnsi(text).length
}

function padAnsi(text: string, width: number): string {
  const missing = Math.max(0, width - visibleLength(text))
  return `${text}${" ".repeat(missing)}`
}

function wrapPlain(text: string, width: number): string[] {
  const normalized = text.trim()
  if (!normalized) return [""]
  const words = normalized.split(/\s+/)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    const candidate = `${current} ${word}`
    if (candidate.length <= width) {
      current = candidate
      continue
    }
    lines.push(current)
    current = word
  }
  lines.push(current)
  return lines
}

function tty(text: string, color: string, bold = false): string {
  if (bold) return `${color}${BOLD}${text}${RESET}`
  return `${color}${text}${RESET}`
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
  if (issue?.kind === "provider-live-check-failed") {
    return issue.actions[0]?.kind === "provider-auth" ? "needs credentials" : "needs attention"
  }
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

function isProblemStatus(status: ConnectMenuStatus): boolean {
  return status !== "ready" && status !== "attached"
}

function statusChip(status: ConnectMenuStatus): string {
  const symbol = status === "ready" || status === "attached"
    ? "●"
    : status === "not attached"
      ? "◌"
      : "◆"
  const label = `${symbol} ${status}`
  if (status === "ready" || status === "attached") return tty(label, GREEN, true)
  if (status === "not attached") return tty(label, MIST)
  return tty(label, GOLD, true)
}

function sectionTitle(title: string, width: number): string {
  const plain = `╭─ ${title} `
  const rule = "─".repeat(Math.max(0, width - plain.length - 1))
  return `${tty("╭─ ", TEAL)}${tty(title, BONE, true)}${tty(` ${rule}╮`, TEAL)}`
}

function bottomRule(width: number): string {
  const line = `╰${"─".repeat(Math.max(0, width - 2))}╯`
  return tty(line, TEAL)
}

function bodyLine(text: string, width: number): string {
  const padded = padAnsi(text, Math.max(0, width - 4))
  return `${tty("│ ", TEAL)}${padded}${tty(" │", TEAL)}`
}

function panel(title: string, body: string[], width: number): string[] {
  const lines = [sectionTitle(title, width)]
  for (const line of body) {
    lines.push(bodyLine(line, width))
  }
  lines.push(bottomRule(width))
  return lines
}

function renderHeader(agent: string, width: number): string[] {
  return panel(
    `${agent} connect bay`,
    [
      tty("Bring one capability online.", BONE, true),
      tty("Everything on this screen was checked live just now.", MIST),
    ],
    width,
  )
}

function nextMoveBody(entry: ConnectMenuEntry | undefined): string[] {
  if (!entry) {
    return [
      tty("Everything here is ready.", BONE, true),
      tty("Pick what you want to review or refresh.", MIST),
    ]
  }
  const lines: string[] = [
    `${entry.name}  ${statusChip(entry.status)}`,
  ]
  if (entry.nextNote) lines.push(entry.nextNote)
  if (entry.nextAction) lines.push(tty(entry.nextAction, MIST))
  return lines
}

function renderProviderBody(entry: ConnectMenuEntry, width: number): string[] {
  const lines: string[] = [
    `${entry.option}  ${entry.name}  ${statusChip(entry.status)}`,
  ]
  const lanes = entry.laneSummaries ?? []
  for (const [index, lane] of lanes.entries()) {
    if (index > 0) lines.push("")
    const laneLabel = lane.lane === "outward" ? "Outward lane" : "Inner lane"
    lines.push(tty(laneLabel, BONE, true))
    lines.push(lane.title)
    lines.push(isProblemStatus(lane.status) ? lane.detail : tty(lane.detail, MIST))
  }
  if (lanes.length === 0) {
    for (const detail of entry.detailLines ?? []) lines.push(detail)
  }
  return normalizeWrappedBody(lines, width)
}

function renderCapabilityBody(entries: ConnectMenuEntry[], width: number): string[] {
  const lines: string[] = []
  for (const [index, entry] of entries.entries()) {
    if (index > 0) lines.push("")
    lines.push(`${entry.option}  ${entry.name}  ${statusChip(entry.status)}`)
    if (entry.description) {
      lines.push(isProblemStatus(entry.status) ? entry.description : tty(entry.description, MIST))
    }
    for (const detail of entry.detailLines ?? []) {
      lines.push(detail)
    }
  }
  return normalizeWrappedBody(lines, width)
}

function normalizeWrappedBody(lines: string[], width: number): string[] {
  const wrapped: string[] = []
  for (const line of lines) {
    if (!line) {
      wrapped.push("")
      continue
    }
    const plain = stripAnsi(line)
    if (plain.length <= width - 4) {
      wrapped.push(line)
      continue
    }
    const segments = wrapPlain(plain, width - 4)
    wrapped.push(...segments)
  }
  return wrapped
}

function stackPanels(panels: string[][]): string[] {
  const lines: string[] = []
  for (const [index, panelLines] of panels.entries()) {
    if (index > 0) lines.push("")
    lines.push(...panelLines)
  }
  return lines
}

function combineColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, gap = 2): string[] {
  const total = Math.max(left.length, right.length)
  const lines: string[] = []
  for (let index = 0; index < total; index += 1) {
    const leftLine = left[index] ?? " ".repeat(leftWidth)
    const rightLine = right[index] ?? " ".repeat(rightWidth)
    lines.push(`${padAnsi(leftLine, leftWidth)}${" ".repeat(gap)}${padAnsi(rightLine, rightWidth)}`)
  }
  return lines
}

function renderTtyBay(entries: ConnectMenuEntry[], options: ConnectRenderOptions): string {
  const columns = Math.max(options.columns ?? 108, 72)
  const fullWidth = Math.max(56, columns - 2)
  const masthead = renderOuroMasthead({
    isTTY: true,
    columns,
    subtitle: "Bring one capability online at a time.",
  }).trimEnd()
  const header = renderHeader(options.agent, fullWidth)
  const nextEntry = entries.find((entry) => isProblemStatus(entry.status))
  const providerEntry = entries.find((entry) => entry.section === "Provider core")!
  const portableEntries = entries.filter((entry) => entry.section === "Portable")
  const machineEntries = entries.filter((entry) => entry.section === "This machine")

  const wide = columns >= 118
  const footer = [
    tty("Pick a path. Type the number or the name.", MIST),
    options.prompt,
  ]

  if (!wide) {
    const panels = [
      header,
      panel("Next best move", nextMoveBody(nextEntry), fullWidth),
      panel("Provider core", renderProviderBody(providerEntry, fullWidth), fullWidth),
      panel("Portable", renderCapabilityBody(portableEntries, fullWidth), fullWidth),
      panel("This machine", renderCapabilityBody(machineEntries, fullWidth), fullWidth),
    ]
    return [masthead, "", ...stackPanels(panels), "", ...footer].join("\n")
  }

  const gap = 2
  const leftWidth = Math.max(52, Math.floor((fullWidth - gap) / 2))
  const rightWidth = Math.max(40, fullWidth - gap - leftWidth)

  const topRow = combineColumns(
    panel("Next best move", nextMoveBody(nextEntry), leftWidth),
    panel("This machine", renderCapabilityBody(machineEntries, rightWidth), rightWidth),
    leftWidth,
    rightWidth,
    gap,
  )
  const bottomRow = combineColumns(
    panel("Provider core", renderProviderBody(providerEntry, leftWidth), leftWidth),
    panel("Portable", renderCapabilityBody(portableEntries, rightWidth), rightWidth),
    leftWidth,
    rightWidth,
    gap,
  )
  return [masthead, "", ...header, "", ...topRow, "", ...bottomRow, "", ...footer].join("\n")
}

function renderNonTtyBay(entries: ConnectMenuEntry[], options: ConnectRenderOptions): string {
  const nextEntry = entries.find((entry) => isProblemStatus(entry.status))
  const lines = [
    `${options.agent} connect bay`,
    "Bring one capability online. Provider status was checked live just now.",
    "",
    "Next best move",
    "--------------",
  ]
  if (!nextEntry) {
    lines.push("Everything here is ready. Pick what you want to review or refresh.")
  } else {
    lines.push(`${nextEntry.name} - ${nextEntry.status}`)
    if (nextEntry.nextNote) lines.push(nextEntry.nextNote)
    if (nextEntry.nextAction) lines.push(`run: ${nextEntry.nextAction}`)
  }
  lines.push("")

  for (const section of ["Provider core", "Portable", "This machine"] as ConnectMenuSection[]) {
    lines.push(section)
    lines.push("-".repeat(Math.max(6, section.length + 4)))
    for (const entry of entries.filter((candidate) => candidate.section === section)) {
      lines.push(`${entry.option}. ${entry.name} [${entry.status}]`)
      if (entry.laneSummaries && entry.laneSummaries.length > 0) {
        for (const lane of entry.laneSummaries) {
          const laneLabel = lane.lane === "outward" ? "Outward lane" : "Inner lane"
          lines.push(`   ${laneLabel}: ${lane.title}`)
          lines.push(`     ${lane.detail}`)
        }
      } else {
        for (const detail of entry.detailLines ?? []) lines.push(`   ${detail}`)
      }
      if (entry.description) lines.push(`   ${entry.description}`)
      lines.push("")
    }
  }

  lines.push("6. Not now")
  lines.push("")
  lines.push("Pick a path. Type the number or the name.")
  lines.push(options.prompt)
  return lines.join("\n")
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
  if (providerHealth?.ok) {
    return {
      lane: lane.lane,
      status: "ready",
      title: `${lane.provider} / ${lane.model}`,
      detail: "ready",
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
  if (!options.isTTY) return renderNonTtyBay(entries, options)
  return renderTtyBay(entries, options)
}
interface ProviderHealthSummary {
  ok: boolean
  fix?: string
  error?: string
  issue?: AgentReadinessIssue
}
