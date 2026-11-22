/**
 * Ordinary Markdown to Telegram HTML, for every agent's Telegram replies (spec R11.1).
 *
 *  - Inline: `**x**` and `*x*` are bold (the long-standing meaning of `*x*` here), `_x_` is italic, `` `x` `` is code,
 *    `[text](https://…)` is a link. A span that doesn't resolve cleanly stays literal text, never half-applied markup.
 *  - Blocks: a heading is a bold line, list items keep their marker (bullets become •), `>` lines are a quote, fenced code
 *    is a code block, and a table is a monospace block with its columns aligned.
 *  - Splitting goes by Markdown block and never inside a code block or table unless that block alone is too long; each
 *    chunk is measured after rendering.
 *  - `renderTelegramMarkdownSafe` is the first fallback when Telegram rejects a chunk: inline markup is escaped and only
 *    code blocks, tables, code spans and links are kept.
 */
import { emitNervesEvent } from "../nerves/runtime"

/** Telegram's limit on one message's text. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export interface TelegramChunkOptions {
  targetUnits?: number
  maxUnits?: number
}

function sourceIndexForRenderedLimit(value: string, limit: number): number {
  let renderedUnits = 0
  let sourceIndex = 0
  for (const character of value) {
    const escaped = escapeTelegramHtml(character)
    if (renderedUnits + escaped.length > limit) break
    renderedUnits += escaped.length
    sourceIndex += character.length
  }
  return sourceIndex
}

function preferredBoundary(value: string, limit: number, minimum: number): number {
  const paragraph = value.lastIndexOf("\n\n", limit - 1)
  if (paragraph >= minimum) return paragraph + 2
  const newline = value.lastIndexOf("\n", limit - 1)
  if (newline >= minimum) return newline + 1
  for (let index = limit - 1; index >= minimum; index -= 1) {
    if (/\s/u.test(value[index])) return index + 1
  }
  return limit
}

export function splitTelegramText(value: string, options: TelegramChunkOptions = {}): string[] {
  const targetUnits = options.targetUnits ?? 1_200
  const maxUnits = options.maxUnits ?? 4_000
  if (!Number.isInteger(targetUnits) || !Number.isInteger(maxUnits) || targetUnits < 1 || maxUnits < targetUnits) {
    throw new Error("Telegram chunk limits must be positive integers with targetUnits <= maxUnits")
  }
  if (!value) return [""]

  const chunks: string[] = []
  let remaining = value
  while (escapeTelegramHtml(remaining).length > maxUnits || escapeTelegramHtml(remaining).length > targetUnits) {
    const targetIndex = sourceIndexForRenderedLimit(remaining, targetUnits)
    const maxIndex = sourceIndexForRenderedLimit(remaining, maxUnits)
    const candidate = targetIndex > 0 ? targetIndex : maxIndex
    if (candidate <= 0) throw new Error("Telegram chunk limit cannot fit one character")
    const splitAt = preferredBoundary(remaining, candidate, Math.floor(candidate / 2))
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  chunks.push(remaining)
  return chunks
}

const escapeAttribute = (value: string): string => escapeTelegramHtml(value).replaceAll("\"", "&quot;")

// Bold spans may carry one level of emphasis inside them, because `**bold with *italic* inside**` is ordinary model prose.
// A span must open on a letter or digit and close on a non-space, which keeps `**/src/**`, `2 ** 3` and `a_b_c` literal.
const BOLD_WITH_NESTING = /`([^`\n]+)`|\*\*([\p{L}\p{N}](?:[^*_`\n]|\*(?!\*)|_)*\S|[\p{L}\p{N}])\*\*|\*([\p{L}\p{N}](?:[^*_`\n]*\S)?)\*|_([\p{L}\p{N}](?:[^*_`\n]*\S)?)_/gu
const EMPHASIS_ONLY = /`([^`\n]+)`|\*([\p{L}\p{N}](?:[^*_`\n]*\S)?)\*|_([\p{L}\p{N}](?:[^*_`\n]*\S)?)_/gu
// A code span, or a link to a web or Telegram address.
const ATOM = /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^\s)]+)\)/gu

// Null when the span can't be rendered cleanly, so the caller escapes it instead of emitting partial markup.
function styledSpan(text: string, allowBold: boolean): string | null {
  let html = ""
  let cursor = 0
  const pattern = allowBold ? BOLD_WITH_NESTING : EMPHASIS_ONLY
  for (const match of text.matchAll(pattern)) {
    const gap = text.slice(cursor, match.index)
    if (/[*_`]/u.test(gap)) return null
    html += escapeTelegramHtml(gap)
    const code = match[1]
    const bold = allowBold ? match[2] : undefined
    const italic = allowBold ? match[3] : match[2]
    const underscored = allowBold ? match[4] : match[3]
    if (code !== undefined) html += `<code>${escapeTelegramHtml(code)}</code>`
    else if (bold !== undefined) {
      const inner = styledSpan(bold, false)
      if (inner === null) return null
      html += `<b>${inner}</b>`
    // A single-marker span is bold at the top level, but inside a bold run it is the nested emphasis the author meant.
    } else if (italic !== undefined) html += allowBold ? `<b>${escapeTelegramHtml(italic)}</b>` : `<i>${escapeTelegramHtml(italic)}</i>`
    else html += `<i>${escapeTelegramHtml(underscored!)}</i>`
    cursor = match.index + match[0].length
  }
  const tail = text.slice(cursor)
  return /[*_`]/u.test(tail) ? null : html + escapeTelegramHtml(tail)
}

/** One line's inline markup: code spans and links are kept whole first, then the styled spans between them. */
function inline(line: string, safe: boolean): string {
  let html = ""
  let cursor = 0
  const rest = (text: string): string => (safe ? escapeTelegramHtml(text) : styledSpan(text, true) ?? escapeTelegramHtml(text))
  for (const match of line.matchAll(ATOM)) {
    html += rest(line.slice(cursor, match.index))
    if (match[1] !== undefined) html += `<code>${escapeTelegramHtml(match[1])}</code>`
    else {
      const label = safe ? escapeTelegramHtml(match[2]!) : styledSpan(match[2]!, true) ?? escapeTelegramHtml(match[2]!)
      html += `<a href="${escapeAttribute(match[3]!)}">${label}</a>`
    }
    cursor = match.index + match[0].length
  }
  return html + rest(line.slice(cursor))
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/u
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/u
const QUOTE = /^\s{0,3}>\s?(.*)$/u

type Block =
  | { kind: "code"; source: string; language: string; lines: string[]; open: string; close: string | null }
  | { kind: "table"; source: string; rows: string[][]; header: string[]; separator: string }
  | { kind: "text"; source: string }

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/u.test(line)
const cells = (line: string): string[] => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim())

