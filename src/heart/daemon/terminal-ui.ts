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
