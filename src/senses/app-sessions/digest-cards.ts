import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
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
  /** Where the work can be followed without reaching its machine: the repository, branch and pull request the card names. */
  repo?: string
  branch?: string
  pr?: string
  /** The session or coordinator the card names as running it. */
  session?: string
  /** The card file and when it last changed, so a reader can open the desk log and judge its age. */
  file: string
  /** The shared desk repository (its remote URL) the relative `file` lives in, when the desk root is a git checkout with a remote. */
  deskRepo?: string
  updatedAt: string | null
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
function scan(id: string, entry: FocusEntry | undefined, maxBytes: number, options: AppSessionsOptions = {}): { entry: FocusEntry; bytes: number } {
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

/** `scan` with a record of how much history was read and whether a task was found, so the digest's cost is visible. */
export function scanFocus(id: string, entry: FocusEntry | undefined, maxBytes: number, options: AppSessionsOptions = {}): { entry: FocusEntry; bytes: number } {
  const scanned = scan(id, entry, maxBytes, options)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_focus_scanned", message: "scanned a session's history for its declared task", meta: { bytes: scanned.bytes, first: entry === undefined, found: !!scanned.entry.track } })
  return scanned
}

const unquote = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "")

/** The indented lines under a top-level front-matter key, or an empty list. */
function block(front: string, key: string): string[] {
  const lines = front.split("\n")
  const start = lines.findIndex(line => line.startsWith(`${key}:`))
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith("- ")) break
    out.push(line)
  }
  return out
}

/** The `- key: value` items of a block list, each as its simple key/value pairs. */
function items(lines: string[]): Array<Record<string, string>> {
  const result: Array<Record<string, string>> = []
  for (const line of lines) {
    const entry = /^(\s*)-\s+(.*)$/.exec(line)
    const text = entry ? entry[2]! : line.trim()
    if (entry) result.push({})
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(text)
    if (pair && result.length > 0) result[result.length - 1]![pair[1]!] = unquote(pair[2]!.replace(/\s+#.*$/, ""))
  }
  return result
}

/** The values of a front-matter list, written inline (`[a, b]`) or as a block of `- value` lines. */
function listValues(front: string, key: string): string[] {
  const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]`, "m").exec(front)?.[1]
  if (inline !== undefined) return inline.split(",").map(unquote).filter(Boolean)
  return block(front, key).map(line => /^\s*-\s+(.+)$/.exec(line)?.[1]).filter((v): v is string => !!v).map(v => unquote(v.replace(/\s+#.*$/, "")))
}

const githubRepo = (url: string): string | undefined => /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1]

/**
 * Where the work a card describes can be followed: the repository, branch, pull request and session. It reads the
 * canonical v1 card (`repos[]`, `evidence.ref`, `artifacts`, `iterations`, `bridge_sessions`, and the `branch:<owner/repo>#<name>`
 * rows of `## Resources`, per Desk's task-card-format) and, for compatibility, flat `repo`, `branch`, `pr`/`pr_url` and
 * `session`/`session_id` fields, which win when present.
 */
function pointers(front: string, body: string, field: (name: string) => string | null): Pick<CardFacts, "repo" | "branch" | "pr" | "session"> {
  const repos = items(block(front, "repos"))
  const history = items(block(front, "iterations").filter(line => /^\s{2,}(?:-\s|[a-z]+:\s)/.test(line) && !/^\s*(active|history):/.test(line)))
  const evidence = block(front, "evidence").join("\n")
  const slugOf = (name: string | undefined): string | undefined => {
    const entry = repos.find(r => r.name === name)
    return (entry?.url ? githubRepo(entry.url) : undefined) ?? name
  }
  const branchRow = [...body.matchAll(/`?branch:([^\s#|`]+)#([^\s|`]+)`?/g)].pop()
  const active = /^\s+active:\s*(\S.*)$/m.exec(block(front, "iterations").join("\n"))?.[1]?.trim()
  const current = history.filter(h => h.pr && h.pr !== "null").find(h => active && h.path && unquote(active).endsWith(h.path.replace(/^\.\//, ""))) ?? [...history].reverse().find(h => h.pr && h.pr !== "null")
  const pullUrl = (evidence.match(/ref:\s*(\S*\/pull\/\d+\S*)/)?.[1]) ?? [...listValues(front, "artifacts")].reverse().find(v => /\/pull\/\d+/.test(v))
  const repo = field("repo") ?? (branchRow ? branchRow[1] : undefined) ?? (pullUrl ? githubRepo(pullUrl) : undefined) ?? slugOf(current?.repo ?? repos[0]?.name)
  const pr = field("pr") ?? field("pr_url") ?? pullUrl ?? (current && repo ? `https://github.com/${repo}/pull/${current.pr}` : undefined)
  const branch = field("branch") ?? branchRow?.[2]
  const session = field("session") ?? field("session_id") ?? listValues(front, "bridge_sessions")[0]
  return { ...(repo ? { repo } : {}), ...(branch ? { branch } : {}), ...(pr ? { pr } : {}), ...(session ? { session } : {}) }
}

/** The origin URL of the desk root's git checkout, or null when it has no remote. */
function deskRemote(root: string): string | null {
  try {
    const config = fs.readFileSync(path.join(root, ".git", "config"), "utf-8")
    return /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] ?? null
  } catch {
    return null
  }
}

/** The card at `<root>/<track>/<slug>/task.md`, or archived beside it, in the first desk root that has it: its title, status and next step. */
export function readCard(roots: string[], track: string, slug: string): CardFacts | null {
  for (const root of roots) {
    const found = [path.join(root, track, slug, "task.md"), path.join(root, track, "_archive", slug, "task.md")].map(file => {
      try {
        return { file, body: fs.readFileSync(file, "utf-8"), updatedAt: fs.statSync(file).mtime.toISOString() }
      } catch {
        return null
      }
    }).find(entry => entry !== null)
    if (found === undefined) continue
    const { body } = found
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
      ...pointers(front, body, field),
      file: path.relative(root, found.file).split(path.sep).join("/"),
      ...(deskRemote(root) ? { deskRepo: deskRemote(root)! } : {}),
      updatedAt: found.updatedAt,
    }
  }
  return null
}
