/**
 * Token-aware navigation and deletion for [Image #N] references.
 *
 * Image refs are treated as atomic "chips" — arrow keys hop over them,
 * backspace/delete removes them atomically, and word-kill treats them
 * as single words.
 */

const IMAGE_REF_PATTERN = /\[Image #\d+\]/g

/**
 * If an [Image #N] ref ends exactly at the given position, return its start index.
 * Otherwise return undefined.
 */
export function imageRefEndingAt(text: string, pos: number): number | undefined {
  // Search backward from pos for a potential image ref
  // Max length of [Image #NNN] is ~14 chars, search a window
  const windowStart = Math.max(0, pos - 20)
  const window = text.slice(windowStart, pos)

  IMAGE_REF_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMAGE_REF_PATTERN.exec(window)) !== null) {
    const matchEnd = windowStart + match.index + match[0].length
    if (matchEnd === pos) {
      return windowStart + match.index
    }
  }
  return undefined
}

/**
 * If an [Image #N] ref starts exactly at the given position, return its end index.
 * Otherwise return undefined.
 */
export function imageRefStartingAt(text: string, pos: number): number | undefined {
  if (pos >= text.length) return undefined

  // Check if text at pos matches an image ref
  const window = text.slice(pos, pos + 20)
  IMAGE_REF_PATTERN.lastIndex = 0
  const match = IMAGE_REF_PATTERN.exec(window)
  if (match && match.index === 0) {
    return pos + match[0].length
  }
  return undefined
}

/**
 * If cursor is right after an [Image #N], remove the entire ref.
 * Returns { text, pos } with the ref removed, or null if no ref found.
 */
export function deleteTokenBefore(text: string, pos: number): { text: string; pos: number } | null {
  const start = imageRefEndingAt(text, pos)
  if (start === undefined) return null

  const before = text.slice(0, start)
  const after = text.slice(pos)
  return { text: before + after, pos: start }
}

/**
 * If cursor is right before an [Image #N], remove the entire ref.
 * Returns { text, pos } with the ref removed, or null if no ref found.
 */
export function deleteTokenAfter(text: string, pos: number): { text: string; pos: number } | null {
  const end = imageRefStartingAt(text, pos)
  if (end === undefined) return null

  const before = text.slice(0, pos)
  const after = text.slice(end)
  return { text: before + after, pos }
}
