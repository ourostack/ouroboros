import React, { useMemo } from "react"
import { Text, Box } from "ink"
import { StreamingMarkdown } from "./streaming-markdown"
import type { DisplayMessage } from "./ink-app"

/**
 * Scrollable message list with virtual rendering.
 *
 * Only renders messages within the viewport window. Supports:
 * - Auto-scroll to bottom (pinned mode, default)
 * - Scroll lock at a specific offset
 * - "N below" indicator when scrolled up
 *
 * Ouroboros-themed: green serpent palette, no padding decoration.
 */

// Ouroboros brand palette
const OURO_TEAL = "#4ec9b0"
const OURO_INDICATOR = "#2ecc40"

interface ScrollableMessageListProps {
  /** All messages to display */
  readonly messages: readonly DisplayMessage[]
  /** Number of visible message slots */
  readonly viewportHeight: number
  /** Fixed scroll position (undefined = auto-scroll to bottom) */
  readonly scrollOffset?: number
}

function MessageItem({ message }: { readonly message: DisplayMessage }): React.ReactElement {
  if (message.role === "user" && message.content) {
    return (
      <Box>
        <Text color={OURO_TEAL} bold>{") "}</Text>
        <Text>{message.content}</Text>
      </Box>
    )
  }
  if (message.role === "assistant" && message.content) {
    return <StreamingMarkdown text={message.content} />
  }
  // system or empty messages render nothing visible
  return <Text>{""}</Text>
}

export function ScrollableMessageList({
  messages,
  viewportHeight,
  scrollOffset,
}: ScrollableMessageListProps): React.ReactElement {
  const { visibleMessages, belowCount } = useMemo(() => {
    if (messages.length === 0) {
      return { visibleMessages: [] as readonly DisplayMessage[], belowCount: 0 }
    }

    let start: number
    if (scrollOffset !== undefined) {
      start = Math.max(0, Math.min(scrollOffset, messages.length - 1))
    } else {
      // Auto-scroll: pin to bottom
      start = Math.max(0, messages.length - viewportHeight)
    }

    const end = Math.min(start + viewportHeight, messages.length)
    return {
      visibleMessages: messages.slice(start, end),
      belowCount: messages.length - end,
    }
  }, [messages, viewportHeight, scrollOffset])

  return (
    <Box flexDirection="column">
      {visibleMessages.map((msg, i) => (
        <MessageItem key={i} message={msg} />
      ))}
      {belowCount > 0 ? (
        <Text color={OURO_INDICATOR} dimColor>{`${belowCount} below`}</Text>
      ) : null}
    </Box>
  )
}
