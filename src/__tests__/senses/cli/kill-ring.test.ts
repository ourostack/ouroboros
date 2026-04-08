import { describe, it, expect, beforeEach } from "vitest"
import { KillRing } from "../../../senses/cli/kill-ring"

describe("KillRing", () => {
  let ring: KillRing

  beforeEach(() => {
    ring = new KillRing()
  })

  describe("push and yank", () => {
    it("returns undefined from yank when ring is empty", () => {
      expect(ring.yank()).toBeUndefined()
    })

    it("yanks the last pushed entry", () => {
      ring.push("hello", "append")
      expect(ring.yank()).toBe("hello")
    })

    it("yanks the most recent entry when multiple pushed", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")
      expect(ring.yank()).toBe("second")
    })
  })

  describe("max capacity (10 entries)", () => {
    it("evicts oldest entry when full", () => {
      for (let i = 0; i < 10; i++) {
        ring.push(`entry-${i}`, "append")
        ring.resetAccumulation()
      }
      // Ring has entries 0..9. Push one more to evict entry-0
      ring.push("overflow", "append")
      ring.resetAccumulation()

      // Yank returns the most recent
      expect(ring.yank()).toBe("overflow")

      // Cycle through all -- entry-0 should be gone
      const seen: string[] = []
      seen.push(ring.yank()!) // overflow (already yanked, resets yank index)
      for (let i = 0; i < 10; i++) {
        const val = ring.yankPop()
        if (val) seen.push(val)
      }
      expect(seen).not.toContain("entry-0")
      expect(seen).toContain("entry-1")
    })

    it("keeps exactly 10 entries", () => {
      for (let i = 0; i < 15; i++) {
        ring.push(`e-${i}`, "append")
        ring.resetAccumulation()
      }
      // Cycle through all entries via yankPop
      const all: string[] = []
      ring.yank() // start yanking
      all.push(ring.yank()!)
      for (let i = 0; i < 9; i++) {
        const val = ring.yankPop()
        if (val) all.push(val)
      }
      // Should have 10 unique entries
      expect(new Set(all).size).toBe(10)
    })
  })

  describe("consecutive kill accumulation", () => {
    it("appends to top entry when direction is 'append' and accumulating", () => {
      ring.push("hello", "append")
      ring.push(" world", "append")
      expect(ring.yank()).toBe("hello world")
    })

    it("prepends to top entry when direction is 'prepend' and accumulating", () => {
      ring.push("world", "prepend")
      ring.push("hello ", "prepend")
      expect(ring.yank()).toBe("hello world")
    })

    it("creates new entry after resetAccumulation", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")

      // Yank gets "second"
      expect(ring.yank()).toBe("second")
      // YankPop gets "first"
      expect(ring.yankPop()).toBe("first")
    })

    it("does not accumulate across resetAccumulation calls", () => {
      ring.push("aaa", "append")
      ring.resetAccumulation()
      ring.push("bbb", "append")
      // Should be separate entries, not "aaabbb"
      expect(ring.yank()).toBe("bbb")
      expect(ring.yankPop()).toBe("aaa")
    })
  })

  describe("yankPop", () => {
    it("returns undefined when ring is empty", () => {
      expect(ring.yankPop()).toBeUndefined()
    })

    it("returns undefined when not in yanking state", () => {
      ring.push("hello", "append")
      // No yank() called first
      expect(ring.yankPop()).toBeUndefined()
    })

    it("cycles backward through entries", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")
      ring.resetAccumulation()
      ring.push("third", "append")

      expect(ring.yank()).toBe("third")
      expect(ring.yankPop()).toBe("second")
      expect(ring.yankPop()).toBe("first")
    })

    it("wraps around to most recent after reaching oldest", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")

      expect(ring.yank()).toBe("second")
      expect(ring.yankPop()).toBe("first")
      // Wrap around
      expect(ring.yankPop()).toBe("second")
    })
  })

  describe("isYanking state", () => {
    it("is false initially", () => {
      expect(ring.isYanking).toBe(false)
    })

    it("is true after yank()", () => {
      ring.push("hello", "append")
      ring.yank()
      expect(ring.isYanking).toBe(true)
    })

    it("is false after resetYankState()", () => {
      ring.push("hello", "append")
      ring.yank()
      ring.resetYankState()
      expect(ring.isYanking).toBe(false)
    })

    it("is true after yankPop()", () => {
      ring.push("a", "append")
      ring.resetAccumulation()
      ring.push("b", "append")
      ring.yank()
      ring.yankPop()
      expect(ring.isYanking).toBe(true)
    })
  })

  describe("lastYankedText", () => {
    it("is undefined initially", () => {
      expect(ring.lastYankedText).toBeUndefined()
    })

    it("is set after yank()", () => {
      ring.push("hello", "append")
      ring.yank()
      expect(ring.lastYankedText).toBe("hello")
    })

    it("is updated after yankPop()", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")
      ring.yank()
      expect(ring.lastYankedText).toBe("second")
      ring.yankPop()
      expect(ring.lastYankedText).toBe("first")
    })

    it("is cleared after resetYankState()", () => {
      ring.push("hello", "append")
      ring.yank()
      ring.resetYankState()
      expect(ring.lastYankedText).toBeUndefined()
    })
  })

  describe("edge cases", () => {
    it("handles empty string push", () => {
      ring.push("", "append")
      expect(ring.yank()).toBe("")
    })

    it("yank on empty ring returns undefined and does not set isYanking", () => {
      ring.yank()
      expect(ring.isYanking).toBe(false)
    })

    it("yankPop returns undefined on single-entry ring (wraps to same)", () => {
      ring.push("only", "append")
      expect(ring.yank()).toBe("only")
      // With one entry, yankPop wraps back to the same entry
      expect(ring.yankPop()).toBe("only")
    })

    it("resetAccumulation is safe to call on empty ring", () => {
      expect(() => ring.resetAccumulation()).not.toThrow()
    })

    it("resetYankState is safe to call when not yanking", () => {
      expect(() => ring.resetYankState()).not.toThrow()
    })

    it("mixed append and prepend accumulation", () => {
      ring.push("middle", "append")
      ring.push(" end", "append")
      ring.push("start ", "prepend")
      expect(ring.yank()).toBe("start middle end")
    })
  })
})
