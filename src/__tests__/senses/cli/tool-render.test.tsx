import React from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

import {
  ToolBadge,
  ToolParams,
  ToolProgress,
  ToolResultCard,
  ToolExecutionBlock,
} from "../../../senses/cli/tool-render"

afterEach(() => {
  cleanup()
})

describe("ToolBadge", () => {
  it("renders tool name with color", () => {
    const { lastFrame } = render(<ToolBadge name="shell" />)
    expect(lastFrame()).toContain("shell")
  })

  it("renders different tool names", () => {
    const { lastFrame } = render(<ToolBadge name="edit_file" />)
    expect(lastFrame()).toContain("edit_file")
  })
})

describe("ToolParams", () => {
  it("shows file path for edit_file", () => {
    const { lastFrame } = render(
      <ToolParams name="edit_file" args={{ path: "/src/index.ts", old_string: "x", new_string: "y" }} />,
    )
    expect(lastFrame()).toContain("/src/index.ts")
  })

  it("shows command for shell", () => {
    const { lastFrame } = render(
      <ToolParams name="shell" args={{ command: "npm test" }} />,
    )
    expect(lastFrame()).toContain("npm test")
  })

  it("shows first string arg as fallback", () => {
    const { lastFrame } = render(
      <ToolParams name="unknown_tool" args={{ query: "search term" }} />,
    )
    expect(lastFrame()).toContain("search term")
  })

  it("handles empty args", () => {
    const { lastFrame } = render(<ToolParams name="settle" args={{}} />)
    expect(lastFrame()).toBeDefined()
  })

  it("handles args with only non-string values", () => {
    const { lastFrame } = render(
      <ToolParams name="unknown" args={{ count: 42, flag: true }} />,
    )
    // Should render without crash -- no string value to display
    expect(lastFrame()).toBeDefined()
  })

  it("truncates long values", () => {
    const longPath = "/very/long/path/" + "a".repeat(200) + ".ts"
    const { lastFrame } = render(
      <ToolParams name="read_file" args={{ path: longPath }} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("...")
    // Should be truncated, not the full 200+ char path
    expect(frame.length).toBeLessThan(250)
  })
})

describe("ToolProgress", () => {
  it("shows indicator while tool runs", () => {
    const { lastFrame } = render(<ToolProgress name="shell" />)
    const frame = lastFrame()!
    // Should show some progress indicator
    expect(frame.length).toBeGreaterThan(0)
  })
})

describe("ToolResultCard", () => {
  it("shows one-line summary by default", () => {
    const { lastFrame } = render(
      <ToolResultCard name="shell" result="line1\nline2\nline3" success={true} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("shell")
  })

  it("shows success indicator for successful result", () => {
    const { lastFrame } = render(
      <ToolResultCard name="grep" result="found 3 matches" success={true} />,
    )
    expect(lastFrame()).toContain("\u2713")
  })

  it("shows failure indicator for failed result", () => {
    const { lastFrame } = render(
      <ToolResultCard name="shell" result="command not found" success={false} />,
    )
    expect(lastFrame()).toContain("\u2717")
  })

  it("preserves ANSI from shell output", () => {
    const result = "normal \x1b[31mred text\x1b[0m normal"
    const { lastFrame } = render(
      <ToolResultCard name="shell" result={result} success={true} expanded={true} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("red text")
  })

  it("shows expanded content when expanded is true", () => {
    const result = "line1\nline2\nline3"
    const { lastFrame } = render(
      <ToolResultCard name="shell" result={result} success={true} expanded={true} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("line1")
    expect(frame).toContain("line2")
    expect(frame).toContain("line3")
  })

  it("truncates summary in collapsed mode", () => {
    const result = "x".repeat(200)
    const { lastFrame } = render(
      <ToolResultCard name="shell" result={result} success={true} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("...")
  })
})

describe("ToolExecutionBlock", () => {
  it("renders inline diff for edit_file with before/after", () => {
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="edit_file"
        args={{ path: "src/test.ts" }}
        result="ok"
        success={true}
        fileBefore="old line"
        fileAfter="new line"
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("edit_file")
    expect(frame).toContain("src/test.ts")
    // Should contain diff markers
    expect(frame).toContain("+")
    expect(frame).toContain("-")
  })

  it("shows summary for files > 50KB (no inline diff)", () => {
    const bigBefore = "x".repeat(60000)
    const bigAfter = "y".repeat(60000)
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="edit_file"
        args={{ path: "big.ts" }}
        result="ok"
        success={true}
        fileBefore={bigBefore}
        fileAfter={bigAfter}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("edit_file")
    // Should NOT render full diff (too large)
    expect(frame).not.toContain("xxxxxx")
    // Should show some kind of summary
    expect(frame).toMatch(/large|changed|overwritten/i)
  })

  it("renders diff with +/- markers and line numbers", () => {
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="edit_file"
        args={{ path: "f.ts" }}
        result="ok"
        success={true}
        fileBefore="alpha\nbeta"
        fileAfter="alpha\ngamma"
      />,
    )
    const frame = lastFrame()!
    // Should have diff with line numbers and semantic markers
    expect(frame).toMatch(/\d/)
    expect(frame).toContain("-")
    expect(frame).toContain("+")
  })

  it("renders shell output without diff", () => {
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="shell"
        args={{ command: "ls" }}
        result="file1.ts\nfile2.ts"
        success={true}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("shell")
    expect(frame).toContain("ls")
  })

  it("has no padding characters in diff rendering", () => {
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="edit_file"
        args={{ path: "f.ts" }}
        result="ok"
        success={true}
        fileBefore="first\nsecond"
        fileAfter="first\nreplaced"
      />,
    )
    const frame = lastFrame()!
    const lines = frame.split("\n")
    for (const line of lines) {
      expect(line).toBe(line.trimEnd())
    }
  })

  it("renders without before/after (no diff available)", () => {
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="edit_file"
        args={{ path: "f.ts" }}
        result="ok"
        success={true}
      />,
    )
    expect(lastFrame()).toContain("edit_file")
  })

  it("uses 'unknown' as filePath when args.path is not a string", () => {
    const { lastFrame } = render(
      <ToolExecutionBlock
        name="edit_file"
        args={{}}
        result="ok"
        success={true}
        fileBefore="old"
        fileAfter="new"
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("unknown")
  })
})
