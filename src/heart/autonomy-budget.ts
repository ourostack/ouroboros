import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { runLedgerHash } from "./run-ledger"

export type AutonomyTriggerType = "proactive" | "recovery" | "habit" | "manual" | "reload"
export type AutonomySourceKind = "sense" | "private-runtime" | "daemon" | "cli"
export type AutonomyDecisionStatus = "allowed" | "blocked" | "duplicate"
export type AutonomyRepairActor = "agent-runnable" | "human-required" | "human-choice"
export type AutonomyReservationStatus = "reserved" | "failed"

export interface AutonomyBudgetPolicy {
  agentProactivePaidTurnsPerHour: number
  agentProactivePaidTurnsPerDay: number
  senseRecoveryPaidTurnsPer15m: number
  senseRecoveryPaidTurnsPerDay: number
  habitPaidTurnsPerDay: number
  duplicateRecoveryTtlMs: number
  duplicateHabitTtlMs: number
  stormFailureThreshold: number
  stormFailureWindowMs: number
  stormBlockMs: number
}

export const AUTONOMY_BUDGET_DEFAULT_POLICY: AutonomyBudgetPolicy = {
  agentProactivePaidTurnsPerHour: 6,
  agentProactivePaidTurnsPerDay: 40,
  senseRecoveryPaidTurnsPer15m: 3,
  senseRecoveryPaidTurnsPerDay: 12,
  habitPaidTurnsPerDay: 4,
  duplicateRecoveryTtlMs: 10 * 60 * 1000,
  duplicateHabitTtlMs: 24 * 60 * 60 * 1000,
  stormFailureThreshold: 3,
  stormFailureWindowMs: 10 * 60 * 1000,
  stormBlockMs: 30 * 60 * 1000,
}

export interface AutonomyBudgetRequest {
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  target: unknown
  idempotencyKey: string
  now?: string
  storm?: AutonomyStormInput
}

export interface AutonomyStormInput {
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  provider: string
  target: unknown
  normalizedErrorName: string
  normalizedErrorCode: string
  codeLocation: string
  idempotencyBucket: string
}

export interface AutonomyBudgetReservation {
  schemaVersion: 1
  reservedAt: string
  status?: AutonomyReservationStatus
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  targetHash: string
  idempotencyKey: string
  contentStored: false
}

export interface AutonomyFailureRecord {
  schemaVersion: 1
  occurredAt: string
  fingerprint: string
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  provider: string
  targetHash: string
  normalizedErrorName: string
  normalizedErrorCode: string
  codeLocation: string
  idempotencyBucket: string
  contentStored: false
}

export interface AutonomyStormBreaker {
  schemaVersion: 1
  fingerprint: string
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  provider: string
  targetHash: string
  normalizedErrorName: string
  normalizedErrorCode: string
  codeLocation: string
  idempotencyBucket: string
  blockedAt: string
  blockedUntil: string
  failureCount: number
  contentStored: false
}

export interface AutonomyBudgetState {
  schemaVersion: 1
  updatedAt: string
  reservations: AutonomyBudgetReservation[]
  failures: AutonomyFailureRecord[]
}

export interface AutonomyReceipt {
  schemaVersion: 1
  receiptId: string
  status: Exclude<AutonomyDecisionStatus, "allowed">
  reason: string
  actor: AutonomyRepairActor
  decidedAt: string
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  targetHash: string
  idempotencyKey: string
  contentStored: false
}

export interface AutonomyBudgetDecision {
  allowed: boolean
  status: AutonomyDecisionStatus
  actor: AutonomyRepairActor
  reason: string
  decidedAt: string
  agent: string
  triggerType: AutonomyTriggerType
  sourceKind: AutonomySourceKind
  senseOrHabit: string
  targetHash: string
  idempotencyKey: string
  receiptId?: string
}

export interface RecordAutonomyFailureInput extends AutonomyStormInput {
  occurredAt?: string
}

function autonomyRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "autonomy")
}

export function autonomyBudgetStatePath(agentRoot: string): string {
  return path.join(autonomyRoot(agentRoot), "budgets.json")
}

export function autonomyReceiptsDir(agentRoot: string): string {
  return path.join(autonomyRoot(agentRoot), "receipts")
}

function stormBreakersPath(agentRoot: string): string {
  return path.join(autonomyRoot(agentRoot), "storm-breakers.jsonl")
}

function nowIso(input?: string): string {
  return input ?? new Date().toISOString()
}

function parseMs(value: string): number {
  return Date.parse(value)
}

function sameCivilDay(left: string, right: string): boolean {
  return left.slice(0, 10) === right.slice(0, 10)
}

function emptyState(): AutonomyBudgetState {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    reservations: [],
    failures: [],
  }
}

function isReservation(value: unknown): value is AutonomyBudgetReservation {
  const row = value as Partial<AutonomyBudgetReservation> | null
  return !!row
    && row.schemaVersion === 1
    && typeof row.reservedAt === "string"
    && (row.status === undefined || row.status === "reserved" || row.status === "failed")
    && typeof row.agent === "string"
    && typeof row.triggerType === "string"
    && typeof row.sourceKind === "string"
    && typeof row.senseOrHabit === "string"
    && typeof row.targetHash === "string"
    && typeof row.idempotencyKey === "string"
    && row.contentStored === false
}

function isFailure(value: unknown): value is AutonomyFailureRecord {
  const row = value as Partial<AutonomyFailureRecord> | null
  return !!row
    && row.schemaVersion === 1
    && typeof row.occurredAt === "string"
    && typeof row.fingerprint === "string"
    && typeof row.agent === "string"
    && typeof row.triggerType === "string"
    && typeof row.sourceKind === "string"
    && typeof row.senseOrHabit === "string"
    && typeof row.provider === "string"
    && typeof row.targetHash === "string"
    && typeof row.normalizedErrorName === "string"
    && typeof row.normalizedErrorCode === "string"
    && typeof row.codeLocation === "string"
    && typeof row.idempotencyBucket === "string"
    && row.contentStored === false
}

export function readAutonomyBudgetState(agentRoot: string): AutonomyBudgetState {
  const filePath = autonomyBudgetStatePath(agentRoot)
  if (!fs.existsSync(filePath)) return emptyState()
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<AutonomyBudgetState>
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      reservations: Array.isArray(parsed.reservations) ? parsed.reservations.filter(isReservation) : [],
      failures: Array.isArray(parsed.failures) ? parsed.failures.filter(isFailure) : [],
    }
  } catch {
    return emptyState()
  }
}

