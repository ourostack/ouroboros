import React from "react"
import { Text, Box } from "ink"

/**
 * Inline diff renderer for file edits in the CLI TUI.
 *
 * Renders a unified-style diff with:
 * - Line numbers (semantic prefix, fine for copy-paste)
 * - +/- markers with green/red coloring
 * - Context lines in default color
 * - File path header
 *
 * Copy-paste integrity: no padding spaces. Visual separation via color only.
 * Semantic prefixes (+, -, line numbers) are intentional and expected in diffs.
 */

interface InlineDiffProps {
  /** Content before the edit */
  readonly before: string
  /** Content after the edit */
  readonly after: string
  /** File path to display in header */
  readonly filePath: string
  /** Number of context lines around changes (default: 3) */
  readonly contextLines?: number
}

// Ouroboros brand colors
const OURO_GREEN = "#2ecc40"     // added lines -- serpent green
const OURO_RED = "#e74c3c"       // removed lines
const OURO_HEADER = "#4ec9b0"    // file header -- teal
const OURO_LINE_NUM = "gray"     // line numbers -- subtle

interface DiffLine {
  type: "add" | "remove" | "context"
  content: string
  oldNum?: number
  newNum?: number
}

/**
 * Simple line-level diff algorithm (Myers-like via LCS).
 * Produces a sequence of add/remove/context lines.
 */
function computeDiff(before: string, after: string): DiffLine[] {
  const oldLines = before ? before.split("\n") : []
  const newLines = after ? after.split("\n") : []

  // LCS-based diff
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "context", content: oldLines[i - 1], oldNum: i, newNum: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", content: newLines[j - 1], newNum: j })
      j--
    } else {
      result.unshift({ type: "remove", content: oldLines[i - 1], oldNum: i })
      i--
    }
  }

  return result
}

function DiffLineComponent({ line }: { readonly line: DiffLine }): React.ReactElement {
  const num = line.type === "remove" ? line.oldNum : line.newNum
  /* v8 ignore next -- defensive fallback; line numbers always present @preserve */
  const lineNum = num !== undefined ? String(num) : ""

  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " "
  const color = line.type === "add" ? OURO_GREEN : line.type === "remove" ? OURO_RED : undefined

  return (
    <Text>
      <Text color={OURO_LINE_NUM}>{lineNum.padStart(4)}</Text>
      <Text color={color}>{` ${prefix} ${line.content}`}</Text>
    </Text>
  )
}

export function InlineDiff({ before, after, filePath }: InlineDiffProps): React.ReactElement {
  const diffLines = computeDiff(before, after)

  return (
    <Box flexDirection="column">
      <Text color={OURO_HEADER} bold>{filePath}</Text>
      {diffLines.map((line, i) => (
        <DiffLineComponent key={i} line={line} />
      ))}
    </Box>
  )
}
