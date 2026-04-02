import React from "react"
import { Text, Box } from "ink"

/**
 * Persistent bottom status bar for the CLI TUI.
 *
 * Shows: model + provider, token usage, session time, context utilization,
 * active tool name.
 *
 * Information-dense single line. Context usage color-coded:
 * green (<60%), amber (60-80%), red (>80%).
 *
 * Ouroboros-themed: teal/green palette.
 */

// Ouroboros brand palette
const OURO_TEAL = "#4ec9b0"
const COLOR_GREEN = "#2ecc40"
const COLOR_AMBER = "#f39c12"
const COLOR_RED = "#e74c3c"

interface StatusLineProps {
  /** Model name (e.g., "gpt-4o") */
  readonly model: string
  /** Provider name (e.g., "azure") */
  readonly provider: string
  /** Tokens consumed in this session */
  readonly tokensUsed: number
  /** Total token budget */
  readonly tokensTotal: number
  /** Session elapsed time in seconds */
  readonly elapsedSeconds: number
  /** Context window utilization percentage (0-100) */
  readonly contextPercent?: number
  /** Currently running tool name */
  readonly activeTool?: string
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

function contextColor(pct: number): string {
  if (pct >= 80) return COLOR_RED
  if (pct >= 60) return COLOR_AMBER
  return COLOR_GREEN
}

export function StatusLine({
  model,
  provider,
  tokensUsed,
  tokensTotal,
  elapsedSeconds,
  contextPercent,
  activeTool,
}: StatusLineProps): React.ReactElement {
  const tokenPct = tokensTotal > 0 ? Math.round((tokensUsed / tokensTotal) * 100) : 0
  const ctxPct = contextPercent ?? tokenPct
  const ctxColor = contextColor(ctxPct)

  const segments: string[] = [
    `${model} ${provider}`,
    `${formatTokens(tokensUsed)}/${formatTokens(tokensTotal)} (${tokenPct}%)`,
    formatTime(elapsedSeconds),
  ]

  if (contextPercent !== undefined) {
    segments.push(`ctx: ${ctxPct}%`)
  }

  if (activeTool) {
    segments.push(activeTool)
  }

  return (
    <Box>
      <Text color={OURO_TEAL} dimColor>{segments[0]}</Text>
      <Text dimColor>{" | "}</Text>
      <Text dimColor>{segments[1]}</Text>
      <Text dimColor>{" | "}</Text>
      <Text dimColor>{segments[2]}</Text>
      {contextPercent !== undefined ? (
        <>
          <Text dimColor>{" | "}</Text>
          <Text color={ctxColor}>{`ctx: ${ctxPct}%`}</Text>
        </>
      ) : null}
      {activeTool ? (
        <>
          <Text dimColor>{" | "}</Text>
          <Text color={OURO_TEAL}>{`[${activeTool}]`}</Text>
        </>
      ) : null}
    </Box>
  )
}
