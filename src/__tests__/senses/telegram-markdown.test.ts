import { describe, expect, it } from "vitest"
import {
  escapeTelegramHtml,
  renderTelegramMarkdown,
  renderTelegramMarkdownSafe,
  splitTelegramMarkdown,
  TELEGRAM_MESSAGE_LIMIT,
} from "../../senses/telegram-markdown"

const render = renderTelegramMarkdown

describe("Telegram Markdown rendering (spec R11.1)", () => {
  it("escapes the three characters Telegram HTML reserves", () => {
    expect(escapeTelegramHtml("a & <b> c")).toBe("a &amp; &lt;b&gt; c")
    expect(TELEGRAM_MESSAGE_LIMIT).toBe(4096)
  })

  it("renders bold, italic, nested emphasis, code and links", () => {
    expect(render("**bold** *also bold* _italic_")).toBe("<b>bold</b> <b>also bold</b> <i>italic</i>")
    expect(render("**bold with *star* and _under_ inside**")).toBe("<b>bold with <i>star</i> and <i>under</i> inside</b>")
    expect(render("run `a < b` now")).toBe("run <code>a &lt; b</code> now")
    expect(render("see [the **guide**](https://example.com/a?b=1&c=\"2\") or [`cmd`](tg://resolve?domain=x)"))
      .toBe("see <a href=\"https://example.com/a?b=1&amp;c=&quot;2&quot;\">the <b>guide</b></a> or <a href=\"tg://resolve?domain=x\"><code>cmd</code></a>")
  })

  it("leaves markup that doesn't resolve cleanly as literal text", () => {
    expect(render("**/src/** and 2 ** 3 and a_b_c")).toBe("**/src/** and 2 ** 3 and a_b_c")
    expect(render("Keep *open while **bold**")).toBe("Keep *open while **bold**")
    expect(render("**bold** then a stray *")).toBe("**bold** then a stray *")
    expect(render("**a _b c**")).toBe("**a _b c**")
    expect(render("[a*b](https://example.com) <x>")).toBe("<a href=\"https://example.com\">a*b</a> &lt;x&gt;")
    expect(render("[not a link](ftp://example.com)")).toBe("[not a link](ftp://example.com)")
  })

  it("renders headings, lists and quotes line by line", () => {
    const text = "# Tonight #\n- one\n* two\n  + nested\n3. three\n4) four\n> quoted **line**\n> second\nafter\n>last"
    expect(render(text)).toBe("<b>Tonight</b>\n• one\n• two\n  • nested\n3. three\n4) four\n<blockquote>quoted <b>line</b>\nsecond</blockquote>\nafter\n<blockquote>last</blockquote>")
  })

  it("renders fenced code with and without a language, closed or not", () => {
    expect(render("```ts\nconst a = 1 < 2\n```\n\nafter")).toBe("<pre><code class=\"language-ts\">const a = 1 &lt; 2</code></pre>\n\nafter")
    expect(render("~~~\nplain *text*\n~~~")).toBe("<pre>plain *text*</pre>")
    expect(render("before\n```\nnever closed")).toBe("before\n<pre>never closed</pre>")
  })

  it("renders a table as aligned monospace, padding short rows", () => {
    const text = "| Title | Year |\n|:---|---:|\n| Chef | 2019 |\n| Hope <x> |\n\nafter"
    expect(render(text)).toBe("<pre>Title    | Year\n---------+-----\nChef     | 2019\nHope &lt;x&gt;</pre>\n\nafter")
    expect(render("| a |\n|---|\n| b |")).toBe("<pre>a\n-\nb</pre>")
    // A lone row with no separator under it is text.
    expect(render("| a |")).toBe("| a |")
    expect(render("text\n| a |")).toBe("text\n| a |")
  })

  it("starts a table or code block on the line it begins, even mid-paragraph", () => {
    expect(render("intro\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("intro\n<pre>a | b\n--+--\n1 | 2</pre>")
    expect(render("intro\n```\ncode\n```")).toBe("intro\n<pre>code</pre>")
  })

  it("keeps the blank lines between blocks and drops Windows line endings", () => {
    expect(render("\n\nfirst\r\n\r\nsecond\r\n")).toBe("\n\nfirst\n\nsecond")
    expect(render("```\na\n```\n\n\n\nnext")).toBe("<pre>a</pre>\n\nnext")
  })

  it("keeps only code and links in the safe rendering", () => {
    const text = "# Head\n**bold** `code` [link](https://example.com) <x>\n> quote\n\n| a |\n|---|\n\n```\nc\n```"
    expect(renderTelegramMarkdownSafe(text)).toBe("# Head\n**bold** <code>code</code> <a href=\"https://example.com\">link</a> &lt;x&gt;\n&gt; quote\n\n<pre>a\n-</pre>\n\n<pre>c</pre>")
  })
})

describe("Telegram Markdown splitting (spec R11.1)", () => {
  const joined = (text: string, options?: Parameters<typeof splitTelegramMarkdown>[1]): string[] => {
    const chunks = splitTelegramMarkdown(text, options)
    expect(chunks.join("")).toBe(text)
    return chunks
  }

  it("checks its limits and keeps an empty text as one empty chunk", () => {
    expect(() => splitTelegramMarkdown("x", { targetUnits: 0 })).toThrow("positive integers")
    expect(() => splitTelegramMarkdown("x", { targetUnits: 1.5 })).toThrow("positive integers")
    expect(() => splitTelegramMarkdown("x", { maxUnits: 1.5 })).toThrow("positive integers")
    expect(() => splitTelegramMarkdown("x", { targetUnits: 10, maxUnits: 5 })).toThrow("positive integers")
    expect(splitTelegramMarkdown("")).toEqual([""])
  })

  it("packs whole blocks up to the target", () => {
    const text = "# Tonight\n\nHere are three picks.\n\n- one\n- two\n\n```\ncode\n```\n\nlast"
    expect(joined(text)).toEqual([text])
    expect(joined(text, { targetUnits: 30, maxUnits: 200 })).toEqual(["# Tonight\n\n", "Here are three picks.\n\n", "- one\n- two\n\n```\ncode\n```\n\n", "last"])
  })

  it("cuts a code block longer than one message by line, each piece fenced and within the limit", () => {
    const code = Array.from({ length: 30 }, (_, index) => `line ${index} < x`).join("\n")
    const chunks = splitTelegramMarkdown(`intro\n\n\`\`\`js\n${code}\n\`\`\`\n\nafter`, { targetUnits: 100, maxUnits: 200 })
    expect(chunks[0]).toBe("intro\n\n")
    expect(chunks.at(-1)).toBe("after")
    const pieces = chunks.slice(1, -1)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece).toMatch(/^```js\n[^`]+```\n/u)
      expect(render(piece).length).toBeLessThanOrEqual(200)
    }
    expect(pieces.map((piece) => piece.replace(/^```js\n/u, "").replace(/```\n(\n)?$/u, "")).join("")).toBe(`${code}\n`)
  })

  it("closes the pieces of a code block that was never closed or closed without a newline", () => {
    const code = Array.from({ length: 20 }, (_, index) => `row ${index}`).join("\n")
    const unclosed = splitTelegramMarkdown(`\`\`\`\n${code}`, { targetUnits: 60, maxUnits: 80 })
    expect(unclosed.every((piece) => piece.startsWith("```\n") && piece.endsWith("```\n"))).toBe(true)
    const closed = splitTelegramMarkdown(`\`\`\`\n${code}\n\`\`\``, { targetUnits: 60, maxUnits: 80 })
    expect(closed.every((piece) => piece.startsWith("```\n") && piece.endsWith("```\n"))).toBe(true)
    expect(closed.length).toBe(unclosed.length)
  })

  it("cuts a table longer than one message by row, repeating the header", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `| show ${index} | 20${index} |\n`).join("")
    const pieces = splitTelegramMarkdown(`| Title | Year |\n|---|---|\n${rows}`, { targetUnits: 100, maxUnits: 200 })
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.startsWith("| Title | Year |\n|---|---|\n")).toBe(true)
      expect(render(piece).length).toBeLessThanOrEqual(200)
    }
  })

  it("cuts a paragraph longer than one message at a space, shrinking the cut until markup fits", () => {
    const plain = `start ${"word ".repeat(900)}end`
    const plainChunks = joined(plain)
    expect(plainChunks).toHaveLength(2)
    expect(plainChunks.every((chunk) => render(chunk).length <= TELEGRAM_MESSAGE_LIMIT)).toBe(true)

    // Bold markup renders longer than it is written, so the first cut is too long and a smaller one is taken.
    const marked = "**a** ".repeat(60)
    const markedChunks = joined(marked, { targetUnits: 100, maxUnits: 200 })
    expect(markedChunks.length).toBeGreaterThan(1)
    expect(markedChunks.every((chunk) => render(chunk).length <= 200)).toBe(true)
  })

  it("stops shrinking at a small limit rather than cutting forever", () => {
    const chunks = joined("**a** ".repeat(20), { targetUnits: 30, maxUnits: 30 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("sends what came before a long block on its own first", () => {
    const chunks = joined(`short\n\n${"x".repeat(300)}`, { targetUnits: 250, maxUnits: 250 })
    expect(chunks[0]).toBe("short\n\n")
    expect(chunks.slice(1).join("")).toBe("x".repeat(300))
  })

  it("cuts a code line or table header too long for one message as text, losing nothing", () => {
    const longLine = `\`\`\`\n${"y".repeat(300)}\n\`\`\``
    const codeChunks = joined(longLine, { targetUnits: 100, maxUnits: 100 })
    expect(codeChunks.length).toBeGreaterThan(1)
    expect(codeChunks.every((chunk) => chunk.length <= 100)).toBe(true)

    const wideHeader = `| ${"h".repeat(150)} |\n|---|\n`
    const tableChunks = joined(wideHeader, { targetUnits: 100, maxUnits: 100 })
    expect(tableChunks.length).toBeGreaterThan(1)
  })
})
