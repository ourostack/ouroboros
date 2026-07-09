import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { randomUUID } from "crypto"
import {
  isFlightRecorderResume,
  readFlightRecorderResume,
  recordFlightRecorderEvent,
  type FlightRecorderEvent,
  type FlightRecorderResume,
} from "../arc/flight-recorder"
import { emitNervesEvent } from "../nerves/runtime"
import { runContextLossGauntlet, type ContextLossGauntletReport } from "./context-loss-gauntlet"
import type { DaemonHealthResult } from "./daemon/daemon"
import {
  buildAgentProviderVisibility,
  type AgentProviderVisibility,
  type ProviderVisibilityLane,
} from "./provider-visibility"

export type ContextLossSentinelTrigger =
  | "post_turn"
  | "provider_failover"
  | "daemon_startup"
  | "daemon_health"
  | "session_start"
  | "manual_cli"

export type ContextLossSentinelVerdict = "ready" | "watch" | "blocked"
export type ContextLossSentinelSignalKind = "gauntlet" | "provider_lane" | "sense" | "daemon" | "bundle"
export type ContextLossSentinelSignalStatus = "pass" | "warn" | "fail"
export type ContextLossSentinelSignalSeverity = "info" | "warn" | "critical"
export type ContextLossSentinelVerdictImpact = "none" | "watch" | "blocked"
export type ContextLossSentinelRepairActor = "agent-runnable" | "human-required" | "human-choice"

export interface ContextLossSentinelSource {
  kind: string
  locator: string
}

export interface ContextLossSentinelRepair {
  actor: ContextLossSentinelRepairActor
  kind: string
  command?: string
  detail: string
}

export interface ContextLossSentinelSignal {
  id: string
  kind: ContextLossSentinelSignalKind
  status: ContextLossSentinelSignalStatus
  severity: ContextLossSentinelSignalSeverity
  verdictImpact: ContextLossSentinelVerdictImpact
  summary: string
  source: ContextLossSentinelSource
  repair?: ContextLossSentinelRepair
  meta?: Record<string, unknown>
}

export interface ContextLossSentinelRecoveryAnchor {
  kind: "flight-recorder" | "latest-ready"
  currentAsk: string | null
  nextSafeAction: string | null
  flightRecorderLatestLocator: string
  sourceEventIds: string[]
  recordedAt: string | null
}

export interface ContextLossSentinelGauntletSummary {
  verdict: ContextLossGauntletReport["verdict"]
  scorePercentage: number
  failedChecks: string[]
  warnedChecks: string[]
  sourceLocator: string
}

export interface ContextLossSentinelReceipt {
  schemaVersion: 1
  id: string
  agent: string
  trigger: ContextLossSentinelTrigger
  generatedAt: string
  verdict: ContextLossSentinelVerdict
  summary: string
  receiptLocator: string
  latestReadyLocator: string | null
  recoveryAnchor: ContextLossSentinelRecoveryAnchor
  gauntlet: ContextLossSentinelGauntletSummary
  signals: ContextLossSentinelSignal[]
  sourceLocators: string[]
  resumeSnapshot: FlightRecorderResume
}

export interface ContextLossSentinelView {
  schemaVersion: 1
  latest: ContextLossSentinelReceipt | null
  latestReady: ContextLossSentinelReceipt | null
  history: ContextLossSentinelReceipt[]
  degraded: {
    issues: string[]
  }
}

export interface ContextLossSentinelPaths {
  rootDir: string
  latest: string
  latestReady: string
  historyDir: string
  receiptsDir: string
  lock: string
}

export type ContextLossSentinelGitStatus =
  | { ok: true; porcelain: string }
  | { ok: false; error: string }

export interface RefreshContextLossSentinelOptions {
  trigger: ContextLossSentinelTrigger
  now?: () => Date
  createReceiptId?: () => string
  providerVisibility?: AgentProviderVisibility
  daemonHealthResults?: DaemonHealthResult[]
  gitStatus?: () => ContextLossSentinelGitStatus
  delayBeforeWriteMs?: number
  lockTimeoutMs?: number
  homeDir?: string
}

export interface ReadContextLossSentinelViewOptions {
  limit?: number
}

const CONTEXT_LOSS_SENTINEL_RECEIPT_FILE_LIMIT = 512
const CONTEXT_LOSS_SENTINEL_GIT_STATUS_TIMEOUT_MS = 5_000

interface ContextLossSentinelOrder {
  generatedAt: string
  id: string
}

interface ContextLossSentinelWatermark {
  schemaVersion: 1
  latest: ContextLossSentinelOrder | null
  latestReady: ContextLossSentinelOrder | null
}

const REQUIRED_LANES = ["outward", "inner"] as const

function logicalLocator(...parts: string[]): string {
  return path.posix.join(...parts)
}

function relativeSentinelRoot(): string {
  return logicalLocator("arc", "flight-recorder", "context-loss-sentinel")
}

function latestLocator(): string {
  return logicalLocator(relativeSentinelRoot(), "latest.json")
}

function latestReadyLocator(): string {
  return logicalLocator(relativeSentinelRoot(), "latest-ready.json")
}

function receiptLocator(receiptId: string): string {
  return logicalLocator(relativeSentinelRoot(), "receipts", `${receiptId}.json`)
}

function historyDay(generatedAt: string): string {
  return generatedAt.slice(0, 10)
}

function historyLocator(generatedAt: string): string {
  return logicalLocator(relativeSentinelRoot(), "history", `${historyDay(generatedAt)}.jsonl`)
}

export function contextLossSentinelPaths(agentRoot: string): ContextLossSentinelPaths {
  const rootDir = path.join(agentRoot, relativeSentinelRoot())
  return {
    rootDir,
    latest: path.join(rootDir, "latest.json"),
    latestReady: path.join(rootDir, "latest-ready.json"),
    historyDir: path.join(rootDir, "history"),
    receiptsDir: path.join(rootDir, "receipts"),
    lock: path.join(rootDir, ".write.lock"),
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
  fs.renameSync(tmpPath, filePath)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withFileLock<T>(lockPath: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const startedAt = Date.now()
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx")
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, "utf-8")
        return await fn()
      } finally {
        fs.closeSync(fd)
        fs.rmSync(lockPath, { force: true })
      }
    } catch (error) {
      const code = String((error as { code?: unknown }).code)
      if (code !== "EEXIST") {
        throw error
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`context-loss Sentinel lock timed out: ${lockPath}`)
      }
      await sleep(5)
    }
  }
}

function compareReceiptOrder(left: ContextLossSentinelReceipt, right: ContextLossSentinelReceipt): number {
  const leftTime = Date.parse(left.generatedAt)
  const rightTime = Date.parse(right.generatedAt)
  if (leftTime !== rightTime) return leftTime - rightTime
  return left.id.localeCompare(right.id)
}

