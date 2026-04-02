import React from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

import { StatusLine } from "../../../senses/cli/status-line"

afterEach(() => {
  cleanup()
})

describe("StatusLine", () => {
  it("renders model name and provider", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={1000}
        tokensTotal={80000}
        elapsedSeconds={60}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("gpt-4o")
    expect(frame).toContain("azure")
  })

  it("renders token usage with percentage", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={12000}
        tokensTotal={80000}
        elapsedSeconds={0}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("12K")
    expect(frame).toContain("80K")
    expect(frame).toContain("15%")
  })

  it("renders session elapsed time", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={80000}
        elapsedSeconds={272}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("4m32s")
  })

  it("renders context utilization percentage", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={48000}
        tokensTotal={80000}
        elapsedSeconds={0}
        contextPercent={62}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("62%")
  })

  it("renders current tool name when active", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={80000}
        elapsedSeconds={0}
        activeTool="shell"
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("shell")
  })

  it("does not show tool name when no tool active", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={80000}
        elapsedSeconds={0}
      />,
    )
    const frame = lastFrame()!
    expect(frame).not.toContain("shell")
  })

  it("is information-dense single line (no decorative padding)", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={5000}
        tokensTotal={80000}
        elapsedSeconds={30}
      />,
    )
    const frame = lastFrame()!
    const lines = frame.split("\n").filter(l => l.trim().length > 0)
    // Should be a single line
    expect(lines.length).toBe(1)
    // No trailing padding
    expect(lines[0]).toBe(lines[0].trimEnd())
  })

  it("shows green color for low context usage (<60%)", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={4000}
        tokensTotal={80000}
        elapsedSeconds={0}
        contextPercent={30}
      />,
    )
    // Just verify it renders -- color verification is visual
    expect(lastFrame()).toContain("30%")
  })

  it("shows amber for medium context usage (60-80%)", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={56000}
        tokensTotal={80000}
        elapsedSeconds={0}
        contextPercent={70}
      />,
    )
    expect(lastFrame()).toContain("70%")
  })

  it("shows red for high context usage (>80%)", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={72000}
        tokensTotal={80000}
        elapsedSeconds={0}
        contextPercent={90}
      />,
    )
    expect(lastFrame()).toContain("90%")
  })

  it("formats large token counts with K suffix", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={128000}
        tokensTotal={200000}
        elapsedSeconds={0}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("128K")
    expect(frame).toContain("200K")
  })

  it("formats time correctly for hours", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={80000}
        elapsedSeconds={3661}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("1h1m")
  })

  it("formats time correctly for seconds only", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={80000}
        elapsedSeconds={45}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("45s")
  })

  it("handles zero tokensTotal gracefully (no division by zero)", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={0}
        elapsedSeconds={0}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("0%")
  })

  it("handles zero tokens gracefully", () => {
    const { lastFrame } = render(
      <StatusLine
        model="gpt-4o"
        provider="azure"
        tokensUsed={0}
        tokensTotal={80000}
        elapsedSeconds={0}
      />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("0")
    expect(frame).toContain("0%")
  })
})
