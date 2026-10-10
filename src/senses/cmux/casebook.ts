import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CaseShape } from "./floor"
import { redactSecrets } from "./redact"

/**
 * Machine-local memory for answering coding agents' prompts. Both files live under the agent's
 * `state/senses/cmux/` (directory 0700, files 0600) and never sync: request text can hold secrets.
 *
 * - The casebook holds the human's precedents: "this exact request is fine to answer once" or
 *   "ask me about this". A precedent matches only the same repository, tool and every token.
 * - The decision log records every judgment the sense or the agent made, newest last.
 */
export type CaseVerdict = "once" | "ask"

export interface CmuxCase {
  id: string
  at: string
  verdict: CaseVerdict
  shape: CaseShape
  requestId: string
  note: string
}

export type DecisionOutcome = "replied_once" | "escalated" | "race" | "reply_failed" | "shadow"

export interface DecisionRecord {
  at: string
  requestId: string
  source: string
  tool: string | null
  cwd: string | null
  outcome: DecisionOutcome
  floor: { verdict: "allow" | "soft" | "hard"; reason: string }
  shape: CaseShape | null
  precedent: { id: string; verdict: CaseVerdict } | null
  authority: string
  detail: string
}

const MAX_CASES = 2_000
const MAX_LOG_BYTES = 2 * 1024 * 1024

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

function sameShape(left: CaseShape, right: CaseShape): boolean {
  return left.repoRoot === right.repoRoot && left.tool === right.tool
    && left.tokens.length === right.tokens.length && left.tokens.every((token, index) => token === right.tokens[index])
}

function isCase(value: unknown): value is CmuxCase {
  const entry = value as CmuxCase
  return !!entry && typeof entry === "object" && (entry.verdict === "once" || entry.verdict === "ask")
    && !!entry.shape && typeof entry.shape.repoRoot === "string" && typeof entry.shape.tool === "string"
    && Array.isArray(entry.shape.tokens) && entry.shape.tokens.every((token) => typeof token === "string")
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
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    if (sameShape(cases[index]!.shape, shape)) return cases[index]!
  }
  return null
}

export function addCase(file: string, input: { verdict: CaseVerdict; shape: CaseShape; requestId: string; note: string; at: string }): CmuxCase {
  const entry: CmuxCase = { id: `case-${randomUUID()}`, at: input.at, verdict: input.verdict, shape: input.shape, requestId: input.requestId, note: redactSecrets(input.note).slice(0, 500) }
  const cases = [...readCasebook(file), entry].slice(-MAX_CASES)
  ensurePrivateDir(path.dirname(file))
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  emitNervesEvent({ component: "senses", event: "senses.cmux_case_added", message: "recorded a cmux precedent", meta: { verdict: entry.verdict, tool: entry.shape.tool } })
  return entry
}

export function appendDecision(file: string, record: DecisionRecord): void {
  ensurePrivateDir(path.dirname(file))
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
  } catch {
    // No log yet.
  }
  const line = redactSecrets(JSON.stringify(record))
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 })
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

/** How many live `once` replies the sense sent inside the window, for the standing grant's count cap. */
export function repliesInWindow(records: readonly DecisionRecord[], windowMs: number, now: number): number {
  return records.filter((record) => record.outcome === "replied_once" && Date.parse(record.at) > now - windowMs).length
}
