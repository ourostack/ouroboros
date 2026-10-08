import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * A peer outbox holds messages this agent has addressed to one A2A friend. A2A peers are clients with no channel back
 * to them, so the agent keeps what it has to say and the peer pulls it (`outbox/list`) and clears it (`outbox/ack`).
 * Each peer has its own directory, `state/outbox/<friendId>/<id>.json`; every call here is scoped to one friend id that
 * the server took from a verified signature, never from the request.
 */
export interface OutboxEntry {
  id: string
  kind: string
  createdAt: string
  body: string
  meta?: Record<string, unknown>
}

export interface OutboxListing {
  entries: OutboxEntry[]
  /** The id of the last entry returned, or null when nothing is left after `since`. */
  nextCursor: string | null
  more: boolean
}

export const OUTBOX_MAX_ENTRIES = 500
export const OUTBOX_MAX_BODY_CHARS = 6_000
export const OUTBOX_LIST_DEFAULT_LIMIT = 20
export const OUTBOX_LIST_MAX_LIMIT = 50
/** One listing reply is a single sealed message of at most 16,000 characters, so a listing stops filling well before that. */
export const OUTBOX_LIST_MAX_CHARS = 12_000

const FRIEND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const ENTRY_ID = /^\d{13}-[0-9a-f]{6}$/u

export function isOutboxEntryId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_ID.test(value)
}

function entryDir(agentRoot: string, friendId: string): string {
  if (!FRIEND_ID.test(friendId)) throw new Error("outbox friend id is invalid")
  return path.join(agentRoot, "state", "outbox", friendId)
}

export function outboxRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "outbox")
}

function readEntry(file: string): OutboxEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OutboxEntry>
    if (!isOutboxEntryId(parsed.id) || typeof parsed.kind !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.body !== "string") return null
    return { id: parsed.id, kind: parsed.kind, createdAt: parsed.createdAt, body: parsed.body, ...(parsed.meta ? { meta: parsed.meta } : {}) }
  } catch {
    return null
  }
}

function sortedIds(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith(".json") && isOutboxEntryId(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort()
}

export class FileOutboxStore {
  constructor(private readonly agentRoot: string) {}

  /** Adds one entry for `friendId`. The oldest entries beyond the cap are dropped so a peer that never reads cannot fill the disk. */
  append(friendId: string, input: { kind: string; body: string; meta?: Record<string, unknown> }, now: number = Date.now()): OutboxEntry {
    const dir = entryDir(this.agentRoot, friendId)
    fs.mkdirSync(dir, { recursive: true })
    const id = `${String(now).padStart(13, "0")}-${randomBytes(3).toString("hex")}`
    const entry: OutboxEntry = {
      id,
      kind: input.kind,
      createdAt: new Date(now).toISOString(),
      body: input.body.slice(0, OUTBOX_MAX_BODY_CHARS),
      ...(input.meta ? { meta: input.meta } : {}),
    }
    const file = path.join(dir, `${id}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    const ids = sortedIds(dir)
    for (const stale of ids.slice(0, Math.max(0, ids.length - OUTBOX_MAX_ENTRIES))) fs.rmSync(path.join(dir, `${stale}.json`), { force: true })
    emitNervesEvent({
      component: "senses",
      event: "senses.a2a_outbox_appended",
      message: "queued a message in a peer outbox",
      meta: { friendId, entryId: id, kind: input.kind },
    })
    return entry
  }

  /** Entries after `since` (exclusive), oldest first, within the count and size limits. */
  list(friendId: string, options: { since?: string; limit?: number } = {}): OutboxListing {
    const dir = entryDir(this.agentRoot, friendId)
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? OUTBOX_LIST_DEFAULT_LIMIT)), OUTBOX_LIST_MAX_LIMIT)
    const since = options.since ?? ""
    const ids = sortedIds(dir).filter((id) => id > since)
    const entries: OutboxEntry[] = []
    let chars = 0
    let more = false
    for (const id of ids) {
      const entry = readEntry(path.join(dir, `${id}.json`))
      if (!entry) continue
      const size = JSON.stringify(entry).length
      if (entries.length >= limit || (entries.length > 0 && chars + size > OUTBOX_LIST_MAX_CHARS)) { more = true; break }
      entries.push(entry)
      chars += size
    }
    return { entries, nextCursor: entries.length > 0 ? entries[entries.length - 1]!.id : null, more }
  }

  /** Removes the named entries from this friend's outbox only; ids that are malformed or not there come back as unknown. */
  ack(friendId: string, ids: string[]): { acked: string[]; unknown: string[] } {
    const dir = entryDir(this.agentRoot, friendId)
    const acked: string[] = []
    const unknown: string[] = []
    for (const id of ids) {
      const file = isOutboxEntryId(id) ? path.join(dir, `${id}.json`) : null
      if (file && fs.existsSync(file)) {
        fs.rmSync(file, { force: true })
        acked.push(id)
      } else {
        unknown.push(id)
      }
    }
    if (acked.length > 0) {
      emitNervesEvent({
        component: "senses",
        event: "senses.a2a_outbox_acked",
        message: "a peer cleared entries from its outbox",
        meta: { friendId, count: acked.length },
      })
    }
    return { acked, unknown }
  }
}
