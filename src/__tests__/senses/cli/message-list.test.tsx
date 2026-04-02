import React from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

import { ScrollableMessageList } from "../../../senses/cli/message-list"
import type { DisplayMessage } from "../../../senses/cli/ink-app"

afterEach(() => {
  cleanup()
})

describe("ScrollableMessageList", () => {
  it("auto-scrolls to bottom when pinned (new messages appear)", () => {
    const messages: DisplayMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: "assistant" as const,
      content: `msg-${i}`,
    }))
    const { lastFrame, rerender } = render(
      <ScrollableMessageList messages={messages} viewportHeight={5} />,
    )
    // Should show latest messages
    expect(lastFrame()).toContain("msg-19")

    // Add more
    const more = [...messages, { role: "assistant" as const, content: "msg-20" }]
    rerender(<ScrollableMessageList messages={more} viewportHeight={5} />)
    expect(lastFrame()).toContain("msg-20")
  })

  it("shows messages from top when scrollOffset is 0", () => {
    const messages: DisplayMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: "assistant" as const,
      content: `item-${i}`,
    }))
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={5} scrollOffset={0} />,
    )
    expect(lastFrame()).toContain("item-0")
    expect(lastFrame()).not.toContain("item-29")
  })

  it("shows 'N new messages' indicator when scrolled up", () => {
    const messages: DisplayMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: "assistant" as const,
      content: `line-${i}`,
    }))
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={5} scrollOffset={0} />,
    )
    const frame = lastFrame()!
    // When scrolled up and there are messages below, show indicator
    expect(frame).toMatch(/\d+ below/)
  })

  it("does not show indicator when at bottom", () => {
    const messages: DisplayMessage[] = Array.from({ length: 5 }, (_, i) => ({
      role: "assistant" as const,
      content: `line-${i}`,
    }))
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={10} />,
    )
    const frame = lastFrame()!
    expect(frame).not.toContain("below")
  })

  it("renders smoothly with 200+ messages (no crash)", () => {
    const messages: DisplayMessage[] = Array.from({ length: 250 }, (_, i) => ({
      role: "assistant" as const,
      content: `stress-${i}`,
    }))
    const start = Date.now()
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={20} />,
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
    expect(lastFrame()).toContain("stress-249")
  })

  it("renders user and assistant messages with different styling", () => {
    const messages: DisplayMessage[] = [
      { role: "user", content: "question?" },
      { role: "assistant", content: "answer!" },
    ]
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={10} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("question?")
    expect(frame).toContain("answer!")
  })

  it("handles empty message list", () => {
    const { lastFrame } = render(
      <ScrollableMessageList messages={[]} viewportHeight={10} />,
    )
    expect(lastFrame()).toBeDefined()
  })

  it("handles system messages (render as empty)", () => {
    const messages: DisplayMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "assistant", content: "Hello!" },
    ]
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={10} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("Hello!")
    // System message content should not appear in output
    expect(frame).not.toContain("You are helpful")
  })

  it("handles assistant message with null content", () => {
    const messages: DisplayMessage[] = [
      { role: "assistant", content: null },
      { role: "assistant", content: "visible" },
    ]
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={10} />,
    )
    expect(lastFrame()).toContain("visible")
  })

  it("handles messages with variable heights", () => {
    const messages: DisplayMessage[] = [
      { role: "assistant", content: "short" },
      { role: "assistant", content: "this is a\nmulti-line\nmessage" },
      { role: "assistant", content: "another" },
    ]
    const { lastFrame } = render(
      <ScrollableMessageList messages={messages} viewportHeight={20} />,
    )
    const frame = lastFrame()!
    expect(frame).toContain("short")
    expect(frame).toContain("multi-line")
    expect(frame).toContain("another")
  })
})
