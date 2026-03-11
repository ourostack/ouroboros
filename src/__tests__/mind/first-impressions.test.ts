import { describe, it, expect } from "vitest"
import { ONBOARDING_TOKEN_THRESHOLD, isOnboarding, getFirstImpressions } from "../../mind/first-impressions"

describe("first-impressions", () => {
  describe("ONBOARDING_TOKEN_THRESHOLD", () => {
    it("is exported and equals 100_000", () => {
      expect(ONBOARDING_TOKEN_THRESHOLD).toBe(100_000)
    })
  })

  describe("isOnboarding", () => {
    it("returns true for totalTokens: 0", () => {
      expect(isOnboarding({ totalTokens: 0 })).toBe(true)
    })

    it("returns true for totalTokens: 99_999", () => {
      expect(isOnboarding({ totalTokens: 99_999 })).toBe(true)
    })

    it("returns false for totalTokens: 100_000 (at threshold)", () => {
      expect(isOnboarding({ totalTokens: 100_000 })).toBe(false)
    })

    it("returns false for totalTokens: 500_000", () => {
      expect(isOnboarding({ totalTokens: 500_000 })).toBe(false)
    })

    it("returns true for totalTokens: undefined (treated as 0 via ?? 0)", () => {
      expect(isOnboarding({ totalTokens: undefined as unknown as number })).toBe(true)
    })
  })

  describe("getFirstImpressions", () => {
    it("returns non-empty string containing name when totalTokens: 0 and known name", () => {
      const result = getFirstImpressions({ totalTokens: 0, name: "Jordan" })
      expect(result.length).toBeGreaterThan(0)
      expect(result).toContain("Jordan")
    })

    it("mentions asking what they'd like to be called when name is 'Unknown'", () => {
      const result = getFirstImpressions({ totalTokens: 0, name: "Unknown" })
      expect(result.length).toBeGreaterThan(0)
      expect(result.toLowerCase()).toMatch(/don't know.*name|do not know.*name/)
      expect(result.toLowerCase()).toMatch(/ask/)
    })

    it("returns empty string for totalTokens: 100_000 (at threshold)", () => {
      const result = getFirstImpressions({ totalTokens: 100_000, name: "Jordan" })
      expect(result).toBe("")
    })

    it("returns empty string for totalTokens: 200_000 (above threshold)", () => {
      const result = getFirstImpressions({ totalTokens: 200_000, name: "Jordan" })
      expect(result).toBe("")
    })

    it("returns empty string when an active obligation is already in flight", () => {
      const result = (getFirstImpressions as any)(
        { totalTokens: 0, name: "Jordan" },
        { currentObligation: "finish the current task" },
      )
      expect(result).toBe("")
    })

    it("returns empty string when a queued follow-up is waiting", () => {
      const result = (getFirstImpressions as any)(
        { totalTokens: 0, name: "Jordan" },
        { hasQueuedFollowUp: true },
      )
      expect(result).toBe("")
    })

    it("returns empty string when mustResolveBeforeHandoff is active", () => {
      const result = (getFirstImpressions as any)(
        { totalTokens: 0, name: "Jordan" },
        { mustResolveBeforeHandoff: true },
      )
      expect(result).toBe("")
    })

    it("actively asks about the friend and mentions agent capabilities", () => {
      const result = getFirstImpressions({ totalTokens: 0, name: "Jordan" })
      // Should actively ask about the friend
      expect(result.toLowerCase()).toMatch(/ask.*about/)
      // Should mention agent capabilities
      expect(result.toLowerCase()).toMatch(/tool|integration|skill/)
      // Should instruct to save everything learned
      expect(result.toLowerCase()).toMatch(/save.*learn/)
    })

    it("forbids generic re-greetings in the middle of active task work", () => {
      const result = getFirstImpressions({ totalTokens: 0, name: "Jordan" })
      expect(result.toLowerCase()).toContain("i do not reset with a generic opener")
      expect(result.toLowerCase()).toContain("what do ya need help with")
    })

    it("still allows a light opener on a genuinely fresh idle conversation", () => {
      const result = getFirstImpressions({ totalTokens: 0, name: "Jordan" })
      expect(result.toLowerCase()).toContain("only when the conversation is genuinely fresh and idle")
      expect(result.toLowerCase()).toContain("a light opener is okay")
    })
  })
})