function shouldReplaceReceipt(existing: ContextLossSentinelReceipt | null, candidate: ContextLossSentinelReceipt): boolean {
  return existing === null || compareReceiptOrder(candidate, existing) >= 0
}

function orderFromReceipt(receipt: ContextLossSentinelReceipt): ContextLossSentinelOrder {
  return { generatedAt: receipt.generatedAt, id: receipt.id }
}

function compareOrder(left: ContextLossSentinelOrder, right: ContextLossSentinelOrder): number {
  const leftTime = Date.parse(left.generatedAt)
  const rightTime = Date.parse(right.generatedAt)
  if (leftTime !== rightTime) return leftTime - rightTime
  return left.id.localeCompare(right.id)
}

function maxOrder(
  left: ContextLossSentinelOrder | null,
  right: ContextLossSentinelOrder | null,
): ContextLossSentinelOrder | null {
  if (!left) return right
  if (!right) return left
  return compareOrder(left, right) >= 0 ? left : right
}

function isOrder(value: unknown): value is ContextLossSentinelOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.generatedAt === "string"
    && isValidTimestamp(record.generatedAt)
    && typeof record.id === "string"
}

function sentinelWatermarkPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "arc", "context-loss-sentinel-watermark.json")
}

function readWatermark(agentRoot: string): ContextLossSentinelWatermark {
  const filePath = sentinelWatermarkPath(agentRoot)
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>
    return {
      schemaVersion: 1,
      latest: isOrder(parsed.latest) ? parsed.latest : null,
      latestReady: isOrder(parsed.latestReady) ? parsed.latestReady : null,
    }
  } catch {
    return { schemaVersion: 1, latest: null, latestReady: null }
  }
}

function writeWatermark(agentRoot: string, watermark: ContextLossSentinelWatermark): void {
  atomicWriteJson(sentinelWatermarkPath(agentRoot), watermark)
}

function updateWatermarkOrder(
  watermark: ContextLossSentinelWatermark,
  key: "latest" | "latestReady",
  candidate: ContextLossSentinelReceipt,
): void {
  watermark[key] = maxOrder(watermark[key], orderFromReceipt(candidate))
}

function stableReceiptState(receipt: ContextLossSentinelReceipt): string {
  return JSON.stringify({
    verdict: receipt.verdict,
    summary: receipt.summary,
    latestReadyLocator: receipt.latestReadyLocator,
    recoveryAnchor: receipt.recoveryAnchor,
    gauntlet: receipt.gauntlet,
    signals: receipt.signals,
    resumeSnapshot: receipt.resumeSnapshot,
  })
}

function sameRecoveryState(left: ContextLossSentinelReceipt, right: ContextLossSentinelReceipt): boolean {
  return stableReceiptState(left) === stableReceiptState(right)
}

function setReceiptFileMtime(filePath: string, receipt: ContextLossSentinelReceipt): void {
  const timestamp = new Date(receipt.generatedAt)
  fs.utimesSync(filePath, timestamp, timestamp)
}

function selectLatestReadyReceipt(
  existingReady: ContextLossSentinelReceipt | null,
  candidate: ContextLossSentinelReceipt,
  latestReadyOrder: ContextLossSentinelOrder | null,
): ContextLossSentinelReceipt | null {
  if (candidate.verdict !== "ready") return existingReady
  if (latestReadyOrder && compareOrder(orderFromReceipt(candidate), latestReadyOrder) < 0) return existingReady
  return candidate
}

function shouldReplaceLatestReceipt(
  existingLatest: ContextLossSentinelReceipt | null,
  candidate: ContextLossSentinelReceipt,
  latestOrder: ContextLossSentinelOrder | null,
): boolean {
  if (latestOrder && compareOrder(orderFromReceipt(candidate), latestOrder) < 0) return false
  if (!existingLatest) return true
  return shouldReplaceReceipt(existingLatest, candidate)
}

function coalescedDaemonHealthReceipt(
  agentRoot: string,
  existingLatest: ContextLossSentinelReceipt | null,
  existingReady: ContextLossSentinelReceipt | null,
  candidate: ContextLossSentinelReceipt,
  watermark: ContextLossSentinelWatermark,
): ContextLossSentinelReceipt | null {
  if (candidate.trigger !== "daemon_health") return null
  if (!existingLatest || !sameRecoveryState(existingLatest, candidate)) return null
  if (candidate.verdict === "ready" && (!existingReady || !sameRecoveryState(existingReady, candidate))) return null
  const candidateOrder = orderFromReceipt(candidate)
  if (watermark.latest && compareOrder(candidateOrder, watermark.latest) <= 0) return existingLatest
  updateWatermarkOrder(watermark, "latest", candidate)
  if (candidate.verdict === "ready" && existingReady) {
    updateWatermarkOrder(watermark, "latestReady", candidate)
  }
  writeWatermark(agentRoot, watermark)
  return existingLatest
}

function readJson(filePath: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

function isSource(value: unknown): value is ContextLossSentinelSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.kind === "string" && typeof record.locator === "string"
}

function isRepair(value: unknown): value is ContextLossSentinelRepair {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.actor === "agent-runnable" || record.actor === "human-required" || record.actor === "human-choice")
    && typeof record.kind === "string"
    && (record.command === undefined || typeof record.command === "string")
    && typeof record.detail === "string"
}

function isSignal(value: unknown): value is ContextLossSentinelSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === "string"
    && (record.kind === "gauntlet" || record.kind === "provider_lane" || record.kind === "sense" || record.kind === "daemon" || record.kind === "bundle")
    && (record.status === "pass" || record.status === "warn" || record.status === "fail")
    && (record.severity === "info" || record.severity === "warn" || record.severity === "critical")
    && (record.verdictImpact === "none" || record.verdictImpact === "watch" || record.verdictImpact === "blocked")
    && typeof record.summary === "string"
    && isSource(record.source)
    && (record.repair === undefined || isRepair(record.repair))
}

function isRecoveryAnchor(value: unknown): value is ContextLossSentinelRecoveryAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.kind === "flight-recorder" || record.kind === "latest-ready")
    && (record.currentAsk === null || typeof record.currentAsk === "string")
    && (record.nextSafeAction === null || typeof record.nextSafeAction === "string")
    && typeof record.flightRecorderLatestLocator === "string"
    && isStringArray(record.sourceEventIds)
    && (record.recordedAt === null || typeof record.recordedAt === "string")
}

function isGauntletSummary(value: unknown): value is ContextLossSentinelGauntletSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.verdict === "ready" || record.verdict === "watch" || record.verdict === "blocked")
    && typeof record.scorePercentage === "number"
    && isStringArray(record.failedChecks)
    && isStringArray(record.warnedChecks)
    && typeof record.sourceLocator === "string"
}

function isResumeSnapshot(value: unknown): value is FlightRecorderResume {
  return isFlightRecorderResume(value)
}

