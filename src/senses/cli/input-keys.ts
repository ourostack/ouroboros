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
