import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactSecrets } from "./redact"
import { shepherdStateDir, type ReturnRecord } from "./returns"
import type { ShepherdSession } from "./surface"

export interface FeedbackSource extends ShepherdSession { tty: string; cwd: string | null; task: string | null }
export interface FeedbackRecipient { friendId: string; aadObjectId: string; tenantId: string | null }
export interface FeedbackInput {
  id: string
  actorId: string
  agent: string
  bodyHash: string
  createdAt: string
  source: FeedbackSource
  packet: { feedback: string; context: string | null; screen: string; previousReturn: ReturnRecord | null }
  recipient: FeedbackRecipient
  receipt: string
}
export interface FeedbackRecord extends FeedbackInput {
  review: { state: "pending" | "claimed" | "complete" | "uncertain"; owner: string | null; response: string | null; reason: string | null }
  delivery: { state: "pending" | "unknown" | "sent"; owner: string | null; attempts: number;
    conversationId: string | null; messageId: string | null; reason: string | null }
}
export interface FeedbackDelivery {
  state: FeedbackRecord["delivery"]["state"]
  conversationId?: string
  messageId?: string
  reason?: string
}
export interface FeedbackStore {
  read(id: string, actorId: string): FeedbackRecord | null
  submit(input: FeedbackInput): FeedbackRecord
  pending(): FeedbackRecord[]
  claimReview(id: string, actorId: string, owner: string): FeedbackRecord | null
  completeReview(id: string, actorId: string, owner: string, response: string, uncertainty?: string): void
  claimDelivery(id: string, actorId: string, owner: string): FeedbackRecord | null
  completeDelivery(id: string, actorId: string, owner: string, delivery: FeedbackDelivery): void
  findReply(actorId: string, conversationId: string, messageId: string): FeedbackRecord | null
  hasReply(messageId: string): boolean
  close(): void
}
interface Row { id: string; actor: string; body_hash: string; data: string | null; archive_hash: string | null }
const MAX_BYTES = 65536
const FUTURE_BYTES = 24576
const MAX_RESPONSE = 16384
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const nullable = (value: unknown): value is string | null => value === null || typeof value === "string"
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function refuse(reason: string): never {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_feedback_store_refused",
    message: "feedback custody operation refused", meta: { reason } })
  throw new Error(`Shepherd feedback: ${reason}`)
}
function bounded(value: unknown, limit: number, field: string): asserts value is string {
  if (!text(value) || bytes(value) > limit) refuse(`${field} byte limit or type`)
}
function validReturn(value: unknown): value is ReturnRecord {
  return object(value) && ["at", "host", "session", "transition", "reason"].every(key => typeof value[key] === "string") &&
    ["agent", "cwd", "task", "reply"].every(key => nullable(value[key])) &&
    ["latencyMs", "inputTokens"].every(key => value[key] === null || typeof value[key] === "number" && Number.isFinite(value[key])) &&
    ["premature", "gate", "done", "working", "waiting", "unclear", "error", "loop_guard"].includes(String(value.kind)) &&
    ["respond", "let_through"].includes(String(value.action))
}
function validInput(value: unknown): value is FeedbackInput {
  if (!object(value) || !text(value.id) || !value.id.startsWith("feedback:") || !UUID.test(value.id.slice(9)) ||
    !text(value.actorId) || !text(value.agent) || !text(value.bodyHash) || !/^[a-f0-9]{64}$/.test(value.bodyHash) ||
    !text(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || !text(value.receipt)) return false
  const source = value.source, packet = value.packet, recipient = value.recipient
  return object(source) && text(source.id) && UUID.test(source.id) && source.host === "cmux" &&
    text(source.label) && text(source.tty) && /^\/dev\/(?:tty[s]?[A-Za-z0-9]+|pts\/[0-9]+)$/.test(source.tty) &&
    nullable(source.cwd) && nullable(source.task) && object(packet) && text(packet.feedback) &&
    nullable(packet.context) && typeof packet.screen === "string" && (packet.previousReturn === null || validReturn(packet.previousReturn)) &&
    object(recipient) && recipient.friendId === value.actorId && text(recipient.aadObjectId) && nullable(recipient.tenantId)
}
function validRecord(value: unknown): value is FeedbackRecord {
  if (!object(value) || !validInput(value)) return false
  const review = value.review, delivery = value.delivery
  if (!object(review) || !object(delivery)) return false
  const shape = ["pending", "claimed", "complete", "uncertain"].includes(String(review.state)) &&
    nullable(review.owner) && nullable(review.response) && nullable(review.reason) &&
    ["pending", "unknown", "sent"].includes(String(delivery.state)) &&
    nullable(delivery.owner) && Number.isSafeInteger(delivery.attempts) && Number(delivery.attempts) >= 0 &&
    nullable(delivery.conversationId) && nullable(delivery.messageId) && nullable(delivery.reason)
  if (!shape) return false
  const reviewPhase = review.state === "pending" ? review.owner === null && review.response === null && review.reason === null
    : review.state === "claimed" ? text(review.owner) && review.response === null && review.reason === null
    : text(review.owner) && text(review.response) && (review.state === "complete" ? review.reason === null : text(review.reason))
  const deliveryPhase = delivery.state === "pending" ? delivery.owner === null
    : Number(delivery.attempts) > 0 && text(review.response) &&
      (delivery.state === "sent" ? delivery.owner === null && text(delivery.conversationId) && text(delivery.messageId)
        : (delivery.owner === null || text(delivery.owner)) && text(delivery.reason))
  return reviewPhase && deliveryPhase
}
function parse(encoded: string): FeedbackRecord {
  if (Buffer.byteLength(encoded) > MAX_BYTES) refuse("record byte limit")
  const value: unknown = JSON.parse(encoded)
  if (!validRecord(value)) refuse("invalid record schema")
  return value
}
function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) {
    refuse("private directory ownership or mode")
  }
}
function privateFile(file: string): void {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) {
    refuse("private file ownership or mode")
  }
}
function readArchive(file: string): string {
  privateFile(file)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (stat.size > MAX_BYTES) refuse("archive byte limit")
    const encoded = fs.readFileSync(fd, "utf8")
    const named = fs.lstatSync(file)
    if (stat.ino !== named.ino || stat.dev !== named.dev || Buffer.byteLength(encoded) > MAX_BYTES) refuse("archive changed")
    return encoded
  } finally { fs.closeSync(fd) }
}

