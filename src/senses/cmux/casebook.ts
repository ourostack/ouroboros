import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CaseShape } from "./floor"
import { redactSecrets } from "./redact"

/**
 * Machine-local memory for answering coding agents' prompts. Both files live under the agent's
 * `state/senses/cmux/` (directory 0700, files 0600) and never sync: request text can hold secrets.
 *
 * - The casebook holds the human's precedents: "this exact request is fine to answer once" or
 *   "ask me about this". A precedent matches only the same repository, tool and every token.
 * - The decision log records every judgment the sense or the agent made, newest last. It is also
 *   the one count of replies the standing grant's cap is checked against.
 *
 * Command words are never stored: a shape keeps a digest of its exact tokens (for matching) and a
 * redacted preview (for people).
 */
export type CaseVerdict = "once" | "ask"

export interface StoredShape {
  repoRoot: string
  tool: string
  digest: string
  preview: string
}

export interface CmuxCase {
  id: string
  at: string
  verdict: CaseVerdict
  shape: StoredShape
  requestId: string
  note: string
}

/** `reply_sent` is written, under the log lock, before every reply; `replied_once` only after cmux shows the item resolved by it. */
export type DecisionOutcome = "reply_sent" | "replied_once" | "escalated" | "race" | "reply_failed" | "shadow"

export interface DecisionRecord {
  at: string
  requestId: string
  source: string
  tool: string | null
  cwd: string | null
  outcome: DecisionOutcome
  floor: { verdict: "allow" | "soft" | "hard"; reason: string }
  shape: StoredShape | null
  precedent: { id: string; verdict: CaseVerdict } | null
  authority: string
  detail: string
}

const MAX_CASES = 2_000
const MAX_LOG_BYTES = 2 * 1024 * 1024
const LOCK_WAIT_MS = 5_000
const STALE_LOCK_MS = 30_000
const TOMBSTONE_KEEP_MS = 5 * 60_000
const heldLocks = new Set<string>()
/** How long reply records survive log rotation; the standing grant's window may not be longer. */
export const REPLY_HISTORY_MS = 31 * 24 * 60 * 60_000
const LOST_TAKEOVER = new Set<string | undefined>(["ENOENT", "ENOTEMPTY", "EEXIST"])

export function cmuxCasebookPath(stateDir: string): string {
  return path.join(stateDir, "casebook.json")
}

export function cmuxDecisionLogPath(stateDir: string): string {
  return path.join(stateDir, "decisions.jsonl")
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

export function storeShape(shape: CaseShape): StoredShape {
  return {
    repoRoot: shape.repoRoot,
    tool: shape.tool,
    digest: createHash("sha256").update(JSON.stringify(shape.tokens)).digest("hex"),
    preview: redactSecrets(shape.tokens.join(" ")).slice(0, 300),
  }
}

export function isShape(value: unknown): value is StoredShape {
  const shape = value as StoredShape
  return !!shape && typeof shape === "object" && typeof shape.repoRoot === "string" && typeof shape.tool === "string"
    && typeof shape.digest === "string" && typeof shape.preview === "string"
}

/** A schema-1 shape kept the raw command tokens; it migrates to a digest and a redacted preview. */
function isLegacyShape(value: unknown): value is CaseShape {
  const shape = value as CaseShape
  return !!shape && typeof shape === "object" && typeof shape.repoRoot === "string" && typeof shape.tool === "string"
    && Array.isArray(shape.tokens) && shape.tokens.every((token) => typeof token === "string")
}

function isVerdict(value: unknown): value is CaseVerdict {
  return value === "once" || value === "ask"
}

export interface CasebookRead {
  cases: CmuxCase[]
  /** Why the casebook cannot be trusted as complete; while set, nothing is answered from it or written to it. */
  problem: string | null
  /** How many schema-1 cases were converted in memory. */
  migrated: number
}

/**
 * Reads the casebook. Schema-1 cases are converted to the stored shape (digest and redacted
 * preview). A casebook that exists but cannot be read, or holds a case that is neither shape, is
 * reported as a problem instead of being skipped, because a skipped "ask" precedent would let a
 * request through that the human asked to be asked about.
 */
export function loadCasebook(file: string): CasebookRead {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cases: [], problem: null, migrated: 0 }
    return { cases: [], problem: `the cmux casebook cannot be read: ${(error as Error).message}`, migrated: 0 }
  }
  let parsed: { cases?: unknown }
  try {
    parsed = JSON.parse(raw) as { cases?: unknown }
  } catch {
    return { cases: [], problem: "the cmux casebook is not valid JSON", migrated: 0 }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.cases)) return { cases: [], problem: "the cmux casebook has no case list", migrated: 0 }
  const cases: CmuxCase[] = []
  let migrated = 0
  for (const value of parsed.cases as unknown[]) {
    const entry = value as Record<string, unknown> | null
    if (!entry || typeof entry !== "object" || !isVerdict(entry.verdict)) return { cases: [], problem: "the cmux casebook holds a case it cannot read", migrated: 0 }
    if (isShape(entry.shape)) {
      cases.push(entry as unknown as CmuxCase)
    } else if (isLegacyShape(entry.shape)) {
      cases.push({ ...(entry as unknown as CmuxCase), shape: storeShape(entry.shape) })
      migrated += 1
    } else {
      return { cases: [], problem: "the cmux casebook holds a case it cannot read", migrated: 0 }
    }
  }
  return { cases, problem: null, migrated }
}

