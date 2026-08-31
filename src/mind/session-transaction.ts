import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"

import { emitNervesEvent } from "../nerves/runtime"
import { probeHabitBootIdentity, probeHabitProcessStartedAt } from "../heart/habits/habit-lifecycle"

export class SessionTurnBusyError extends Error {
  readonly retryable = true

  constructor(message = "session turn is busy") {
    super(message)
    this.name = "SessionTurnBusyError"
  }
}

export class SessionTransactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionTransactionError"
  }
}

export interface SessionTurnLease {
  sessionPath: string
  ownerId: string
  ownerToken: string
  release(): Promise<void>
}

interface LeaseRecord {
  pid: number
  ownerId: string
  ownerToken: string
  bootIdentity: string | null
  processStartedAt: string | null
}

interface HeldLease extends LeaseRecord {
  sessionPath: string
  lockPath: string
  depth: number
  released: boolean
}

export interface AcquireSessionTurnLeaseOptions {
  ownerId?: string
  ownerToken?: string
  timeoutMs?: number
  pollIntervalMs?: number
  pid?: number
  isProcessAlive?: (pid: number) => boolean
  getBootIdentity?: () => string
  getProcessStartedAt?: (pid: number) => string | null
  onStaleLease?: (record: LeaseRecord) => void
}

export interface WriteSessionTransactionOptions {
  lease: SessionTurnLease
  expectedRevision: string
  hooks?: { beforeRename?: () => void }
}

const heldLeases = new Map<string, HeldLease>()
const leaseContext = new AsyncLocalStorage<SessionTurnLease>()

function canonicalSessionPath(sessionPath: string): string {
  return path.resolve(sessionPath)
}

function revision(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex")
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as Error & { code?: string }).code === "SQLITE_BUSY"
}

