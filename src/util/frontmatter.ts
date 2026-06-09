/**
 * Shared YAML-ish frontmatter parser.
 *
 * Originally lived in `src/repertoire/tasks/parser.ts`. Hoisted to
 * `src/util/` as part of W6 Unit 8b so habit-parser, habit-migration,
 * and await-parser can consume it without depending on the deprecated
 * task module. Behavior unchanged from the original implementation.
 *
 * This is a pure-data helper: no side effects, no nerves observability of
 * its own. Callers (habit-parser, await-parser, etc.) emit nerves events
 * around parse calls, which is the right ownership boundary.
 */

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === "null") return null
  if (value === "true") return true
  if (value === "false") return false
  if (value === "[]") return []
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function parseFrontmatter(raw: string): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {}
  const lines = raw.split(/\r?\n/)

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (!line.trim()) continue

    const match = /^([A-Za-z0-9_:-]+):\s*(.*)$/.exec(line)
    if (!match) continue

    const key = match[1]
    const inline = match[2]
    if (inline.length > 0) {
      frontmatter[key] = parseScalar(inline)
      continue
    }

    const items: unknown[] = []
    let cursor = idx + 1
    while (cursor < lines.length && /^\s*-\s+/.test(lines[cursor])) {
      items.push(parseScalar(lines[cursor].replace(/^\s*-\s+/, "")))
      cursor += 1
    }

    if (items.length > 0) {
      frontmatter[key] = items
      idx = cursor - 1
      continue
    }

    const nested: Record<string, unknown> = {}
    cursor = idx + 1
    while (cursor < lines.length && /^\s+[A-Za-z0-9_:-]+:\s*/.test(lines[cursor])) {
      const child = /^\s+([A-Za-z0-9_:-]+):\s*(.*)$/.exec(lines[cursor]) as RegExpExecArray
      nested[child[1]] = parseScalar(child[2])
      cursor += 1
    }

    frontmatter[key] = Object.keys(nested).length > 0 ? nested : items
    idx = cursor - 1
  }

  return frontmatter
}