/**
 * The text as blocks whose sources concatenate back to it exactly. A text block runs to the next blank line, so a
 * paragraph, list or quote is one block; code fences and tables are their own blocks.
 */
function parseBlocks(text: string): Block[] {
  const lines = text.split(/(?<=\n)/u)
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const bare = line.replace(/\r?\n$/u, "")
    const fence = FENCE.exec(bare)
    if (fence) {
      const marker = fence[1]!
      let end = index + 1
      while (end < lines.length && !lines[end]!.trim().startsWith(marker.slice(0, 3))) end += 1
      const closed = end < lines.length
      const body = lines.slice(index + 1, end)
      const source = lines.slice(index, closed ? end + 1 : end).join("")
      blocks.push({ kind: "code", source, language: fence[2]!, lines: body.map((entry) => entry.replace(/\r?\n$/u, "")), open: line, close: closed ? lines[end]! : null })
      index = closed ? end + 1 : end
      continue
    }
    if (isTableRow(bare) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!.replace(/\r?\n$/u, ""))) {
      let end = index + 2
      while (end < lines.length && isTableRow(lines[end]!.replace(/\r?\n$/u, ""))) end += 1
      const body = lines.slice(index + 2, end).map((entry) => cells(entry))
      blocks.push({ kind: "table", source: lines.slice(index, end).join(""), header: cells(bare), separator: lines[index + 1]!, rows: body })
      index = end
      continue
    }
    // A text block: up to and including the blank lines that end it, stopping before a fence or a table.
    let end = index + 1
    let sawBlank = bare.trim() === ""
    while (end < lines.length) {
      const next = lines[end]!.replace(/\r?\n$/u, "")
      const blank = next.trim() === ""
      if (FENCE.test(next) || (isTableRow(next) && end + 1 < lines.length && TABLE_SEPARATOR.test(lines[end + 1]!.replace(/\r?\n$/u, "")))) break
      if (sawBlank && !blank) break
      sawBlank = sawBlank || blank
      end += 1
    }
    const previous = blocks.at(-1)
    const source = lines.slice(index, end).join("")
    // Blank lines after a code block or table belong with it, so every block keeps its own separator.
    if (bare.trim() === "" && previous && previous.kind !== "text" && source.trim() === "") previous.source += source
    else blocks.push({ kind: "text", source })
    index = end
  }
  return blocks
}

function renderTable(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map((row) => row.length))
  const all = [header, ...rows].map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ""))
  const widths = Array.from({ length: width }, (_, column) => Math.max(...all.map((row) => [...row[column]!].length)))
  const line = (row: string[]): string => row.map((cell, column) => cell + " ".repeat(widths[column]! - [...cell].length)).join(" | ").replace(/[ |]+$/u, "")
  const rule = widths.map((size) => "-".repeat(size)).join("-+-")
  return `<pre>${escapeTelegramHtml([line(all[0]!), rule, ...all.slice(1).map(line)].join("\n"))}</pre>`
}

function renderCode(language: string, lines: string[]): string {
  const code = escapeTelegramHtml(lines.join("\n"))
  return language ? `<pre><code class="language-${escapeAttribute(language)}">${code}</code></pre>` : `<pre>${code}</pre>`
}

