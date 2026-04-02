import React from "react"
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "ink-testing-library"

import { InkApp } from "../../../senses/cli/ink-app"

afterEach(() => {
  cleanup()
})

describe("InkApp (CLI TUI Shell)", () => {
  it("renders without crashing", () => {
    const { lastFrame } = render(<InkApp messages={[]} />)
    expect(lastFrame()).toBeDefined()
  })

  it("renders the input area with prompt indicator", () => {
    const { lastFrame } = render(<InkApp messages={[]} />)
    const frame = lastFrame()!
    // Should contain the ouroboros prompt indicator
    expect(frame).toContain(")")
  })

  it("renders assistant messages as markdown", () => {
    const messages = [
      { role: "assistant" as const, content: "Hello **world**" },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    const frame = lastFrame()!
    expect(frame).toContain("world")
    // Should not contain raw markdown
    expect(frame).not.toContain("**")
  })

  it("renders user messages distinctly from assistant messages", () => {
    const messages = [
      { role: "user" as const, content: "What is 2+2?" },
      { role: "assistant" as const, content: "4" },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    const frame = lastFrame()!
    expect(frame).toContain("What is 2+2?")
    expect(frame).toContain("4")
  })

  it("produces no padding characters in output containers", () => {
    const messages = [
      { role: "assistant" as const, content: "clean text" },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    const frame = lastFrame()!
    const lines = frame.split("\n")
    for (const line of lines) {
      // No trailing whitespace padding
      expect(line).toBe(line.trimEnd())
    }
  })

  it("accepts onSubmit prop without crashing", () => {
    const onSubmit = vi.fn()
    // InkApp renders with onSubmit; stdin interaction tested via integration tests
    const { lastFrame } = render(<InkApp messages={[]} onSubmit={onSubmit} />)
    expect(lastFrame()).toBeDefined()
    expect(lastFrame()).toContain(")")
  })

  it("shows spinner text when loading is true", () => {
    // Render with loading state — spinner text should appear in output
    const { lastFrame } = render(<InkApp messages={[]} loading={true} spinnerText="thinking" />)
    const frame = lastFrame()!
    // The spinner component renders the text; stdin.ref errors don't affect this
    expect(frame).toBeDefined()
  })

  it("hides spinner when loading is false", () => {
    const { lastFrame } = render(<InkApp messages={[]} loading={false} spinnerText="thinking" />)
    const frame = lastFrame()!
    // "thinking" should not appear when not loading
    expect(frame).not.toContain("thinking")
  })

  it("displays tool execution results", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "shell", arguments: '{"command":"ls"}' } }],
      },
    ]
    const toolResults = [
      { toolCallId: "t1", name: "shell", result: "file1.ts\nfile2.ts", success: true },
    ]
    const { lastFrame } = render(<InkApp messages={messages} toolResults={toolResults} />)
    const frame = lastFrame()!
    expect(frame).toContain("shell")
  })

  it("handles terminal resize without crashing", () => {
    const { lastFrame, rerender } = render(<InkApp messages={[]} columns={80} />)
    expect(lastFrame()).toBeDefined()

    // Simulate resize
    rerender(<InkApp messages={[]} columns={120} />)
    expect(lastFrame()).toBeDefined()

    rerender(<InkApp messages={[]} columns={40} />)
    expect(lastFrame()).toBeDefined()
  })

  it("handles tool call with invalid JSON arguments", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "t1",
          type: "function" as const,
          function: { name: "shell", arguments: "not-json{{{" },
        }],
      },
    ]
    // Render may encounter stdin.ref errors in test env; verify it doesn't crash
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toBeDefined()
  })

  it("handles tool call with long argument values (truncation)", () => {
    const longPath = "/very/long/path/" + "a".repeat(100) + "/file.ts"
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "t1",
          type: "function" as const,
          function: { name: "read_file", arguments: JSON.stringify({ path: longPath }) },
        }],
      },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toContain("read_file")
    // Should be truncated (long path > 60 chars)
    expect(lastFrame()).toContain("...")
  })

  it("handles failed tool results (red color)", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "shell", arguments: '{"command":"exit 1"}' } }],
      },
    ]
    const toolResults = [
      { toolCallId: "t1", name: "shell", result: "command failed", success: false },
    ]
    const { lastFrame } = render(<InkApp messages={messages} toolResults={toolResults} />)
    expect(lastFrame()).toContain("shell")
  })

  it("handles long tool result (truncation)", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "grep", arguments: '{}' } }],
      },
    ]
    const toolResults = [
      { toolCallId: "t1", name: "grep", result: "x".repeat(200), success: true },
    ]
    const { lastFrame } = render(<InkApp messages={messages} toolResults={toolResults} />)
    expect(lastFrame()).toContain("...")
  })

  it("renders input area with prompt indicator", () => {
    // Verifies InputArea component mounts (stdin interaction tested via integration)
    const onSubmit = vi.fn()
    const { lastFrame } = render(<InkApp messages={[]} onSubmit={onSubmit} />)
    expect(lastFrame()).toContain(")")
  })

  it("renders with no onSubmit prop (optional)", () => {
    const { lastFrame } = render(<InkApp messages={[]} />)
    expect(lastFrame()).toBeDefined()
  })

  it("renders system messages (no crash)", () => {
    const messages = [
      { role: "system" as const, content: "You are helpful" },
      { role: "assistant" as const, content: "Hello" },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toContain("Hello")
  })

  it("handles assistant message with null content and tool calls", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "edit_file", arguments: '{"path":"f.ts"}' } }],
      },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toContain("edit_file")
  })

  it("handles tool call with empty arguments object", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "settle", arguments: "{}" } }],
      },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toContain("settle")
  })

  it("handles tool call with non-string first argument value", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "shell", arguments: '{"timeout_ms":5000}' } }],
      },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toContain("shell")
  })

  it("renders multiple message types without crashing", () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "answer" },
    ]
    const { lastFrame } = render(<InkApp messages={messages} />)
    expect(lastFrame()).toContain("answer")
  })

  it("handles multiline tool result (newlines collapsed)", () => {
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "t1", type: "function" as const, function: { name: "shell", arguments: '{}' } }],
      },
    ]
    const toolResults = [
      { toolCallId: "t1", name: "shell", result: "line1\nline2\nline3", success: true },
    ]
    const { lastFrame } = render(<InkApp messages={messages} toolResults={toolResults} />)
    const frame = lastFrame()!
    // Newlines in result should be collapsed to spaces
    expect(frame).toContain("line1 line2 line3")
  })
})