function writeCasebook(file: string, cases: readonly CmuxCase[]): void {
  ensurePrivateDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 2, cases }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/**
 * The casebook's cases, with schema-1 cases rewritten on disk as digests so raw command words
 * leave the file. Throws while the casebook has a problem, so callers fail closed.
 */
export function readCasebook(file: string): CmuxCase[] {
  const first = loadCasebook(file)
  if (first.problem) throw new Error(first.problem)
  if (first.migrated === 0) return first.cases
  return withDecisionLock(path.dirname(file), () => {
    const current = loadCasebook(file)
    if (current.problem) throw new Error(current.problem)
    if (current.migrated > 0) {
      writeCasebook(file, current.cases)
      emitNervesEvent({ component: "senses", event: "senses.cmux_casebook_migrated", message: "migrated schema-1 cmux precedents to digests", meta: { migrated: current.migrated } })
    }
    return current.cases
  })
}

/** The newest precedent for exactly this shape; a later "ask" overrides an earlier "once" and the reverse. */
export function findPrecedent(cases: readonly CmuxCase[], shape: CaseShape): CmuxCase | null {
  const want = storeShape(shape)
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    const have = cases[index]!.shape
    if (have.repoRoot === want.repoRoot && have.tool === want.tool && have.digest === want.digest) return cases[index]!
  }
  return null
}

export function addCase(file: string, input: { verdict: CaseVerdict; shape: StoredShape; requestId: string; note: string; at: string }): CmuxCase {
  const entry: CmuxCase = { id: `case-${randomUUID()}`, at: input.at, verdict: input.verdict, shape: input.shape, requestId: input.requestId, note: redactSecrets(input.note).slice(0, 500) }
  withDecisionLock(path.dirname(file), () => {
    const current = loadCasebook(file)
    if (current.problem) throw new Error(current.problem)
    writeCasebook(file, [...current.cases, entry].slice(-MAX_CASES))
  })
  emitNervesEvent({ component: "senses", event: "senses.cmux_case_added", message: "recorded a cmux precedent", meta: { verdict: entry.verdict, tool: entry.shape.tool } })
  return entry
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/**
 * Takes over a stale lock. The stale directory is renamed to a tombstone named after its inode, and
 * a marker is written into the tombstone before this process tries the lock again. A contender that
 * judged the same stale lock and renames later finds the tombstone non-empty and fails, so it can
 * never move away the fresh lock that the winner made in the meantime.
 */
function takeOverStaleLock(lock: string, staleIno: number): void {
  const tombstone = `${lock}.stale-${staleIno}`
  try {
    fs.renameSync(lock, tombstone)
  } catch (error) {
    // Gone, or another contender's tombstone is already there: the lock is not ours to take.
    if (LOST_TAKEOVER.has(errorCode(error))) return
    throw error
  }
  fs.writeFileSync(path.join(tombstone, "taken-over"), `${process.pid}\n`)
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.cmux_stale_lock_taken_over", message: "took over a stale cmux decision log lock", meta: { tombstone } })
}

/** Tombstones older than a few minutes can no longer be raced; removing them keeps the folder tidy. */
function sweepTombstones(stateDir: string, now: number): void {
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.startsWith("decisions.lock.stale-")) continue
    const tombstone = path.join(stateDir, name)
    try {
      if (now - fs.statSync(tombstone).mtimeMs <= TOMBSTONE_KEEP_MS) continue
      // A tombstone holds only its marker file, so it is emptied file by file, never removed recursively.
      for (const entry of fs.readdirSync(tombstone)) fs.unlinkSync(path.join(tombstone, entry))
      fs.rmdirSync(tombstone)
    } catch {
      // Another process swept it first.
    }
  }
}

