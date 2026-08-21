/**
 * Static source scanner for emitNervesEvent and emitNervesEventDurable calls.
 *
 * Extracts component:event keys from production source files by
 * regex-matching either static emitter with literal component/event fields.
 * calls. Only accepts static string literals (single or double quotes).
 * Template literals and variable references are rejected.
 */

const EMIT_CALL_RE = /emitNervesEvent(?:Durable)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g

function extractStringLiteral(block: string, field: string): string | null {
  const re = new RegExp(`${field}\\s*:\\s*(['"])((?:(?!\\1).)+)\\1`)
  const match = re.exec(block)
  return match ? match[2] : null
}

/**
 * Scan a source file's content for synchronous or durable Nerves calls and extract
 * component:event keys. Only static string literals are accepted.
 */
export function scanSourceForNervesKeys(source: string): string[] {
  const keys = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = EMIT_CALL_RE.exec(source)) !== null) {
    const block = match[1]
    const component = extractStringLiteral(block, "component")
    const event = extractStringLiteral(block, "event")
    if (component && event) {
      keys.add(`${component}:${event}`)
    }
  }

  return [...keys].sort()
}
