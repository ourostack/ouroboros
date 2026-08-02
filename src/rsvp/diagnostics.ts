import * as path from "node:path"
import { parseHabitFile, type HabitDegradedReason, type HabitFileStatus } from "../heart/habits/habit-parser"
import { emitNervesEvent } from "../nerves/runtime"
import { isRsvpHabitName } from "./habit-policy"

export type RsvpDiagnosticStatus = "pass" | "warn" | "fail"

export interface RsvpDiagnosticsDeps {
  existsSync: (filePath: string) => boolean
  readFileSync: (filePath: string) => string
  readdirSync: (dirPath: string) => string[]
}

export interface RsvpContextPacketLedgerHealth {
  status: RsvpDiagnosticStatus
  detail: string
  latestPacketId?: string
  ledgerPath?: string
  rows: number
}

export interface RsvpHabitScheduleHealth {
  status: RsvpDiagnosticStatus
  detail: string
  activeHabit?: string
  cadence?: string
  policyVersion?: string
  sense?: string
  source?: string
  routeRef?: string
  snapshotRef?: string
  outboundStateRef?: string
  budgetRef?: string
  idempotencyRef?: string
  habitStates?: Array<{
    name: string
    status: HabitFileStatus
    degradedReason: HabitDegradedReason | null
  }>
}

export interface RsvpLatestFetchHealth {
  status: RsvpDiagnosticStatus
  detail: string
  snapshotId?: string
  counts?: { attending: number; declined: number; pending: number }
}

export interface RsvpDeliveryReconciliationHealth {
  status: RsvpDiagnosticStatus
  detail: string
  accepted: number
}

export interface RsvpSpendTimelineHealth {
  status: RsvpDiagnosticStatus
  detail: string
  runs: number
}

export interface RsvpDiagnostics {
  contextPacketLedger: RsvpContextPacketLedgerHealth
  habitSchedule: RsvpHabitScheduleHealth
  latestFetch: RsvpLatestFetchHealth
  deliveryReconciliation: RsvpDeliveryReconciliationHealth
  spendTimeline: RsvpSpendTimelineHealth
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readJson(filePath: string, deps: RsvpDiagnosticsDeps): unknown | null {
  try {
    return JSON.parse(deps.readFileSync(filePath)) as unknown
  } catch {
    return null
  }
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function countsFrom(value: unknown): { attending: number; declined: number; pending: number } | null {
  if (!isRecord(value)) return null
  const attending = numberField(value, "attending")
  const declined = numberField(value, "declined")
  const pending = numberField(value, "pending")
  return attending === null || declined === null || pending === null
    ? null
    : { attending, declined, pending }
}

function readLedgerRows(filePath: string, deps: RsvpDiagnosticsDeps): Record<string, unknown>[] {
  if (!deps.existsSync(filePath)) return []
  const lines = deps.readFileSync(filePath).split(/\r?\n/).filter((line) => line.trim().length > 0)
  const rows: Record<string, unknown>[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRecord(parsed)) rows.push(parsed)
    } catch {
      // Ignore malformed rows in this high-level health summary.
    }
  }
  return rows
}

