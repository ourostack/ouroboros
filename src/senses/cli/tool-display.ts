/**
 * Imperative tool result rendering for the CLI.
 *
 * Writes colored one-liners to stderr — no React, no Ink.
 * Features:
 * - Green check / red cross prefix
 * - Tool name in ouroboros teal
 * - Parsed first argument (file path, command, query) dimmed
 * - For edit_file: compact inline diff summary (+N/-M lines)
 */

import { emitNervesEvent } from "../../nerves/runtime"

// Flow control tools are invisible to the user — internal agent mechanics.
// `speak` is included because its visible output is the message itself (delivered
// via onTextChunk/flushNow), not a "running speak..." spinner or tool-end status line.
const FLOW_CONTROL_TOOLS = new Set(["settle", "ponder", "observe", "rest", "speak"])

// Ouroboros teal: #4ec9b0 -> RGB escape
const OURO_TEAL = "\x1b[38;2;78;201;176m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RESET = "\x1b[0m"

// Tool name -> primary parameter key mapping
const PRIMARY_PARAM: Record<string, string> = {
  edit_file: "path",
  write_file: "path",
  read_file: "path",
  glob: "pattern",
  grep: "pattern",
  shell: "command",
  coding_spawn: "task",
  coding_status: "session_id",
  coding_tail: "session_id",
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s
}

/**
 * Extract the primary display parameter from tool args.
 */
function getPrimaryArg(name: string, args: Record<string, unknown>): string {
  const primaryKey = PRIMARY_PARAM[name]
  if (primaryKey && typeof args[primaryKey] === "string") {
    return truncate(args[primaryKey] as string, 80)
  }
  // Fallback: show first string value
  for (const val of Object.values(args)) {
    if (typeof val === "string") {
      return truncate(val, 80)
    }
  }
  return ""
}

/**
 * Format and write a tool start line to stderr.
 * Shows: [teal tool name] [dim primary arg]
 */
export function writeToolStart(name: string, args: Record<string, string>): void {
  if (FLOW_CONTROL_TOOLS.has(name)) return
  const primary = getPrimaryArg(name, args)
  const argDisplay = primary ? ` ${DIM}${primary}${RESET}` : ""
  process.stderr.write(`\r\x1b[K${OURO_TEAL}${BOLD}${name}${RESET}${argDisplay}\n`)
}

/**
 * Format and write a tool result line to stderr.
 * Shows: [green check / red cross] [teal tool name] [dim summary]
 */
export function writeToolEnd(name: string, argSummary: string, success: boolean): void {
  if (FLOW_CONTROL_TOOLS.has(name)) return
  const icon = success ? `${GREEN}\u2713` : `${RED}\u2717`
  const summary = argSummary ? ` ${DIM}${truncate(argSummary, 100)}${RESET}` : ""
  process.stderr.write(`${icon}${RESET} ${OURO_TEAL}${name}${RESET}${summary}\n`)

  emitNervesEvent({
    component: "senses",
    event: "senses.tool_display",
    message: "tool result displayed",
    meta: { name, success },
  })
}
