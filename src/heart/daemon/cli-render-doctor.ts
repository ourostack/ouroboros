/**
 * Rendering for `ouro doctor` output.
 *
 * Pure function: takes a DoctorResult and returns a formatted string
 * with ANSI colors, category grouping, and a summary line.
 */

import type { DoctorCheck, DoctorResult } from "./doctor-types"

// ── ANSI color helpers ──

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[38;2;46;204;64m"
const RED = "\x1b[38;2;231;76;60m"
const YELLOW = "\x1b[38;2;230;190;50m"
const TEAL = "\x1b[38;2;78;201;176m"

function green(text: string): string { return `${GREEN}${text}${RESET}` }
function red(text: string): string { return `${RED}${text}${RESET}` }
function yellow(text: string): string { return `${YELLOW}${text}${RESET}` }
function bold(text: string): string { return `${BOLD}${text}${RESET}` }
function dim(text: string): string { return `${DIM}${text}${RESET}` }
function teal(text: string): string { return `${TEAL}${text}${RESET}` }

// ── Check status symbols ──

function statusSymbol(status: DoctorCheck["status"]): string {
  switch (status) {
    case "pass": return green("\u2714") // checkmark
    case "warn": return yellow("\u26A0") // warning
    case "fail": return red("\u2718")   // X
  }
}

// ── Main formatter ──

export function formatDoctorOutput(result: DoctorResult): string {
  const lines: string[] = []

  lines.push("")
  lines.push(`  ${bold("ouro doctor")}`)
  lines.push("")

  for (const category of result.categories) {
    lines.push(`  ${teal("--")} ${bold(category.name)} ${teal("-".repeat(Math.max(1, 40 - category.name.length)))}`)

    for (const check of category.checks) {
      const symbol = statusSymbol(check.status)
      const detail = check.detail ? `  ${dim(check.detail)}` : ""
      lines.push(`    ${symbol} ${check.label}${detail}`)
    }

    lines.push("")
  }

  // Summary line
  const { passed, warnings, failed } = result.summary
  const parts = [
    green(`${passed} passed`),
    yellow(`${warnings} warning${warnings === 1 ? "" : "s"}`),
    red(`${failed} failed`),
  ]
  lines.push(`  ${parts.join(dim("  |  "))}`)
  lines.push("")

  return lines.join("\n")
}
