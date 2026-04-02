import React from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

// Will be implemented in src/senses/cli/inline-diff.tsx
import { InlineDiff } from "../../../senses/cli/inline-diff"

afterEach(() => {
  cleanup()
})

describe("InlineDiff (Ink)", () => {
  it("renders added lines with + prefix", () => {
    const before = "line one\nline two"
    const after = "line one\nline added\nline two"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="test.ts" />)
    const frame = lastFrame()!
    expect(frame).toContain("+")
    expect(frame).toContain("line added")
  })

  it("renders removed lines with - prefix", () => {
    const before = "line one\nline two\nline three"
    const after = "line one\nline three"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="test.ts" />)
    const frame = lastFrame()!
    expect(frame).toContain("-")
    expect(frame).toContain("line two")
  })

  it("renders unchanged lines as context", () => {
    const before = "line one\nline two\nline three"
    const after = "line one\nline changed\nline three"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="test.ts" />)
    const frame = lastFrame()!
    // Context lines should appear without +/- prefix
    expect(frame).toContain("line one")
    expect(frame).toContain("line three")
  })

  it("includes line numbers", () => {
    const before = "alpha\nbeta"
    const after = "alpha\ngamma"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="test.ts" />)
    const frame = lastFrame()!
    // Should have some line number indicator
    expect(frame).toMatch(/\d/)
  })

  it("shows file path header", () => {
    const { lastFrame } = render(
      <InlineDiff before="old" after="new" filePath="src/example.ts" />,
    )
    expect(lastFrame()).toContain("src/example.ts")
  })

  it("produces clean copy-paste output (no padding spaces)", () => {
    const before = "first\nsecond"
    const after = "first\nreplaced"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="f.ts" />)
    const frame = lastFrame()!
    const lines = frame.split("\n")
    for (const line of lines) {
      // Lines should not have trailing padding whitespace
      // (leading whitespace for line numbers and +/- markers is fine)
      expect(line).toBe(line.trimEnd())
    }
  })

  it("handles empty before (new file)", () => {
    const { lastFrame } = render(<InlineDiff before="" after="new content" filePath="new.ts" />)
    const frame = lastFrame()!
    expect(frame).toContain("+")
    expect(frame).toContain("new content")
  })

  it("handles empty after (deleted file)", () => {
    const { lastFrame } = render(<InlineDiff before="old content" after="" filePath="del.ts" />)
    const frame = lastFrame()!
    expect(frame).toContain("-")
    expect(frame).toContain("old content")
  })

  it("handles identical content (no diff)", () => {
    const { lastFrame } = render(<InlineDiff before="same" after="same" filePath="noop.ts" />)
    const frame = lastFrame()!
    // Should indicate no changes or just show context
    expect(frame).toContain("same")
  })

  it("handles multi-line additions at end", () => {
    const before = "line one"
    const after = "line one\nline two\nline three"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="test.ts" />)
    const frame = lastFrame()!
    expect(frame).toContain("line two")
    expect(frame).toContain("line three")
  })

  it("handles multi-line removals at end", () => {
    const before = "line one\nline two\nline three"
    const after = "line one"
    const { lastFrame } = render(<InlineDiff before={before} after={after} filePath="test.ts" />)
    const frame = lastFrame()!
    expect(frame).toContain("line two")
    expect(frame).toContain("line three")
  })

  it("handles both empty before and after", () => {
    const { lastFrame } = render(<InlineDiff before="" after="" filePath="empty.ts" />)
    const frame = lastFrame()!
    // Should show file header at minimum
    expect(frame).toContain("empty.ts")
  })
})
