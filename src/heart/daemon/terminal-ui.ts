import type { RepairActor } from "./readiness-repair"
import { emitNervesEvent } from "../../nerves/runtime"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
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
}

function color(text: string, tone: string, bold = false, dim = false): string {
  if (!text) return text
  return `${tone}${bold ? BOLD : ""}${dim ? DIM : ""}${text}${RESET}`
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
      "  ____  _   _ ____   ___  ____   ___  ____   ___  ____",
      " / __ \\| | | |  _ \\ / _ \\|  _ \\ / _ \\| __ ) / _ \\|  _ \\",
      "| |  | | | | | |_) | | | | |_) | | | |  _ \\| | | | |_) |",
      "| |__| | |_| |  _ <| |_| |  _ <| |_| | |_) | |_| |  _ <",
      " \\____/ \\___/|_| \\_\\\\___/|_| \\_\\\\___/|____/ \\___/|_| \\_\\",
    ]
  }
  return [
    "  O U R O B O R O S",
    "  -----------------",
  ]
}

export function renderOuroMasthead(options: TerminalMastheadOptions): string {
  const lines = mastheadArt(options.columns)
  const branded = [
    ...lines,
    "OUROBOROS",
    ...(options.subtitle ? [options.subtitle] : []),
  ]
  if (!options.isTTY) {
    return `${branded.join("\n")}\n`
  }
  const ttyLines = [
    ...lines.map((line, index) => color(line, index < 2 ? GLOW : SCALE, true)),
    color("OUROBOROS", BONE, true),
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

  if ((options.actions?.length ?? 0) > 0) {
    const lines: string[] = []
    for (const [index, action] of (options.actions ?? []).entries()) {
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
