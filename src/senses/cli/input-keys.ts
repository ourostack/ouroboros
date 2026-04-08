/**
 * Pure key-handling functions for TUI input.
 *
 * Each function takes the current (text, cursorPos, ...) and returns
 * the new {text, cursorPos}. These are extracted from InputArea's
 * useInput callback for testability.
 */
import type { KillRing } from "./kill-ring"

export interface InputResult {
  text: string
  cursorPos: number
}

/**
 * Ctrl+K: kill from cursor to end of line.
 * Pushes killed text to ring with "append" direction.
 */
export function handleKillToEnd(text: string, cursorPos: number, ring: KillRing): InputResult {
  if (cursorPos >= text.length) {
    return { text, cursorPos }
  }
  const killed = text.slice(cursorPos)
  ring.push(killed, "append")
  return { text: text.slice(0, cursorPos), cursorPos }
}

/**
 * Ctrl+U: kill from start of line to cursor.
 * Pushes killed text to ring with "prepend" direction.
 */
export function handleKillToStart(text: string, cursorPos: number, ring: KillRing): InputResult {
  if (cursorPos === 0) {
    return { text, cursorPos }
  }
  const killed = text.slice(0, cursorPos)
  ring.push(killed, "prepend")
  return { text: text.slice(cursorPos), cursorPos: 0 }
}

/**
 * Ctrl+W / Meta+Backspace: kill word before cursor.
 * Pushes killed word to ring with "prepend" direction.
 */
export function handleKillWordBack(text: string, cursorPos: number, ring: KillRing): InputResult {
  if (cursorPos === 0) {
    return { text, cursorPos }
  }
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const wordStart = before.replace(/\s*\S+\s*$/, "")
  const killed = before.slice(wordStart.length)
  ring.push(killed, "prepend")
  return { text: wordStart + after, cursorPos: wordStart.length }
}

/**
 * Ctrl+Y: yank (paste) from kill ring at cursor.
 * Returns null if ring is empty.
 */
export function handleYank(text: string, cursorPos: number, ring: KillRing): InputResult | null {
  const yanked = ring.yank()
  if (yanked === undefined) return null
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  return { text: before + yanked + after, cursorPos: cursorPos + yanked.length }
}

// ─── Emacs Cursor Navigation ─────────────────────────────────────

/** Ctrl+B: move cursor left by 1. Returns new cursor position. */
export function handleCursorLeft(_text: string, cursorPos: number): number {
  return Math.max(0, cursorPos - 1)
}

/** Ctrl+F: move cursor right by 1. Returns new cursor position. */
export function handleCursorRight(text: string, cursorPos: number): number {
  return Math.min(text.length, cursorPos + 1)
}

/** Ctrl+H: backspace (delete char before cursor). */
export function handleBackspace(text: string, cursorPos: number): InputResult {
  if (cursorPos === 0) return { text, cursorPos }
  const before = text.slice(0, cursorPos - 1)
  const after = text.slice(cursorPos)
  return { text: before + after, cursorPos: cursorPos - 1 }
}

/** Forward delete: delete char at cursor position. */
export function handleForwardDelete(text: string, cursorPos: number): InputResult {
  if (cursorPos >= text.length) return { text, cursorPos }
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos + 1)
  return { text: before + after, cursorPos }
}

// ─── Home / End ──────────────────────────────────────────────────

/** Home key: move cursor to position 0. Returns new cursor position. */
export function handleHome(_text: string, _cursorPos: number): number {
  return 0
}

/** End key: move cursor to end of text. Returns new cursor position. */
export function handleEnd(text: string, _cursorPos: number): number {
  return text.length
}

// ─── Escape Sequence Classification ──────────────────────────────

/**
 * Classify raw escape sequences that Ink passes through as regular characters.
 * Returns:
 *   "home"   — Home key sequences
 *   "end"    — End key sequences
 *   "ignore" — PageUp, PageDown, mouse wheel (should be suppressed)
 *   null     — not a recognized escape sequence
 */
export function classifyEscapeSequence(inputChar: string): "home" | "end" | "ignore" | null {
  if (!inputChar.startsWith("\x1b[")) return null

  const seq = inputChar.slice(2) // after \x1b[

  // Home: \x1b[H or \x1b[1~
  if (seq === "H" || seq === "1~") return "home"

  // End: \x1b[F or \x1b[4~
  if (seq === "F" || seq === "4~") return "end"

  // PageUp: \x1b[5~, PageDown: \x1b[6~
  if (seq === "5~" || seq === "6~") return "ignore"

  // SGR mouse wheel: \x1b[<64;... or \x1b[<65;...
  if (seq.startsWith("<64;") || seq.startsWith("<65;")) return "ignore"

  return null
}

/**
 * Alt+Y: yank-pop -- replace previously yanked text with next ring entry.
 * Returns null if not in yanking state or ring is empty.
 */
export function handleYankPop(text: string, cursorPos: number, ring: KillRing): InputResult | null {
  const lastYanked = ring.lastYankedText
  if (!ring.isYanking || lastYanked === undefined) return null

  const popped = ring.yankPop()
  if (popped === undefined) return null

  // Find where the last yanked text ends (at current cursor position)
  // and starts (cursorPos - lastYanked.length)
  const yankStart = cursorPos - lastYanked.length
  const before = text.slice(0, yankStart)
  const after = text.slice(cursorPos)
  return { text: before + popped + after, cursorPos: yankStart + popped.length }
}

// ─── Clipboard Image Paste ───────────────────────────────────────

export interface ClipboardImageResult {
  text: string
  cursorPos: number
  imageRef: number
  imageData: { base64: string; mediaType: string }
}

type ClipboardReader = () => Promise<{ base64: string; mediaType: string } | null>

/**
 * Handle an empty paste event by checking clipboard for images (macOS only).
 * Returns null if no image found, not on macOS, or clipboard empty.
 */
export async function handleEmptyPaste(
  text: string,
  cursorPos: number,
  currentImageCount: number,
  platform: string,
  clipboardReader: ClipboardReader,
): Promise<ClipboardImageResult | null> {
  if (platform !== "darwin") return null

  const imageData = await clipboardReader()
  if (!imageData) return null

  const refNum = currentImageCount + 1
  const ref = `[Image #${refNum}]`
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  return {
    text: before + ref + after,
    cursorPos: cursorPos + ref.length,
    imageRef: refNum,
    imageData,
  }
}