function openLeaseDatabase(lockPath: string, busyTimeoutMs = 0): Database.Database {
  const database = new Database(lockPath)
  database.pragma(`busy_timeout = ${busyTimeoutMs}`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_turn_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pid INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      owner_token TEXT NOT NULL
    )
  `)
  const columns = new Set((database.prepare(`PRAGMA table_info(session_turn_lease)`).all() as Array<{ name: string }>).map((column) => column.name))
  if (!columns.has("boot_identity")) database.exec(`ALTER TABLE session_turn_lease ADD COLUMN boot_identity TEXT`)
  if (!columns.has("process_started_at")) database.exec(`ALTER TABLE session_turn_lease ADD COLUMN process_started_at TEXT`)
  return database
}

function acquisitionRecord(options: AcquireSessionTurnLeaseOptions): LeaseRecord {
  const pid = options.pid ?? process.pid
  const bootIdentity = (options.getBootIdentity ?? probeHabitBootIdentity)()
  const processStartedAt = (options.getProcessStartedAt ?? probeHabitProcessStartedAt)(pid)
  if (!bootIdentity || !processStartedAt) throw new SessionTransactionError("current process identity is unavailable")
  return {
    pid,
    ownerId: options.ownerId ?? randomUUID(),
    ownerToken: options.ownerToken ?? randomUUID(),
    bootIdentity,
    processStartedAt,
  }
}

function claimLeaseRecord(
  lockPath: string,
  record: LeaseRecord,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartedAt: (pid: number) => string | null,
): { acquired: boolean; stale: LeaseRecord | null } {
  const database = openLeaseDatabase(lockPath)
  try {
    return database.transaction(() => {
      const current = database.prepare(`
        SELECT pid, owner_id, owner_token, boot_identity, process_started_at FROM session_turn_lease WHERE singleton = 1
      `).get() as { pid: number; owner_id: string; owner_token: string; boot_identity: unknown; process_started_at: unknown } | undefined
      if (!current) {
        database.prepare(`
          INSERT INTO session_turn_lease (singleton, pid, owner_id, owner_token, boot_identity, process_started_at) VALUES (1, ?, ?, ?, ?, ?)
        `).run(record.pid, record.ownerId, record.ownerToken, record.bootIdentity, record.processStartedAt)
        return { acquired: true, stale: null }
      }
      if (!Number.isSafeInteger(current.pid) || current.pid <= 0
        || typeof current.owner_id !== "string" || current.owner_id.length === 0
        || typeof current.owner_token !== "string" || current.owner_token.length === 0
        || !((current.boot_identity === null && current.process_started_at === null)
          || (typeof current.boot_identity === "string" && current.boot_identity.length > 0
            && typeof current.process_started_at === "string" && current.process_started_at.length > 0))) {
        throw new SessionTransactionError("invalid session lease record")
      }
      const observed: LeaseRecord = {
        pid: current.pid,
        ownerId: current.owner_id,
        ownerToken: current.owner_token,
        bootIdentity: current.boot_identity as string | null,
        processStartedAt: current.process_started_at as string | null,
      }
      const differentBoot = observed.bootIdentity !== null && observed.bootIdentity !== record.bootIdentity
      let differentProcess = false
      if (observed.bootIdentity !== null && !differentBoot) {
        const liveStartedAt = getProcessStartedAt(observed.pid)
        differentProcess = liveStartedAt !== null && liveStartedAt !== observed.processStartedAt
        if (liveStartedAt === observed.processStartedAt) return { acquired: false, stale: null }
      }
      if (!differentBoot && !differentProcess && isProcessAlive(observed.pid)) return { acquired: false, stale: null }
      const changed = database.prepare(`
        UPDATE session_turn_lease SET pid = ?, owner_id = ?, owner_token = ?, boot_identity = ?, process_started_at = ?
        WHERE singleton = 1 AND pid = ? AND owner_id = ? AND owner_token = ?
          AND boot_identity IS ? AND process_started_at IS ?
      `).run(record.pid, record.ownerId, record.ownerToken, record.bootIdentity, record.processStartedAt,
        observed.pid, observed.ownerId, observed.ownerToken, observed.bootIdentity, observed.processStartedAt).changes
      return changed === 1 ? { acquired: true, stale: observed } : { acquired: false, stale: null }
    })()
  } finally {
    database.close()
  }
}

function releaseLeaseRecord(lockPath: string, record: LeaseRecord): boolean {
  const database = openLeaseDatabase(lockPath, 5_000)
  try {
    return database.prepare(`
      DELETE FROM session_turn_lease WHERE singleton = 1 AND pid = ? AND owner_id = ? AND owner_token = ?
        AND boot_identity IS ? AND process_started_at IS ?
    `).run(record.pid, record.ownerId, record.ownerToken, record.bootIdentity, record.processStartedAt).changes === 1
  } finally {
    database.close()
  }
}

function makeLease(held: HeldLease): SessionTurnLease {
  let localReleased = false
  return {
    sessionPath: held.sessionPath,
    ownerId: held.ownerId,
    ownerToken: held.ownerToken,
    release: async () => {
      if (localReleased) return
      localReleased = true
      held.depth -= 1
      if (held.depth > 0 || held.released) return
      held.released = true
      releaseLeaseRecord(held.lockPath, held)
      heldLeases.delete(held.sessionPath)
      emitNervesEvent({
        component: "mind",
        event: "mind.session_turn_lease_released",
        message: "released session turn lease",
        meta: { sessionPath: held.sessionPath, ownerId: held.ownerId },
      })
    },
  }
}

export async function acquireSessionTurnLease(
  sessionPath: string,
  options: AcquireSessionTurnLeaseOptions = {},
): Promise<SessionTurnLease> {
  const canonical = canonicalSessionPath(sessionPath)
  const existing = heldLeases.get(canonical)
  if (existing && !existing.released) {
    if (options.ownerId === existing.ownerId && options.ownerToken === existing.ownerToken) {
      existing.depth += 1
      return makeLease(existing)
    }
  }

  const record = acquisitionRecord(options)
  const { ownerId } = record
  const timeoutMs = options.timeoutMs ?? 5_000
  const pollIntervalMs = options.pollIntervalMs ?? 10
  const isProcessAlive = options.isProcessAlive ?? processAlive
  const lockPath = `${canonical}.turn.lock`
  const started = Date.now()
  fs.mkdirSync(path.dirname(canonical), { recursive: true })

  for (;;) {
    let claim: ReturnType<typeof claimLeaseRecord> | null = null
    try {
      claim = claimLeaseRecord(lockPath, record, isProcessAlive, options.getProcessStartedAt ?? probeHabitProcessStartedAt)
    } catch (error) {
      if (!isSqliteBusy(error)) throw error
    }
    if (claim?.acquired) {
      const held: HeldLease = { sessionPath: canonical, lockPath, ...record, depth: 1, released: false }
      heldLeases.set(canonical, held)
      emitNervesEvent({
        component: "mind",
        event: "mind.session_turn_lease_acquired",
        message: "acquired session turn lease",
        meta: { sessionPath: canonical, ownerId },
      })
      if (claim.stale) {
        options.onStaleLease?.(claim.stale)
        emitNervesEvent({
          level: "warn",
          component: "mind",
          event: "mind.session_turn_lease_stolen",
          message: "stole stale session turn lease",
          meta: { sessionPath: canonical, stalePid: claim.stale.pid, staleOwnerId: claim.stale.ownerId },
        })
      }
      return makeLease(held)
    }
    if (Date.now() - started >= timeoutMs) {
      emitNervesEvent({
        level: "warn",
        component: "mind",
        event: "mind.session_turn_lease_busy",
        message: "session turn lease acquisition timed out",
        meta: { sessionPath: canonical, ownerId, timeoutMs },
      })
      throw new SessionTurnBusyError(`session turn busy: ${canonical}`)
    }
    await sleep(pollIntervalMs)
  }
}

export async function withSessionTurnLease<T>(
  sessionPath: string,
  work: (lease: SessionTurnLease) => Promise<T>,
  options: AcquireSessionTurnLeaseOptions = {},
): Promise<T> {
  const lease = await acquireSessionTurnLease(sessionPath, options)
  try {
    return await leaseContext.run(lease, () => work(lease))
  } finally {
    await lease.release()
  }
}

export function withImmediateSessionTurnLease<T>(
  sessionPath: string,
  work: (lease: SessionTurnLease) => T,
  options: Pick<AcquireSessionTurnLeaseOptions, "ownerId" | "ownerToken" | "pid" | "isProcessAlive" | "getBootIdentity" | "getProcessStartedAt" | "onStaleLease"> = {},
): T {
  const canonical = canonicalSessionPath(sessionPath)
  const contextual = currentSessionTurnLease(canonical)
  if (contextual) return work(contextual)
  const record = acquisitionRecord(options)
  const lockPath = `${canonical}.turn.lock`
  fs.mkdirSync(path.dirname(canonical), { recursive: true })
  const tryAcquire = (): HeldLease | null => {
    let claim: ReturnType<typeof claimLeaseRecord>
    try {
      claim = claimLeaseRecord(lockPath, record, options.isProcessAlive ?? processAlive, options.getProcessStartedAt ?? probeHabitProcessStartedAt)
    } catch (error) {
      if (isSqliteBusy(error)) return null
      throw error
    }
    if (claim.acquired) {
      const held: HeldLease = { sessionPath: canonical, lockPath, ...record, depth: 1, released: false }
      heldLeases.set(canonical, held)
      if (claim.stale) {
        options.onStaleLease?.(claim.stale)
        emitNervesEvent({
          level: "warn",
          component: "mind",
          event: "mind.session_turn_lease_stolen",
          message: "stole stale session turn lease",
          meta: { sessionPath: canonical, stalePid: claim.stale.pid, staleOwnerId: claim.stale.ownerId },
        })
      }
      return held
    }
    return null
  }
  const held = tryAcquire()
  if (!held) throw new SessionTurnBusyError(`session turn busy: ${canonical}`)
  const lease = makeLease(held)
  try {
    return leaseContext.run(lease, () => work(lease))
  } finally {
    void lease.release()
  }
}

export function currentSessionTurnLease(sessionPath: string): SessionTurnLease | null {
  const lease = leaseContext.getStore()
  return lease && lease.sessionPath === canonicalSessionPath(sessionPath) ? lease : null
}

export function assertSessionTurnLease(sessionPath: string, lease: SessionTurnLease): void {
  const canonical = canonicalSessionPath(sessionPath)
  if (lease.sessionPath !== canonical) throw new SessionTransactionError("leased session path mismatch")
  const held = heldLeases.get(canonical)
  if (!held || held.released || held.ownerId !== lease.ownerId || held.ownerToken !== lease.ownerToken) {
    throw new SessionTransactionError("session lease owner token mismatch")
  }
}

export function readSessionTransaction(sessionPath: string, lease: SessionTurnLease): {
  bytes: string
  value: unknown
  revision: string
} {
  assertSessionTurnLease(sessionPath, lease)
  let bytes = ""
  try { bytes = fs.readFileSync(canonicalSessionPath(sessionPath), "utf8") } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return { bytes, value: bytes ? JSON.parse(bytes) : null, revision: revision(bytes) }
}

export function writeSessionTransaction(
  sessionPath: string,
  value: unknown,
  options: WriteSessionTransactionOptions,
): string {
  assertSessionTurnLease(sessionPath, options.lease)
  const canonical = canonicalSessionPath(sessionPath)
  const current = readSessionTransaction(canonical, options.lease)
  if (current.revision !== options.expectedRevision) throw new SessionTransactionError("session revision changed")
  fs.mkdirSync(path.dirname(canonical), { recursive: true })
  const bytes = JSON.stringify(value, null, 2)
  const tempPath = path.join(path.dirname(canonical), `.${path.basename(canonical)}.tmp-${process.pid}-${randomUUID()}`)
  let fd: number | null = null
  try {
    fd = fs.openSync(tempPath, "wx", 0o600)
    fs.writeFileSync(fd, bytes, "utf8")
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    options.hooks?.beforeRename?.()
    fs.renameSync(tempPath, canonical)
    const directoryFd = fs.openSync(path.dirname(canonical), "r")
    try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
  } catch (error) {
    /* v8 ignore next -- fd-close failure after a prior node:fs failure is best-effort cleanup @preserve */
    if (fd !== null) try { fs.closeSync(fd) } catch { /* best effort */ }
    try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
    throw error
  }
  emitNervesEvent({
    component: "mind",
    event: "mind.session_transaction_written",
    message: "durably replaced session envelope",
    meta: { sessionPath: canonical, ownerId: options.lease.ownerId },
  })
  return revision(bytes)
}

export function deleteSessionTransaction(sessionPath: string, lease: SessionTurnLease): void {
  assertSessionTurnLease(sessionPath, lease)
  try { fs.unlinkSync(canonicalSessionPath(sessionPath)) } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  emitNervesEvent({
    component: "mind",
    event: "mind.session_transaction_deleted",
    message: "deleted session under turn lease",
    meta: { sessionPath: canonicalSessionPath(sessionPath), ownerId: lease.ownerId },
  })
}
