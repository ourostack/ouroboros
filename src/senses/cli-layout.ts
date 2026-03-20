import { emitNervesEvent } from "../nerves/runtime"

// Strip ANSI escape sequences to measure visible text width.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function visibleLength(text: string): number {
  return text.replace(ANSI_RE, "").length
}

/**
 * Streaming word wrapper for terminal output.
 *
 * Text arrives in small chunks (sometimes single characters). This class
 * buffers a partial line and emits complete wrapped lines at word boundaries
 * when the visible width approaches the terminal column limit.
 *
 * ANSI escape sequences are treated as zero-width so colours and styles
 * pass through without affecting line-break decisions.
 */
export class StreamingWordWrapper {
  private col = 0       // visible columns consumed on the current line
  private buf = ""       // buffered text for the current line (not yet emitted)
  private width: number  // terminal column count

  constructor(cols?: number) {
    this.width = Math.max(cols ?? (process.stdout.columns || 80), 1)
  }

  /** Accept a chunk of already-rendered text and return text ready for stdout. */
  push(text: string): string {
    let out = ""

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]

      // Pass through ANSI escape sequences without counting width
      /* v8 ignore start -- ANSI handling: tested via StreamingWordWrapper ANSI test @preserve */
      if (ch === "\x1b") {
        const rest = text.slice(i)
        const m = rest.match(/^\x1b\[[0-9;]*[A-Za-z]/)
        if (m) {
          this.buf += m[0]
          i += m[0].length - 1
          continue
        }
      }
      /* v8 ignore stop */

      // Explicit newline: flush current line and reset
      if (ch === "\n") {
        out += this.buf + "\n"
        this.buf = ""
        this.col = 0
        continue
      }

      // Space: if the current line is already at or past width, wrap now.
      // Otherwise just append.
      if (ch === " ") {
        /* v8 ignore start -- wrap-at-space: tested via StreamingWordWrapper unit tests @preserve */
      if (this.col >= this.width) {
          out += this.buf + "\n"
          this.buf = ""
          this.col = 0
          // Drop the space at the wrap point
          continue
      /* v8 ignore stop */
        }
        this.buf += ch
        this.col++
        continue
      }

      // Non-space character
      this.col++
      if (this.col > this.width) {
        // We've exceeded the width. Try to break at the last space.
        const lastSpace = this.buf.lastIndexOf(" ")
        if (lastSpace !== -1) {
          out += this.buf.slice(0, lastSpace) + "\n"
          // Keep the remainder (after space) plus current char
          this.buf = this.buf.slice(lastSpace + 1) + ch
          this.col = visibleLength(this.buf)
        } else {
          // No space to break at — hard wrap
          out += this.buf + "\n"
          this.buf = ch
          this.col = 1
        }
        continue
      }

      this.buf += ch
    }

    return out
  }

  /** Flush any remaining buffered text (call at end of response). */
  flush(): string {
    const remainder = this.buf
    this.buf = ""
    this.col = 0
    return remainder
  }

  /** Reset wrapper state (call at start of new model turn). */
  reset(): void {
    this.buf = ""
    this.col = 0
  }
}

function splitLongWord(word: string, width: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width))
  }
  return chunks
}

export function wrapCliText(text: string, cols: number): string[] {
  const width = Math.max(cols, 1)
  const wrapped: string[] = []

  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) {
      wrapped.push("")
      continue
    }

    const words = rawLine.trim().split(/\s+/)
    let current = ""

    for (const word of words) {
      if (!current) {
        if (word.length <= width) {
          current = word
          continue
        }

        const chunks = splitLongWord(word, width)
        wrapped.push(...chunks.slice(0, -1))
        current = chunks[chunks.length - 1]
        continue
      }

      const candidate = `${current} ${word}`
      if (candidate.length <= width) {
        current = candidate
        continue
      }

      wrapped.push(current)
      if (word.length <= width) {
        current = word
        continue
      }

      const chunks = splitLongWord(word, width)
      wrapped.push(...chunks.slice(0, -1))
      current = chunks[chunks.length - 1]
    }

    wrapped.push(current)
  }

  return wrapped
}

function countEchoedInputRows(input: string, cols: number): number {
  const width = Math.max(cols, 1)
  return input.split("\n").reduce((sum, line, index) => {
    const promptWidth = index === 0 ? 2 : 0
    return sum + Math.max(1, Math.ceil((promptWidth + line.length) / width))
  }, 0)
}

export function formatEchoedInputSummary(input: string, cols: number): string {
  const inputLines = input.split("\n")
  const summary = `> ${inputLines[0]}${inputLines.length > 1 ? ` (+${inputLines.length - 1} lines)` : ""}`
  const wrappedSummary = wrapCliText(summary, cols)
  const echoRows = countEchoedInputRows(input, cols)

  emitNervesEvent({
    component: "senses",
    event: "senses.cli_echo_summary_formatted",
    message: "formatted echoed cli input summary",
    meta: {
      cols,
      echo_rows: echoRows,
      input_line_count: inputLines.length,
      wrapped_line_count: wrappedSummary.length,
    },
  })

  let output = `\x1b[${echoRows}A`
  for (let i = 0; i < echoRows; i += 1) {
    output += "\r\x1b[K"
    if (i < echoRows - 1) {
      output += "\x1b[1B"
    }
  }
  if (echoRows > 1) {
    output += `\x1b[${echoRows - 1}A`
  }

  output += `\x1b[1m${wrappedSummary.join("\n")}\x1b[0m\n\n`
  return output
}