function isReceipt(value: unknown): value is ContextLossSentinelReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1
    && typeof record.id === "string"
    && typeof record.agent === "string"
    && (record.trigger === "post_turn" || record.trigger === "provider_failover" || record.trigger === "daemon_startup" || record.trigger === "daemon_health" || record.trigger === "session_start" || record.trigger === "manual_cli")
    && typeof record.generatedAt === "string"
    && isValidTimestamp(record.generatedAt)
    && (record.verdict === "ready" || record.verdict === "watch" || record.verdict === "blocked")
    && typeof record.summary === "string"
    && typeof record.receiptLocator === "string"
    && (record.latestReadyLocator === null || typeof record.latestReadyLocator === "string")
    && isRecoveryAnchor(record.recoveryAnchor)
    && isGauntletSummary(record.gauntlet)
    && Array.isArray(record.signals)
    && record.signals.every(isSignal)
    && isStringArray(record.sourceLocators)
    && isResumeSnapshot(record.resumeSnapshot)
}

function readReceiptFile(filePath: string, label: string, issues: string[]): ContextLossSentinelReceipt | null {
  if (!fs.existsSync(filePath)) return null
  const parsed = readJson(filePath)
  if (!parsed.ok) {
    issues.push(`${label} unreadable: ${parsed.reason}`)
    return null
  }
  if (!isReceipt(parsed.value)) {
    issues.push(`${label} malformed`)
    return null
  }
  return parsed.value
}

function receiptIdFromFileName(fileName: string): string | null {
  return fileName.endsWith(".json") ? fileName.slice(0, -".json".length) : null
}

function receiptOrderFromDetailFile(filePath: string, fileName: string): ContextLossSentinelOrder {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
    if (isReceipt(parsed)) return orderFromReceipt(parsed)
  } catch {
    // Malformed legacy detail files should not block retention cleanup.
  }
  const stat = fs.statSync(filePath)
  return {
    generatedAt: new Date(stat.mtimeMs).toISOString(),
    id: receiptIdFromFileName(fileName)!,
  }
}

function pruneReceiptDetailFiles(
  paths: ContextLossSentinelPaths,
  protectedReceiptIds: Set<string>,
): void {
  const fileNames = fs.readdirSync(paths.receiptsDir)
    .filter((entry) => receiptIdFromFileName(entry) !== null)
  if (fileNames.length <= CONTEXT_LOSS_SENTINEL_RECEIPT_FILE_LIMIT) return

  const candidates = fileNames
    .map((fileName) => ({
      fileName,
      filePath: path.join(paths.receiptsDir, fileName),
      receiptId: receiptIdFromFileName(fileName)!,
      order: receiptOrderFromDetailFile(path.join(paths.receiptsDir, fileName), fileName),
    }))
    .filter((entry) => !protectedReceiptIds.has(entry.receiptId))
    .sort((left, right) => compareOrder(left.order, right.order))

  const removalCount = fileNames.length - CONTEXT_LOSS_SENTINEL_RECEIPT_FILE_LIMIT
  for (const entry of candidates.slice(0, removalCount)) {
    fs.rmSync(entry.filePath, { force: true })
  }
}

function isNonEmptyText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function hasSafeResumeSnapshot(receipt: ContextLossSentinelReceipt): boolean {
  const resume = receipt.resumeSnapshot
  return resume.canContinue
    && resume.hasCompleteState
    && resume.recorderHealth.status === "ok"
    && resume.blockedBecause.length === 0
    && isNonEmptyText(resume.currentAsk.value)
    && isNonEmptyText(resume.nextSafeAction.value)
}

function readLatestReadyFile(filePath: string, label: string, issues: string[]): ContextLossSentinelReceipt | null {
  const receipt = readReceiptFile(filePath, label, issues)
  if (receipt && receipt.verdict !== "ready") {
    issues.push(`${label} is not a ready receipt`)
    return null
  }
  if (receipt && (
    receipt.gauntlet.verdict !== "ready"
    || receipt.signals.some((signal) => signal.verdictImpact !== "none")
    || !hasSafeResumeSnapshot(receipt)
  )) {
    issues.push(`${label} is not a semantically ready receipt`)
    return null
  }
  return receipt
}

function readLatestReady(agentRoot: string): ContextLossSentinelReceipt | null {
  const receipt = readLatestReadyFile(contextLossSentinelPaths(agentRoot).latestReady, "latest-ready.json", [])
  return receipt?.verdict === "ready" ? receipt : null
}

function signalStatusForImpact(impact: ContextLossSentinelVerdictImpact): Pick<ContextLossSentinelSignal, "status" | "severity"> {
  if (impact === "blocked") return { status: "fail", severity: "critical" }
  if (impact === "watch") return { status: "warn", severity: "warn" }
  return { status: "pass", severity: "info" }
}

function providerCheckCommand(agentName: string, lane: ProviderVisibilityLane["lane"]): string {
  return `ouro provider check --agent ${agentName} --lane ${lane}`
}

function sourceForLane(lane: ProviderVisibilityLane["lane"]): ContextLossSentinelSource {
  return {
    kind: "provider-visibility",
    locator: `agent.json#providers.${lane}`,
  }
}

function repair(
  actor: ContextLossSentinelRepairActor,
  kind: string,
  detail: string,
  command?: string,
): ContextLossSentinelRepair {
  return {
    actor,
    kind,
    detail,
    command,
  }
}

function providerSignal(
  visibility: AgentProviderVisibility,
  lane: ProviderVisibilityLane["lane"],
  impact: ContextLossSentinelVerdictImpact,
  summary: string,
  repairValue?: ContextLossSentinelRepair,
  meta: Record<string, unknown> = {},
): ContextLossSentinelSignal {
  return {
    id: `provider:${lane}`,
    kind: "provider_lane",
    ...signalStatusForImpact(impact),
    verdictImpact: impact,
    summary,
    source: sourceForLane(lane),
    ...(repairValue ? { repair: repairValue } : {}),
    meta: {
      agentName: visibility.agentName,
      lane,
      ...meta,
    },
  }
}

