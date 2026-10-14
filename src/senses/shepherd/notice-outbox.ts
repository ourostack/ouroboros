import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { withFileLock } from "../../heart/file-lock"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactSecrets } from "./redact"
import { shepherdStateDir, type ReturnRecord } from "./returns"

export type NoticeDeliveryState = "pending" | "sent" | "unknown"
export interface NoticeDelivery {
  state: NoticeDeliveryState
  at: string
  attempts: number
  reason?: string
  messageId?: string
}
export interface NoticeOutboxEntry {
  id: string
  record: ReturnRecord
  deliveries: Record<string, NoticeDelivery>
}
const MAX_BYTES = 2 * 1024 * 1024
const RECENT_SENT = 256
const STATES = new Set<string>(["pending", "sent", "unknown"])
const KINDS = new Set<string>(["premature", "gate", "done", "working", "waiting", "unclear", "error", "loop_guard"])
const fileFor = (root: string) => path.join(shepherdStateDir(root), "notice-outbox.json")
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string"

function isReturn(value: unknown): value is ReturnRecord {
  return object(value)
    && ["at", "host", "session", "transition", "kind", "action", "reason"].every(key => typeof value[key] === "string")
    && KINDS.has(String(value.kind)) && ["respond", "let_through"].includes(String(value.action))
    && ["agent", "cwd", "task", "reply"].every(key => nullableString(value[key]))
    && ["latencyMs", "inputTokens"].every(key => value[key] === null || typeof value[key] === "number")
    && (value.title === undefined || typeof value.title === "string")
    && (value.workspaceTitle === undefined || nullableString(value.workspaceTitle))
}

function isDelivery(value: unknown): value is NoticeDelivery {
  return object(value) && typeof value.state === "string" && STATES.has(value.state)
    && typeof value.at === "string" && Number.isSafeInteger(value.attempts) && Number(value.attempts) >= 0
    && (value.reason === undefined || typeof value.reason === "string")
    && (value.messageId === undefined || typeof value.messageId === "string")
}

export function noticeRecordId(record: ReturnRecord): string {
  return createHash("sha256").update(JSON.stringify([record.host, record.session, record.transition, record.at])).digest("hex")
}

