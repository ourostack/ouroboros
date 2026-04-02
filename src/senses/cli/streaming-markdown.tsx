import React from "react"
import { Text, Box } from "ink"

/**
 * Render markdown-formatted text as Ink components with ANSI styling.
 *
 * Supports: # headings, **bold**, *italic*, ***bold italic***, `inline code`,
 * ```fenced code blocks```, > blockquotes (nested), [links](url),
 * <autolinks>, ~~strikethrough~~, bullet/numbered/task lists,
 * horizontal rules (--- / ***), tables, unified diff coloring,
 * escape sequences (\*, \_, etc.), and HTML entity decoding.
 *
 * Designed for streaming: accepts partial text and re-renders as text prop grows.
 * Incomplete code fences are rendered as dim text without crashing.
 *
 * Copy-paste integrity: no padding characters are injected. Visual hierarchy
 * comes from color/bold/dim styling only.
 *
 * Uses standard ANSI colors (cyan, green, red, dim, bold, italic, underline)
 * that work on both light and dark terminal themes.
 */

interface StreamingMarkdownProps {
  /** The markdown text to render. May be partial (streaming). */
  readonly text: string
  /** Maximum width in columns. Lines wrap at this boundary. */
  readonly maxWidth?: number
}

// ─── Inline Segment Types ──────────────────────────────────────────

interface Segment {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  codeBlock?: boolean
  strikethrough?: boolean
  link?: { text: string; url: string }
  autolink?: boolean
  image?: boolean
}

// ─── Line-Level Block Types ────────────────────────────────────────

interface Block {
  type: "paragraph" | "heading" | "codeblock" | "blockquote" | "blank" | "hr" | "diff" | "table"
  level?: number        // heading level (1-6) or blockquote nesting depth
  language?: string     // code block language
  lines: string[]       // raw text lines for this block
}

// ─── Block Parser ──────────────────────────────────────────────────

const HR_PATTERN = /^(\s*[-*_]){3,}\s*$/

/** Detect if a line is a diff header or hunk marker. */
function isDiffLine(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("@@") ||
    line.startsWith("+") ||
    line.startsWith("-")
  )
}

/** Check if a block of consecutive lines looks like a unified diff. */
function looksLikeDiff(lines: string[]): boolean {
  return lines.some(l =>
    l.startsWith("diff --git") ||
    l.startsWith("@@") ||
    l.startsWith("--- a/") ||
    l.startsWith("+++ b/"),
  )
}

/** Check if a line is a table row (starts and ends with pipe, has inner pipes). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2
}

/** Check if a line is a table separator (e.g., |---|---|). */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false
  // Between outer pipes, each cell must be only dashes, colons, and spaces
  const inner = trimmed.slice(1, -1)
  return inner.split("|").every(cell => /^\s*:?-+:?\s*$/.test(cell))
}