function configuredProviderSignal(
  visibility: AgentProviderVisibility,
  lane: Extract<ProviderVisibilityLane, { status: "configured" }>,
): ContextLossSentinelSignal {
  if (lane.credential.status === "missing") {
    return providerSignal(
      visibility,
      lane.lane,
      "blocked",
      `${lane.lane} credentials missing for ${lane.provider}`,
      repair("human-required", "provider-credential", `${lane.provider} credentials must be added to the agent vault.`, lane.credential.repairCommand),
      { provider: lane.provider, model: lane.model, credentialStatus: lane.credential.status },
    )
  }
  if (lane.credential.status === "invalid-pool") {
    return providerSignal(
      visibility,
      lane.lane,
      "blocked",
      `${lane.lane} credential vault unavailable for ${lane.provider}`,
      repair("human-required", "vault-unavailable", "The agent credential vault must be unlocked or repaired.", lane.credential.repairCommand),
      { provider: lane.provider, model: lane.model, credentialStatus: lane.credential.status },
    )
  }
  if (lane.credential.status === "not-loaded") {
    return providerSignal(
      visibility,
      lane.lane,
      "watch",
      `${lane.lane} credentials not loaded for ${lane.provider}`,
      repair("agent-runnable", "provider-credential-cache", "Refresh the in-process provider credential cache.", lane.credential.repairCommand ?? `ouro provider refresh --agent ${visibility.agentName}`),
      { provider: lane.provider, model: lane.model, credentialStatus: lane.credential.status },
    )
  }

  if (lane.readiness.status === "failed") {
    return providerSignal(
      visibility,
      lane.lane,
      "blocked",
      `${lane.lane} live check failed for ${lane.provider}${lane.readiness.error ? `: ${lane.readiness.error}` : ""}`,
      repair("agent-runnable", "provider-live-check", "Run a fresh provider capability check and inspect the failure.", providerCheckCommand(visibility.agentName, lane.lane)),
      { provider: lane.provider, model: lane.model, readinessStatus: lane.readiness.status, checkedAt: lane.readiness.checkedAt ?? null, attempts: lane.readiness.attempts ?? null },
    )
  }
  if (lane.readiness.status === "stale" && (lane.readiness.checkedAt || lane.readiness.reason || lane.readiness.error)) {
    return providerSignal(
      visibility,
      lane.lane,
      "watch",
      `${lane.lane} readiness stale for ${lane.provider}${lane.readiness.reason ? `: ${lane.readiness.reason}` : ""}`,
      repair("agent-runnable", "provider-live-check", "Run a fresh provider capability check before relying on this lane.", providerCheckCommand(visibility.agentName, lane.lane)),
      { provider: lane.provider, model: lane.model, readinessStatus: lane.readiness.status, checkedAt: lane.readiness.checkedAt ?? null },
    )
  }
  if (lane.readiness.status === "unknown" || lane.readiness.status === "stale") {
    return providerSignal(
      visibility,
      lane.lane,
      "watch",
      `${lane.lane} readiness unknown for ${lane.provider}${lane.readiness.reason ? `: ${lane.readiness.reason}` : ""}`,
      repair("agent-runnable", "provider-live-check", "Run a provider capability check; Sentinel will not invent stale readiness without evidence.", providerCheckCommand(visibility.agentName, lane.lane)),
      { provider: lane.provider, model: lane.model, readinessStatus: "unknown" },
    )
  }

  return providerSignal(
    visibility,
    lane.lane,
    "none",
    `${lane.lane} provider ready: ${lane.provider} / ${lane.model}`,
    undefined,
    { provider: lane.provider, model: lane.model, readinessStatus: lane.readiness.status, checkedAt: lane.readiness.checkedAt ?? null },
  )
}

function missingProviderLaneSignal(visibility: AgentProviderVisibility, lane: ProviderVisibilityLane["lane"]): ContextLossSentinelSignal {
  return providerSignal(
    visibility,
    lane,
    "blocked",
    `${lane} provider visibility missing from deterministic provider report`,
    repair("agent-runnable", "provider-visibility", "Refresh Sentinel from a complete provider visibility source.", `ouro work sentinel refresh --agent ${visibility.agentName}`),
    { laneStatus: "missing-from-report" },
  )
}

export function deriveContextLossSentinelProviderSignals(visibility: AgentProviderVisibility): ContextLossSentinelSignal[] {
  return REQUIRED_LANES.map((laneName): ContextLossSentinelSignal => {
    const lane = visibility.lanes.find((entry) => entry.lane === laneName)
    if (!lane) {
      return missingProviderLaneSignal(visibility, laneName)
    }
    if (lane.status === "unconfigured") {
      return providerSignal(
        visibility,
        lane.lane,
        "blocked",
        `${lane.lane} provider unconfigured: ${lane.reason}`,
        repair("human-choice", "provider-selection", "Choose a provider and model for this lane.", lane.repairCommand),
        { laneStatus: lane.status, reason: lane.reason },
      )
    }
    return configuredProviderSignal(visibility, lane)
  })
}

function gauntletSignal(report: ContextLossGauntletReport): ContextLossSentinelSignal {
  const impact: ContextLossSentinelVerdictImpact = report.verdict === "blocked"
    ? "blocked"
    : report.verdict === "watch"
      ? "watch"
      : "none"
  return {
    id: "gauntlet:context-loss",
    kind: "gauntlet",
    ...signalStatusForImpact(impact),
    verdictImpact: impact,
    summary: report.summary,
    source: {
      kind: "context-loss-gauntlet",
      locator: "arc/flight-recorder/latest.json",
    },
    meta: {
      scorePercentage: report.score.percentage,
      failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.id),
      warnedChecks: report.checks.filter((check) => check.status === "warn").map((check) => check.id),
    },
  }
}

function healthSignalKind(result: DaemonHealthResult): "sense" | "daemon" {
  return result.name.startsWith("sense-probe:") ? "sense" : "daemon"
}

function healthSignals(results: DaemonHealthResult[]): ContextLossSentinelSignal[] {
  return results
    .filter((result) => result.name.startsWith("sense-probe:") || result.status !== "ok")
    .map((result): ContextLossSentinelSignal => {
      const impact: ContextLossSentinelVerdictImpact = result.status === "critical"
        ? "blocked"
        : result.status === "warn"
          ? "watch"
          : "none"
      const kind = healthSignalKind(result)
      return {
        id: `${kind}:${result.name}`,
        kind,
        ...signalStatusForImpact(impact),
        verdictImpact: impact,
        summary: result.message,
        source: {
          kind: "daemon-health",
          locator: `daemon.health:${result.name}`,
        },
        meta: { healthStatus: result.status },
      }
    })
}

function defaultGitStatus(agentRoot: string): ContextLossSentinelGitStatus {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: agentRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CONTEXT_LOSS_SENTINEL_GIT_STATUS_TIMEOUT_MS,
    })
    return { ok: true, porcelain }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

