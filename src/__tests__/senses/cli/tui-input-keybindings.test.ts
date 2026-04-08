/**
 * Tests for TUI input keybinding logic.
 *
 * These test the pure key-handling functions extracted from InputArea,
 * not the React component itself. Each function takes (text, cursorPos, ...)
 * and returns {text, cursorPos} or similar.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { KillRing } from "../../../senses/cli/kill-ring"
import {
  handleKillToEnd,
  handleKillToStart,
  handleKillWordBack,
  handleYank,
  handleYankPop,
  handleCursorLeft,
  handleCursorRight,
  handleBackspace,
  handleForwardDelete,
  handleHome,
  handleEnd,
  classifyEscapeSequence,
} from "../../../senses/cli/input-keys"

describe("Kill Ring Keybindings", () => {
  let ring: KillRing

  beforeEach(() => {
    ring = new KillRing()
  })

  describe("Ctrl+K (kill to end of line)", () => {
    it("kills text from cursor to end of line", () => {
      const result = handleKillToEnd("hello world", 5, ring)
      expect(result).toEqual({ text: "hello", cursorPos: 5 })
    })

    it("pushes killed text to ring with 'append' direction", () => {
      handleKillToEnd("hello world", 5, ring)
      expect(ring.yank()).toBe(" world")
    })

    it("is a no-op when cursor is at end", () => {
      const result = handleKillToEnd("hello", 5, ring)
      expect(result).toEqual({ text: "hello", cursorPos: 5 })
      expect(ring.yank()).toBeUndefined()
    })

    it("kills entire line when cursor is at start", () => {
      const result = handleKillToEnd("hello", 0, ring)
      expect(result).toEqual({ text: "", cursorPos: 0 })
      expect(ring.yank()).toBe("hello")
    })
  })

  describe("Ctrl+U (kill to start of line)", () => {
    it("kills text from start to cursor", () => {
      const result = handleKillToStart("hello world", 5, ring)
      expect(result).toEqual({ text: " world", cursorPos: 0 })
    })

    it("pushes killed text to ring with 'prepend' direction", () => {
      handleKillToStart("hello world", 5, ring)
      expect(ring.yank()).toBe("hello")
    })

    it("is a no-op when cursor is at start", () => {
      const result = handleKillToStart("hello", 0, ring)
      expect(result).toEqual({ text: "hello", cursorPos: 0 })
      expect(ring.yank()).toBeUndefined()
    })

    it("kills entire line when cursor is at end", () => {
      const result = handleKillToStart("hello", 5, ring)
      expect(result).toEqual({ text: "", cursorPos: 0 })
      expect(ring.yank()).toBe("hello")
    })
  })

  describe("Ctrl+W / Meta+Backspace (kill word back)", () => {
    it("kills word before cursor including leading whitespace", () => {
      const result = handleKillWordBack("hello world", 11, ring)
      // Kills " world" (space + word), leaving "hello"
      expect(result).toEqual({ text: "hello", cursorPos: 5 })
    })

    it("pushes killed word (with whitespace) to ring with 'prepend' direction", () => {
      handleKillWordBack("hello world", 11, ring)
      expect(ring.yank()).toBe(" world")
    })

    it("kills first word when cursor is within it", () => {
      const result = handleKillWordBack("hello world", 3, ring)
      expect(result).toEqual({ text: "lo world", cursorPos: 0 })
    })

    it("is a no-op when cursor is at start", () => {
      const result = handleKillWordBack("hello", 0, ring)
      expect(result).toEqual({ text: "hello", cursorPos: 0 })
      expect(ring.yank()).toBeUndefined()
    })

    it("kills trailing spaces as part of the word", () => {
      const result = handleKillWordBack("hello   world", 8, ring)
      // Cursor at 8 means before = "hello   ", regex kills " hello   " -> actually
      // before is "hello   ", regex /\s*\S+\s*$/ matches "hello   " (trailing spaces + word)
      expect(result.cursorPos).toBe(0)
    })
  })

  describe("Ctrl+Y (yank)", () => {
    it("inserts yanked text at cursor position", () => {
      ring.push("world", "append")
      const result = handleYank("hello ", 6, ring)
      expect(result).toEqual({ text: "hello world", cursorPos: 11 })
    })

    it("returns null when ring is empty", () => {
      const result = handleYank("hello", 5, ring)
      expect(result).toBeNull()
    })

    it("inserts at cursor mid-text", () => {
      ring.push("beautiful ", "append")
      const result = handleYank("hello world", 6, ring)
      expect(result).toEqual({ text: "hello beautiful world", cursorPos: 16 })
    })

    it("inserts at beginning of text", () => {
      ring.push("hey ", "append")
      const result = handleYank("world", 0, ring)
      expect(result).toEqual({ text: "hey world", cursorPos: 4 })
    })
  })

  describe("Alt+Y (yank-pop)", () => {
    it("replaces previously yanked text with next ring entry", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")

      // Yank gets "second"
      const yankResult = handleYank("text: ", 6, ring)
      expect(yankResult).toEqual({ text: "text: second", cursorPos: 12 })

      // YankPop replaces "second" with "first"
      const popResult = handleYankPop("text: second", 12, ring)
      expect(popResult).toEqual({ text: "text: first", cursorPos: 11 })
    })

    it("returns null when ring is not in yanking state", () => {
      ring.push("hello", "append")
      // No yank() called
      const result = handleYankPop("hello", 5, ring)
      expect(result).toBeNull()
    })

    it("returns null when ring is empty", () => {
      const result = handleYankPop("hello", 5, ring)
      expect(result).toBeNull()
    })

    it("cycles through multiple entries", () => {
      ring.push("first", "append")
      ring.resetAccumulation()
      ring.push("second", "append")
      ring.resetAccumulation()
      ring.push("third", "append")

      handleYank("", 0, ring) // gets "third"

      const pop1 = handleYankPop("third", 5, ring)
      expect(pop1!.text).toBe("second")

      const pop2 = handleYankPop("second", 6, ring)
      expect(pop2!.text).toBe("first")
    })
  })

  describe("Consecutive kill accumulation", () => {
    it("consecutive Ctrl+K calls merge into one ring entry", () => {
      // First kill: "hello world" with cursor at 5 -> kills " world"
      handleKillToEnd("hello world", 5, ring)
      // Second kill on remaining "hello" with cursor at 3 -> kills "lo"
      handleKillToEnd("hello", 3, ring)
      // Should accumulate: " world" + "lo" = " worldlo"
      expect(ring.yank()).toBe(" worldlo")
    })

    it("typing a character then Ctrl+K creates a new entry", () => {
      handleKillToEnd("hello world", 5, ring)
      ring.resetAccumulation() // simulates non-kill keystroke
      handleKillToEnd("hello again", 5, ring)

      expect(ring.yank()).toBe(" again")
      expect(ring.yankPop()).toBe(" world")
    })

    it("consecutive Ctrl+U calls merge with 'prepend'", () => {
      handleKillToStart("hello world", 11, ring) // kills "hello world"
      handleKillToStart("prefix ", 7, ring) // kills "prefix "
      // Prepend: "prefix " + "hello world" = "prefix hello world"
      expect(ring.yank()).toBe("prefix hello world")
    })
  })
})

describe("Emacs Navigation (Ctrl+B/F/H)", () => {
  describe("Ctrl+B (cursor left)", () => {
    it("moves cursor left by 1", () => {
      expect(handleCursorLeft("hello", 3)).toBe(2)
    })

    it("does not go below 0", () => {
      expect(handleCursorLeft("hello", 0)).toBe(0)
    })

    it("moves from end of string", () => {
      expect(handleCursorLeft("hi", 2)).toBe(1)
    })
  })

  describe("Ctrl+F (cursor right)", () => {
    it("moves cursor right by 1", () => {
      expect(handleCursorRight("hello", 3)).toBe(4)
    })

    it("does not go beyond text length", () => {
      expect(handleCursorRight("hello", 5)).toBe(5)
    })

    it("moves from start of string", () => {
      expect(handleCursorRight("hi", 0)).toBe(1)
    })
  })

  describe("Ctrl+H (backspace)", () => {
    it("deletes character before cursor", () => {
      const result = handleBackspace("hello", 3)
      expect(result).toEqual({ text: "helo", cursorPos: 2 })
    })

    it("is a no-op at start of text", () => {
      const result = handleBackspace("hello", 0)
      expect(result).toEqual({ text: "hello", cursorPos: 0 })
    })

    it("deletes last character when cursor is at end", () => {
      const result = handleBackspace("hello", 5)
      expect(result).toEqual({ text: "hell", cursorPos: 4 })
    })

    it("handles single character string", () => {
      const result = handleBackspace("x", 1)
      expect(result).toEqual({ text: "", cursorPos: 0 })
    })

    it("handles empty string", () => {
      const result = handleBackspace("", 0)
      expect(result).toEqual({ text: "", cursorPos: 0 })
    })
  })
})

describe("Home/End Keys", () => {
  describe("handleHome", () => {
    it("moves cursor to position 0", () => {
      expect(handleHome("hello world", 5)).toBe(0)
    })

    it("is already at 0", () => {
      expect(handleHome("hello", 0)).toBe(0)
    })
  })

  describe("handleEnd", () => {
    it("moves cursor to end of text", () => {
      expect(handleEnd("hello world", 5)).toBe(11)
    })

    it("is already at end", () => {
      expect(handleEnd("hello", 5)).toBe(5)
    })
  })
})

describe("classifyEscapeSequence", () => {
  it("detects Home via \\x1b[H", () => {
    expect(classifyEscapeSequence("\x1b[H")).toBe("home")
  })

  it("detects Home via \\x1b[1~", () => {
    expect(classifyEscapeSequence("\x1b[1~")).toBe("home")
  })

  it("detects End via \\x1b[F", () => {
    expect(classifyEscapeSequence("\x1b[F")).toBe("end")
  })

  it("detects End via \\x1b[4~", () => {
    expect(classifyEscapeSequence("\x1b[4~")).toBe("end")
  })

  it("detects PageUp via \\x1b[5~", () => {
    expect(classifyEscapeSequence("\x1b[5~")).toBe("ignore")
  })

  it("detects PageDown via \\x1b[6~", () => {
    expect(classifyEscapeSequence("\x1b[6~")).toBe("ignore")
  })

  it("detects SGR mouse wheel up", () => {
    expect(classifyEscapeSequence("\x1b[<64;10;20M")).toBe("ignore")
  })

  it("detects SGR mouse wheel down", () => {
    expect(classifyEscapeSequence("\x1b[<65;10;20M")).toBe("ignore")
  })

  it("returns null for normal text", () => {
    expect(classifyEscapeSequence("hello")).toBeNull()
  })

  it("returns null for unrecognized escape sequences", () => {
    expect(classifyEscapeSequence("\x1b[Z")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(classifyEscapeSequence("")).toBeNull()
  })
})
