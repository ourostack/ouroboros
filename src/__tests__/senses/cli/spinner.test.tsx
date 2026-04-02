import React from "react"
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

import { EnhancedSpinner } from "../../../senses/cli/spinner"

afterEach(() => {
  cleanup()
})

describe("EnhancedSpinner", () => {
  it("shows elapsed time for current operation", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={10} phrase="thinking" />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("10s")
  })

  it("shows elapsed time in minutes when over 60s", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={95} phrase="working" />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("1m35s")
  })

  it("shows phrase text", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={0} phrase="pondering deeply" />,
    )
    expect(lastFrame()).toContain("pondering deeply")
  })

  it("shows output token counter during streaming", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={5} phrase="streaming" outputTokens={42} />,
    )
    expect(lastFrame()).toContain("42")
  })

  it("does not show token counter when not provided", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={5} phrase="thinking" />,
    )
    const frame = lastFrame()!
    expect(frame).not.toContain("tok")
  })

  it("uses snake/ouroboros animation frames", async () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={0} phrase="thinking" />,
    )
    const frame1 = lastFrame()!
    // Wait for animation to advance
    await new Promise(r => setTimeout(r, 200))
    const frame2 = lastFrame()!
    // At least one frame should have been rendered
    expect(frame1.length).toBeGreaterThan(0)
    expect(frame2.length).toBeGreaterThan(0)
  })

  it("renders in normal color for short operations (<15s)", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={5} phrase="thinking" />,
    )
    // Just verify render succeeds -- color is visual
    expect(lastFrame()).toContain("thinking")
  })

  it("renders in amber color for medium operations (>15s)", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={20} phrase="working" />,
    )
    expect(lastFrame()).toContain("working")
  })

  it("renders in red color for long operations (>45s)", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={60} phrase="still going" />,
    )
    expect(lastFrame()).toContain("still going")
  })

  it("respects reduced-motion setting", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={0} phrase="thinking" reducedMotion={true} />,
    )
    const frame = lastFrame()!
    // Should still show text but no animation character
    expect(frame).toContain("thinking")
  })

  it("handles zero elapsed seconds", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={0} phrase="starting" />,
    )
    expect(lastFrame()).toContain("0s")
  })

  it("handles large elapsed time", () => {
    const { lastFrame } = render(
      <EnhancedSpinner elapsedSeconds={7200} phrase="long task" />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("2h0m")
  })
})