export function feedbackStorePath(agentRoot: string): string {
  return path.join(shepherdStateDir(agentRoot), "feedback", "queue.sqlite")
}

export function openFeedbackStore(file: string): FeedbackStore {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) refuse("database path")
  privateDirectory(path.dirname(file))
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    fs.closeSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  privateFile(file)
  const database = new Database(file)
  try {
    const version = database.pragma("user_version", { simple: true })
    if (version !== 0 && version !== 1) refuse("unsupported database schema")
    database.pragma("journal_mode = DELETE")
    database.pragma("busy_timeout = 1000")
    database.exec(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT NOT NULL, actor TEXT NOT NULL, body_hash TEXT NOT NULL, data TEXT,
      archive_hash TEXT, conversation TEXT, message TEXT, PRIMARY KEY (actor, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_reply ON feedback(actor, conversation, message)
      WHERE conversation IS NOT NULL AND message IS NOT NULL;`)
    database.pragma("user_version = 1")
  } catch (error) { database.close(); throw error }
  const rowFor = (id: string, actorId: string): Row | undefined =>
    database.prepare("SELECT id, actor, body_hash, data, archive_hash FROM feedback WHERE id=? AND actor=?").get(id, actorId) as Row | undefined
  const archiveFor = (id: string, actorId: string) => path.join(path.dirname(file), "receipts", `${digest(JSON.stringify([actorId, id]))}.json`)
  function read(id: string, actorId: string): FeedbackRecord | null {
    const row = rowFor(id, actorId)
    if (!row) return null
    const encoded = row.data ?? readArchive(archiveFor(id, actorId))
    if (row.data === null && digest(encoded) !== row.archive_hash) refuse("archive fingerprint")
    const record = parse(encoded)
    if (record.id !== id || record.actorId !== actorId || record.bodyHash !== row.body_hash) refuse("record identity")
    return record
  }
  function write(record: FeedbackRecord): void {
    const encoded = JSON.stringify(record)
    parse(encoded)
    let data: string | null = encoded
    let archiveHash: string | null = null
    if (record.delivery.state === "sent") {
      const archive = archiveFor(record.id, record.actorId)
      privateDirectory(path.dirname(archive))
      try {
        const fd = fs.openSync(archive, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
        try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (readArchive(archive) !== encoded) refuse("archive conflict")
      }
      data = null
      archiveHash = digest(encoded)
    }
    database.prepare(`INSERT INTO feedback(id,actor,body_hash,data,archive_hash,conversation,message) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(actor,id) DO UPDATE SET data=excluded.data,archive_hash=excluded.archive_hash,
      conversation=excluded.conversation,message=excluded.message`).run(record.id, record.actorId, record.bodyHash, data, archiveHash,
      record.delivery.conversationId, record.delivery.messageId)
  }
  const transact = <T>(work: () => T): T => database.transaction(work).immediate()
  const owned = (id: string, actorId: string): FeedbackRecord => read(id, actorId) ?? refuse("unknown request")
  emitNervesEvent({ component: "senses", event: "senses.shepherd_feedback_store_opened",
    message: "opened private feedback custody", meta: { status: "ready" } })
  return {
    read,
    submit(input) {
      if (!validInput(input)) refuse("invalid input schema")
      bounded(input.actorId, 512, "actor")
      bounded(input.agent, 256, "agent")
      bounded(input.receipt, 4096, "receipt")
      if (input.packet.feedback.length > 2000 || bytes(input.packet.context) > 8192 || bytes(input.packet.screen) > 16384) refuse("packet limit")
      return transact(() => {
        const prior = read(input.id, input.actorId)
        if (prior) {
          if (prior.bodyHash !== input.bodyHash) refuse("request ID has a different body")
          return prior
        }
        const count = database.prepare("SELECT COUNT(*) AS count FROM feedback WHERE data IS NOT NULL").get() as { count: number }
        if (count.count >= 512) refuse("hot queue capacity")
        const record: FeedbackRecord = { ...structuredClone(input),
          review: { state: "pending", owner: null, response: null, reason: null },
          delivery: { state: "pending", owner: null, attempts: 0, conversationId: null, messageId: null, reason: null } }
        if (bytes(record) + FUTURE_BYTES > MAX_BYTES) refuse("reserved response capacity")
        write(record)
        return structuredClone(record)
      })
    },
    pending() {
      const rows = database.prepare("SELECT id,actor FROM feedback WHERE data IS NOT NULL ORDER BY rowid").all() as Array<{ id: string; actor: string }>
      return rows.map(row => owned(row.id, row.actor)).filter(record => record.review.state === "pending" ||
        record.review.response !== null && record.delivery.state === "pending")
    },
    claimReview(id, actorId, owner) {
      bounded(owner, 256, "review owner")
      return transact(() => {
        const record = owned(id, actorId)
        if (record.review.state !== "pending") return null
        record.review = { ...record.review, state: "claimed", owner }
        write(record)
        return record
      })
    },
    completeReview(id, actorId, owner, response, uncertainty) {
      bounded(response, MAX_RESPONSE, "response")
      if (uncertainty !== undefined) bounded(uncertainty, 2048, "uncertainty")
      transact(() => {
        const record = owned(id, actorId)
        if (record.review.state !== "claimed" || record.review.owner !== owner) refuse("review owner changed")
        record.review = { state: uncertainty === undefined ? "complete" : "uncertain", owner,
          response: redactSecrets(response), reason: uncertainty === undefined ? null : redactSecrets(uncertainty) }
        write(record)
      })
    },
    claimDelivery(id, actorId, owner) {
      bounded(owner, 256, "delivery owner")
      return transact(() => {
        const record = owned(id, actorId)
        if (!record.review.response || record.delivery.state !== "pending") return null
        record.delivery = { ...record.delivery, state: "unknown", owner, attempts: record.delivery.attempts + 1,
          reason: "awaiting transport acceptance" }
        write(record)
        return record
      })
    },
    completeDelivery(id, actorId, owner, delivery) {
      if (!["sent", "pending", "unknown"].includes(delivery.state)) refuse("delivery state")
      if (delivery.reason !== undefined) bounded(delivery.reason, 2048, "delivery reason")
      if (delivery.conversationId !== undefined) bounded(delivery.conversationId, 2048, "conversation")
      if (delivery.messageId !== undefined) bounded(delivery.messageId, 1024, "message")
      if (delivery.state === "sent" && (!delivery.conversationId || !delivery.messageId)) refuse("missing transport receipt")
      transact(() => {
        const record = owned(id, actorId)
        if (record.delivery.state !== "unknown" || record.delivery.owner !== owner) refuse("delivery owner changed")
        record.delivery = { ...record.delivery, state: delivery.state, owner: null,
          conversationId: delivery.conversationId ?? null, messageId: delivery.messageId ?? null,
          reason: delivery.reason === undefined ? null : redactSecrets(delivery.reason) }
        write(record)
      })
    },
    findReply(actorId, conversationId, messageId) {
      const row = database.prepare("SELECT id FROM feedback WHERE actor=? AND conversation=? AND message=?")
        .get(actorId, conversationId, messageId) as { id: string } | undefined
      return row ? read(row.id, actorId) : null
    },
    hasReply(messageId) {
      return database.prepare("SELECT 1 FROM feedback WHERE message=? LIMIT 1").get(messageId) !== undefined
    },
    close() { if (database.open) database.close() },
  }
}