export function readNoticeOutbox(root: string): NoticeOutboxEntry[] {
  let raw: string
  try { raw = fs.readFileSync(fileFor(root), "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Shepherd notice outbox exceeds its 2 MiB limit")
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new Error("Shepherd notice outbox is malformed JSON") }
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("invalid Shepherd notice outbox schema")
  const entries: NoticeOutboxEntry[] = []
  const seen = new Set<string>()
  for (const entry of value.entries) {
    if (!object(entry) || typeof entry.id !== "string" || !isReturn(entry.record)
      || !object(entry.deliveries) || !Object.values(entry.deliveries).every(isDelivery)
      || entry.id !== noticeRecordId(entry.record) || seen.has(entry.id)) throw new Error("invalid Shepherd notice outbox entry")
    seen.add(entry.id)
    entries.push({ id: entry.id, record: entry.record, deliveries: entry.deliveries as Record<string, NoticeDelivery> })
  }
  return entries
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("Shepherd notice outbox exceeds its 2 MiB limit")
  const temp = `${file}.${randomUUID()}.tmp`
  const fd = fs.openSync(temp, "wx", 0o600)
  try {
    fs.writeFileSync(fd, encoded)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
}

function persist(root: string, entries: NoticeOutboxEntry[]): void {
  const sent = entries.filter(entry => Object.keys(entry.deliveries).length > 0 && Object.values(entry.deliveries).every(value => value.state === "sent"))
  const older = sent.slice(0, Math.max(0, sent.length - RECENT_SENT))
  const ids = new Set(older.map(entry => entry.id))
  // Archive acceptances before removing their payloads from the active snapshot.
  for (const entry of older) atomicWrite(path.join(shepherdStateDir(root), "notice-receipts", `${entry.id}.json`), entry)
  atomicWrite(fileFor(root), { schemaVersion: 1, entries: entries.filter(entry => !ids.has(entry.id)) })
}

function archived(root: string, id: string): NoticeOutboxEntry | undefined {
  const file = path.join(shepherdStateDir(root), "notice-receipts", `${id}.json`)
  let raw: string
  try { raw = fs.readFileSync(file, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const value: unknown = JSON.parse(raw)
  if (!object(value) || value.id !== id || !isReturn(value.record) || !object(value.deliveries)
    || !Object.values(value.deliveries).every(isDelivery)) throw new Error("invalid archived Shepherd notice receipt")
  return { id, record: value.record, deliveries: value.deliveries as Record<string, NoticeDelivery> }
}

function mutate<T>(root: string, change: (entries: NoticeOutboxEntry[]) => T): Promise<T> {
  const dir = shepherdStateDir(root)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return withFileLock(dir, "notice-outbox", () => {
    const entries = readNoticeOutbox(root)
    const result = change(entries)
    persist(root, entries)
    return result
  }, { waitMs: 1000 })
}

export function enqueueNotice(root: string, record: ReturnRecord): Promise<string> {
  if (!isReturn(record)) return Promise.reject(new Error("invalid Shepherd return for a notice"))
  const redacted: ReturnRecord = {
    ...record,
    reason: redactSecrets(record.reason),
    reply: record.reply === null ? null : redactSecrets(record.reply),
    ...(record.title !== undefined ? { title: redactSecrets(record.title) } : {}),
    ...(record.workspaceTitle !== undefined && record.workspaceTitle !== null ? { workspaceTitle: redactSecrets(record.workspaceTitle) } : {}),
  }
  const normalized: unknown = JSON.parse(JSON.stringify(redacted))
  if (!isReturn(normalized)) return Promise.reject(new Error("invalid normalized Shepherd return for a notice"))
  const safe = normalized
  const id = noticeRecordId(safe)
  return mutate(root, entries => {
    const existing = entries.find(entry => entry.id === id) ?? archived(root, id)
    if (existing && !isDeepStrictEqual(existing.record, safe)) throw new Error("the same return has a different notice body")
    if (!existing) entries.push({ id, record: safe, deliveries: {} })
    return id
  }).then(value => {
    emitNervesEvent({ component: "senses", event: "senses.shepherd_notice_queued", message: "persisted a Shepherd owner notice intent", meta: { id } })
    return value
  })
}

export function noticeDeliveryState(entry: NoticeOutboxEntry, friendId: string): NoticeDeliveryState {
  return Object.hasOwn(entry.deliveries, friendId) ? entry.deliveries[friendId]!.state : "pending"
}

export function knownNotice(root: string, id: string, entries: readonly NoticeOutboxEntry[]): NoticeOutboxEntry | undefined {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`unknown notice: ${id}`)
  return entries.find(value => value.id === id) ?? archived(root, id)
}

function validTarget(friendId: string): boolean {
  return !!friendId && !["__proto__", "constructor", "prototype"].includes(friendId)
}

function selectedEntries(root: string, entries: NoticeOutboxEntry[], ids: readonly string[]): NoticeOutboxEntry[] {
  return ids.map(id => {
    const entry = knownNotice(root, id, entries)
    if (!entry) throw new Error(`unknown notice: ${id}`)
    return entry
  })
}

export function declareNoticeTargets(root: string, ids: readonly string[], friendIds: readonly string[], at: string): Promise<void> {
  if (!friendIds.every(validTarget)) return Promise.reject(new Error("invalid notice target"))
  return mutate(root, entries => {
    for (const entry of selectedEntries(root, entries, ids)) {
      if (!entries.includes(entry) && friendIds.some(friendId => !Object.hasOwn(entry.deliveries, friendId))) throw new Error("notice is already settled; it cannot acquire new recipients")
      for (const friendId of friendIds) {
        if (!Object.hasOwn(entry.deliveries, friendId)) entry.deliveries[friendId] = { state: "pending", at, attempts: 0 }
      }
    }
  })
}

/** Claim under the same cross-process lock as receipts, before any transport side effect. */
export function claimPendingNotices(root: string, ids: readonly string[], friendId: string, at: string): Promise<NoticeOutboxEntry[]> {
  if (!validTarget(friendId)) return Promise.reject(new Error("invalid notice target"))
  return mutate(root, entries => {
    const claimed = selectedEntries(root, entries, ids).filter(entry => noticeDeliveryState(entry, friendId) === "pending")
    for (const entry of claimed) {
      if (!entries.includes(entry)) throw new Error("notice is already settled; it cannot acquire new recipients")
      entry.deliveries[friendId] = {
        state: "unknown", at, reason: "awaiting transport acceptance", attempts: (entry.deliveries[friendId]?.attempts ?? 0) + 1,
      }
    }
    return claimed
  })
}

export function recordNoticeDelivery(
  root: string, ids: readonly string[], friendId: string,
  receipt: Omit<NoticeDelivery, "attempts">,
): Promise<void> {
  if (!validTarget(friendId)) return Promise.reject(new Error("invalid notice target"))
  return mutate(root, entries => {
    let updated = 0
    for (const entry of selectedEntries(root, entries, ids)) {
      if (!entries.includes(entry) && !Object.hasOwn(entry.deliveries, friendId)) throw new Error("notice is already settled; it cannot acquire new recipients")
      const previous = Object.hasOwn(entry.deliveries, friendId) ? entry.deliveries[friendId] : undefined
      // A late failure cannot erase an acceptance another worker already recorded.
      if (previous?.state === "sent") continue
      entry.deliveries[friendId] = {
        ...receipt,
        ...(receipt.reason ? { reason: redactSecrets(receipt.reason) } : {}),
        attempts: previous?.state === "unknown" ? previous.attempts : (previous?.attempts ?? 0) + 1,
      }
      updated += 1
    }
    return updated
  }).then(updated => {
    if (updated > 0) emitNervesEvent({ component: "senses", event: "senses.shepherd_notice_receipt", message: "persisted a Shepherd owner notice delivery outcome", meta: { friendId, state: receipt.state, notices: updated } })
  })
}
