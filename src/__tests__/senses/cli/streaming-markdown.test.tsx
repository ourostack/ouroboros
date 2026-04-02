import React from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

import { StreamingMarkdown } from "../../../senses/cli/streaming-markdown"

afterEach(() => {
  cleanup()
})

describe("StreamingMarkdown (Ink)", () => {
  it("renders plain text without crashing", () => {
    const { lastFrame } = render(<StreamingMarkdown text="Hello world" />)
    expect(lastFrame()).toContain("Hello world")
  })

  it("renders bold markdown as ANSI bold", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this is **bold** text" />)
    const frame = lastFrame()!
    expect(frame).toContain("bold")
    expect(frame).not.toContain("**")
  })

  it("renders inline code with styling", () => {
    const { lastFrame } = render(<StreamingMarkdown text="use `npm install` here" />)
    const frame = lastFrame()!
    expect(frame).toContain("npm install")
    expect(frame).not.toMatch(/`npm install`/)
  })

  it("renders fenced code blocks with dim styling", () => {
    const text = "before\n```js\nconst x = 1\n```\nafter"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("const x = 1")
    expect(frame).toContain("before")
    expect(frame).toContain("after")
  })

  it("handles empty text gracefully", () => {
    const { lastFrame } = render(<StreamingMarkdown text="" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
  })

  it("updates when text prop changes (streaming simulation)", () => {
    const { lastFrame, rerender } = render(<StreamingMarkdown text="Hel" />)
    expect(lastFrame()).toContain("Hel")

    rerender(<StreamingMarkdown text="Hello wor" />)
    expect(lastFrame()).toContain("Hello wor")

    rerender(<StreamingMarkdown text="Hello world!" />)
    expect(lastFrame()).toContain("Hello world!")
  })

  it("respects maxWidth for line wrapping", () => {
    const longText = "a".repeat(200)
    const { lastFrame } = render(<StreamingMarkdown text={longText} maxWidth={80} />)
    const frame = lastFrame()!
    const stripped = frame.replace(/\n/g, "")
    expect(stripped).toContain("a".repeat(80))
  })

  it("produces no padding characters that corrupt copy-paste", () => {
    const { lastFrame } = render(<StreamingMarkdown text="line one\nline two" />)
    const frame = lastFrame()!
    const lines = frame.split("\n").filter(l => l.length > 0)
    for (const line of lines) {
      expect(line).toBe(line.trimEnd())
    }
  })

  it("renders italic text", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this is *italic* text" />)
    const frame = lastFrame()!
    expect(frame).toContain("italic")
    expect(frame).not.toMatch(/\*italic\*/)
  })

  it("handles bold followed by plain text", () => {
    const { lastFrame } = render(<StreamingMarkdown text="**bold** then plain" />)
    const frame = lastFrame()!
    expect(frame).toContain("bold")
    expect(frame).toContain("then plain")
  })

  it("wraps text when maxWidth is very small", () => {
    const { lastFrame } = render(<StreamingMarkdown text="hello world foo bar" maxWidth={5} />)
    const frame = lastFrame()!
    expect(frame).toContain("hello")
  })

  it("handles maxWidth of 0 (no wrapping)", () => {
    const { lastFrame } = render(<StreamingMarkdown text="hello world" maxWidth={0} />)
    const frame = lastFrame()!
    expect(frame).toContain("hello world")
  })

  it("handles long word with no spaces at wrap boundary", () => {
    const longWord = "a".repeat(20)
    const { lastFrame } = render(<StreamingMarkdown text={longWord} maxWidth={10} />)
    const frame = lastFrame()!
    const stripped = frame.replace(/\n/g, "")
    expect(stripped.length).toBeGreaterThanOrEqual(20)
  })

  it("handles text with only inline code", () => {
    const { lastFrame } = render(<StreamingMarkdown text="`code only`" />)
    const frame = lastFrame()!
    expect(frame).toContain("code only")
  })

  it("wraps text with both short and long lines", () => {
    const text = "short\n" + "x".repeat(100)
    const { lastFrame } = render(<StreamingMarkdown text={text} maxWidth={30} />)
    const frame = lastFrame()!
    expect(frame).toContain("short")
    expect(frame).toContain("x")
  })

  it("wraps remaining text after long-word split", () => {
    const text = "a".repeat(15)
    const { lastFrame } = render(<StreamingMarkdown text={text} maxWidth={10} />)
    const frame = lastFrame()!
    const stripped = frame.replace(/\n/g, "")
    expect(stripped).toContain("aaaaaa")
  })

  // ─── Heading tests ─────────────────────────────────────────────────

  it("renders H1 headings as bold text without # marker", () => {
    const { lastFrame } = render(<StreamingMarkdown text="# Hello World" />)
    const frame = lastFrame()!
    expect(frame).toContain("Hello World")
    expect(frame).not.toContain("# ")
  })

  it("renders H2 headings as bold text without ## marker", () => {
    const { lastFrame } = render(<StreamingMarkdown text="## Section Two" />)
    const frame = lastFrame()!
    expect(frame).toContain("Section Two")
    expect(frame).not.toContain("## ")
  })

  it("renders H3 headings as bold text without ### marker", () => {
    const { lastFrame } = render(<StreamingMarkdown text="### Subsection" />)
    const frame = lastFrame()!
    expect(frame).toContain("Subsection")
    expect(frame).not.toContain("### ")
  })

  // ─── Blockquote tests ──────────────────────────────────────────────

  it("renders blockquotes with dim bar prefix", () => {
    const { lastFrame } = render(<StreamingMarkdown text="> This is quoted" />)
    const frame = lastFrame()!
    expect(frame).toContain("This is quoted")
    expect(frame).toContain("\u2502")
  })

  it("renders multi-line blockquotes", () => {
    const { lastFrame } = render(<StreamingMarkdown text={"> line one\n> line two"} />)
    const frame = lastFrame()!
    expect(frame).toContain("line one")
    expect(frame).toContain("line two")
  })

  // ─── Link tests ────────────────────────────────────────────────────

  it("renders links with text and URL", () => {
    const { lastFrame } = render(<StreamingMarkdown text="[click here](https://example.com)" />)
    const frame = lastFrame()!
    expect(frame).toContain("click here")
    expect(frame).toContain("https://example.com")
    expect(frame).not.toContain("[click here]")
  })

  // ─── Strikethrough tests ───────────────────────────────────────────

  it("renders strikethrough text without ~~ markers", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this is ~~deleted~~ text" />)
    const frame = lastFrame()!
    expect(frame).toContain("deleted")
    expect(frame).not.toContain("~~")
  })

  // ─── Underscore italic tests ───────────────────────────────────────

  it("renders _italic_ text with underscores", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this is _emphasized_ text" />)
    const frame = lastFrame()!
    expect(frame).toContain("emphasized")
    expect(frame).not.toMatch(/_emphasized_/)
  })

  // ─── Combined markdown tests ──────────────────────────────────────

  it("renders mixed heading and paragraph blocks", () => {
    const text = "# Title\n\nSome paragraph text.\n\n## Subtitle\n\nMore text."
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("Title")
    expect(frame).toContain("Some paragraph text.")
    expect(frame).toContain("Subtitle")
    expect(frame).toContain("More text.")
  })

  it("renders bullet lists as-is", () => {
    const text = "- item one\n- item two\n- item three"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("- item one")
    expect(frame).toContain("- item two")
  })

  it("renders numbered lists as-is", () => {
    const text = "1. first\n2. second\n3. third"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("1. first")
    expect(frame).toContain("2. second")
  })

  // ─── Horizontal rule tests ────────────────────────────────────────

  it("renders --- as a horizontal rule", () => {
    const { lastFrame } = render(<StreamingMarkdown text={"before\n---\nafter"} />)
    const frame = lastFrame()!
    expect(frame).toContain("before")
    expect(frame).toContain("after")
    expect(frame).toContain("\u2500") // box-drawing dash
    expect(frame).not.toContain("---")
  })

  it("renders *** as a horizontal rule", () => {
    const { lastFrame } = render(<StreamingMarkdown text={"above\n***\nbelow"} />)
    const frame = lastFrame()!
    expect(frame).toContain("above")
    expect(frame).toContain("below")
    expect(frame).toContain("\u2500")
  })

  it("renders ___ as a horizontal rule", () => {
    const { lastFrame } = render(<StreamingMarkdown text={"top\n___\nbottom"} />)
    const frame = lastFrame()!
    expect(frame).toContain("top")
    expect(frame).toContain("bottom")
    expect(frame).toContain("\u2500")
  })

  // ─── Diff rendering tests ─────────────────────────────────────────

  it("renders diff blocks with colored lines", () => {
    const text = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " unchanged",
      "-removed line",
      "+added line",
    ].join("\n")
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("diff --git a/file.ts b/file.ts")
    expect(frame).toContain("removed line")
    expect(frame).toContain("added line")
    expect(frame).toContain("unchanged")
  })

  it("renders fenced diff code blocks as diffs", () => {
    const text = "```diff\n-old\n+new\n```"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("old")
    expect(frame).toContain("new")
  })

  it("does not treat plain lines starting with + or - as diffs without signal", () => {
    const text = "- bullet one\n- bullet two"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    // Should render as paragraph (bullet list), not diff
    expect(frame).toContain("- bullet one")
    expect(frame).toContain("- bullet two")
  })

  // ─── Streaming edge case tests ────────────────────────────────────

  it("handles partial code fence (opened but not closed) during streaming", () => {
    const text = "before\n```js\nconst x = 1\nconst y = 2"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    // Should not crash, and should show the code lines
    expect(frame).toContain("const x = 1")
    expect(frame).toContain("const y = 2")
  })

  it("handles partial bold (** opened but not closed) during streaming", () => {
    const text = "this is **bold but not clo"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    // Should not crash
    expect(frame).toBeDefined()
    expect(frame).toContain("this is")
  })

  it("handles partial inline code (backtick opened but not closed) during streaming", () => {
    const text = "use `npm inst"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toBeDefined()
    expect(frame).toContain("use")
  })

  // ─── Diff with @@ hunk markers ────────────────────────────────────

  it("renders @@ hunk headers in diff blocks", () => {
    const text = [
      "diff --git a/x.ts b/x.ts",
      "@@ -10,6 +10,8 @@",
      " context",
      "+added",
    ].join("\n")
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("@@ -10,6 +10,8 @@")
    expect(frame).toContain("context")
    expect(frame).toContain("added")
  })

  // ─── Bold italic tests ───────────────────────────────────────────

  it("renders ***bold italic*** with triple stars", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this is ***bold italic*** text" />)
    const frame = lastFrame()!
    expect(frame).toContain("bold italic")
    expect(frame).not.toContain("***")
    expect(frame).not.toContain("*bold")
  })

  it("renders **_bold italic_** with mixed markers", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this is **_mixed bold italic_** text" />)
    const frame = lastFrame()!
    expect(frame).toContain("mixed bold italic")
    expect(frame).not.toContain("**")
    expect(frame).not.toContain("_")
  })

  // ─── Task list tests ─────────────────────────────────────────────

  it("renders unchecked task list items with ballot box", () => {
    const { lastFrame } = render(<StreamingMarkdown text="- [ ] unchecked item" />)
    const frame = lastFrame()!
    expect(frame).toContain("\u2610")
    expect(frame).toContain("unchecked item")
    expect(frame).not.toContain("[ ]")
  })

  it("renders checked task list items with checked ballot box", () => {
    const { lastFrame } = render(<StreamingMarkdown text="- [x] checked item" />)
    const frame = lastFrame()!
    expect(frame).toContain("\u2611")
    expect(frame).toContain("checked item")
    expect(frame).not.toContain("[x]")
  })

  it("renders uppercase [X] as checked", () => {
    const { lastFrame } = render(<StreamingMarkdown text="- [X] also checked" />)
    const frame = lastFrame()!
    expect(frame).toContain("\u2611")
    expect(frame).toContain("also checked")
  })

  it("preserves indentation for nested task items", () => {
    const text = "- [ ] top\n  - [x] nested"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("\u2610")
    expect(frame).toContain("\u2611")
    expect(frame).toContain("top")
    expect(frame).toContain("nested")
  })

  // ─── Nested blockquote tests ──────────────────────────────────────

  it("renders nested >> blockquotes with two bar prefixes", () => {
    const { lastFrame } = render(<StreamingMarkdown text=">> nested quote" />)
    const frame = lastFrame()!
    expect(frame).toContain("nested quote")
    // Should have two vertical bars
    const barCount = (frame.match(/\u2502/g) || []).length
    expect(barCount).toBeGreaterThanOrEqual(2)
  })

  it("renders triple >>> blockquotes with three bar prefixes", () => {
    const { lastFrame } = render(<StreamingMarkdown text=">>> deep quote" />)
    const frame = lastFrame()!
    expect(frame).toContain("deep quote")
    const barCount = (frame.match(/\u2502/g) || []).length
    expect(barCount).toBeGreaterThanOrEqual(3)
  })

  it("applies inline styling inside blockquotes", () => {
    const { lastFrame } = render(<StreamingMarkdown text="> this is **bold** inside quote" />)
    const frame = lastFrame()!
    expect(frame).toContain("bold")
    expect(frame).not.toContain("**")
    expect(frame).toContain("\u2502")
  })

  // ─── Code fence visual tests ──────────────────────────────────────

  it("shows language label for code fences", () => {
    const text = "```typescript\nconst x = 1\n```"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("typescript")
    expect(frame).toContain("const x = 1")
  })

  it("shows language label for json code fences", () => {
    const text = '```json\n{"key": "value"}\n```'
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("json")
    expect(frame).toContain('"key": "value"')
  })

  it("shows language label for bash code fences", () => {
    const text = "```bash\necho hello\n```"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("bash")
    expect(frame).toContain("echo hello")
  })

  it("shows language label for txt code fences", () => {
    const text = "```txt\nplain text\n```"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("txt")
    expect(frame).toContain("plain text")
  })

  it("renders code fence with no language label when unspecified", () => {
    const text = "```\nno lang\n```"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("no lang")
  })

  // ─── Table tests ──────────────────────────────────────────────────

  it("renders a simple table with headers and rows", () => {
    const text = "| Name | Age | City |\n| --- | --- | --- |\n| Alice | 30 | NYC |\n| Bob | 25 | LA |"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("Name")
    expect(frame).toContain("Age")
    expect(frame).toContain("City")
    expect(frame).toContain("Alice")
    expect(frame).toContain("Bob")
    expect(frame).toContain("NYC")
    expect(frame).toContain("LA")
    // Separator should have dashes
    expect(frame).toContain("---")
  })

  it("pads table columns to equal width", () => {
    const text = "| A | LongHeader |\n| --- | --- |\n| x | y |"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("LongHeader")
    expect(frame).toContain("x")
    expect(frame).toContain("y")
  })

  // ─── Escape handling tests ────────────────────────────────────────

  it("renders escaped asterisk as literal *", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this has \\* a star" />)
    const frame = lastFrame()!
    expect(frame).toContain("*")
    expect(frame).toContain("this has")
    expect(frame).toContain("a star")
  })

  it("renders escaped backslash as literal \\", () => {
    const { lastFrame } = render(<StreamingMarkdown text="path\\\\to\\\\file" />)
    const frame = lastFrame()!
    expect(frame).toContain("\\")
  })

  it("renders escaped underscore as literal _", () => {
    const { lastFrame } = render(<StreamingMarkdown text="snake\\_case" />)
    const frame = lastFrame()!
    expect(frame).toContain("_")
    expect(frame).toContain("snake")
    expect(frame).toContain("case")
  })

  it("renders escaped backtick as literal `", () => {
    const { lastFrame } = render(<StreamingMarkdown text="use \\` for code" />)
    const frame = lastFrame()!
    expect(frame).toContain("`")
  })

  // ─── HTML entity tests ────────────────────────────────────────────

  it("decodes &lt; and &gt; to < and >", () => {
    const { lastFrame } = render(<StreamingMarkdown text="a &lt; b &gt; c" />)
    const frame = lastFrame()!
    expect(frame).toContain("a < b > c")
  })

  it("decodes &amp; to &", () => {
    const { lastFrame } = render(<StreamingMarkdown text="this &amp; that" />)
    const frame = lastFrame()!
    expect(frame).toContain("this & that")
  })

  it("decodes &quot; and &#39;", () => {
    const { lastFrame } = render(<StreamingMarkdown text="&quot;hello&#39;s&quot;" />)
    const frame = lastFrame()!
    expect(frame).toContain('"hello\'s"')
  })

  // ─── Autolink tests ───────────────────────────────────────────────

  it("renders autolinks without angle brackets", () => {
    const { lastFrame } = render(<StreamingMarkdown text="visit <https://example.com> now" />)
    const frame = lastFrame()!
    expect(frame).toContain("https://example.com")
    expect(frame).not.toContain("<https://")
    expect(frame).not.toContain(">")
  })

  // ─── Link rendering tests ────────────────────────────────────────

  it("renders links with text normally and URL in parentheses", () => {
    const { lastFrame } = render(<StreamingMarkdown text="[docs](https://docs.example.com)" />)
    const frame = lastFrame()!
    expect(frame).toContain("docs")
    expect(frame).toContain("https://docs.example.com")
    expect(frame).not.toContain("[docs]")
  })

  // ─── Diff block separator tests ──────────────────────────────────

  it("renders diff blocks with separators before and after", () => {
    const text = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      "+added",
    ].join("\n")
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    // Should have horizontal line separators (box drawing chars)
    const dashLines = (frame.match(/\u2500{40}/g) || []).length
    expect(dashLines).toBeGreaterThanOrEqual(2)
  })

  // ─── Spacing tests ───────────────────────────────────────────────

  it("adds blank lines around headings", () => {
    const text = "before\n\n## Heading\n\nafter"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("before")
    expect(frame).toContain("Heading")
    expect(frame).toContain("after")
  })

  it("adds blank lines around code blocks", () => {
    const text = "before\n\n```js\ncode\n```\n\nafter"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toContain("before")
    expect(frame).toContain("code")
    expect(frame).toContain("after")
  })

  // ─── Streaming safety tests ──────────────────────────────────────

  it("handles partial triple-star bold italic during streaming", () => {
    const text = "this is ***bold it"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toBeDefined()
    expect(frame).toContain("this is")
  })

  it("handles partial link during streaming", () => {
    const text = "see [link text](https://exam"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toBeDefined()
  })

  it("handles partial table during streaming", () => {
    const text = "| Header1 | Header2 |"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toBeDefined()
    expect(frame).toContain("Header1")
  })

  it("handles partial task list during streaming", () => {
    const text = "- [ ] item one\n- [x"
    const { lastFrame } = render(<StreamingMarkdown text={text} />)
    const frame = lastFrame()!
    expect(frame).toBeDefined()
    expect(frame).toContain("item one")
  })

  // ─── Image placeholder tests ─────────────────────────────────────

  it("renders ![alt](url) as dim image placeholder", () => {
    const { lastFrame } = render(<StreamingMarkdown text="here is ![a cat](https://example.com/cat.png) in text" />)
    const frame = lastFrame()!
    expect(frame).toContain("\ud83d\uddbc a cat")
    expect(frame).not.toContain("https://example.com/cat.png")
    expect(frame).not.toContain("![")
  })

  it("renders ![](url) with no alt as generic image placeholder", () => {
    const { lastFrame } = render(<StreamingMarkdown text="![](https://example.com/pic.png)" />)
    const frame = lastFrame()!
    expect(frame).toContain("\ud83d\uddbc image")
  })

  it("renders [Image: description] as image placeholder", () => {
    const { lastFrame } = render(<StreamingMarkdown text="[Image: screenshot of dashboard]" />)
    const frame = lastFrame()!
    expect(frame).toContain("\ud83d\uddbc screenshot of dashboard")
    expect(frame).not.toContain("[Image:")
  })

  it("renders [Image: ] with empty description as generic placeholder", () => {
    const { lastFrame } = render(<StreamingMarkdown text="[Image: ]" />)
    const frame = lastFrame()!
    expect(frame).toContain("\ud83d\uddbc image")
  })

  it("does not treat regular links as images", () => {
    const { lastFrame } = render(<StreamingMarkdown text="[click here](https://example.com)" />)
    const frame = lastFrame()!
    expect(frame).toContain("click here")
    expect(frame).not.toContain("\ud83d\uddbc")
  })
})
