import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { UsageData } from "../mind/context"
import { emitNervesEvent } from "../nerves/runtime"

export type RunLedgerTriggerType = "inbound" | "habit" | "reload" | "recovery" | "manual"
export type RunLedgerSourceKind = "sense" | "private-runtime" | "daemon" | "cli"
export type RunLedgerLifecycle = "started" | "completed" | "skipped" | "blocked" | "error"
export type RunLedgerUsageSource = "provider" | "none" | "reported-unavailable"

export interface RunLedgerUsageMetadata {
  source: RunLedgerUsageSource
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface RunLedgerSessionRef {
  channel: string
  keyHash: string
}

export interface RunLedgerIds {
  runId: string
  rootRunId: string
  parentRunId?: string
  idempotencyKey: string
  targetHash: string
}

export interface DeriveRunLedgerIdsInput {
  agent: string
  triggerType: RunLedgerTriggerType
  sourceKind: RunLedgerSourceKind
  senseOrHabit: string
  target: unknown
  idempotencyScope?: unknown
  parentRunId?: string
  rootRunId?: string
}

export interface CreateRunLedgerRecordInput extends DeriveRunLedgerIdsInput {
  lifecycle: RunLedgerLifecycle
  startedAt: string
  endedAt?: string
  usage?: RunLedgerUsageMetadata
  provider?: string
  model?: string
  sessionRef?: RunLedgerSessionRef
  contextPacketIds?: string[]
  errorName?: string
  errorCode?: string
}

export interface RunLedgerRecord {
  schemaVersion: 1
  recordedAt: string
  runId: string
  rootRunId: string
  parentRunId?: string
  idempotencyKey: string
  agent: string
  triggerType: RunLedgerTriggerType
  sourceKind: RunLedgerSourceKind
  senseOrHabit: string
  targetHash: string
  lifecycle: RunLedgerLifecycle
  startedAt: string
  endedAt?: string
  usage?: RunLedgerUsageMetadata
  provider?: string
  model?: string
  sessionRef?: RunLedgerSessionRef
  contextPacketIds: string[]
  contentStored: false
  errorName?: string
  errorCode?: string
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function runLedgerHash(value: unknown): string {
  return `sha256:${hashValue(value)}`
}

function stableUnique(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim().length > 0))]
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

export function usageMetadataFromUsageData(
  usage: Partial<UsageData> | undefined,
  source: RunLedgerUsageSource,
): RunLedgerUsageMetadata {
  return {
    source,
    inputTokens: numberOrZero(usage?.input_tokens),
    outputTokens: numberOrZero(usage?.output_tokens),
    reasoningTokens: numberOrZero(usage?.reasoning_tokens),
    totalTokens: numberOrZero(usage?.total_tokens),
  }
}

export function deriveRunLedgerIds(input: DeriveRunLedgerIdsInput): RunLedgerIds {
  const targetHash = runLedgerHash(input.target)
  const idempotencyKey = `idem_${hashValue({
    agent: input.agent,
    triggerType: input.triggerType,
    sourceKind: input.sourceKind,
    senseOrHabit: input.senseOrHabit,
    scope: input.idempotencyScope ?? input.target,
  }).slice(0, 32)}`
  const runId = `run_${hashValue({
    agent: input.agent,
    triggerType: input.triggerType,
    sourceKind: input.sourceKind,
    senseOrHabit: input.senseOrHabit,
    targetHash,
    idempotencyKey,
    parentRunId: input.parentRunId ?? null,
  }).slice(0, 24)}`
  return {
    runId,
    rootRunId: input.rootRunId ?? input.parentRunId ?? runId,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    idempotencyKey,
    targetHash,
  }
}

export function createRunLedgerRecord(input: CreateRunLedgerRecordInput): RunLedgerRecord {
  const ids = deriveRunLedgerIds(input)
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    ...ids,
    agent: input.agent,
    triggerType: input.triggerType,
    sourceKind: input.sourceKind,
    senseOrHabit: input.senseOrHabit,
    lifecycle: input.lifecycle,
    startedAt: input.startedAt,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
    contextPacketIds: stableUnique(input.contextPacketIds),
    contentStored: false,
    ...(input.errorName ? { errorName: input.errorName } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  }
}

