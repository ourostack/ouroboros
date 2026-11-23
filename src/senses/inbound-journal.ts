import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomicSync } from "../heart/atomic-file"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The shared inbound rule every sense follows (the rule iMessage got on 2026-11-22): an inbound message is
 * written here before its turn runs, and leaves only when its one outcome is recorded. A process that dies
 * mid-turn leaves it pending, and the next process replays it or records why it can't. Each sense keeps a
 * thin adapter that decides what "replay" means for its transport.
 */

/** How many turns a sense starts for one inbound before it records a failure instead of trying again. */
export const MAX_INBOUND_ATTEMPTS = 3

/** How long an inbound's recorded outcome is kept, so a late copy of it is not taken for a new message. */
export const INBOUND_OUTCOME_RETENTION_MS = 30 * 24 * 60 * 60_000

/**
 * answered: the reply reached the transport. silent: the agent chose to say nothing. failed: a visible failure
 * was recorded instead of a reply. canceled: the sender withdrew the message.
 */
export type InboundOutcome = "answered" | "silent" | "failed" | "canceled"

export interface PendingInbound<T> {
  id: string
  sense: string
  receivedAt: string
  /** Turns started for this inbound, across processes. */
  attempts: number
  /** Part of a reply may already have reached the person, so a replay must not say it again. */
  spoke: boolean
  payload: T
}

export interface InboundOutcomeRecord {
  id: string
  sense: string
  receivedAt: string
  settledAt: string
  outcome: InboundOutcome
  attempts: number
  detail?: string
}

export interface InboundJournal<T> {
  /**
   * Record an inbound before its turn runs. A copy of one still pending returns the first record; a copy of one
   * that already has an outcome returns null, so it is not run again.
   */
  record(id: string, payload: T): PendingInbound<T> | null
  get(id: string): PendingInbound<T> | null
  /** Count a turn starting for this inbound and return the new count (0 when it is not pending). */
  beginAttempt(id: string): number
  /** Give back the attempt of a turn that a clean shutdown stopped: it did not fail, so it should not use up the inbound. */
  refundAttempt(id: string): void
  /** Note that part of the reply may have reached the person. */
  markSpoke(id: string): void
  /** Record the inbound's one outcome. False when it was not pending (never recorded, or already settled). */
  settle(id: string, outcome: InboundOutcome, detail?: string): boolean
  /** Pending inbounds, oldest first. */
  pending(): Array<PendingInbound<T>>
  /** How long the oldest pending inbound has waited, or null when none is pending. */
  oldestPendingAgeMs(): number | null
}

export interface InboundJournalOptions {
  now?: () => number
}

function journalDir(agentRoot: string, sense: string): string {
  return path.join(agentRoot, "state", "senses", sense)
}

function fileName(id: string): string {
  return `${createHash("sha256").update(id).digest("hex")}.json`
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

function listJson(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** The recorded outcome of one inbound, or null when it has none (still pending, never seen, or past retention). */
export function readInboundOutcome(agentRoot: string, sense: string, id: string): InboundOutcomeRecord | null {
  return readJson<InboundOutcomeRecord>(path.join(journalDir(agentRoot, sense), "inbound-outcomes", fileName(id)))
}

export function openInboundJournal<T>(agentRoot: string, sense: string, options: InboundJournalOptions = {}): InboundJournal<T> {
  const now = options.now ?? Date.now
  const pendingDir = path.join(journalDir(agentRoot, sense), "pending-inbound")
  const outcomesDir = path.join(journalDir(agentRoot, sense), "inbound-outcomes")
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.mkdirSync(outcomesDir, { recursive: true })

  const cutoff = now() - INBOUND_OUTCOME_RETENTION_MS
  for (const file of listJson(outcomesDir)) {
    const outcome = readJson<InboundOutcomeRecord>(file)
    if (!outcome || Date.parse(outcome.settledAt) < cutoff) fs.rmSync(file, { force: true })
  }

  const pendingPath = (id: string): string => path.join(pendingDir, fileName(id))
  const outcomePath = (id: string): string => path.join(outcomesDir, fileName(id))
  const get = (id: string): PendingInbound<T> | null => {
    if (fs.existsSync(outcomePath(id))) return null
    return readJson<PendingInbound<T>>(pendingPath(id))
  }
  const update = (id: string, change: (entry: PendingInbound<T>) => PendingInbound<T>): PendingInbound<T> | null => {
    const entry = get(id)
    if (!entry) return null
    const next = change(entry)
    writeJsonAtomicSync(pendingPath(id), next)
    return next
  }

  const pending = (): Array<PendingInbound<T>> => {
    const entries: Array<PendingInbound<T>> = []
    for (const file of listJson(pendingDir)) {
      const entry = readJson<PendingInbound<T>>(file)
      if (!entry || typeof entry.id !== "string") continue
      // Settled just before a crash: the outcome stands and the leftover pending copy goes.
      if (fs.existsSync(outcomePath(entry.id))) {
        fs.rmSync(file, { force: true })
        continue
      }
      entries.push(entry)
    }
    return entries.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  }

  return {
    record(id, payload) {
      const existing = get(id)
      if (existing) return existing
      const settled = readJson<InboundOutcomeRecord>(outcomePath(id))
      if (settled) {
        emitNervesEvent({ component: "senses", event: "senses.inbound_duplicate", message: "an inbound that already has an outcome arrived again; it is not run again", meta: { sense, id, outcome: settled.outcome } })
        return null
      }
      const entry: PendingInbound<T> = { id, sense, receivedAt: new Date(now()).toISOString(), attempts: 0, spoke: false, payload }
      writeJsonAtomicSync(pendingPath(id), entry)
      emitNervesEvent({ component: "senses", event: "senses.inbound_recorded", message: "recorded an inbound before its turn", meta: { sense, id } })
      return entry
    },
    get,
    beginAttempt(id) {
      return update(id, (entry) => ({ ...entry, attempts: entry.attempts + 1 }))?.attempts ?? 0
    },
    refundAttempt(id) {
      update(id, (entry) => ({ ...entry, attempts: Math.max(0, entry.attempts - 1) }))
    },
    markSpoke(id) {
      update(id, (entry) => ({ ...entry, spoke: true }))
    },
    settle(id, outcome, detail) {
      const entry = get(id)
      if (!entry) return false
      const record: InboundOutcomeRecord = {
        id,
        sense,
        receivedAt: entry.receivedAt,
        settledAt: new Date(now()).toISOString(),
        outcome,
        attempts: entry.attempts,
        ...(detail ? { detail } : {}),
      }
      // The outcome file is the record; the pending copy is removed only after it has landed.
      writeJsonAtomicSync(outcomePath(id), record)
      fs.rmSync(pendingPath(id), { force: true })
      emitNervesEvent({
        level: outcome === "failed" ? "error" : "info",
        component: "senses",
        event: "senses.inbound_settled",
        message: outcome === "failed" ? "recorded a visible failure for an inbound" : "recorded an inbound's outcome",
        meta: { sense, id, outcome, attempts: entry.attempts, ...(detail ? { detail } : {}) },
      })
      return true
    },
    pending,
    oldestPendingAgeMs() {
      const oldest = pending()[0]
      return oldest ? Math.max(0, now() - Date.parse(oldest.receivedAt)) : null
    },
  }
}