function writeAutonomyBudgetState(agentRoot: string, state: AutonomyBudgetState): void {
  const filePath = autonomyBudgetStatePath(agentRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8")
}

function receiptIdFor(input: Pick<AutonomyBudgetDecision, "status" | "idempotencyKey" | "targetHash" | "decidedAt">): string {
  return `autr_${runLedgerHash(input).slice("sha256:".length, "sha256:".length + 32)}`
}

function writeReceipt(agentRoot: string, decision: Omit<AutonomyBudgetDecision, "allowed" | "receiptId"> & { status: "blocked" | "duplicate" }): AutonomyReceipt {
  const receiptId = receiptIdFor(decision)
  const receipt: AutonomyReceipt = {
    schemaVersion: 1,
    receiptId,
    status: decision.status,
    reason: decision.reason,
    actor: decision.actor,
    decidedAt: decision.decidedAt,
    agent: decision.agent,
    triggerType: decision.triggerType,
    sourceKind: decision.sourceKind,
    senseOrHabit: decision.senseOrHabit,
    targetHash: decision.targetHash,
    idempotencyKey: decision.idempotencyKey,
    contentStored: false,
  }
  const filePath = path.join(autonomyReceiptsDir(agentRoot), `${receiptId}.json`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf-8")
  return receipt
}

function duplicateTtlMs(triggerType: AutonomyTriggerType, policy: AutonomyBudgetPolicy): number {
  if (triggerType === "habit") return policy.duplicateHabitTtlMs
  return policy.duplicateRecoveryTtlMs
}

function paidAutonomyTrigger(triggerType: AutonomyTriggerType): boolean {
  return triggerType === "proactive" || triggerType === "recovery" || triggerType === "habit" || triggerType === "reload"
}

function inWindow(at: string, now: string, windowMs: number): boolean {
  const atMs = parseMs(at)
  const nowMs = parseMs(now)
  return Number.isFinite(atMs) && Number.isFinite(nowMs) && nowMs - atMs >= 0 && nowMs - atMs <= windowMs
}

function reservationFor(request: AutonomyBudgetRequest, decidedAt: string): AutonomyBudgetReservation {
  return {
    schemaVersion: 1,
    reservedAt: decidedAt,
    status: "reserved",
    agent: request.agent,
    triggerType: request.triggerType,
    sourceKind: request.sourceKind,
    senseOrHabit: request.senseOrHabit,
    targetHash: runLedgerHash(request.target),
    idempotencyKey: request.idempotencyKey,
    contentStored: false,
  }
}

function stormFingerprint(input: AutonomyStormInput): string {
  return runLedgerHash({
    agent: input.agent,
    triggerType: input.triggerType,
    sourceKind: input.sourceKind,
    senseOrHabit: input.senseOrHabit,
    provider: input.provider,
    targetHash: runLedgerHash(input.target),
    normalizedErrorName: input.normalizedErrorName,
    normalizedErrorCode: input.normalizedErrorCode,
    codeLocation: input.codeLocation,
    idempotencyBucket: input.idempotencyBucket,
  })
}

function failureRecord(input: RecordAutonomyFailureInput, occurredAt: string): AutonomyFailureRecord {
  return {
    schemaVersion: 1,
    occurredAt,
    fingerprint: stormFingerprint(input),
    agent: input.agent,
    triggerType: input.triggerType,
    sourceKind: input.sourceKind,
    senseOrHabit: input.senseOrHabit,
    provider: input.provider,
    targetHash: runLedgerHash(input.target),
    normalizedErrorName: input.normalizedErrorName,
    normalizedErrorCode: input.normalizedErrorCode,
    codeLocation: input.codeLocation,
    idempotencyBucket: input.idempotencyBucket,
    contentStored: false,
  }
}

export function readAutonomyStormBreakers(agentRoot: string): AutonomyStormBreaker[] {
  const filePath = stormBreakersPath(agentRoot)
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as AutonomyStormBreaker
        return parsed.schemaVersion === 1 && parsed.contentStored === false ? [parsed] : []
      } catch {
        return []
      }
    })
}

