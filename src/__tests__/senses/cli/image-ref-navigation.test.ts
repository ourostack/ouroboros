import { describe, it, expect } from "vitest"
import {
  imageRefEndingAt,
  imageRefStartingAt,
  deleteTokenBefore,
  deleteTokenAfter,
} from "../../../senses/cli/image-ref-navigation"

describe("Image Ref Navigation Helpers", () => {
  describe("imageRefEndingAt", () => {
    it("returns start index when cursor is at end of [Image #1]", () => {
      const text = "hello [Image #1] world"
      //           0123456789...
      // [Image #1] is at index 6..16 (10 chars)
      expect(imageRefEndingAt(text, 16)).toBe(6)
    })

    it("returns start index for multi-digit ref number", () => {
      const text = "[Image #10]"
      expect(imageRefEndingAt(text, 11)).toBe(0)
    })

    it("returns undefined when cursor is not at end of an image ref", () => {
      expect(imageRefEndingAt("hello world", 5)).toBeUndefined()
    })

    it("returns undefined when cursor is mid-way through image ref", () => {
      const text = "[Image #1]"
      expect(imageRefEndingAt(text, 5)).toBeUndefined()
    })

    it("returns undefined for empty string", () => {
      expect(imageRefEndingAt("", 0)).toBeUndefined()
    })

    it("handles image ref at the very start of text", () => {
      const text = "[Image #1] after"
      expect(imageRefEndingAt(text, 10)).toBe(0)
    })

    it("handles image ref at the very end of text", () => {
      const text = "before [Image #2]"
      expect(imageRefEndingAt(text, 17)).toBe(7)
    })
  })

  describe("imageRefStartingAt", () => {
    it("returns end index when cursor is at start of [Image #1]", () => {
      const text = "hello [Image #1] world"
      expect(imageRefStartingAt(text, 6)).toBe(16)
    })

    it("returns end index for multi-digit ref number", () => {
      const text = "[Image #10]"
      expect(imageRefStartingAt(text, 0)).toBe(11)
    })

    it("returns undefined when cursor is not at start of an image ref", () => {
      expect(imageRefStartingAt("hello world", 5)).toBeUndefined()
    })

    it("returns undefined when cursor is mid-way through image ref", () => {
      const text = "[Image #1]"
      expect(imageRefStartingAt(text, 3)).toBeUndefined()
    })

    it("returns undefined for empty string", () => {
      expect(imageRefStartingAt("", 0)).toBeUndefined()
    })

    it("returns undefined when cursor is at end of text", () => {
      const text = "[Image #1]"
      expect(imageRefStartingAt(text, 10)).toBeUndefined()
    })
  })

  describe("deleteTokenBefore", () => {
    it("removes entire [Image #N] when cursor is right after it", () => {
      const text = "hello [Image #1] world"
      const result = deleteTokenBefore(text, 16)
      expect(result).toEqual({ text: "hello  world", pos: 6 })
    })

    it("returns null when cursor is not after an image ref", () => {
      expect(deleteTokenBefore("hello world", 5)).toBeNull()
    })

    it("removes image ref at start of text", () => {
      const text = "[Image #3]rest"
      const result = deleteTokenBefore(text, 10)
      expect(result).toEqual({ text: "rest", pos: 0 })
    })

    it("handles multi-digit ref numbers", () => {
      const text = "x[Image #99]y"
      const result = deleteTokenBefore(text, 12)
      expect(result).toEqual({ text: "xy", pos: 1 })
    })

    it("returns null at position 0", () => {
      expect(deleteTokenBefore("hello", 0)).toBeNull()
    })
  })

  describe("deleteTokenAfter", () => {
    it("removes entire [Image #N] when cursor is right before it", () => {
      const text = "hello [Image #1] world"
      const result = deleteTokenAfter(text, 6)
      expect(result).toEqual({ text: "hello  world", pos: 6 })
    })

    it("returns null when cursor is not before an image ref", () => {
      expect(deleteTokenAfter("hello world", 5)).toBeNull()
    })

    it("removes image ref at end of text", () => {
      const text = "text[Image #2]"
      const result = deleteTokenAfter(text, 4)
      expect(result).toEqual({ text: "text", pos: 4 })
    })

    it("handles multi-digit ref numbers", () => {
      const text = "a[Image #100]b"
      const result = deleteTokenAfter(text, 1)
      expect(result).toEqual({ text: "ab", pos: 1 })
    })

    it("returns null at end of text", () => {
      expect(deleteTokenAfter("hello", 5)).toBeNull()
    })
  })

  describe("Arrow key navigation", () => {
    it("left arrow at end of [Image #N] jumps cursor to start of ref", () => {
      const text = "hello [Image #1] world"
      // Using imageRefEndingAt to detect chip and jump
      const start = imageRefEndingAt(text, 16)
      expect(start).toBe(6)
    })

    it("right arrow at start of [Image #N] jumps cursor to end of ref", () => {
      const text = "hello [Image #1] world"
      const end = imageRefStartingAt(text, 6)
      expect(end).toBe(16)
    })

    it("backspace at end of [Image #N] removes entire ref", () => {
      const text = "abc[Image #1]def"
      const result = deleteTokenBefore(text, 13)
      expect(result).toEqual({ text: "abcdef", pos: 3 })
    })

    it("forward delete at start of [Image #N] removes entire ref", () => {
      const text = "abc[Image #1]def"
      const result = deleteTokenAfter(text, 3)
      expect(result).toEqual({ text: "abcdef", pos: 3 })
    })

    it("Ctrl+W with cursor after [Image #N] removes entire ref as word", () => {
      // Using deleteTokenBefore as the check — if cursor is right after
      // an image ref, it should be treated as one "word"
      const text = "text [Image #5] rest"
      const result = deleteTokenBefore(text, 15)
      expect(result).toEqual({ text: "text  rest", pos: 5 })
    })
  })
})
