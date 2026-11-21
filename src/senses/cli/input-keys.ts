/**
 * Pure key-handling functions for TUI input.
 *
 * Each function takes the current (text, cursorPos, ...) and returns
 * the new {text, cursorPos}. These are extracted from InputArea's
 * useInput callback for testability.
 */
import type { KillRing } from "./kill-ring"
import { emitNervesEvent } from "../../nerves/runtime"
import { PASTE_END, PASTE_START } from "./bracketed-paste"

export interface InputResult {
  text: string
  cursorPos: number
}

/**
 * Ctrl+K: kill from cursor to end of line.
 * Pushes killed text to ring with "append" direction.
 */
export function handleKillToEnd(text: string, cursorPos: number, ring: KillRing): InputResult {
  emitNervesEvent({ component: "senses", event: "senses.input_kill", message: "kill to end", meta: { direction: "end" } })
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
export function classifyEscapeSequence(inputChar: string): "home" | "end" | "ignore" | "word-left" | "word-right" | null {
  if (!inputChar.startsWith("\x1b[")) return null

  const seq = inputChar.slice(2) // after \x1b[

  // Home: \x1b[H or \x1b[1~
  if (seq === "H" || seq === "1~") return "home"

  // End: \x1b[F or \x1b[4~
  if (seq === "F" || seq === "4~") return "end"

  // Option+Left: \x1b[1;3D (CSI modified arrow with Alt modifier)
  if (seq === "1;3D") return "word-left"

  // Option+Right: \x1b[1;3C
  if (seq === "1;3C") return "word-right"

  // PageUp: \x1b[5~, PageDown: \x1b[6~
  if (seq === "5~" || seq === "6~") return "ignore"

  // SGR mouse wheel: \x1b[<64;... or \x1b[<65;...
  if (seq.startsWith("<64;") || seq.startsWith("<65;")) return "ignore"

  return null
}

// Escape sequences (CSI, OSC, other two-byte ESC forms) and C0/C1 control bytes other than \n and \t.
// eslint-disable-next-line no-control-regex -- matching the control bytes a paste must not carry into the composer
const PASTED_CONTROLS = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * The text of a bracketed paste chunk, or null when `raw` holds no paste marker.
 * Terminals and hosts such as Orca paste a prompt between \x1b[200~ and \x1b[201~, and Ink hands a chunk that
 * starts with a marker over as an escape sequence, so without this the paste is dropped.
 * `raw` must keep its leading \x1b (Ink strips it and sets meta). Line endings become \n, and escape sequences
 * and other control bytes are removed.
 * Only the chunks that carry a marker come through here; a paste's middle chunks arrive as ordinary input, which
 * the composer cleans with `plainInputText` too.
 */
export function bracketedPasteText(raw: string): string | null {
  if (!raw.includes(PASTE_START) && !raw.includes(PASTE_END)) return null
  const text = plainInputText(raw.split(PASTE_START).join("").split(PASTE_END).join(""))
  emitNervesEvent({ component: "senses", event: "senses.input_paste", message: "bracketed paste chunk reached the composer", meta: { length: text.length } })
  return text
}

/** Input as plain text for the composer: line endings become \n, and escape sequences and other control bytes go. */
export function plainInputText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(PASTED_CONTROLS, "")
}

/** Whether a paste is still open after `raw`, given whether one was open before it. */
export function pasteOpenAfter(raw: string, openBefore: boolean): boolean {
  const start = raw.lastIndexOf(PASTE_START)
  const end = raw.lastIndexOf(PASTE_END)
  if (start === -1 && end === -1) return openBefore
  return start > end
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