function renderTextBlock(source: string, safe: boolean): string {
  const trailing = /\s*$/u.exec(source)![0]
  const body = source.slice(0, source.length - trailing.length)
  const out: string[] = []
  let quote: string[] = []
  const flushQuote = (): void => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`)
    quote = []
  }
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/u, "")
    if (safe) { out.push(inline(line, true)); continue }
    const quoted = QUOTE.exec(line)
    if (quoted) { quote.push(inline(quoted[1]!, false)); continue }
    flushQuote()
    const heading = HEADING.exec(line)
    const item = LIST_ITEM.exec(line)
    if (heading) out.push(`<b>${inline(heading[1]!, false)}</b>`)
    else if (item) out.push(`${item[1]}${/^[-*+]$/u.test(item[2]!) ? "•" : item[2]} ${inline(item[3]!, false)}`)
    else out.push(inline(line, false))
  }
  flushQuote()
  return out.join("\n") + trailing.replace(/\r/gu, "")
}

function renderBlocks(blocks: Block[], safe: boolean): string {
  return blocks.map((block) => {
    if (block.kind === "code") return renderCode(block.language, block.lines) + trailingOf(block)
    if (block.kind === "table") return renderTable(block.header, block.rows) + trailingOf(block)
    return renderTextBlock(block.source, safe)
  }).join("")
}

// What follows a code block's closing fence or a table's last row: the blank lines that separate it from the next block.
function trailingOf(block: Block): string {
  return /\n*$/u.exec(block.source.replace(/[^\S\n]+$/u, ""))![0].slice(1) ? "\n\n" : ""
}

/** Markdown as Telegram HTML. */
export function renderTelegramMarkdown(text: string): string {
  return renderBlocks(parseBlocks(text), false).trimEnd()
}

/** The first fallback for a chunk Telegram refused: inline markup escaped; code blocks, tables, code spans and links kept. */
export function renderTelegramMarkdownSafe(text: string): string {
  return renderBlocks(parseBlocks(text), true).trimEnd()
}

export interface TelegramMarkdownChunkOptions {
  /** Pack blocks up to this many rendered characters before starting a new message. */
  targetUnits?: number
  /** No chunk renders longer than this. */
  maxUnits?: number
}

/** Pieces of one block that alone renders longer than the limit: code and tables by line, each piece still a whole block. */
function cutBlock(block: Block, maxUnits: number): string[] {
  const fits = (source: string): boolean => renderTelegramMarkdown(source).length <= maxUnits
  const pack = (items: string[], wrap: (body: string) => string): string[] => {
    const pieces: string[] = []
    let current = ""
    for (const item of items) {
      if (current && !fits(wrap(current + item))) { pieces.push(wrap(current)); current = "" }
      current += item
    }
    if (current) pieces.push(wrap(current))
    return pieces
  }
  // A piece is a whole block only if every piece fits; a single line or header too long for one message is cut as text.
  const whole = (pieces: string[]): string[] | null => (pieces.length && pieces.every(fits) ? pieces : null)
  if (block.kind === "code") {
    const close = block.close ?? "```\n"
    const pieces = whole(pack(block.lines.map((line) => `${line}\n`), (body) => `${block.open}${body}${close.endsWith("\n") ? close : `${close}\n`}`))
    if (pieces) return pieces
  }
  if (block.kind === "table") {
    const head = block.source.split(/(?<=\n)/u).slice(0, 2).join("")
    const pieces = whole(pack(block.source.split(/(?<=\n)/u).slice(2), (body) => `${head}${body}`))
    if (pieces) return pieces
  }
  // A long paragraph, or a block that can't be cut whole: cut at paragraph, line or word boundaries by escaped length, then checked after rendering; markup only
  // adds tags, so a piece still too long is cut again with a smaller budget.
  for (let budget = maxUnits; ; budget = Math.floor(budget * 0.8)) {
    const pieces = splitTelegramText(block.source, { targetUnits: budget, maxUnits: budget })
    if (budget < 64 || pieces.every(fits)) return pieces
  }
}

/**
 * The text cut into Telegram messages by Markdown block; each chunk is measured after rendering. Chunks join back to the
 * text, except where one code block or table is longer than a message: each of its pieces is re-fenced or repeats the header.
 */
export function splitTelegramMarkdown(text: string, options: TelegramMarkdownChunkOptions = {}): string[] {
  const targetUnits = options.targetUnits ?? 1_200
  const maxUnits = options.maxUnits ?? TELEGRAM_MESSAGE_LIMIT
  if (!Number.isInteger(targetUnits) || !Number.isInteger(maxUnits) || targetUnits < 1 || maxUnits < targetUnits) {
    throw new Error("Telegram chunk limits must be positive integers with targetUnits <= maxUnits")
  }
  if (!text) return [""]
  const chunks: string[] = []
  let current = ""
  for (const block of parseBlocks(text)) {
    if (current && renderTelegramMarkdown(current + block.source).length > targetUnits) { chunks.push(current); current = "" }
    if (renderTelegramMarkdown(block.source).length > maxUnits) {
      const pieces = cutBlock(block, maxUnits)
      emitNervesEvent({ component: "senses", event: "telegram.block_cut", message: "a Markdown block longer than one Telegram message was cut", meta: { kind: block.kind, pieces: pieces.length } })
      chunks.push(...pieces)
      continue
    }
    current += block.source
  }
  if (current) chunks.push(current)
  return chunks
}
