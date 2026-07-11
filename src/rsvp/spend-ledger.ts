import * as fs from "node:fs"
import * as path from "node:path"

import type { RunLedgerLifecycle, RunLedgerRecord, RunLedgerUsageMetadata } from "../heart/run-ledger"
import { emitNervesEvent } from "../nerves/runtime"

export const RSVP_SPEND_LEDGER_POLICY_VERSION = "rsvp-spend-ledger/v1" as const

export interface RsvpSpendLedgerRun {
  schemaVersion: 1
  runId: string
  rootRunId: string
  idempotencyKey: string
  targetHash: string
  habitName: string
  trigger: string
  lifecycle: RunLedgerLifecycle
  startedAt: string
  recordedAt: string
  endedAt?: string
  usage?: RunLedgerUsageMetadata
  contentStored: false
}

export type RsvpSpendLedgerStoredRun = RsvpSpendLedgerRun | Record<string, unknown>

export interface RsvpSpendLedger {
  schemaVersion: 1
  policyVersion: typeof RSVP_SPEND_LEDGER_POLICY_VERSION
  createdAt: string
  updatedAt: string
  runs: RsvpSpendLedgerStoredRun[]
}

function ledgerPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "rsvp", "spend-ledger.json")
}

function emptyLedger(now: string): RsvpSpendLedger {
  return {
    schemaVersion: 1,
    policyVersion: RSVP_SPEND_LEDGER_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
    runs: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function isRun(value: unknown): value is RsvpSpendLedgerRun {
  const row = value as Partial<RsvpSpendLedgerRun> | null
  return !!row
    && row.schemaVersion === 1
    && typeof row.runId === "string"
    && typeof row.rootRunId === "string"
    && typeof row.idempotencyKey === "string"
    && typeof row.targetHash === "string"
    && typeof row.habitName === "string"
    && typeof row.trigger === "string"
    && typeof row.lifecycle === "string"
    && typeof row.startedAt === "string"
    && typeof row.recordedAt === "string"
    && row.contentStored === false
}

function storedRun(value: unknown): RsvpSpendLedgerStoredRun | null {
  if (isRun(value)) return value
  return isRecord(value) ? value : null
}

function isLedger(value: unknown): value is RsvpSpendLedger {
  const row = value as Partial<RsvpSpendLedger> | null
  return !!row
    && row.schemaVersion === 1
    && row.policyVersion === RSVP_SPEND_LEDGER_POLICY_VERSION
    && typeof row.createdAt === "string"
    && typeof row.updatedAt === "string"
    && Array.isArray(row.runs)
}

export function readRsvpSpendLedger(agentRoot: string): RsvpSpendLedger {
  const filePath = ledgerPath(agentRoot)
  if (!fs.existsSync(filePath)) return emptyLedger(new Date().toISOString())
  try {
    const now = new Date().toISOString()
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
    if (!isLedger(parsed)) {
      if (!isRecord(parsed) || !Array.isArray(parsed.runs)) return emptyLedger(now)
      return {
        schemaVersion: 1,
        policyVersion: RSVP_SPEND_LEDGER_POLICY_VERSION,
        createdAt: stringField(parsed, "createdAt") ?? now,
        updatedAt: stringField(parsed, "updatedAt") ?? now,
        runs: parsed.runs.map(storedRun).filter((run): run is RsvpSpendLedgerStoredRun => run !== null),
      }
    }
    return {
      schemaVersion: 1,
      policyVersion: RSVP_SPEND_LEDGER_POLICY_VERSION,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      runs: parsed.runs.map(storedRun).filter((run): run is RsvpSpendLedgerStoredRun => run !== null),
    }
  } catch {
    return emptyLedger(new Date().toISOString())
  }
}

function writeLedger(agentRoot: string, ledger: RsvpSpendLedger): RsvpSpendLedger {
  const filePath = ledgerPath(agentRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8")
  fs.renameSync(tmp, filePath)
  return ledger
}

export function ensureRsvpSpendLedger(agentRoot: string, now: string = new Date().toISOString()): RsvpSpendLedger {
  const filePath = ledgerPath(agentRoot)
  if (fs.existsSync(filePath)) return readRsvpSpendLedger(agentRoot)
  const ledger = writeLedger(agentRoot, emptyLedger(now))
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.spend_ledger_initialized",
    message: "initialized RSVP spend ledger",
    meta: { updatedAt: ledger.updatedAt },
  })
  return ledger
}

export function recordRsvpSpendLedgerRun(agentRoot: string, record: RunLedgerRecord): RsvpSpendLedger {
  const current = readRsvpSpendLedger(agentRoot)
  const run: RsvpSpendLedgerRun = {
    schemaVersion: 1,
    runId: record.runId,
    rootRunId: record.rootRunId,
    idempotencyKey: record.idempotencyKey,
    targetHash: record.targetHash,
    habitName: record.senseOrHabit,
    trigger: record.triggerType,
    lifecycle: record.lifecycle,
    startedAt: record.startedAt,
    recordedAt: record.recordedAt,
    ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
    contentStored: false,
  }
  const withoutDuplicate = current.runs.filter((entry) => !(entry.runId === run.runId && entry.lifecycle === run.lifecycle))
  const updated = writeLedger(agentRoot, {
    schemaVersion: 1,
    policyVersion: RSVP_SPEND_LEDGER_POLICY_VERSION,
    createdAt: current.createdAt,
    updatedAt: run.recordedAt,
    runs: [...withoutDuplicate, run],
  })
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.spend_ledger_recorded",
    message: "recorded RSVP spend ledger row",
    meta: { runId: run.runId, lifecycle: run.lifecycle, habitName: run.habitName },
  })
  return updated
}
