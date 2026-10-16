import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { emitNervesEvent } from "../../nerves/runtime"
import { shepherdStateDir } from "./returns"

export interface DispatchInput {
  host: string
  session: string
  instance: string | null
  screenFingerprint: string
  guidanceRevision: string
  reply: string
  trigger: "immediate" | "network" | "periodic"
  transition: string
  at: string
}
export interface DispatchClaim extends DispatchInput {
  id: string
  owner: string
  state: "claimed" | "sent" | "not_sent" | "unknown"
  reason?: string
}
export interface DispatchResult { state: "sent" | "not_sent" | "unknown"; reason?: string }
export interface CheckInStore {
  claimDispatch(input: DispatchInput, owner: string): DispatchClaim | null
  completeDispatch(id: string, owner: string, result: DispatchResult): void
  shouldNotify(signature: string): boolean
  markNotified(signature: string, at: string): void
  close(): void
}

interface DispatchRow { id: string; host: string; session: string; instance: string | null; data: string }
interface Notice { signature: string; at: string }
const MAX_ROW = 4096
const MAX_DB = 64 * 1024 * 1024
const WARN_DB = 48 * 1024 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
function refuse(reason: string): never {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_checkin_store_refused",
    message: "check-in custody operation refused", meta: { reason } })
  throw new Error(`Shepherd check-in custody: ${reason}`)
}
function bounded(value: unknown, limit: number, field: string): asserts value is string {
  if (!text(value) || bytes(value) > limit) refuse(`${field} byte limit or type`)
}
function validInput(value: unknown): value is DispatchInput {
  return object(value) && ["host", "session", "screenFingerprint", "guidanceRevision", "reply", "transition"].every(key => text(value[key])) &&
    (value.instance === null || text(value.instance)) && ["immediate", "network", "periodic"].includes(String(value.trigger)) && timestamp(value.at)
}
function dispatchId(input: DispatchInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.host, input.session, input.instance, input.screenFingerprint, input.guidanceRevision,
  ])).digest("hex")
}
function validClaim(value: unknown): value is DispatchClaim {
  return object(value) && validInput(value) && text(value.owner) && bytes(value.owner) <= 256 &&
    ["claimed", "sent", "not_sent", "unknown"].includes(String(value.state)) &&
    (value.reason === undefined || text(value.reason) && bytes(value.reason) <= 1024)
}
function parseDispatch(row: DispatchRow): DispatchClaim {
  if (Buffer.byteLength(row.data) > MAX_ROW) refuse("record byte limit")
  const value: unknown = JSON.parse(row.data)
  if (!validClaim(value) || value.id !== row.id || dispatchId(value) !== row.id || value.host !== row.host ||
    value.session !== row.session || value.instance !== row.instance) refuse("invalid dispatch schema")
  return value
}
function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) refuse("private directory ownership or mode")
}
function privateFile(file: string): void {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!()) refuse("private file ownership or mode")
}

export function checkInStorePath(agentRoot: string): string {
  return path.join(shepherdStateDir(agentRoot), "checkins", "custody.sqlite")
}

