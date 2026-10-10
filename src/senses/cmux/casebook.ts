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

function isShape(value: unknown): value is StoredShape {
  const shape = value as StoredShape
  return !!shape && typeof shape === "object" && typeof shape.repoRoot === "string" && typeof shape.tool === "string"
    && typeof shape.digest === "string" && typeof shape.preview === "string"
}

function isCase(value: unknown): value is CmuxCase {
  const entry = value as CmuxCase
  return !!entry && typeof entry === "object" && (entry.verdict === "once" || entry.verdict === "ask") && isShape(entry.shape)
}

export function readCasebook(file: string): CmuxCase[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { cases?: unknown }
    return Array.isArray(parsed.cases) ? parsed.cases.filter(isCase) : []
  } catch {
    return []
  }
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
  const cases = [...readCasebook(file), entry].slice(-MAX_CASES)
  ensurePrivateDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 2, cases }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  emitNervesEvent({ component: "senses", event: "senses.cmux_case_added", message: "recorded a cmux precedent", meta: { verdict: entry.verdict, tool: entry.shape.tool } })
  return entry
}

/**
 * Runs `fn` while holding the decision log's lock (an atomic `mkdir`), so the sense process and the
 * agent's tool never both pass the grant's count cap. A lock older than 30 seconds is taken over.
 */
export function withDecisionLock<T>(stateDir: string, fn: () => T, waitMs: number = LOCK_WAIT_MS): T {
  ensurePrivateDir(stateDir)
  const lock = path.join(stateDir, "decisions.lock")
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
        fs.rmdirSync(lock)
        continue
      }
      if (Date.now() >= deadline) throw new Error("the cmux decision log is locked")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmdirSync(lock)
  }
}

/** Appends one record. Free-text fields are redacted before the line is built, so every line stays valid JSON. */
export function appendDecision(file: string, record: DecisionRecord): void {
  ensurePrivateDir(path.dirname(file))
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
  } catch {
    // No log yet.
  }
  const safe: DecisionRecord = {
    ...record,
    cwd: record.cwd === null ? null : redactSecrets(record.cwd),
    floor: { verdict: record.floor.verdict, reason: redactSecrets(record.floor.reason) },
    authority: redactSecrets(record.authority),
    detail: redactSecrets(record.detail).slice(0, 2_000),
  }
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  emitNervesEvent({ component: "senses", event: "senses.cmux_decision_logged", message: "logged a cmux prompt decision", meta: { outcome: record.outcome, tool: record.tool, floor: record.floor.verdict } })
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8")
  } catch {
    return ""
  }
}

/** Every logged decision, oldest first, including the one rotated-out file. */
export function readDecisions(file: string): DecisionRecord[] {
  return `${readText(`${file}.1`)}\n${readText(file)}`.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as DecisionRecord
      return value && typeof value === "object" && typeof value.requestId === "string" ? [value] : []
    } catch {
      return []
    }
  })
}

/** How many replies the sense sent inside the window. Every attempt counts, confirmed or not, so the cap fails closed. */
export function repliesInWindow(records: readonly DecisionRecord[], windowMs: number, now: number): number {
  return records.filter((record) => record.outcome === "reply_sent" && Date.parse(record.at) > now - windowMs).length
}
