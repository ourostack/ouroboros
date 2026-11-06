import { expect } from "vitest"
import { EVENT_CONTENT_MAX_CHARS, truncateLargeEventContent } from "../../heart/session-events"

export function makeOversizedAgentContent(prefix = "agent-authored content "): string {
  return `${prefix}${"x".repeat(EVENT_CONTENT_MAX_CHARS + 1)}`
}

export function expectedCappedContent(content: string): string {
  return truncateLargeEventContent(content, EVENT_CONTENT_MAX_CHARS).content as string
}

export function expectedTruncationMarker(content: string): string {
  return `[truncated \u2014 event content exceeded ${EVENT_CONTENT_MAX_CHARS} chars; original length ${content.length} chars]`
}

export function expectCappedAgentContent(actual: string, original: string): void {
  const expected = expectedCappedContent(original)
  expect(actual.length).toBeLessThanOrEqual(EVENT_CONTENT_MAX_CHARS)
  expect(actual).toContain(expectedTruncationMarker(original))
  expect(actual).not.toBe(original)
  expect(actual).toBe(expected)
}