function gitStatusEntries(porcelain: string): string[] {
  return porcelain.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

function normalizeGitStatusPath(entryPath: string): string {
  return entryPath.trim().replace(/^"|"$/g, "")
}

function gitStatusPaths(entry: string): string[] {
  const rawPath = entry.slice(3).trim()
  const paths: string[] = []
  let start = 0
  let inQuote = false
  let escaped = false
  for (let index = 0; index < rawPath.length; index += 1) {
    const char = rawPath[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inQuote && char === "\\") {
      escaped = true
      continue
    }
    if (char === "\"") {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && rawPath.startsWith(" -> ", index)) {
      paths.push(rawPath.slice(start, index))
      start = index + 4
      index += 3
    }
  }
  paths.push(rawPath.slice(start))
  return paths.map(normalizeGitStatusPath)
}

function isSentinelGitStatusEntry(entry: string): boolean {
  const sentinelRoot = relativeSentinelRoot()
  return gitStatusPaths(entry).every((entryPath) => {
    const normalizedPath = entryPath.replace(/\/$/, "")
    return normalizedPath === sentinelRoot || normalizedPath.startsWith(`${sentinelRoot}/`)
  })
}

function isContextLossSentinelBlockerText(value: string): boolean {
  return value.startsWith("context-loss Sentinel blocked:")
}

function hasContextLossSentinelCheckpointEvents(agentRoot: string, resume: FlightRecorderResume): boolean {
  const events = readFlightRecorderEventsByIds(agentRoot, resume.lastSafeCheckpoint.sourceEventIds)
  const foundEventIds = new Set(events.map((event) => event.id))
  if (resume.lastSafeCheckpoint.sourceEventIds.some((eventId) => !foundEventIds.has(eventId))) return false
  return resume.blockedBecause.length > 0
    ? events.every(isContextLossSentinelBlockerEvent)
    : events.every(isContextLossSentinelRecoveryEvent)
}

function isContextLossSentinelCheckpoint(agentRoot: string, resume: FlightRecorderResume): boolean {
  return resume.lastSafeCheckpoint.sourceEventIds.length > 0
    && resume.lastSafeCheckpoint.sourceEventIds.every((eventId) => eventId.startsWith("fr-sentinel-"))
    && resume.blockedBecause.every(isContextLossSentinelBlockerText)
    && hasContextLossSentinelCheckpointEvents(agentRoot, resume)
}

function neutralizeSentinelCheckpoint(resume: FlightRecorderResume): FlightRecorderResume {
  return {
    ...resume,
    canContinue: true,
    blockedBecause: [],
    lastSafeCheckpoint: {
      turnId: null,
      sessionRef: null,
      recordedAt: null,
      sourceEventIds: [],
    },
    recorderHealth: { status: "ok", issues: [] },
  }
}

function isContextLossSentinelProducedRef(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.kind !== "arc" || typeof record.locator !== "string") return false
  const sentinelRoot = relativeSentinelRoot()
  return record.locator === sentinelRoot || record.locator.startsWith(`${sentinelRoot}/`)
}

function isContextLossSentinelFlightRecorderEvent(value: unknown): value is FlightRecorderEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const meta = record.meta as Record<string, unknown> | undefined
  const producedRefs = record.producedRefs
  return typeof record.id === "string"
    && record.id.startsWith("fr-sentinel-")
    && (record.kind === "blocker_detected" || record.kind === "agent_note")
    && meta?.source === "context-loss-sentinel"
    && Array.isArray(producedRefs)
    && producedRefs.length > 0
    && producedRefs.every(isContextLossSentinelProducedRef)
}

function isContextLossSentinelBlockerEvent(event: FlightRecorderEvent): boolean {
  return isContextLossSentinelFlightRecorderEvent(event)
    && event.kind === "blocker_detected"
    && Array.isArray(event.blockedBecause)
    && event.blockedBecause.length > 0
    && event.blockedBecause.every(isContextLossSentinelBlockerText)
}

function isContextLossSentinelRecoveryEvent(event: FlightRecorderEvent): boolean {
  return isContextLossSentinelFlightRecorderEvent(event)
    && event.kind === "agent_note"
    && Array.isArray(event.blockedBecause)
    && event.blockedBecause.length === 0
    && event.meta?.resolution === "blocked-signals-recovered"
}

