import React from "react"
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "ink-testing-library"

// Will be implemented in src/senses/cli/virtual-list.tsx
import { VirtualList } from "../../../senses/cli/virtual-list"

afterEach(() => {
  cleanup()
})

describe("VirtualList (Ink)", () => {
  it("renders a subset of items when count exceeds viewport", () => {
    const items = Array.from({ length: 200 }, (_, i) => `item-${i}`)
    const { lastFrame } = render(
      <VirtualList
        items={items}
        viewportHeight={10}
        renderItem={(item: string) => item}
      />,
    )
    const frame = lastFrame()!
    // Should not render all 200 items -- only visible window
    const visibleItems = items.filter(item => frame.includes(item))
    expect(visibleItems.length).toBeLessThan(200)
    expect(visibleItems.length).toBeGreaterThan(0)
  })

  it("auto-scrolls to bottom when pinned (new items appear)", () => {
    const items = Array.from({ length: 20 }, (_, i) => `msg-${i}`)
    const { lastFrame, rerender } = render(
      <VirtualList
        items={items}
        viewportHeight={5}
        renderItem={(item: string) => item}
      />,
    )
    // Should see last items
    expect(lastFrame()).toContain("msg-19")

    // Add more items
    const moreItems = [...items, "msg-20", "msg-21"]
    rerender(
      <VirtualList
        items={moreItems}
        viewportHeight={5}
        renderItem={(item: string) => item}
      />,
    )
    // Should auto-scroll to show newest
    expect(lastFrame()).toContain("msg-21")
  })

  it("supports scroll lock via scrollOffset prop", () => {
    const items = Array.from({ length: 50 }, (_, i) => `line-${i}`)
    const { lastFrame } = render(
      <VirtualList
        items={items}
        viewportHeight={5}
        scrollOffset={0}
        renderItem={(item: string) => item}
      />,
    )
    // When scrollOffset is 0, should show items from the top
    expect(lastFrame()).toContain("line-0")
    expect(lastFrame()).not.toContain("line-49")
  })

  it("renders custom item content via renderItem", () => {
    const items = ["alpha", "beta", "gamma"]
    const { lastFrame } = render(
      <VirtualList
        items={items}
        viewportHeight={10}
        renderItem={(item: string) => `>> ${item} <<`}
      />,
    )
    expect(lastFrame()).toContain(">> alpha <<")
    expect(lastFrame()).toContain(">> beta <<")
  })

  it("handles empty items array", () => {
    const { lastFrame } = render(
      <VirtualList
        items={[]}
        viewportHeight={10}
        renderItem={(item: string) => item}
      />,
    )
    const frame = lastFrame()
    expect(frame).toBeDefined()
  })

  it("handles items with variable heights (multi-line)", () => {
    const items = ["short", "this is\na multi-line\nitem", "another"]
    const { lastFrame } = render(
      <VirtualList
        items={items}
        viewportHeight={10}
        renderItem={(item: string) => item}
      />,
    )
    expect(lastFrame()).toContain("short")
    expect(lastFrame()).toContain("multi-line")
    expect(lastFrame()).toContain("another")
  })

  it("performs well with 200+ items (no crash)", () => {
    const items = Array.from({ length: 500 }, (_, i) => `stress-${i}`)
    const start = Date.now()
    const { lastFrame } = render(
      <VirtualList
        items={items}
        viewportHeight={20}
        renderItem={(item: string) => item}
      />,
    )
    const elapsed = Date.now() - start
    // Render should complete in under 500ms
    expect(elapsed).toBeLessThan(500)
    expect(lastFrame()).toBeDefined()
    // Should show some of the latest items (auto-scroll)
    expect(lastFrame()).toContain("stress-499")
  })
})