function appendStormBreaker(agentRoot: string, breaker: AutonomyStormBreaker): void {
  const filePath = stormBreakersPath(agentRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(breaker)}\n`, "utf-8")
}

function activeStormBreaker(agentRoot: string, input: AutonomyStormInput, now: string): AutonomyStormBreaker | null {
  const fingerprint = stormFingerprint(input)
  const nowMs = parseMs(now)
  return readAutonomyStormBreakers(agentRoot)
    .filter((breaker) => breaker.fingerprint === fingerprint)
    .filter((breaker) => parseMs(breaker.blockedUntil) > nowMs)
    .sort((left, right) => right.blockedAt.localeCompare(left.blockedAt))[0] ?? null
}

function blockDecision(
  agentRoot: string,
  request: AutonomyBudgetRequest,
  decidedAt: string,
  status: "blocked" | "duplicate",
  reason: string,
): AutonomyBudgetDecision {
  const targetHash = runLedgerHash(request.target)
  const base = {
    status,
    actor: "agent-runnable" as const,
    reason,
    decidedAt,
    agent: request.agent,
    triggerType: request.triggerType,
    sourceKind: request.sourceKind,
    senseOrHabit: request.senseOrHabit,
    targetHash,
    idempotencyKey: request.idempotencyKey,
  }
  const receipt = writeReceipt(agentRoot, base)
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.autonomy_budget_blocked",
    message: "autonomy trigger blocked before paid work",
    meta: {
      agent: request.agent,
      triggerType: request.triggerType,
      sourceKind: request.sourceKind,
      senseOrHabit: request.senseOrHabit,
      status,
      reason,
      receiptId: receipt.receiptId,
    },
  })
  return { allowed: false, ...base, receiptId: receipt.receiptId }
}

function budgetBlockReason(state: AutonomyBudgetState, request: AutonomyBudgetRequest, now: string, policy: AutonomyBudgetPolicy): string | null {
  if (!paidAutonomyTrigger(request.triggerType)) return null
  const agentRecentHour = state.reservations.filter((row) =>
    row.agent === request.agent
    && paidAutonomyTrigger(row.triggerType)
    && inWindow(row.reservedAt, now, 60 * 60 * 1000),
  ).length
  if (agentRecentHour >= policy.agentProactivePaidTurnsPerHour) return "agent proactive paid turn budget exceeded for rolling hour"
  const agentToday = state.reservations.filter((row) =>
    row.agent === request.agent
    && paidAutonomyTrigger(row.triggerType)
    && sameCivilDay(row.reservedAt, now),
  ).length
  if (agentToday >= policy.agentProactivePaidTurnsPerDay) return "agent proactive paid turn budget exceeded for day"
  if (request.triggerType === "recovery" && request.sourceKind === "sense") {
    const recentRecovery = state.reservations.filter((row) =>
      row.agent === request.agent
      && row.triggerType === "recovery"
      && row.sourceKind === request.sourceKind
      && row.senseOrHabit === request.senseOrHabit
      && inWindow(row.reservedAt, now, 15 * 60 * 1000),
    ).length
    if (recentRecovery >= policy.senseRecoveryPaidTurnsPer15m) return "sense recovery paid turn budget exceeded for rolling 15 minutes"
    const recoveryToday = state.reservations.filter((row) =>
      row.agent === request.agent
      && row.triggerType === "recovery"
      && row.sourceKind === request.sourceKind
      && row.senseOrHabit === request.senseOrHabit
      && sameCivilDay(row.reservedAt, now),
    ).length
    if (recoveryToday >= policy.senseRecoveryPaidTurnsPerDay) return "sense recovery paid turn budget exceeded for day"
  }
  if (request.triggerType === "habit") {
    const habitToday = state.reservations.filter((row) =>
      row.agent === request.agent
      && row.triggerType === "habit"
      && row.senseOrHabit === request.senseOrHabit
      && sameCivilDay(row.reservedAt, now),
    ).length
    if (habitToday >= policy.habitPaidTurnsPerDay) return "habit paid turn budget exceeded for day"
  }
  return null
}

export function reserveAutonomyBudget(
  agentRoot: string,
  request: AutonomyBudgetRequest,
  policy: AutonomyBudgetPolicy = AUTONOMY_BUDGET_DEFAULT_POLICY,
): AutonomyBudgetDecision {
  const decidedAt = nowIso(request.now)
  const state = readAutonomyBudgetState(agentRoot)
  const targetHash = runLedgerHash(request.target)
  const duplicate = state.reservations.find((row) =>
    row.idempotencyKey === request.idempotencyKey
    && row.status !== "failed"
    && inWindow(row.reservedAt, decidedAt, duplicateTtlMs(request.triggerType, policy)),
  )
  if (duplicate) return blockDecision(agentRoot, request, decidedAt, "duplicate", "duplicate trigger suppressed")
  if (request.storm && activeStormBreaker(agentRoot, request.storm, decidedAt)) {
    return blockDecision(agentRoot, request, decidedAt, "blocked", "storm breaker active for this trigger fingerprint")
  }
  const reason = budgetBlockReason(state, request, decidedAt, policy)
  if (reason) return blockDecision(agentRoot, request, decidedAt, "blocked", reason)
  const reservation = reservationFor(request, decidedAt)
  const nextState: AutonomyBudgetState = {
    schemaVersion: 1,
    updatedAt: decidedAt,
    reservations: [...state.reservations, reservation],
    failures: state.failures,
  }
  writeAutonomyBudgetState(agentRoot, nextState)
  emitNervesEvent({
    component: "heart",
    event: "heart.autonomy_budget_allowed",
    message: "autonomy trigger reserved budget before paid work",
    meta: {
      agent: request.agent,
      triggerType: request.triggerType,
      sourceKind: request.sourceKind,
      senseOrHabit: request.senseOrHabit,
      targetHash,
    },
  })
  return {
    allowed: true,
    status: "allowed",
    actor: "agent-runnable",
    reason: "budget reserved",
    decidedAt,
    agent: request.agent,
    triggerType: request.triggerType,
    sourceKind: request.sourceKind,
    senseOrHabit: request.senseOrHabit,
    targetHash,
    idempotencyKey: request.idempotencyKey,
  }
}

export function recordAutonomyFailure(
  agentRoot: string,
  input: RecordAutonomyFailureInput,
  policy: AutonomyBudgetPolicy = AUTONOMY_BUDGET_DEFAULT_POLICY,
): AutonomyFailureRecord {
  const occurredAt = nowIso(input.occurredAt)
  const record = failureRecord(input, occurredAt)
  const state = readAutonomyBudgetState(agentRoot)
  const targetHash = runLedgerHash(input.target)
  const reservations = state.reservations.map((row) =>
    row.agent === input.agent
    && row.triggerType === input.triggerType
    && row.sourceKind === input.sourceKind
    && row.senseOrHabit === input.senseOrHabit
    && row.targetHash === targetHash
    && row.status !== "failed"
      ? { ...row, status: "failed" as const }
      : row)
  const nextFailures = [...state.failures, record]
  writeAutonomyBudgetState(agentRoot, {
    schemaVersion: 1,
    updatedAt: occurredAt,
    reservations,
    failures: nextFailures,
  })
  const recent = nextFailures.filter((row) =>
    row.fingerprint === record.fingerprint
    && inWindow(row.occurredAt, occurredAt, policy.stormFailureWindowMs),
  )
  if (recent.length >= policy.stormFailureThreshold && !activeStormBreaker(agentRoot, input, occurredAt)) {
    const breaker: AutonomyStormBreaker = {
      schemaVersion: 1,
      fingerprint: record.fingerprint,
      agent: record.agent,
      triggerType: record.triggerType,
      sourceKind: record.sourceKind,
      senseOrHabit: record.senseOrHabit,
      provider: record.provider,
      targetHash: record.targetHash,
      normalizedErrorName: record.normalizedErrorName,
      normalizedErrorCode: record.normalizedErrorCode,
      codeLocation: record.codeLocation,
      idempotencyBucket: record.idempotencyBucket,
      blockedAt: occurredAt,
      blockedUntil: new Date(parseMs(occurredAt) + policy.stormBlockMs).toISOString(),
      failureCount: recent.length,
      contentStored: false,
    }
    appendStormBreaker(agentRoot, breaker)
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.autonomy_storm_breaker",
      message: "autonomy storm breaker activated",
      meta: {
        agent: breaker.agent,
        triggerType: breaker.triggerType,
        sourceKind: breaker.sourceKind,
        senseOrHabit: breaker.senseOrHabit,
        blockedUntil: breaker.blockedUntil,
        failureCount: breaker.failureCount,
      },
    })
  }
  return record
}