function gitShowHeadFile(agentRoot: string, entryPath: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${entryPath}`], {
      cwd: agentRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CONTEXT_LOSS_SENTINEL_GIT_STATUS_TIMEOUT_MS,
    })
  } catch {
    return null
  }
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

function isFlightRecorderEventsPath(entryPath: string): boolean {
  return /^arc\/flight-recorder\/events\/[^/]+\.jsonl$/.test(entryPath)
}

function isFlightRecorderLatestPath(entryPath: string): boolean {
  return entryPath === "arc/flight-recorder/latest.json"
}

function isDeletedGitStatusEntry(entry: string): boolean {
  return entry.slice(0, 2).includes("D")
}

function isUntrackedGitStatusEntry(entry: string): boolean {
  return entry.startsWith("??")
}

function isWorktreeOnlyModifiedGitStatusEntry(entry: string): boolean {
  return entry.slice(0, 2) === " M"
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

function isContextLossSentinelEventFileDirty(agentRoot: string, entry: string, entryPath: string): boolean {
  if (isDeletedGitStatusEntry(entry)) return false
  const filePath = path.join(agentRoot, entryPath)
  if (isUntrackedGitStatusEntry(entry)) {
    const candidateLines = fs.existsSync(filePath) ? nonEmptyLines(fs.readFileSync(filePath, "utf-8")) : []
    return candidateLines.length > 0
      && candidateLines.every((line) => isContextLossSentinelFlightRecorderEvent(parseJsonLine(line)))
  }
  if (!isWorktreeOnlyModifiedGitStatusEntry(entry) || !fs.existsSync(filePath)) return false
  const headText = gitShowHeadFile(agentRoot, entryPath)
  if (headText === null) return false
  const headLines = nonEmptyLines(headText)
  const currentLines = nonEmptyLines(fs.readFileSync(filePath, "utf-8"))
  if (currentLines.length <= headLines.length) return false
  if (!headLines.every((line, index) => currentLines[index] === line)) return false
  const appendedLines = currentLines.slice(headLines.length)
  return appendedLines.every((line) => isContextLossSentinelFlightRecorderEvent(parseJsonLine(line)))
}

function isContextLossSentinelLatestDirty(agentRoot: string, entry: string, entryPath: string): boolean {
  if (isDeletedGitStatusEntry(entry) || isUntrackedGitStatusEntry(entry)) return false
  if (!isWorktreeOnlyModifiedGitStatusEntry(entry)) return false
  const current = readJson(path.join(agentRoot, entryPath))
  if (!current.ok || !isFlightRecorderResume(current.value) || !isContextLossSentinelCheckpoint(agentRoot, current.value)) {
    return false
  }
  const headText = gitShowHeadFile(agentRoot, entryPath)
  if (headText === null) return false
  const head = parseJsonLine(headText)
  if (!isFlightRecorderResume(head)) return false
  return JSON.stringify(neutralizeSentinelCheckpoint(current.value))
    === JSON.stringify(neutralizeSentinelCheckpoint(head))
}

function isContextLossSentinelFlightRecorderGitStatusEntry(agentRoot: string, entry: string): boolean {
  return gitStatusPaths(entry).every((entryPath) => (
    isFlightRecorderEventsPath(entryPath)
      ? isContextLossSentinelEventFileDirty(agentRoot, entry, entryPath)
      : isFlightRecorderLatestPath(entryPath)
        ? isContextLossSentinelLatestDirty(agentRoot, entry, entryPath)
        : false
  ))
}

function isContextLossSentinelOwnedGitStatusEntry(
  entry: string,
  options: { agentRoot: string },
): boolean {
  return isSentinelGitStatusEntry(entry)
    || isContextLossSentinelFlightRecorderGitStatusEntry(options.agentRoot, entry)
}

function bundleSignal(
  status: ContextLossSentinelGitStatus,
  options: { ignoreSentinelDirtyEntries?: boolean; agentRoot: string },
): ContextLossSentinelSignal {
  const gitStatusCommand = "git status --porcelain=v1 -uall"
  if (!status.ok) {
    return {
      id: "bundle:git",
      kind: "bundle",
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      summary: `bundle git status unavailable: ${status.error}`,
      source: { kind: "git", locator: gitStatusCommand },
      repair: repair("agent-runnable", "bundle-cleanup", "Inspect bundle git state before assuming the local state is clean.", gitStatusCommand),
    }
  }
  const dirtyEntries = gitStatusEntries(status.porcelain)
    .filter((entry) => !(options.ignoreSentinelDirtyEntries && isContextLossSentinelOwnedGitStatusEntry(entry, options)))
  if (dirtyEntries.length > 0) {
    return {
      id: "bundle:git",
      kind: "bundle",
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      summary: `bundle has ${dirtyEntries.length} uncommitted git status entr${dirtyEntries.length === 1 ? "y" : "ies"}`,
      source: { kind: "git", locator: gitStatusCommand },
      repair: repair("agent-runnable", "bundle-cleanup", "Resolve or intentionally preserve local bundle changes before handoff.", gitStatusCommand),
      meta: { dirtyEntries },
    }
  }
  return {
    id: "bundle:git",
    kind: "bundle",
    status: "pass",
    severity: "info",
    verdictImpact: "none",
    summary: "bundle git status clean",
    source: { kind: "git", locator: gitStatusCommand },
  }
}

function sentinelVerdict(signals: ContextLossSentinelSignal[]): ContextLossSentinelVerdict {
  if (signals.some((entry) => entry.verdictImpact === "blocked")) return "blocked"
  if (signals.some((entry) => entry.verdictImpact === "watch")) return "watch"
  return "ready"
}

function summaryForVerdict(verdict: ContextLossSentinelVerdict): string {
  if (verdict === "ready") return "ready: deterministic recovery state is current and last-known-good is safe"
  if (verdict === "watch") return "watch: deterministic recovery can continue, but one or more signals need attention"
  return "blocked: deterministic recovery failed and must use latest-ready or repair before continuing"
}

function gauntletSummary(report: ContextLossGauntletReport): ContextLossSentinelGauntletSummary {
  return {
    verdict: report.verdict,
    scorePercentage: report.score.percentage,
    failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.id),
    warnedChecks: report.checks.filter((check) => check.status === "warn").map((check) => check.id),
    sourceLocator: "arc/flight-recorder/latest.json",
  }
}

function anchorFromResume(kind: ContextLossSentinelRecoveryAnchor["kind"], resume: FlightRecorderResume): ContextLossSentinelRecoveryAnchor {
  return {
    kind,
    currentAsk: resume.currentAsk.value,
    nextSafeAction: resume.nextSafeAction.value,
    flightRecorderLatestLocator: "arc/flight-recorder/latest.json",
    sourceEventIds: [...resume.currentAsk.sourceEventIds, ...resume.nextSafeAction.sourceEventIds],
    recordedAt: resume.lastSafeCheckpoint.recordedAt,
  }
}

function readFlightRecorderEventsByIds(agentRoot: string, eventIds: string[]): FlightRecorderEvent[] {
  const wanted = new Set(eventIds)
  const eventsRoot = path.join(agentRoot, "arc", "flight-recorder", "events")
  if (!fs.existsSync(eventsRoot)) return []
  return fs.readdirSync(eventsRoot)
    .filter((entry) => entry.endsWith(".jsonl"))
    .flatMap((entry) => fs.readFileSync(path.join(eventsRoot, entry), "utf-8").split(/\r?\n/))
    .filter((line) => line.trim().length > 0)
    .flatMap((line): FlightRecorderEvent[] => {
      try {
        const parsed = JSON.parse(line) as FlightRecorderEvent
        return wanted.has(parsed.id) ? [parsed] : []
      } catch {
        return []
      }
    })
}

function isSentinelAuthoredBlockerEvent(event: FlightRecorderEvent): boolean {
  return event.kind === "blocker_detected"
    && (
      event.meta?.source === "context-loss-sentinel"
      || Boolean(event.producedRefs?.some((ref) => ref.kind === "arc" && ref.locator.startsWith(relativeSentinelRoot())))
    )
}

function hasOnlySentinelAuthoredBlockers(agentRoot: string, resume: FlightRecorderResume): boolean {
  if (resume.blockedBecause.length === 0) return false
  if (resume.lastSafeCheckpoint.sourceEventIds.length === 0) return false
  const events = readFlightRecorderEventsByIds(agentRoot, resume.lastSafeCheckpoint.sourceEventIds)
  const foundEventIds = new Set(events.map((event) => event.id))
  if (resume.lastSafeCheckpoint.sourceEventIds.some((eventId) => !foundEventIds.has(eventId))) return false
  const blockerEvents = events.filter((event) => (event.blockedBecause?.length ?? 0) > 0)
  if (blockerEvents.length === 0) return false
  return blockerEvents.every(isSentinelAuthoredBlockerEvent)
}

function selectGauntletResume(agentRoot: string): { resume: FlightRecorderResume; anchorKind: ContextLossSentinelRecoveryAnchor["kind"] } {
  const resume = readFlightRecorderResume(agentRoot)
  const latestReady = readLatestReady(agentRoot)
  if (hasOnlySentinelAuthoredBlockers(agentRoot, resume) && latestReady) {
    return { resume: latestReady.resumeSnapshot, anchorKind: "latest-ready" }
  }
  return { resume, anchorKind: "flight-recorder" }
}

function resolveProviderVisibility(agentName: string, agentRoot: string, options: RefreshContextLossSentinelOptions): AgentProviderVisibility {
  return options.providerVisibility ?? buildAgentProviderVisibility({
    agentName,
    agentRoot,
    homeDir: options.homeDir,
  })
}

function shouldUseLatestReadyRecovery(
  anchorKind: ContextLossSentinelRecoveryAnchor["kind"],
  verdict: ContextLossSentinelVerdict,
  signals: ContextLossSentinelSignal[],
): boolean {
  if (anchorKind === "latest-ready") return true
  if (verdict === "ready") return false
  const hasNonGauntletRisk = signals.some((signal) => signal.kind !== "gauntlet" && signal.verdictImpact !== "none")
  const hasGauntletBlocker = signals.some((signal) => signal.kind === "gauntlet" && signal.verdictImpact === "blocked")
  return hasNonGauntletRisk && !hasGauntletBlocker
}

function makeReceipt(
  agentName: string,
  agentRoot: string,
  options: RefreshContextLossSentinelOptions,
  generatedAt: string,
): ContextLossSentinelReceipt {
  const receiptId = options.createReceiptId?.() ?? `sentinel-${randomUUID()}`
  const selectedResume = selectGauntletResume(agentRoot)
  const report = runContextLossGauntlet(agentName, agentRoot, {
    now: options.now,
    homeDir: options.homeDir,
    flightRecorderResume: selectedResume.resume,
  })
  const providerVisibility = resolveProviderVisibility(agentName, agentRoot, options)
  const signals = [
    gauntletSignal(report),
    ...deriveContextLossSentinelProviderSignals(providerVisibility),
    ...healthSignals(options.daemonHealthResults ?? []),
    bundleSignal((options.gitStatus ?? (() => defaultGitStatus(agentRoot)))(), {
      ignoreSentinelDirtyEntries: options.trigger === "daemon_health",
      agentRoot,
    }),
  ]
  const verdict = sentinelVerdict(signals)
  const latestReady = readLatestReady(agentRoot)
  const recoverySource = latestReady && shouldUseLatestReadyRecovery(selectedResume.anchorKind, verdict, signals)
    ? { resume: latestReady.resumeSnapshot, anchorKind: "latest-ready" as const }
    : selectedResume
  const readyLocator = verdict === "ready" || latestReady ? latestReadyLocator() : null
  return {
    schemaVersion: 1,
    id: receiptId,
    agent: agentName,
    trigger: options.trigger,
    generatedAt,
    verdict,
    summary: summaryForVerdict(verdict),
    receiptLocator: receiptLocator(receiptId),
    latestReadyLocator: readyLocator,
    recoveryAnchor: anchorFromResume(recoverySource.anchorKind, recoverySource.resume),
    gauntlet: gauntletSummary(report),
    signals,
    sourceLocators: [
      "arc/flight-recorder/latest.json",
      latestLocator(),
      historyLocator(generatedAt),
      receiptLocator(receiptId),
      ...(readyLocator ? [readyLocator] : []),
    ],
    resumeSnapshot: recoverySource.resume,
  }
}

function ensureSentinelDirs(paths: ContextLossSentinelPaths): void {
  fs.mkdirSync(paths.rootDir, { recursive: true })
  fs.mkdirSync(paths.historyDir, { recursive: true })
  fs.mkdirSync(paths.receiptsDir, { recursive: true })
}

function appendHistory(paths: ContextLossSentinelPaths, receipt: ContextLossSentinelReceipt): void {
  fs.mkdirSync(paths.historyDir, { recursive: true })
  fs.appendFileSync(path.join(paths.historyDir, `${historyDay(receipt.generatedAt)}.jsonl`), `${JSON.stringify(receipt)}\n`, "utf-8")
}

function syncLatestReadyLocator(receipt: ContextLossSentinelReceipt, hasLatestReady: boolean): ContextLossSentinelReceipt {
  receipt.latestReadyLocator = hasLatestReady ? latestReadyLocator() : null
  const locator = latestReadyLocator()
  receipt.sourceLocators = hasLatestReady
    ? Array.from(new Set([...receipt.sourceLocators, locator]))
    : receipt.sourceLocators.filter((entry) => entry !== locator)
  return receipt
}

function syncLatestReadyState(
  receipt: ContextLossSentinelReceipt,
  latestReady: ContextLossSentinelReceipt | null,
): ContextLossSentinelReceipt {
  syncLatestReadyLocator(receipt, latestReady !== null)
  if (latestReady && shouldUseLatestReadyRecovery(receipt.recoveryAnchor.kind, receipt.verdict, receipt.signals)) {
    receipt.recoveryAnchor = anchorFromResume("latest-ready", latestReady.resumeSnapshot)
    receipt.resumeSnapshot = latestReady.resumeSnapshot
  }
  return receipt
}

function blockedSignalSummaries(receipt: ContextLossSentinelReceipt): string[] {
  return receipt.signals
    .filter((signal) => signal.verdictImpact === "blocked")
    .map((signal) => `${signal.id}: ${signal.summary}`)
}

function recordBlockedReceiptEvent(agentRoot: string, receipt: ContextLossSentinelReceipt): void {
  if (receipt.verdict !== "blocked") return
  if (receipt.signals.some((signal) => signal.kind === "gauntlet" && signal.verdictImpact === "blocked")) return
  recordFlightRecorderEvent(agentRoot, {
    id: `fr-${receipt.id}`,
    kind: "blocker_detected",
    recordedAt: receipt.generatedAt,
    summary: "context-loss Sentinel blocked recovery",
    blockedBecause: blockedSignalSummaries(receipt).map((summary) => `context-loss Sentinel blocked: ${summary}`),
    producedRefs: [{
      kind: "arc",
      locator: receipt.receiptLocator,
    }],
    meta: {
      source: "context-loss-sentinel",
      receiptId: receipt.id,
      trigger: receipt.trigger,
    },
  })
}

function recordRecoveredReceiptEvent(agentRoot: string, receipt: ContextLossSentinelReceipt): void {
  if (receipt.verdict === "blocked") return
  const resume = readFlightRecorderResume(agentRoot)
  if (!hasOnlySentinelAuthoredBlockers(agentRoot, resume)) return
  recordFlightRecorderEvent(agentRoot, {
    id: `fr-${receipt.id}-recovered`,
    kind: "agent_note",
    recordedAt: receipt.generatedAt,
    summary: "context-loss Sentinel cleared its prior recovery blocker",
    blockedBecause: [],
    producedRefs: [{
      kind: "arc",
      locator: receipt.receiptLocator,
    }],
    meta: {
      source: "context-loss-sentinel",
      receiptId: receipt.id,
      trigger: receipt.trigger,
      resolution: "blocked-signals-recovered",
    },
  })
}

async function persistReceipt(agentRoot: string, receipt: ContextLossSentinelReceipt, lockTimeoutMs: number): Promise<ContextLossSentinelReceipt> {
  const paths = contextLossSentinelPaths(agentRoot)
  return withFileLock(paths.lock, lockTimeoutMs, async () => {
    ensureSentinelDirs(paths)
    const existingLatest = readReceiptFile(paths.latest, "latest.json", [])
    const existingReady = readLatestReady(agentRoot)
    const watermark = readWatermark(agentRoot)
    const latestOrder = maxOrder(
      maxOrder(
        maxOrder(
          existingLatest ? orderFromReceipt(existingLatest) : null,
          existingReady ? orderFromReceipt(existingReady) : null,
        ),
        watermark.latest,
      ),
      watermark.latestReady,
    )
    const latestReadyOrder = maxOrder(
      maxOrder(existingReady ? orderFromReceipt(existingReady) : null, watermark.latestReady),
      existingLatest?.verdict === "ready" ? orderFromReceipt(existingLatest) : null,
    )
    const nextReady = selectLatestReadyReceipt(existingReady, receipt, latestReadyOrder)
    syncLatestReadyState(receipt, nextReady)
    const coalesced = coalescedDaemonHealthReceipt(
      agentRoot,
      existingLatest,
      existingReady,
      receipt,
      watermark,
    )
    if (coalesced) return coalesced
    const receiptPath = path.join(paths.receiptsDir, `${receipt.id}.json`)
    atomicWriteJson(receiptPath, receipt)
    setReceiptFileMtime(receiptPath, receipt)
    appendHistory(paths, receipt)
    let latestAfterWrite = existingLatest ?? receipt
    if (shouldReplaceLatestReceipt(existingLatest, receipt, latestOrder)) {
      atomicWriteJson(paths.latest, receipt)
      updateWatermarkOrder(watermark, "latest", receipt)
      writeWatermark(agentRoot, watermark)
      setReceiptFileMtime(paths.latest, receipt)
      latestAfterWrite = receipt
      recordBlockedReceiptEvent(agentRoot, receipt)
      recordRecoveredReceiptEvent(agentRoot, receipt)
    } else if (existingLatest && nextReady === receipt) {
      const updatedLatest = syncLatestReadyState(existingLatest, nextReady)
      atomicWriteJson(paths.latest, updatedLatest)
      latestAfterWrite = updatedLatest
    }
    if (receipt.verdict === "ready" && nextReady === receipt) {
      atomicWriteJson(paths.latestReady, receipt)
      updateWatermarkOrder(watermark, "latestReady", receipt)
      writeWatermark(agentRoot, watermark)
      setReceiptFileMtime(paths.latestReady, receipt)
    }
    const protectedReceiptIds = new Set([receipt.id, latestAfterWrite.id])
    if (nextReady) protectedReceiptIds.add(nextReady.id)
    pruneReceiptDetailFiles(paths, protectedReceiptIds)
    return receipt
  })
}

export async function refreshContextLossSentinel(
  agentName: string,
  agentRoot: string,
  options: RefreshContextLossSentinelOptions,
): Promise<ContextLossSentinelReceipt> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()
  const receipt = makeReceipt(agentName, agentRoot, options, generatedAt)
  if (options.delayBeforeWriteMs && options.delayBeforeWriteMs > 0) {
    await sleep(options.delayBeforeWriteMs)
  }
  const persistedReceipt = await persistReceipt(agentRoot, receipt, options.lockTimeoutMs ?? 5_000)
  emitNervesEvent({
    component: "engine",
    event: "engine.context_loss_sentinel_refreshed",
    message: "context-loss Sentinel refreshed deterministic recovery state",
    meta: {
      agentName,
      trigger: options.trigger,
      verdict: persistedReceipt.verdict,
      receiptId: persistedReceipt.id,
      blockedSignals: persistedReceipt.signals.filter((entry) => entry.verdictImpact === "blocked").map((entry) => entry.id),
      watchSignals: persistedReceipt.signals.filter((entry) => entry.verdictImpact === "watch").map((entry) => entry.id),
    },
  })
  return persistedReceipt
}

function readHistory(paths: ContextLossSentinelPaths, limit: number, issues: string[]): ContextLossSentinelReceipt[] {
  if (!fs.existsSync(paths.historyDir)) return []
  const files = fs.readdirSync(paths.historyDir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort()
  const receipts: ContextLossSentinelReceipt[] = []
  for (const fileName of files) {
    const filePath = path.join(paths.historyDir, fileName)
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/)
    lines.forEach((line, index) => {
      if (line.trim().length === 0) return
      try {
        const parsed = JSON.parse(line) as unknown
        if (isReceipt(parsed)) {
          receipts.push(parsed)
        } else {
          issues.push(`history/${fileName} line ${index + 1} malformed`)
        }
      } catch (error) {
        issues.push(`history/${fileName} line ${index + 1} unreadable: ${String(error)}`)
      }
    })
  }
  return receipts.slice(Math.max(0, receipts.length - limit))
}

export function readContextLossSentinelView(
  agentRoot: string,
  options: ReadContextLossSentinelViewOptions = {},
): ContextLossSentinelView {
  const paths = contextLossSentinelPaths(agentRoot)
  const issues: string[] = []
  const limit = Math.max(0, options.limit ?? 20)
  return {
    schemaVersion: 1,
    latest: readReceiptFile(paths.latest, "latest.json", issues),
    latestReady: readLatestReadyFile(paths.latestReady, "latest-ready.json", issues),
    history: readHistory(paths, limit, issues),
    degraded: { issues },
  }
}

function renderSignal(signalEntry: ContextLossSentinelSignal): string {
  const repairText = signalEntry.repair?.command ? ` repair: ${signalEntry.repair.command}` : ""
  return `  - ${signalEntry.status.toUpperCase()} ${signalEntry.id}: ${signalEntry.summary}${repairText}`
}

function formatReceipt(receipt: ContextLossSentinelReceipt): string[] {
  const blockedGuidance = receipt.verdict === "blocked"
    ? receipt.latestReadyLocator
      ? "guidance: current latest is blocked; repair blocked signals or use latest-ready before continuing."
      : "guidance: current latest is blocked; repair blocked signals before continuing."
    : null
  return [
    `Recovery Sentinel - ${receipt.agent}`,
    `generated: ${receipt.generatedAt}`,
    `receipt: ${receipt.receiptLocator}`,
    `trigger: ${receipt.trigger}`,
    `verdict: ${receipt.verdict}`,
    `latest-ready: ${receipt.latestReadyLocator ?? "unavailable"}`,
    `summary: ${receipt.summary}`,
    ...(blockedGuidance ? [blockedGuidance] : []),
    "",
    "Recovery anchor",
    `  kind: ${receipt.recoveryAnchor.kind}`,
    `  current ask: ${receipt.recoveryAnchor.currentAsk ?? "unavailable"}`,
    `  next action: ${receipt.recoveryAnchor.nextSafeAction ?? "unavailable"}`,
    "",
    "Signals",
    ...receipt.signals.map(renderSignal),
  ]
}

export function formatContextLossSentinelText(input: ContextLossSentinelView | ContextLossSentinelReceipt | null): string {
  if (input === null) return "Recovery Sentinel - unavailable"
  if ("latest" in input) {
    const displayReceipt = input.latest ?? input.latestReady
    if (!displayReceipt) {
      return [
        "Recovery Sentinel - unavailable",
        ...input.degraded.issues.map((issue) => `degraded: ${issue}`),
      ].join("\n").trim()
    }
    return [
      ...formatReceipt(displayReceipt),
      "",
      `history: ${input.history.length} receipt${input.history.length === 1 ? "" : "s"}`,
      ...(input.degraded.issues.length > 0 ? ["", ...input.degraded.issues.map((issue) => `degraded: ${issue}`)] : []),
    ].join("\n").trim()
  }
  return formatReceipt(input).join("\n").trim()
}

export function formatContextLossSentinelJson(input: ContextLossSentinelView | ContextLossSentinelReceipt | null): string {
  return `${JSON.stringify(input, null, 2)}\n`
}
