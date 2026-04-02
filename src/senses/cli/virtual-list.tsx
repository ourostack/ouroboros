import React, { useMemo } from "react"
import { Text, Box } from "ink"

/**
 * Virtual scrolling list for the CLI TUI.
 *
 * Only renders items within the viewport window, enabling smooth performance
 * with hundreds of messages. Supports:
 * - Auto-scroll to bottom (pinned) when scrollOffset is undefined
 * - Scroll lock at a specific offset
 * - Custom item rendering
 *
 * Copy-paste integrity: no padding characters. Items render as plain text.
 */

interface VirtualListProps<T> {
  /** All items in the list */
  readonly items: readonly T[]
  /** Number of visible rows in the viewport */
  readonly viewportHeight: number
  /** Fixed scroll position (undefined = auto-scroll to bottom) */
  readonly scrollOffset?: number
  /** Render function for each item */
  readonly renderItem: (item: T, index: number) => React.ReactNode
}

export function VirtualList<T>({
  items,
  viewportHeight,
  scrollOffset,
  renderItem,
}: VirtualListProps<T>): React.ReactElement {
  const { startIndex, visibleItems } = useMemo(() => {
    if (items.length === 0) {
      return { startIndex: 0, visibleItems: [] as readonly T[] }
    }

    // Determine the start index for the visible window
    let start: number
    if (scrollOffset !== undefined) {
      // Scroll-locked: show items starting at the given offset
      start = Math.max(0, Math.min(scrollOffset, items.length - 1))
    } else {
      // Auto-scroll: pin to bottom, show last viewportHeight items
      start = Math.max(0, items.length - viewportHeight)
    }

    const end = Math.min(start + viewportHeight, items.length)
    return {
      startIndex: start,
      visibleItems: items.slice(start, end),
    }
  }, [items, viewportHeight, scrollOffset])

  if (visibleItems.length === 0) {
    return <Box><Text>{""}</Text></Box>
  }

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, i) => {
        const globalIndex = startIndex + i
        return (
          <Box key={globalIndex}>
            <Text>{renderItem(item, globalIndex)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}
