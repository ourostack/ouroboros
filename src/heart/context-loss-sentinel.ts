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
export type ContextLossSentinelSignalKind = "gauntlet" | "provider_lane" | "sense" | "bundle"
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

const REQUIRED_LANES = ["outward", "inner"] as const

function relativeSentinelRoot(): string {
  return path.join("arc", "flight-recorder", "context-loss-sentinel")
}

function latestLocator(): string {
  return path.join(relativeSentinelRoot(), "latest.json")
}

function latestReadyLocator(): string {
  return path.join(relativeSentinelRoot(), "latest-ready.json")
}

function receiptLocator(receiptId: string): string {
  return path.join(relativeSentinelRoot(), "receipts", `${receiptId}.json`)
}

function historyDay(generatedAt: string): string {
  return generatedAt.slice(0, 10)
}

function historyLocator(generatedAt: string): string {
  return path.join(relativeSentinelRoot(), "history", `${historyDay(generatedAt)}.jsonl`)
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
    && (record.kind === "gauntlet" || record.kind === "provider_lane" || record.kind === "sense" || record.kind === "bundle")
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

function readLatestReady(agentRoot: string): ContextLossSentinelReceipt | null {
  return readReceiptFile(contextLossSentinelPaths(agentRoot).latestReady, "latest-ready.json", [])
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

function senseSignals(results: DaemonHealthResult[]): ContextLossSentinelSignal[] {
  return results
    .filter((result) => result.name.startsWith("sense-probe:"))
    .map((result): ContextLossSentinelSignal => {
      const impact: ContextLossSentinelVerdictImpact = result.status === "critical"
        ? "blocked"
        : result.status === "warn"
          ? "watch"
          : "none"
      return {
        id: `sense:${result.name}`,
        kind: "sense",
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
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: agentRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, porcelain }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

function bundleSignal(status: ContextLossSentinelGitStatus): ContextLossSentinelSignal {
  if (!status.ok) {
    return {
      id: "bundle:git",
      kind: "bundle",
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      summary: `bundle git status unavailable: ${status.error}`,
      source: { kind: "git", locator: "git status --porcelain" },
      repair: repair("agent-runnable", "bundle-cleanup", "Inspect bundle git state before assuming the local state is clean.", "git status --porcelain"),
    }
  }
  const dirtyEntries = status.porcelain.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (dirtyEntries.length > 0) {
    return {
      id: "bundle:git",
      kind: "bundle",
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      summary: `bundle has ${dirtyEntries.length} uncommitted git status entr${dirtyEntries.length === 1 ? "y" : "ies"}`,
      source: { kind: "git", locator: "git status --porcelain" },
      repair: repair("agent-runnable", "bundle-cleanup", "Resolve or intentionally preserve local bundle changes before handoff.", "git status --porcelain"),
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
    source: { kind: "git", locator: "git status --porcelain" },
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
  if (eventIds.length === 0) return []
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

function hasSentinelAuthoredBlocker(agentRoot: string, resume: FlightRecorderResume): boolean {
  if (resume.blockedBecause.length === 0) return false
  return readFlightRecorderEventsByIds(agentRoot, resume.lastSafeCheckpoint.sourceEventIds)
    .some(isSentinelAuthoredBlockerEvent)
}

function selectGauntletResume(agentRoot: string): { resume: FlightRecorderResume; anchorKind: ContextLossSentinelRecoveryAnchor["kind"] } {
  const resume = readFlightRecorderResume(agentRoot)
  const latestReady = readLatestReady(agentRoot)
  if (hasSentinelAuthoredBlocker(agentRoot, resume) && latestReady) {
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
    ...senseSignals(options.daemonHealthResults ?? []),
    bundleSignal((options.gitStatus ?? (() => defaultGitStatus(agentRoot)))()),
  ]
  const verdict = sentinelVerdict(signals)
  const readyLocator = verdict === "ready" || readLatestReady(agentRoot) ? latestReadyLocator() : null
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
    recoveryAnchor: anchorFromResume(selectedResume.anchorKind, selectedResume.resume),
    gauntlet: gauntletSummary(report),
    signals,
    sourceLocators: [
      "arc/flight-recorder/latest.json",
      latestLocator(),
      historyLocator(generatedAt),
      receiptLocator(receiptId),
      ...(readyLocator ? [readyLocator] : []),
    ],
    resumeSnapshot: selectedResume.resume,
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

function blockedSignalSummaries(receipt: ContextLossSentinelReceipt): string[] {
  return receipt.signals
    .filter((signal) => signal.verdictImpact === "blocked")
    .map((signal) => `${signal.id}: ${signal.summary}`)
}

function recordBlockedReceiptEvent(agentRoot: string, receipt: ContextLossSentinelReceipt): void {
  if (receipt.verdict !== "blocked") return
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

async function persistReceipt(agentRoot: string, receipt: ContextLossSentinelReceipt, lockTimeoutMs: number): Promise<void> {
  const paths = contextLossSentinelPaths(agentRoot)
  await withFileLock(paths.lock, lockTimeoutMs, async () => {
    ensureSentinelDirs(paths)
    const existingLatest = readReceiptFile(paths.latest, "latest.json", [])
    const existingReady = readReceiptFile(paths.latestReady, "latest-ready.json", [])
    syncLatestReadyLocator(receipt, receipt.verdict === "ready" || existingReady !== null)
    atomicWriteJson(path.join(paths.receiptsDir, `${receipt.id}.json`), receipt)
    appendHistory(paths, receipt)
    if (shouldReplaceReceipt(existingLatest, receipt)) {
      atomicWriteJson(paths.latest, receipt)
    } else if (existingLatest && receipt.verdict === "ready") {
      atomicWriteJson(paths.latest, syncLatestReadyLocator(existingLatest, true))
    }
    if (receipt.verdict === "ready" && shouldReplaceReceipt(existingReady, receipt)) {
      atomicWriteJson(paths.latestReady, receipt)
    }
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
  await persistReceipt(agentRoot, receipt, options.lockTimeoutMs ?? 5_000)
  recordBlockedReceiptEvent(agentRoot, receipt)
  emitNervesEvent({
    component: "engine",
    event: "engine.context_loss_sentinel_refreshed",
    message: "context-loss Sentinel refreshed deterministic recovery state",
    meta: {
      agentName,
      trigger: options.trigger,
      verdict: receipt.verdict,
      receiptId: receipt.id,
      blockedSignals: receipt.signals.filter((entry) => entry.verdictImpact === "blocked").map((entry) => entry.id),
      watchSignals: receipt.signals.filter((entry) => entry.verdictImpact === "watch").map((entry) => entry.id),
    },
  })
  return receipt
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
    latestReady: readReceiptFile(paths.latestReady, "latest-ready.json", issues),
    history: readHistory(paths, limit, issues),
    degraded: { issues },
  }
}

function renderSignal(signalEntry: ContextLossSentinelSignal): string {
  const repairText = signalEntry.repair?.command ? ` repair: ${signalEntry.repair.command}` : ""
  return `  - ${signalEntry.status.toUpperCase()} ${signalEntry.id}: ${signalEntry.summary}${repairText}`
}

function formatReceipt(receipt: ContextLossSentinelReceipt): string[] {
  return [
    `Recovery Sentinel - ${receipt.agent}`,
    `generated: ${receipt.generatedAt}`,
    `trigger: ${receipt.trigger}`,
    `verdict: ${receipt.verdict}`,
    `latest-ready: ${receipt.latestReadyLocator ?? "unavailable"}`,
    `summary: ${receipt.summary}`,
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
    if (!input.latest) {
      return [
        "Recovery Sentinel - unavailable",
        ...input.degraded.issues.map((issue) => `degraded: ${issue}`),
      ].join("\n").trim()
    }
    return [
      ...formatReceipt(input.latest),
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