export function openCheckInStore(file: string): CheckInStore {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) refuse("database path")
  privateDirectory(path.dirname(file))
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    fs.closeSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  privateFile(file)
  const database = new Database(file, { fileMustExist: true })
  let warned = false
  function capacity(writing = false): void {
    const size = Number(database.pragma("page_count", { simple: true })) * Number(database.pragma("page_size", { simple: true }))
    if (size > MAX_DB || writing && size + 65536 > MAX_DB) refuse("database capacity; no input authorized")
    if (!warned && size >= WARN_DB) {
      warned = true
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_checkin_capacity_warning",
        message: "check-in custody is approaching capacity", meta: { bytes: size, limit: MAX_DB } })
    }
  }
  try {
    const version = database.pragma("user_version", { simple: true })
    if (version !== 0 && version !== 1) refuse("unsupported database schema")
    capacity()
    database.pragma("journal_mode = DELETE")
    database.pragma("busy_timeout = 1000")
    database.pragma(`max_page_count = ${Math.floor(MAX_DB / Number(database.pragma("page_size", { simple: true })))}`)
    database.exec(`CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY NOT NULL, host TEXT NOT NULL, session TEXT NOT NULL, instance TEXT, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dispatch_barriers ON dispatches(host,session,instance);
    CREATE TABLE IF NOT EXISTS notices (signature TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);`)
    database.pragma("user_version = 1")
  } catch (error) { database.close(); throw error }
  const transact = <T>(work: () => T): T => database.transaction(() => { capacity(true); return work() }).immediate()
  function write(record: DispatchClaim): void {
    const data = JSON.stringify(record)
    if (Buffer.byteLength(data) > MAX_ROW) refuse("record byte limit")
    database.prepare(`INSERT INTO dispatches(id,host,session,instance,data) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, record.host, record.session, record.instance, data)
  }
  function notice(signature: string): Notice | null {
    bounded(signature, MAX_ROW - 128, "signature")
    const row = database.prepare("SELECT data FROM notices WHERE signature=?").get(signature) as { data: string } | undefined
    if (!row) return null
    if (Buffer.byteLength(row.data) > MAX_ROW) refuse("notice byte limit")
    const value: unknown = JSON.parse(row.data)
    if (!object(value) || value.signature !== signature || !timestamp(value.at)) refuse("invalid notice schema")
    return { signature, at: value.at }
  }
  emitNervesEvent({ component: "senses", event: "senses.shepherd_checkin_store_opened",
    message: "opened private check-in custody", meta: { status: "ready" } })
  return {
    claimDispatch(input, owner) {
      if (!validInput(input)) refuse("invalid dispatch input schema")
      bounded(owner, 256, "owner")
      const record: DispatchClaim = { ...input, id: dispatchId(input), owner, state: "claimed" }
      if (bytes(record) + 1050 > MAX_ROW) refuse("reserved record byte limit")
      return transact(() => {
        const rows = database.prepare(`SELECT id,host,session,instance,data FROM dispatches
          WHERE id=? OR (host=? AND session=? AND (instance IS NULL OR ? IS NULL OR instance=?))`)
          .all(record.id, input.host, input.session, input.instance, input.instance) as DispatchRow[]
        for (const row of rows) {
          const prior = parseDispatch(row)
          if (prior.state === "claimed" || prior.state === "unknown" || prior.id === record.id && prior.state === "sent") return null
        }
        write(record)
        return record
      })
    },
    completeDispatch(id, owner, result) {
      bounded(owner, 256, "owner")
      if (!object(result) || !["sent", "not_sent", "unknown"].includes(result.state)) refuse("invalid completion state")
      if (result.reason !== undefined) bounded(result.reason, 1024, "reason")
      transact(() => {
        const row = database.prepare("SELECT id,host,session,instance,data FROM dispatches WHERE id=?").get(id) as DispatchRow | undefined
        if (!row) refuse("unknown dispatch owner")
        const prior = parseDispatch(row)
        if (prior.owner !== owner || prior.state !== "claimed") refuse("dispatch owner or phase mismatch")
        write({ ...prior, state: result.state, ...(result.reason === undefined ? {} : { reason: result.reason }) })
      })
    },
    shouldNotify(signature) { return notice(signature) === null },
    markNotified(signature, at) {
      bounded(signature, MAX_ROW - 128, "signature")
      if (!timestamp(at)) refuse("invalid notification timestamp")
      const data = JSON.stringify({ signature, at })
      if (Buffer.byteLength(data) > MAX_ROW) refuse("notice byte limit")
      transact(() => {
        if (!notice(signature)) database.prepare("INSERT INTO notices(signature,data) VALUES(?,?)").run(signature, data)
      })
    },
    close() { database.close() },
  }
}