function parseBlocks(input: string): Block[] {
  const rawLines = input.split("\n")
  const blocks: Block[] = []
  let i = 0

  while (i < rawLines.length) {
    const line = rawLines[i]

    // Fenced code block (``` with optional language)
    if (line.trimStart().startsWith("```")) {
      const langMatch = line.trimStart().match(/^```(\S*)/)
      const language = langMatch?.[1] ?? ""

      // Special case: ```diff -> render as diff block
      if (language === "diff") {
        const codeLines: string[] = []
        i++
        while (i < rawLines.length && !rawLines[i].trimStart().startsWith("```")) {
          codeLines.push(rawLines[i])
          i++
        }
        if (i < rawLines.length) i++
        blocks.push({ type: "diff", lines: codeLines })
        continue
      }

      const codeLines: string[] = []
      i++
      while (i < rawLines.length && !rawLines[i].trimStart().startsWith("```")) {
        codeLines.push(rawLines[i])
        i++
      }
      // Skip closing fence if present (if not, it's a streaming partial)
      if (i < rawLines.length) i++
      blocks.push({ type: "codeblock", language, lines: codeLines })
      continue
    }

    // Horizontal rule (---, ***, ___) -- must come before heading check
    // to avoid "---" being treated differently
    if (HR_PATTERN.test(line)) {
      blocks.push({ type: "hr", lines: [line] })
      i++
      continue
    }

    // Heading (# through ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, lines: [headingMatch[2]] })
      i++
      continue
    }

    // Blockquote (> text) -- handle nested levels
    if (/^>/.test(line)) {
      const quoteLines: string[] = []
      // Determine nesting depth from first line
      const depthMatch = line.match(/^(>+)\s?/)
      const depth = depthMatch ? depthMatch[1].length : 1
      while (i < rawLines.length && /^>/.test(rawLines[i])) {
        // Strip the leading > markers (up to depth levels)
        let stripped = rawLines[i]
        for (let d = 0; d < depth; d++) {
          stripped = stripped.replace(/^>\s?/, "")
        }
        quoteLines.push(stripped)
        i++
      }
      blocks.push({ type: "blockquote", level: depth, lines: quoteLines })
      continue
    }

    // Table detection: line is a table row, and next line (or line after) is a separator
    if (isTableRow(line)) {
      const tableLines: string[] = []
      const startI = i
      // Collect consecutive table-like rows
      while (i < rawLines.length && isTableRow(rawLines[i])) {
        tableLines.push(rawLines[i])
        i++
      }
      // Validate: must have at least a header, separator, and one data row
      if (tableLines.length >= 2 && tableLines.some(l => isTableSeparator(l))) {
        blocks.push({ type: "table", lines: tableLines })
        continue
      }
      // Not a valid table, backtrack
      i = startI
    }

    // Diff block detection: consecutive diff-like lines with a strong signal
    if (isDiffLine(line)) {
      const diffLines: string[] = []
      const startI = i
      while (i < rawLines.length && isDiffLine(rawLines[i])) {
        diffLines.push(rawLines[i])
        i++
      }
      if (looksLikeDiff(diffLines)) {
        blocks.push({ type: "diff", lines: diffLines })
        continue
      }
      // Not actually a diff -- backtrack and treat as paragraph
      i = startI
    }

    // Blank line
    if (line.trim() === "") {
      blocks.push({ type: "blank", lines: [""] })
      i++
      continue
    }

    // Regular paragraph (collect consecutive non-special lines)
    const paraLines: string[] = []
    while (
      i < rawLines.length &&
      rawLines[i].trim() !== "" &&
      !rawLines[i].trimStart().startsWith("```") &&
      !rawLines[i].match(/^#{1,6}\s/) &&
      !/^>/.test(rawLines[i]) &&
      !HR_PATTERN.test(rawLines[i])
    ) {
      paraLines.push(rawLines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", lines: paraLines })
    }
  }

  return blocks
}

// ─── HTML Entity Decoding ─────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": "\"",
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#39|lt|gt|amp|quot|apos|nbsp);/g, match => HTML_ENTITIES[match] ?? match)
}

// ─── Escape Handling ──────────────────────────────────────────────

/** Sentinel character for protected escapes. */
const ESC_SENTINEL = "\x01"

interface EscapeResult {
  text: string
  escapes: string[]
}

/** Replace \*, \_, \`, \\ with sentinels before inline parsing. */
function protectEscapes(text: string): EscapeResult {
  const escapes: string[] = []
  const processed = text.replace(/\\([*_`\\[\]()~<>])/g, (_m, char: string) => {
    const idx = escapes.length
    escapes.push(char)
    return `${ESC_SENTINEL}ESC${idx}${ESC_SENTINEL}`
  })
  return { text: processed, escapes }
}

/** Restore escape sentinels to their literal characters. */
function restoreEscapes(text: string, escapes: string[]): string {
  return text.replace(new RegExp(`${ESC_SENTINEL}ESC(\\d+)${ESC_SENTINEL}`, "g"), (_m, idx: string) => {
    return escapes[parseInt(idx)] ?? ""
  })
}

// ─── Inline Parser ─────────────────────────────────────────────────

/**
 * Parse inline markdown (bold, italic, bold-italic, code, links,
 * autolinks, strikethrough, escapes, HTML entities) from a single line.
 */
function parseInline(text: string): Segment[] {
  // Step 0: decode HTML entities
  let processed = decodeHtmlEntities(text)

  // Step 1: protect escape sequences
  const { text: escaped, escapes } = protectEscapes(processed)
  processed = escaped

  const segments: Segment[] = []
  const placeholders: { idx: number; segment: Segment }[] = []

  // Step 2: extract inline code
  processed = processed.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = placeholders.length
    placeholders.push({ idx, segment: { text: restoreEscapes(code, escapes), code: true } })
    return `\x00PH${idx}\x00`
  })

  // Step 3a: extract image references ![alt](url) -> placeholder
  processed = processed.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt: string, _url: string) => {
    const idx = placeholders.length
    const label = alt ? `\ud83d\uddbc ${restoreEscapes(alt, escapes)}` : "\ud83d\uddbc image"
    placeholders.push({ idx, segment: { text: label, image: true } })
    return `\x00PH${idx}\x00`
  })

  // Step 3b: extract [Image: ...] references
  processed = processed.replace(/\[Image:\s*([^\]]*)\]/gi, (_m, desc: string) => {
    const idx = placeholders.length
    const label = desc.trim() ? `\ud83d\uddbc ${restoreEscapes(desc.trim(), escapes)}` : "\ud83d\uddbc image"
    placeholders.push({ idx, segment: { text: label, image: true } })
    return `\x00PH${idx}\x00`
  })

  // Step 3c: extract links [text](url)
  processed = processed.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, linkText: string, url: string) => {
    const idx = placeholders.length
    const restoredText = restoreEscapes(linkText, escapes)
    const restoredUrl = restoreEscapes(url, escapes)
    placeholders.push({ idx, segment: { text: restoredText, link: { text: restoredText, url: restoredUrl } } })
    return `\x00PH${idx}\x00`
  })

  // Step 4: extract autolinks <https://...>
  processed = processed.replace(/<(https?:\/\/[^>]+)>/g, (_m, url: string) => {
    const idx = placeholders.length
    const restoredUrl = restoreEscapes(url, escapes)
    placeholders.push({ idx, segment: { text: restoredUrl, autolink: true } })
    return `\x00PH${idx}\x00`
  })

  // Step 5: extract strikethrough ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, (_m, content: string) => {
    const idx = placeholders.length
    placeholders.push({ idx, segment: { text: restoreEscapes(content, escapes), strikethrough: true } })
    return `\x00PH${idx}\x00`
  })

  // Step 6: parse bold-italic, bold, and italic from remaining text
  const parts = processed.split(/(\x00PH\d+\x00)/)

  for (const part of parts) {
    const phMatch = part.match(/^\x00PH(\d+)\x00$/)
    if (phMatch) {
      segments.push(placeholders[parseInt(phMatch[1])].segment)
      continue
    }

    // Parse ***bold italic***, **bold**, *italic*, _italic_
    parseInlineStyles(part, segments, escapes)
  }

  return segments
}

function parseInlineStyles(text: string, segments: Segment[], escapes: string[]): void {
  // Match ***bold italic***, **_bold italic_**, **bold**, *italic*, _italic_
  // Order matters: triple-star before double-star before single-star
  const pattern = /(\*\*\*(.+?)\*\*\*)|(\*\*_(.+?)_\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(_(.+?)_)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = restoreEscapes(text.slice(lastIndex, match.index), escapes)
      if (plain) segments.push({ text: plain })
    }

    if (match[2]) {
      // ***bold italic***
      segments.push({ text: restoreEscapes(match[2], escapes), bold: true, italic: true })
    } else if (match[4]) {
      // **_bold italic_**
      segments.push({ text: restoreEscapes(match[4], escapes), bold: true, italic: true })
    } else if (match[6]) {
      // **bold**
      segments.push({ text: restoreEscapes(match[6], escapes), bold: true })
    } else if (match[8]) {
      // *italic*
      segments.push({ text: restoreEscapes(match[8], escapes), italic: true })
    } else if (match[10]) {
      // _italic_
      segments.push({ text: restoreEscapes(match[10], escapes), italic: true })
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    const plain = restoreEscapes(text.slice(lastIndex), escapes)
    if (plain) segments.push({ text: plain })
  }
}

// ─── Task List Detection ──────────────────────────────────────────

interface TaskListItem {
  indent: string
  checked: boolean
  text: string
}

function parseTaskListItem(line: string): TaskListItem | null {
  const match = line.match(/^(\s*)-\s+\[([ xX])\]\s(.*)$/)
  if (!match) return null
  return {
    indent: match[1],
    checked: match[2].toLowerCase() === "x",
    text: match[3],
  }
}

// ─── Table Parser ─────────────────────────────────────────────────

interface TableData {
  headers: string[]
  rows: string[][]
  columnWidths: number[]
}

function parseTable(lines: string[]): TableData | null {
  if (lines.length < 2) return null

  // Find the separator row
  let sepIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (isTableSeparator(lines[i])) {
      sepIdx = i
      break
    }
  }
  if (sepIdx < 1) return null // separator must not be the first line

  const parseCells = (line: string): string[] => {
    const trimmed = line.trim()
    // Remove leading and trailing pipes, split by pipe
    const inner = trimmed.slice(1, -1)
    return inner.split("|").map(c => c.trim())
  }

  const headers = parseCells(lines[sepIdx - 1])
  const rows: string[][] = []
  for (let i = sepIdx + 1; i < lines.length; i++) {
    if (!isTableSeparator(lines[i])) {
      rows.push(parseCells(lines[i]))
    }
  }

  // Calculate column widths
  const columnWidths = headers.map((h, ci) => {
    let max = h.length
    for (const row of rows) {
      const cell = row[ci] ?? ""
      if (cell.length > max) max = cell.length
    }
    return Math.max(max, 3) // minimum width of 3
  })

  return { headers, rows, columnWidths }
}

// ─── Word Wrap ─────────────────────────────────────────────────────

function wrapText(text: string, maxWidth: number): string {
  /* v8 ignore next -- defensive guard for non-positive width @preserve */
  if (maxWidth <= 0) return text
  const lines = text.split("\n")
  const result: string[] = []
  for (const line of lines) {
    if (line.length <= maxWidth) {
      result.push(line)
    } else {
      let remaining = line
      while (remaining.length > maxWidth) {
        let breakAt = remaining.lastIndexOf(" ", maxWidth)
        if (breakAt <= 0) breakAt = maxWidth
        result.push(remaining.slice(0, breakAt))
        remaining = remaining.slice(breakAt).replace(/^ /, "")
      }
      /* v8 ignore next -- defensive guard for empty remaining after word-wrap @preserve */
      if (remaining) result.push(remaining)
    }
  }
  return result.join("\n")
}

// ─── Segment Renderer ──────────────────────────────────────────────

function SegmentRenderer({ segment }: { readonly segment: Segment }): React.ReactElement {
  if (segment.image) {
    return <Text dimColor>{segment.text}</Text>
  }
  if (segment.codeBlock) {
    return <Text dimColor>{segment.text}</Text>
  }
  if (segment.code) {
    return <Text color="cyan">{segment.text}</Text>
  }
  if (segment.autolink) {
    return <Text color="cyan">{segment.text}</Text>
  }
  if (segment.link) {
    return (
      <Text>
        <Text>{segment.link.text}</Text>
        <Text color="cyan" dimColor>{` (${segment.link.url})`}</Text>
      </Text>
    )
  }
  if (segment.strikethrough) {
    return <Text dimColor strikethrough>{segment.text}</Text>
  }
  if (segment.bold && segment.italic) {
    return <Text bold italic>{segment.text}</Text>
  }
  if (segment.bold) {
    return <Text bold>{segment.text}</Text>
  }
  if (segment.italic) {
    return <Text italic>{segment.text}</Text>
  }
  return <Text>{segment.text}</Text>
}

// ─── Inline Line Renderer ──────────────────────────────────────────

function InlineLine({ text: lineText }: { readonly text: string }): React.ReactElement {
  const segs = parseInline(lineText)
  return (
    <Text>
      {segs.map((seg, i) => (
        <SegmentRenderer key={i} segment={seg} />
      ))}
    </Text>
  )
}

// ─── Diff Line Renderer ───────────────────────────────────────────

function DiffLine({ line }: { readonly line: string }): React.ReactElement {
  if (line.startsWith("@@")) {
    return <Text color="cyan">{line}</Text>
  }
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return <Text bold>{line}</Text>
  }
  if (line.startsWith("+")) {
    return <Text color="green">{line}</Text>
  }
  if (line.startsWith("-")) {
    return <Text color="red">{line}</Text>
  }
  return <Text>{line}</Text>
}

// ─── Table Renderer ───────────────────────────────────────────────

function TableRenderer({ lines }: { readonly lines: string[] }): React.ReactElement {
  const table = parseTable(lines)
  if (!table) {
    // Fallback: render raw lines
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    )
  }

  const { headers, rows, columnWidths } = table

  const padCell = (text: string, width: number): string => {
    return text + " ".repeat(Math.max(0, width - text.length))
  }

  const renderRow = (cells: string[], bold: boolean): React.ReactElement => {
    const cellTexts = columnWidths.map((w, ci) => padCell(cells[ci] ?? "", w))
    const rowText = "| " + cellTexts.join(" | ") + " |"
    if (bold) return <Text bold>{rowText}</Text>
    return <InlineLine text={rowText} />
  }

  const separatorRow = "| " + columnWidths.map(w => "-".repeat(w)).join(" | ") + " |"

  return (
    <Box flexDirection="column">
      {renderRow(headers, true)}
      <Text dimColor>{separatorRow}</Text>
      {rows.map((row, i) => (
        <React.Fragment key={i}>
          {renderRow(row, false)}
        </React.Fragment>
      ))}
    </Box>
  )
}

// ─── Block Renderer ────────────────────────────────────────────────

function BlockRenderer({ block, isFirst, isLast }: { readonly block: Block; readonly isFirst: boolean; readonly isLast: boolean }): React.ReactElement {
  switch (block.type) {
    case "blank":
      return <Text>{""}</Text>

    case "hr":
      return (
        <Box flexDirection="column">
          {!isFirst && <Text>{""}</Text>}
          <Text dimColor>{"\u2500".repeat(40)}</Text>
          {!isLast && <Text>{""}</Text>}
        </Box>
      )

    case "heading": {
      const text = block.lines.join(" ")
      return (
        <Box flexDirection="column">
          {!isFirst && <Text>{""}</Text>}
          {(block.level ?? 1) === 1
            ? <Text bold underline>{text}</Text>
            : <Text bold>{text}</Text>}
          {!isLast && <Text>{""}</Text>}
        </Box>
      )
    }

    case "codeblock": {
      const langLabel = block.language || undefined
      return (
        <Box flexDirection="column">
          {!isFirst && <Text>{""}</Text>}
          {langLabel && <Text dimColor>{langLabel}</Text>}
          {block.lines.map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))}
          {!isLast && <Text>{""}</Text>}
        </Box>
      )
    }

    case "diff":
      return (
        <Box flexDirection="column">
          {!isFirst && <Text>{""}</Text>}
          <Text dimColor>{"\u2500".repeat(40)}</Text>
          {block.lines.map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
          <Text dimColor>{"\u2500".repeat(40)}</Text>
          {!isLast && <Text>{""}</Text>}
        </Box>
      )

    case "table":
      return (
        <Box flexDirection="column">
          {!isFirst && <Text>{""}</Text>}
          <TableRenderer lines={block.lines} />
          {!isLast && <Text>{""}</Text>}
        </Box>
      )

    case "blockquote": {
      const depth = block.level ?? 1
      const barPrefix = "\u2502 ".repeat(depth)
      return (
        <Box flexDirection="column">
          {!isFirst && <Text>{""}</Text>}
          {block.lines.map((line, i) => (
            <Text key={i}>
              <Text dimColor>{barPrefix}</Text>
              <Text italic><InlineLine text={line} /></Text>
            </Text>
          ))}
          {!isLast && <Text>{""}</Text>}
        </Box>
      )
    }

    case "paragraph": {
      // Check for task list items and render them specially
      const renderedLines = block.lines.map((line, i) => {
        const task = parseTaskListItem(line)
        if (task) {
          const checkbox = task.checked ? "\u2611" : "\u2610"
          return (
            <Text key={i}>
              <Text>{task.indent}{checkbox} </Text>
              <InlineLine text={task.text} />
            </Text>
          )
        }
        return <InlineLine key={i} text={line} />
      })

      return (
        <Box flexDirection="column">
          {renderedLines}
        </Box>
      )
    }
  }
}

// ─── Main Component ────────────────────────────────────────────────

export function StreamingMarkdown({ text, maxWidth }: StreamingMarkdownProps): React.ReactElement {
  const processed = maxWidth ? wrapText(text, maxWidth) : text
  const blocks = parseBlocks(processed)

  if (blocks.length === 0) {
    return <Text>{""}</Text>
  }

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <BlockRenderer key={i} block={block} isFirst={i === 0} isLast={i === blocks.length - 1} />
      ))}
    </Box>
  )
}