export function runLedgerPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "run-ledger", "runs.jsonl")
}

export function appendRunLedgerRecord(agentRoot: string, record: RunLedgerRecord): void {
  const filePath = runLedgerPath(agentRoot)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8")
  emitNervesEvent({
    component: "heart",
    event: "heart.run_ledger_recorded",
    message: "recorded causal run ledger row",
    meta: {
      agent: record.agent,
      runId: record.runId,
      triggerType: record.triggerType,
      sourceKind: record.sourceKind,
      lifecycle: record.lifecycle,
      senseOrHabit: record.senseOrHabit,
    },
  })
}

export function appendRunLedgerRecordNonFatal(agentRoot: string, record: RunLedgerRecord): boolean {
  try {
    appendRunLedgerRecord(agentRoot, record)
    return true
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "heart",
      event: "heart.run_ledger_record_error",
      message: "failed to record causal run ledger row",
      meta: {
        agent: record.agent,
        runId: record.runId,
        lifecycle: record.lifecycle,
        error: String(error),
      },
    })
    return false
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isUsageMetadata(value: unknown): value is RunLedgerUsageMetadata {
  const usage = value as Partial<RunLedgerUsageMetadata> | null
  return !!usage
    && (usage.source === "provider" || usage.source === "none" || usage.source === "reported-unavailable")
    && typeof usage.inputTokens === "number"
    && typeof usage.outputTokens === "number"
    && typeof usage.reasoningTokens === "number"
    && typeof usage.totalTokens === "number"
}

function isSessionRef(value: unknown): value is RunLedgerSessionRef {
  const ref = value as Partial<RunLedgerSessionRef> | null
  return !!ref
    && typeof ref.channel === "string"
    && typeof ref.keyHash === "string"
}

function isRunLedgerRecord(value: unknown): value is RunLedgerRecord {
  const record = value as Partial<RunLedgerRecord> | null
  return !!record
    && record.schemaVersion === 1
    && typeof record.recordedAt === "string"
    && typeof record.runId === "string"
    && typeof record.rootRunId === "string"
    && (record.parentRunId === undefined || typeof record.parentRunId === "string")
    && typeof record.idempotencyKey === "string"
    && typeof record.agent === "string"
    && (record.triggerType === "inbound" || record.triggerType === "habit" || record.triggerType === "reload" || record.triggerType === "recovery" || record.triggerType === "manual")
    && (record.sourceKind === "sense" || record.sourceKind === "private-runtime" || record.sourceKind === "daemon" || record.sourceKind === "cli")
    && typeof record.senseOrHabit === "string"
    && typeof record.targetHash === "string"
    && (record.lifecycle === "started" || record.lifecycle === "completed" || record.lifecycle === "skipped" || record.lifecycle === "blocked" || record.lifecycle === "error")
    && typeof record.startedAt === "string"
    && (record.endedAt === undefined || typeof record.endedAt === "string")
    && (record.usage === undefined || isUsageMetadata(record.usage))
    && (record.provider === undefined || typeof record.provider === "string")
    && (record.model === undefined || typeof record.model === "string")
    && (record.sessionRef === undefined || isSessionRef(record.sessionRef))
    && isStringArray(record.contextPacketIds)
    && record.contentStored === false
    && (record.errorName === undefined || typeof record.errorName === "string")
    && (record.errorCode === undefined || typeof record.errorCode === "string")
}

function emitMalformedRunLedgerRow(lineNumber: number, reason: string): void {
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.run_ledger_malformed",
    message: "skipped malformed causal run ledger row",
    meta: { lineNumber, reason },
  })
}

export function readRunLedger(agentRoot: string): RunLedgerRecord[] {
  const filePath = runLedgerPath(agentRoot)
  if (!fs.existsSync(filePath)) return []
  const rows: RunLedgerRecord[] = []
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim().length > 0)
  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRunLedgerRecord(parsed)) {
        rows.push(parsed)
      } else {
        emitMalformedRunLedgerRow(index + 1, "invalid shape")
      }
    } catch (error) {
      emitMalformedRunLedgerRow(index + 1, String(error))
    }
  })
  return rows
}
