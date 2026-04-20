import type { RepairActor } from "./readiness-repair"
import { emitNervesEvent } from "../../nerves/runtime"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const CANOPY = "\x1b[38;2;30;61;40m"
const SCALE = "\x1b[38;2;45;148;71m"
const GLOW = "\x1b[38;2;74;227;108m"
const BONE = "\x1b[38;2;237;242;238m"
const MIST = "\x1b[38;2;154;174;159m"

const ANSI_RE = /\x1b\[[0-9;]*m/g

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
  if ((columns ?? 88) >= 74) {
    return [
      "              .----------------------------.",
      "          .--'    O U R O B O R O S        '--.",
      "        .'       .--------------------.       '.",
      "       /        /  .--------------.   \\        \\",
      "       \\        \\  '--------------'   /        /",
      "        '.       '--------------------'      .'",
      "          '--._                          _.--'",
      "               '------------------------'",
    ]
  }
  return [
    "  O U R O B O R O S",
    "  -----------------",
  ]
}

export function renderOuroMasthead(options: TerminalMastheadOptions): string {
  const lines = mastheadArt(options.columns)
  const subtitle = options.subtitle ?? "the house wakes when called"
  const branded = [
    ...lines,
    "OUROBOROS",
    subtitle,
  ]
  if (!options.isTTY) {
    return `${branded.join("\n")}\n`
  }
  const ttyLines = [
    ...lines.map((line, index) => color(line, index < 2 ? GLOW : SCALE, true)),
    color("OUROBOROS", BONE, true),
    color(subtitle, MIST),
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

export function renderTerminalOperation(options: RenderTerminalOperationOptions): string {
  const currentLines = options.currentStep
    ? [
        options.currentStep.label,
        ...(options.currentStep.detailLines ?? []),
      ]
    : ["Standing by."]
  const progressLines = (options.steps ?? []).length > 0
    ? (options.steps ?? []).map((step) => formatOperationStep(step))
    : ["No active steps yet."]

  return renderTerminalBoard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: options.masthead,
    title: options.title,
    summary: options.summary,
    sections: [
      {
        title: "Right now",
        lines: currentLines,
      },
      {
        title: "Progress",
        lines: progressLines,
      },
    ],
    prompt: options.prompt,
    suppressEvent: options.suppressEvent,
  })
}