function rowTimestamp(row: Record<string, unknown>): number {
  const raw = stringField(row, "createdAt") ?? stringField(row, "anchorTimestamp") ?? ""
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function contextPacketLedgerHealth(agentRoot: string, deps: RsvpDiagnosticsDeps): RsvpContextPacketLedgerHealth {
  const candidates = [
    path.join(agentRoot, "state", "senses", "context-packets", "bluebubbles", "ledger.jsonl"),
    path.join(agentRoot, "state", "senses", "context-packets", "ledger.jsonl"),
  ]
  const rowsByPath = candidates
    .map((ledgerPath) => ({ ledgerPath, rows: readLedgerRows(ledgerPath, deps) }))
    .filter((entry) => entry.rows.length > 0)
  if (rowsByPath.length === 0) {
    return { status: "warn", detail: "no context packet ledger rows found", rows: 0 }
  }
  const selected = rowsByPath[0]
  const latest = [...selected.rows].sort((left, right) => rowTimestamp(right) - rowTimestamp(left))[0]
  const latestPacketId = stringField(latest, "packetId") ?? stringField(latest, "id") ?? undefined
  return {
    status: latestPacketId ? "pass" : "warn",
    detail: latestPacketId ? `latestPacketId=${latestPacketId}; rows=${selected.rows.length}` : `rows=${selected.rows.length}; latest packet id missing`,
    ...(latestPacketId ? { latestPacketId } : {}),
    ledgerPath: selected.ledgerPath,
    rows: selected.rows.length,
  }
}

function habitScheduleHealth(agentRoot: string, deps: RsvpDiagnosticsDeps): RsvpHabitScheduleHealth {
  const habitsDir = path.join(agentRoot, "habits")
  if (!deps.existsSync(habitsDir)) return { status: "warn", detail: "habits directory missing" }
  try {
    const rsvpHabits = deps.readdirSync(habitsDir)
      .filter((name) => name.endsWith(".md") && isRsvpHabitName(name.replace(/\.md$/, "")))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => {
        const filePath = path.join(habitsDir, name)
        return parseHabitFile(deps.readFileSync(filePath), filePath)
      })
    const habitStates = rsvpHabits.map((habit) => ({
      name: habit.name,
      status: habit.status,
      degradedReason: habit.status === "degraded" ? habit.degradedReason : null,
    }))
    if (rsvpHabits.some((habit) => habit.status === "degraded")) {
      return { status: "fail", detail: "RSVP habit definitions degraded", habitStates }
    }
    const active = rsvpHabits.find((habit) => habit.status === "active")
    if (!active) return { status: "warn", detail: "no active RSVP habit found", habitStates }
    if (!active.rsvp) return { status: "fail", detail: `activeHabit=${active.name}; typed RSVP habit metadata missing`, habitStates }
    const cadence = active.cadence ?? "unspecified"
    return {
      status: "pass",
      detail: [
        `activeHabit=${active.name}`,
        `cadence=${cadence}`,
        `sense=${active.rsvp.sense}`,
        `source=${active.rsvp.source}`,
        `snapshotRef=${active.rsvp.snapshotRef}`,
      ].join("; "),
      activeHabit: active.name,
      cadence,
      policyVersion: active.rsvp.policyVersion,
      sense: active.rsvp.sense,
      source: active.rsvp.source,
      routeRef: active.rsvp.routeRef,
      snapshotRef: active.rsvp.snapshotRef,
      outboundStateRef: active.rsvp.outboundStateRef,
      budgetRef: active.rsvp.budgetRef,
      idempotencyRef: active.rsvp.idempotencyRef,
      habitStates,
    }
  } catch (error) {
    return { status: "fail", detail: `habit schedule unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function latestFetchHealth(agentRoot: string, deps: RsvpDiagnosticsDeps): RsvpLatestFetchHealth {
  const latestPath = path.join(agentRoot, "state", "rsvp", "snapshots", "latest.json")
  if (!deps.existsSync(latestPath)) return { status: "warn", detail: "latest RSVP snapshot missing" }
  const parsed = readJson(latestPath, deps)
  if (!isRecord(parsed)) return { status: "fail", detail: "latest RSVP snapshot is malformed" }
  const snapshotId = stringField(parsed, "snapshotId")
  const counts = countsFrom(parsed.counts) ?? countsFrom(parsed.summary)
  if (!snapshotId || !counts) return { status: "fail", detail: "latest RSVP snapshot missing id or counts" }
  return {
    status: "pass",
    detail: `snapshotId=${snapshotId}; pending=${counts.pending}`,
    snapshotId,
    counts,
  }
}

function deliveryReconciliationHealth(agentRoot: string, deps: RsvpDiagnosticsDeps): RsvpDeliveryReconciliationHealth {
  const legacyLedgerPath = path.join(agentRoot, "state", "rsvp", "outbound", "ledger.json")
  if (deps.existsSync(legacyLedgerPath)) {
    const parsed = readJson(legacyLedgerPath, deps)
    const reservations = isRecord(parsed) && Array.isArray(parsed.reservations) ? parsed.reservations : []
    const accepted = reservations.filter((entry) => isRecord(entry) && entry.status === "accepted").length
    return { status: "pass", detail: `accepted=${accepted}`, accepted }
  }
  const statePath = path.join(agentRoot, "state", "rsvp", "outbound-state.json")
  if (!deps.existsSync(statePath)) return { status: "warn", detail: "RSVP outbound state missing", accepted: 0 }
  const parsed = readJson(statePath, deps)
  if (!isRecord(parsed)) return { status: "fail", detail: "RSVP outbound state is malformed", accepted: 0 }
  const accepted = isRecord(parsed.baseline) ? 1 : 0
  return { status: "pass", detail: `accepted=${accepted}`, accepted }
}

function spendTimelineHealth(agentRoot: string, deps: RsvpDiagnosticsDeps): RsvpSpendTimelineHealth {
  const spendPath = path.join(agentRoot, "state", "rsvp", "spend-ledger.json")
  if (!deps.existsSync(spendPath)) return { status: "warn", detail: "RSVP spend ledger missing", runs: 0 }
  const parsed = readJson(spendPath, deps)
  if (!isRecord(parsed) || !Array.isArray(parsed.runs)) {
    return { status: "fail", detail: "RSVP spend ledger is malformed", runs: 0 }
  }
  return { status: "pass", detail: `runs=${parsed.runs.length}`, runs: parsed.runs.length }
}

export function collectRsvpDiagnostics(agentRoot: string, deps: RsvpDiagnosticsDeps): RsvpDiagnostics {
  const diagnostics = {
    contextPacketLedger: contextPacketLedgerHealth(agentRoot, deps),
    habitSchedule: habitScheduleHealth(agentRoot, deps),
    latestFetch: latestFetchHealth(agentRoot, deps),
    deliveryReconciliation: deliveryReconciliationHealth(agentRoot, deps),
    spendTimeline: spendTimelineHealth(agentRoot, deps),
  }
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.diagnostics_collected",
    message: "collected RSVP diagnostics",
    meta: {
      contextPacketLedger: diagnostics.contextPacketLedger.status,
      habitSchedule: diagnostics.habitSchedule.status,
      latestFetch: diagnostics.latestFetch.status,
      deliveryReconciliation: diagnostics.deliveryReconciliation.status,
      spendTimeline: diagnostics.spendTimeline.status,
    },
  })
  return diagnostics
}