/**
 * Runs `fn` while holding the decision log's lock (an atomic `mkdir`), so the sense process and the
 * agent's tool never both pass the grant's count cap. A lock older than 30 seconds is taken over
 * (see `takeOverStaleLock`); a lock that disappears while being checked is simply tried again.
 */
export function withDecisionLock<T>(stateDir: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): T {
  ensurePrivateDir(stateDir)
  const lock = path.join(stateDir, "decisions.lock")
  // `fn` is synchronous, so a nested call from inside it (an append while reserving a reply) already holds the lock.
  if (heldLocks.has(lock)) return fn()
  const deadline = Date.now() + waitMs
  let held: number
  for (;;) {
    try {
      fs.mkdirSync(lock)
      held = fs.statSync(lock).ino
      break
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    let current: fs.Stats | null = null
    try {
      current = fs.statSync(lock)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    if (current === null) continue
    if (Date.now() - current.mtimeMs > STALE_LOCK_MS) {
      takeOverStaleLock(lock, current.ino)
      if (Date.now() < deadline) continue
    }
    if (Date.now() >= deadline) throw new Error("the cmux decision log is locked")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  heldLocks.add(lock)
  try {
    return fn()
  } finally {
    heldLocks.delete(lock)
    // Release only the lock this call made; if it was taken over meanwhile, the new holder keeps it.
    try {
      if (fs.statSync(lock).ino === held) fs.rmdirSync(lock)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    sweepTombstones(stateDir, Date.now())
  }
}

/**
 * Rotates a full log under the lock. The active file becomes `.1`; reply records from the old `.1`
 * that are younger than `REPLY_HISTORY_MS` start the new active file, so the grant's count never
 * loses a reply that is still inside its window.
 */
function rotateIfFull(file: string, now: number): void {
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  if (size <= MAX_LOG_BYTES) return
  const keep = parseDecisions(readText(`${file}.1`)).filter((record) => record.outcome === "reply_sent" && Date.parse(record.at) > now - REPLY_HISTORY_MS)
  fs.renameSync(file, `${file}.1`)
  if (keep.length > 0) fs.writeFileSync(file, keep.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 })
}

/**
 * Appends one record under the decision log's lock. Free-text fields are redacted before the line is
 * built, so every line stays valid JSON.
 */
export function appendDecision(file: string, record: DecisionRecord): void {
  const safe: DecisionRecord = {
    ...record,
    cwd: record.cwd === null ? null : redactSecrets(record.cwd),
    floor: { verdict: record.floor.verdict, reason: redactSecrets(record.floor.reason) },
    authority: redactSecrets(record.authority),
    detail: redactSecrets(record.detail).slice(0, 2_000),
  }
  withDecisionLock(path.dirname(file), () => {
    rotateIfFull(file, Date.parse(record.at))
    fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  })
  emitNervesEvent({ component: "senses", event: "senses.cmux_decision_logged", message: "logged a cmux prompt decision", meta: { outcome: record.outcome, tool: record.tool, floor: record.floor.verdict } })
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8")
  } catch {
    return ""
  }
}

function parseDecisions(text: string): DecisionRecord[] {
  return text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as DecisionRecord
      return value && typeof value === "object" && typeof value.requestId === "string" ? [value] : []
    } catch {
      return []
    }
  })
}

/** Every logged decision, oldest first, including the one rotated-out file. */
export function readDecisions(file: string): DecisionRecord[] {
  return parseDecisions(`${readText(`${file}.1`)}\n${readText(file)}`)
}

/** How many replies the sense sent inside the window. Every attempt counts, confirmed or not, so the cap fails closed. */
export function repliesInWindow(records: readonly DecisionRecord[], windowMs: number, now: number): number {
  return records.filter((record) => record.outcome === "reply_sent" && Date.parse(record.at) > now - windowMs).length
}
