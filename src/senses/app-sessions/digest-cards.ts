import * as fs from "node:fs"
import * as path from "node:path"
import { eventLogPath, type AppSessionsOptions } from "./client"

/**
 * Which task card a session is working on, found without a model: the session's own history records the task it declared
 * (the `task_focus` call its agent made), and the card is a file in a desk. Reading is incremental: each digest scans only
 * the part of a log it has not seen.
 */
export interface FocusEntry {
  /** Byte offset in the session's event log already scanned. */
  offset: number
  track?: string
  slug?: string
}

export interface CardFacts {
  track: string
  slug: string
  title: string
  status: string
  next: string | null
}

const CHUNK_BYTES = 256 * 1024
/** The most of one session's history the first scan reads, newest first; a declaration older than this is not found. */
export const FIRST_SCAN_BYTES = 512 * 1024 * 1024
const NEXT_MAX_CHARS = 120
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function declaration(line: string): { track: string; slug: string } | "clear" | null {
  let event: { type?: unknown; data?: { toolRequests?: unknown } }
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event.type !== "assistant.message" || !Array.isArray(event.data?.toolRequests)) return null
  let found: { track: string; slug: string } | "clear" | null = null
  for (const request of event.data.toolRequests as Array<{ name?: unknown; arguments?: unknown }>) {
    if (typeof request.name !== "string" || !request.name.endsWith("task_focus")) continue
    const args = (request.arguments && typeof request.arguments === "object" ? request.arguments : {}) as Record<string, unknown>
    if (args.clear === true) found = "clear"
    else if (typeof args.track === "string" && typeof args.slug === "string" && SLUG.test(args.track) && SLUG.test(args.slug)) found = { track: args.track, slug: args.slug }
  }
  return found
}

function applyDeclaration(next: FocusEntry, found: { track: string; slug: string } | "clear"): void {
  if (found === "clear") {
    delete next.track
    delete next.slug
  } else {
    next.track = found.track
    next.slug = found.slug
  }
}

/** The newest declaration in the log, found by reading backwards from the end, as the entry that continues from the end. */
function scanBackwards(fd: number, size: number, maxBytes: number): { entry: FocusEntry; bytes: number } {
  const entry: FocusEntry = { offset: size }
  let position = size
  let carry = Buffer.alloc(0)
  while (position > 0 && size - position < maxBytes) {
    const start = Math.max(0, position - CHUNK_BYTES)
    const chunk = Buffer.alloc(position - start)
    fs.readSync(fd, chunk, 0, chunk.length, start)
    const buffer = Buffer.concat([chunk, carry])
    const first = start > 0 ? buffer.indexOf(10) : -1
    position = start
    if (start > 0 && first < 0) {
      carry = buffer
      continue
    }
    carry = start > 0 ? buffer.subarray(0, first + 1) : Buffer.alloc(0)
    const lines = buffer.subarray(first + 1).toString("utf-8").split("\n")
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]!.includes("task_focus")) continue
      const found = declaration(lines[index]!)
      if (!found) continue
      applyDeclaration(entry, found)
      return { entry, bytes: size - position }
    }
  }
  return { entry, bytes: size - position }
}

/**
 * Finds the task the session declared. A session not seen before is read backwards from its end until its newest
 * declaration; after that only what was added since is read, forwards, up to `maxBytes`.
 */
export function scanFocus(id: string, entry: FocusEntry | undefined, maxBytes: number, options: AppSessionsOptions = {}): { entry: FocusEntry; bytes: number } {
  let fd: number
  try {
    fd = fs.openSync(eventLogPath(id, options), "r")
  } catch {
    return { entry: entry ?? { offset: 0 }, bytes: 0 }
  }
  try {
    const size = fs.fstatSync(fd).size
    if (entry === undefined) return scanBackwards(fd, size, Math.min(maxBytes, FIRST_SCAN_BYTES))
    let offset = Math.min(entry.offset, size)
    const next: FocusEntry = { offset, ...(entry.track ? { track: entry.track, slug: entry.slug } : {}) }
    const begin = offset
    let carry = Buffer.alloc(0)
    while (offset < size && offset - begin < maxBytes) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset))
      fs.readSync(fd, chunk, 0, chunk.length, offset)
      offset += chunk.length
      const buffer = Buffer.concat([carry, chunk])
      const end = buffer.lastIndexOf(10)
      carry = buffer.subarray(end + 1)
      const lines = end < 0 ? [] : buffer.subarray(0, end).toString("utf-8").split("\n")
      for (const line of lines) {
        if (!line.includes("task_focus")) continue
        const found = declaration(line)
        if (found) applyDeclaration(next, found)
      }
      next.offset = offset - carry.length
    }
    return { entry: next, bytes: offset - begin }
  } finally {
    fs.closeSync(fd)
  }
}

/** The card at `<root>/<track>/<slug>/task.md`, or archived beside it, in the first desk root that has it: its title, status and next step. */
export function readCard(roots: string[], track: string, slug: string): CardFacts | null {
  for (const root of roots) {
    const body = [path.join(root, track, slug, "task.md"), path.join(root, track, "_archive", slug, "task.md")].map(file => {
      try {
        return fs.readFileSync(file, "utf-8")
      } catch {
        return null
      }
    }).find(content => content !== null)
    if (body === undefined) continue
    const front = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? ""
    const field = (name: string): string | null => {
      const value = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^['"]|['"]$/g, "")
      return value || null
    }
    const next = /^\*\*Next step:\*\*\s*(.+)$/m.exec(body)?.[1]?.trim().replace(/[*_`]/g, "")
    return {
      track,
      slug,
      title: field("title") ?? slug,
      status: field("status") ?? "unknown",
      next: next ? (next.length > NEXT_MAX_CHARS ? `${next.slice(0, NEXT_MAX_CHARS - 1)}…` : next) : null,
    }
  }
  return null
}
