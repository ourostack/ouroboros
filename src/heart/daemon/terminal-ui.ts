import type { RepairActor } from "./readiness-repair"
import { emitNervesEvent } from "../../nerves/runtime"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const CANOPY = "\x1b[38;2;30;61;40m"
const SCALE = "\x1b[38;2;45;148;71m"
const GLOW = "\x1b[38;2;74;227;108m"
const BONE = "\x1b[38;2;237;242;238m"
const MIST = "\x1b[38;2;154;174;159m"
const ALERT = "\x1b[38;2;255;106;106m"

const ANSI_RE = /\x1b\[[0-9;]*m/g
const MASTHEAD_WORD = "OUROBOROS"

const CLASSIC_WORDMARK_GLYPHS: Record<string, string[]> = {
  O: ["  ___  ", " / _ \\ ", "| | | |", "| |_| |", " \\___/ "],
  U: [" _   _ ", "| | | |", "| | | |", "| |_| |", " \\___/ "],
  R: [" ____  ", "|  _ \\ ", "| |_) |", "|  _ < ", "|_| \\_\\"],
  B: [" ____  ", "| __ ) ", "|  _ \\ ", "| |_) |", "|____/ "],
  S: [" ____  ", "/ ___| ", "\\___ \\ ", " ___) |", "|____/ "],
}

export interface TerminalMastheadOptions {
  isTTY: boolean
  columns?: number
  subtitle?: string
}

export interface TerminalSection {
  title: string
  lines: string[]
}

export interface TerminalAction {
  label: string
  actor: RepairActor
  command: string
  recommended?: boolean
}

export type TerminalWizardStatus =
  | "ready"
  | "needs attention"
  | "needs credentials"
  | "needs setup"
  | "missing"
  | "locked"
  | "attached"
  | "not attached"

export interface TerminalWizardItem {
  key?: string
  label: string
  status?: TerminalWizardStatus
  actor?: RepairActor
  summary?: string
  detailLines?: string[]
  command?: string
  recommended?: boolean
}

export interface TerminalWizardSection {
  title: string
  summary?: string
  items: TerminalWizardItem[]
}

export interface TerminalWizardNextStep {
  label: string
  detail?: string
  command?: string
}

export interface RenderTerminalWizardOptions {
  isTTY: boolean
  columns?: number
  masthead?: Omit<TerminalMastheadOptions, "isTTY" | "columns">
  title: string
  summary?: string
  nextStep?: TerminalWizardNextStep
  sections?: TerminalWizardSection[]
  footerLines?: string[]
  prompt?: string
  suppressEvent?: boolean
}

export interface RenderTerminalBoardOptions {
  isTTY: boolean
  columns?: number
  masthead?: Omit<TerminalMastheadOptions, "isTTY" | "columns">
  title: string
  summary?: string
  sections?: TerminalSection[]
  actions?: TerminalAction[]
  prompt?: string
  suppressEvent?: boolean
}

export interface RenderTerminalGuideOptions {
  isTTY: boolean
  columns?: number
  masthead?: Omit<TerminalMastheadOptions, "isTTY" | "columns">
  title: string
  summary?: string
  sections?: TerminalSection[]
  actions?: TerminalAction[]
  prompt?: string
  suppressEvent?: boolean
}

export interface TerminalOperationCurrentStep {
  label: string
  detailLines?: string[]
}

export interface TerminalOperationStep {
  label: string
  status: "done" | "active" | "pending" | "failed"
  detail?: string
}

export interface RenderTerminalOperationOptions {
  isTTY: boolean
  columns?: number
  masthead?: Omit<TerminalMastheadOptions, "isTTY" | "columns">
  title: string
  summary?: string
  currentStep?: TerminalOperationCurrentStep
  steps?: TerminalOperationStep[]
  currentTitle?: string
  stepsTitle?: string
  prompt?: string
  suppressEvent?: boolean
}

function color(text: string, tone: string, bold = false): string {
  if (!text) return text
  return `${tone}${bold ? BOLD : ""}${text}${RESET}`
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length
}

export function padAnsi(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`
}

export function wrapPlain(text: string, width: number): string[] {
  const normalized = text.trim()
  if (!normalized) return [""]
  if (width <= 0) return [normalized]

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

function plainLine(line: string): string {
  return stripAnsi(line)
}

function boardWidth(columns?: number): number {
  const requested = columns ?? 88
  return Math.max(58, Math.min(requested, 96))
}

export function renderOverwriteFrame(lines: string[], prevLineCount: number, isTTY: boolean): string {
  if (!isTTY) return `${lines.join("\n")}\n`

  let output = ""
  if (prevLineCount > 0) {
    output += `\x1b[${prevLineCount}A`
  }
  for (const line of lines) {
    output += `\x1b[2K${line}\n`
  }
  const extraLineCount = Math.max(0, prevLineCount - lines.length)
  for (let i = 0; i < extraLineCount; i++) {
    output += "\x1b[2K\n"
  }
  if (extraLineCount > 0) {
    output += `\x1b[${extraLineCount}A`
  }
  return output
}

function renderPanelTTY(title: string, lines: string[], width: number): string[] {
  const innerWidth = Math.max(8, width - 4)
  const topPrefix = `╭─ ${title} `
  const rule = "─".repeat(Math.max(0, width - topPrefix.length - 1))
  const rendered = [
    `${color("╭─ ", CANOPY)}${color(title, BONE, true)}${color(` ${rule}╮`, CANOPY)}`,
  ]
  for (const line of lines) {
    const wrapped = wrapPlain(plainLine(line), innerWidth)
    for (const wrappedLine of wrapped) {
      rendered.push(`${color("│ ", CANOPY)}${padAnsi(wrappedLine, innerWidth)}${color(" │", CANOPY)}`)
    }
  }
  rendered.push(color(`╰${"─".repeat(Math.max(0, width - 2))}╯`, CANOPY))
  return rendered
}

function renderPanelPlain(title: string, lines: string[]): string[] {
  return [
    `${title}`,
    ...lines.map((line) => `  ${plainLine(line)}`),
  ]
}

function mastheadArt(columns?: number): string[] {
  const rows = Array.from({ length: 5 }, () => [] as string[])
  for (const letter of MASTHEAD_WORD.split("") as Array<keyof typeof CLASSIC_WORDMARK_GLYPHS>) {
    const glyph = CLASSIC_WORDMARK_GLYPHS[letter]
    for (const [index, line] of glyph.entries()) {
      rows[index].push(line)
    }
  }
  const classicWordmark = rows.map((row) => row.join(" "))
  const availableColumns = columns ?? 88
  const classicWidth = Math.max(...classicWordmark.map((line) => line.length))
  if (availableColumns >= classicWidth) {
    return classicWordmark
  }
  return [MASTHEAD_WORD]
}

export function renderOuroMasthead(options: TerminalMastheadOptions): string {
  const lines = options.isTTY ? mastheadArt(options.columns) : [MASTHEAD_WORD]
  const branded = options.subtitle ? [...lines, options.subtitle] : lines
  if (!options.isTTY) {
    return `${branded.join("\n")}\n`
  }
  const ttyLines = [
    ...lines.map((line, index) => color(line, index < 2 ? GLOW : SCALE, true)),
    ...(options.subtitle ? [color(options.subtitle, MIST)] : []),
  ]
  return `${ttyLines.join("\n")}\n`
}

export function formatActionActorLabel(actor: RepairActor): string {
  return actor.replace(/-/g, " ")
}

function formatWizardStatusLabel(status: TerminalWizardStatus): string {
  return status
}

function isQuietWizardStatus(status: TerminalWizardStatus): boolean {
  return status === "ready" || status === "attached" || status === "not attached"
}

function renderWizardStatusBadge(status: TerminalWizardStatus, isTTY: boolean): string {
  const symbol = status === "ready" || status === "attached"
    ? "●"
    : status === "not attached"
      ? "◌"
      : "◆"
  const label = `${symbol} ${formatWizardStatusLabel(status)}`
  if (!isTTY) return label
  if (status === "ready" || status === "attached") return color(label, GLOW, true)
  if (status === "not attached") return color(label, MIST)
  return color(label, ALERT, true)
}

function renderWizardActorBadge(actor: RepairActor, isTTY: boolean): string {
  const label = `[${formatActionActorLabel(actor)}]`
  if (!isTTY) return label
  if (actor === "human-required") return color(label, ALERT, true)
  if (actor === "human-choice") return color(label, SCALE, true)
  return color(label, MIST)
}

function renderWizardRecommendedBadge(isTTY: boolean): string {
  if (!isTTY) return "[recommended]"
  return color("[recommended]", GLOW, true)
}

function wrapWizardDetailLines(
  lines: string[],
  width: number,
  isTTY: boolean,
  tone: string,
): string[] {
  const rendered: string[] = []
  for (const line of lines) {
    const wrapped = wrapPlain(line, width)
    for (const segment of wrapped) {
      rendered.push(isTTY ? color(segment, tone) : segment)
    }
  }
  return rendered
}

function renderWizardItem(item: TerminalWizardItem, width: number, isTTY: boolean): string[] {
  const badges = [
    ...(item.status ? [renderWizardStatusBadge(item.status, isTTY)] : []),
    ...(item.actor ? [renderWizardActorBadge(item.actor, isTTY)] : []),
    ...(item.recommended ? [renderWizardRecommendedBadge(isTTY)] : []),
  ]
  const keyPrefix = item.key ? `${item.key}. ` : ""
  const header = `${keyPrefix}${item.label}${badges.length > 0 ? `  ${badges.join("  ")}` : ""}`
  const detailWidth = Math.max(18, width - 6)
  const detailTone = item.status && !isQuietWizardStatus(item.status) ? BONE : MIST
  const lines = [isTTY ? color(header, BONE, true) : header]
  if (item.summary) {
    lines.push(...wrapWizardDetailLines([item.summary], detailWidth, isTTY, detailTone))
  }
  if (item.detailLines && item.detailLines.length > 0) {
    lines.push(...wrapWizardDetailLines(item.detailLines, detailWidth, isTTY, detailTone))
  }
  if (item.command) {
    lines.push(...wrapWizardDetailLines([`run: ${item.command}`], detailWidth, isTTY, MIST))
  }
  return lines.flatMap((line, index) => index === 0 ? [line] : [`   ${line}`])
}

function renderWizardSectionTTY(section: TerminalWizardSection, width: number): string[] {
  const lines: string[] = []
  if (section.summary) {
    lines.push(...wrapWizardDetailLines([section.summary], Math.max(18, width - 4), true, MIST))
  }
  for (const [index, item] of section.items.entries()) {
    if (index > 0) lines.push("")
    lines.push(...renderWizardItem(item, width, true))
  }
  return renderOperationSectionTTY(section.title, lines, width)
}

function renderWizardSectionPlain(section: TerminalWizardSection, width: number): string[] {
  const lines: string[] = []
  if (section.summary) {
    lines.push(...wrapWizardDetailLines([section.summary], Math.max(18, width - 4), false, MIST))
  }
  for (const [index, item] of section.items.entries()) {
    if (index > 0) lines.push("")
    lines.push(...renderWizardItem(item, width, false))
  }
  return renderOperationSectionPlain(section.title, lines)
}

export function renderTerminalWizard(options: RenderTerminalWizardOptions): string {
  if (!options.suppressEvent) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.terminal_wizard_rendered",
      message: "rendered shared terminal wizard",
      meta: {
        title: options.title,
        sections: options.sections?.length ?? 0,
        items: options.sections?.reduce((count, section) => count + section.items.length, 0) ?? 0,
        hasNextStep: !!options.nextStep,
        tty: options.isTTY,
      },
    })
  }

  const width = boardWidth(options.columns)
  const blocks: string[] = []
  blocks.push(renderOuroMasthead({
    isTTY: options.isTTY,
    columns: width,
    subtitle: options.masthead?.subtitle,
  }).trimEnd())

  const introLines = [
    options.isTTY ? color(options.title, BONE, true) : options.title,
    ...(options.summary
      ? wrapPlain(options.summary, Math.max(20, width - 2)).map((line) => options.isTTY ? color(line, MIST) : line)
      : []),
  ]
  blocks.push(introLines.join("\n"))

  if (options.nextStep) {
    const nextStepLines = [
      options.isTTY ? color(options.nextStep.label, BONE, true) : options.nextStep.label,
      ...(options.nextStep.detail
        ? wrapPlain(options.nextStep.detail, Math.max(18, width - 4)).map((line) => options.isTTY ? color(line, MIST) : line)
        : []),
      ...(options.nextStep.command
        ? wrapPlain(`run: ${options.nextStep.command}`, Math.max(18, width - 4)).map((line) => options.isTTY ? color(line, MIST) : line)
        : []),
    ]
    blocks.push(
      (options.isTTY
        ? renderOperationSectionTTY("Recommended next step", nextStepLines, width)
        : renderOperationSectionPlain("Recommended next step", nextStepLines)).join("\n"),
    )
  }

  for (const section of options.sections ?? []) {
    blocks.push(
      (options.isTTY
        ? renderWizardSectionTTY(section, width)
        : renderWizardSectionPlain(section, width)).join("\n"),
    )
  }

  if (options.footerLines && options.footerLines.length > 0) {
    blocks.push(options.footerLines.map((line) => options.isTTY ? color(line, MIST) : line).join("\n"))
  }

  if (options.prompt) {
    blocks.push(options.isTTY ? color(options.prompt, BONE, true) : options.prompt)
  }

  return `${blocks.join("\n\n")}\n`
}

function renderActionLine(action: TerminalAction): string {
  const chips = [`[${formatActionActorLabel(action.actor)}]`]
  if (action.recommended) chips.push("[recommended]")
  return `${action.label} ${chips.join(" ")}`
}

export function renderTerminalBoard(options: RenderTerminalBoardOptions): string {
  if (!options.suppressEvent) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.terminal_board_rendered",
      message: "rendered shared terminal board",
      meta: {
        title: options.title,
        sections: options.sections?.length ?? 0,
        actions: options.actions?.length ?? 0,
        tty: options.isTTY,
      },
    })
  }

  const width = boardWidth(options.columns)
  const blocks: string[] = []
  blocks.push(renderOuroMasthead({
    isTTY: options.isTTY,
    columns: width,
    subtitle: options.masthead?.subtitle,
  }).trimEnd())

  const introLines = [
    options.isTTY ? color(options.title, BONE, true) : options.title,
    ...(options.summary ? wrapPlain(options.summary, Math.max(20, width - 4)).map((line) => options.isTTY ? color(line, MIST) : line) : []),
  ]
  blocks.push((options.isTTY ? renderPanelTTY("Overview", introLines, width) : renderPanelPlain("Overview", introLines)).join("\n"))

  for (const section of options.sections ?? []) {
    const lines = section.lines.map((line) => options.isTTY ? color(line, BONE) : line)
    blocks.push((options.isTTY ? renderPanelTTY(section.title, lines, width) : renderPanelPlain(section.title, lines)).join("\n"))
  }

  const actionList = options.actions ?? []
  if (actionList.length > 0) {
    const lines: string[] = []
    for (const [index, action] of actionList.entries()) {
      lines.push(`${index + 1}. ${renderActionLine(action)}`)
      lines.push(`   ${action.command}`)
    }
    blocks.push((options.isTTY ? renderPanelTTY("Actions", lines, width) : renderPanelPlain("Actions", lines)).join("\n"))
  }

  if (options.prompt) {
    blocks.push(options.isTTY ? color(options.prompt, BONE, true) : options.prompt)
  }

  return `${blocks.join("\n\n")}\n`
}

export function renderTerminalGuide(options: RenderTerminalGuideOptions): string {
  if (!options.suppressEvent) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.terminal_guide_rendered",
      message: "rendered shared terminal guide",
      meta: {
        title: options.title,
        sections: options.sections?.length ?? 0,
        actions: options.actions?.length ?? 0,
        tty: options.isTTY,
      },
    })
  }

  const width = boardWidth(options.columns)
  const blocks: string[] = []
  blocks.push(renderOuroMasthead({
    isTTY: options.isTTY,
    columns: width,
    subtitle: options.masthead?.subtitle,
  }).trimEnd())

  const introLines = [
    options.isTTY ? color(options.title, BONE, true) : options.title,
    ...(options.summary
      ? wrapPlain(options.summary, Math.max(20, width - 2)).map((line) => options.isTTY ? color(line, MIST) : line)
      : []),
  ]
  blocks.push(introLines.join("\n"))

  for (const section of options.sections ?? []) {
    const lines = section.lines.map((line) => options.isTTY ? color(line, BONE) : line)
    blocks.push((options.isTTY
      ? renderOperationSectionTTY(section.title, lines, width)
      : renderOperationSectionPlain(section.title, lines)).join("\n"))
  }

  const actionList = options.actions ?? []
  if (actionList.length > 0) {
    const lines: string[] = []
    for (const [index, action] of actionList.entries()) {
      lines.push(options.isTTY ? color(`${index + 1}. ${renderActionLine(action)}`, BONE, true) : `${index + 1}. ${renderActionLine(action)}`)
      lines.push(options.isTTY ? color(`run: ${action.command}`, MIST) : `run: ${action.command}`)
    }
    blocks.push((options.isTTY
      ? renderOperationSectionTTY("Next moves", lines, width)
      : renderOperationSectionPlain("Next moves", lines)).join("\n"))
  }

  if (options.prompt) {
    blocks.push(options.isTTY ? color(options.prompt, BONE, true) : options.prompt)
  }

  return `${blocks.join("\n\n")}\n`
}

function formatOperationStep(step: TerminalOperationStep): string {
  const marker = step.status === "done"
    ? "✓"
    : step.status === "failed"
      ? "✗"
      : step.status === "active"
        ? "→"
        : "○"
  const detail = step.detail ? ` — ${step.detail}` : ""
  return `${marker} ${step.label}${detail}`
}

function operationMarkerTone(status: TerminalOperationStep["status"]): string {
  switch (status) {
    case "done":
      return GLOW
    case "active":
      return BONE
    case "failed":
      return ALERT
    case "pending":
    default:
      return MIST
  }
}

function renderOperationStepTTY(step: TerminalOperationStep): string {
  const marker = step.status === "done"
    ? "✓"
    : step.status === "failed"
      ? "✗"
      : step.status === "active"
        ? "→"
        : "○"
  const label = color(step.label, step.status === "pending" ? MIST : BONE, step.status !== "pending")
  const detail = step.detail ? ` ${color(`— ${step.detail}`, MIST)}` : ""
  return `${color(marker, operationMarkerTone(step.status), true)} ${label}${detail}`
}

function renderOperationSectionTTY(title: string, lines: string[], width: number): string[] {
  const rule = "─".repeat(Math.max(8, width - title.length - 3))
  return [
    `${color("─ ", CANOPY)}${color(title, BONE, true)} ${color(rule, CANOPY)}`,
    ...lines.map((line) => `  ${line}`),
  ]
}

function renderOperationSectionPlain(title: string, lines: string[]): string[] {
  return [
    title,
    ...lines.map((line) => `  ${plainLine(line)}`),
  ]
}

export function renderTerminalOperation(options: RenderTerminalOperationOptions): string {
  if (!options.suppressEvent) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.terminal_operation_rendered",
      message: "rendered terminal operation surface",
      meta: {
        title: options.title,
        steps: options.steps?.length ?? 0,
        hasCurrentStep: !!options.currentStep,
        tty: options.isTTY,
      },
    })
  }

  const steps = options.steps ?? []
  const currentLines = options.currentStep
    ? [
        options.currentStep.label,
        ...(options.currentStep.detailLines ?? []),
      ]
    : ["Standing by."]
  const progressLines = steps.length > 0
    ? options.isTTY
      ? steps.map((step) => renderOperationStepTTY(step))
      : steps.map((step) => formatOperationStep(step))
    : ["No active steps yet."]

  const width = boardWidth(options.columns)
  const blocks: string[] = []
  blocks.push(renderOuroMasthead({
    isTTY: options.isTTY,
    columns: width,
    subtitle: options.masthead?.subtitle,
  }).trimEnd())

  const introLines = [
    options.isTTY ? color(options.title, BONE, true) : options.title,
    ...(options.summary
      ? wrapPlain(options.summary, Math.max(20, width - 2)).map((line) => options.isTTY ? color(line, MIST) : line)
      : []),
  ]
  blocks.push(introLines.join("\n"))

  const renderedSteps = options.isTTY
    ? renderOperationSectionTTY(options.stepsTitle ?? "Checklist", progressLines, width)
    : renderOperationSectionPlain(options.stepsTitle ?? "Checklist", progressLines)
  const renderedCurrent = options.isTTY
    ? renderOperationSectionTTY(
        options.currentTitle ?? "Current work",
        currentLines.map((line, index) => index === 0 ? color(line, BONE, true) : color(line, MIST)),
        width,
      )
    : renderOperationSectionPlain(options.currentTitle ?? "Current work", currentLines)

  blocks.push(renderedSteps.join("\n"))
  blocks.push(renderedCurrent.join("\n"))

  if (options.prompt) {
    blocks.push(options.isTTY ? color(options.prompt, BONE, true) : options.prompt)
  }

  return `${blocks.join("\n\n")}\n`
}
