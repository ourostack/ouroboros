import * as fs from "fs"
import * as path from "path"
import { runPrivateRuntimeTurn, type PreparedHabitContext } from "./private-runtime"
import type { PriorHabitSessionSummaryInfo } from "./habit-turn-message"
import type { PrivateTurnDecision } from "../heart/private-runtime"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { getPrivateRuntimePendingDir, hasPendingMessages } from "../mind/pending"
import { createDegradedHabitFile, parseHabitFile, type HabitFile } from "../heart/habits/habit-parser"
import { applyHabitRuntimeState } from "../heart/habits/habit-runtime-state"
import {
  completeHabitRun,
  createHabitSessionPaths,
  filterHabitToolsForEnvelope,
  normalizeHabitPermissionEnvelope,
} from "../heart/habits/habit-session"
import {
  createHabitRunId,
  type HabitRunReceipt,
  type HabitRunSummarySnapshot,
} from "../arc/flight-recorder"
import { readHabitSessionSummary } from "../heart/habits/habit-session-summary"
import { FileFriendStore } from "@ouro.bot/friends"
import type { UsageData } from "../mind/context"
import { baseToolDefinitions, type HabitSessionToolContext, type ToolDefinition, type ToolRiskProfile } from "../repertoire/tools-base"
import { surfaceToolDefinition } from "../repertoire/tools-surface"
import { riskProfileForTool } from "../repertoire/tools"
import {
  RSVP_HABIT_ALLOWED_TOOLS,
  isRsvpHabitName,
  rsvpHabitRuntimePolicy,
  type RsvpHabitRuntimePolicy,
} from "../rsvp/habit-policy"
import { recordRsvpSpendLedgerRun } from "../rsvp/spend-ledger"
import {
  appendRunLedgerRecordNonFatal,
  createRunLedgerRecord,
  runLedgerHash,
  usageMetadataFromUsageData,
  type RunLedgerLifecycle,
} from "../heart/run-ledger"
import { reserveAutonomyBudget, resolveAutonomyBudgetPolicy, type AutonomyBudgetDecision } from "../heart/autonomy-budget"
import { privateRuntimeHabitRejectionReason } from "./habit-lifecycle-guard"

export type PrivateRuntimeWorkerReason = "boot" | "habit" | "instinct" | "await"

export interface PrivateRuntimeWorkerMessage {
  type: "heartbeat" | "habit" | "await" | "shutdown" | "poke" | "chat" | "message" | string
  taskId?: string
  habitName?: string
  awaitName?: string
  trigger?: HabitRunReceipt["trigger"]
  noSend?: true
  privateTurnDecision?: PrivateTurnDecision
}

export interface PrivateRuntimeWorkerRunOptions {
  reason: PrivateRuntimeWorkerReason
  taskId?: string
  habitName?: string
  awaitName?: string
  trigger?: HabitRunReceipt["trigger"]
  habitSession?: HabitSessionToolContext
  preparedHabit?: PreparedHabitContext
  noSend?: true
  privateTurnDecision?: PrivateTurnDecision
}

export interface PrivateRuntimeWorkerController {
  run(
    reason: PrivateRuntimeWorkerReason,
    taskId?: string,
    habitName?: string,
    awaitName?: string,
    trigger?: HabitRunReceipt["trigger"],
    privateTurnDecision?: PrivateTurnDecision,
    noSend?: true,
  ): Promise<void>
  handleMessage(message: unknown): Promise<void>
}

export interface StartPrivateRuntimeWorkerOptions {
  attachProcessListeners?: boolean
  bufferedMessages?: unknown[]
}

interface QueueEntry {
  reason: PrivateRuntimeWorkerReason
  taskId?: string
  habitName?: string
  awaitName?: string
  trigger?: HabitRunReceipt["trigger"]
  noSend?: true
  privateTurnDecision?: PrivateTurnDecision
}

interface PreparedHabitRun {
  agentRoot: string
  habit: HabitFile
  runId: string
  operationId: string | null
  trigger: HabitRunReceipt["trigger"]
  startedAt: string
  priorSessionSummary?: PriorHabitSessionSummaryInfo
  paths: ReturnType<typeof createHabitSessionPaths>
  permissionEnvelope: HabitRunReceipt["permissionEnvelope"]
  toolPolicy: HabitRunReceipt["toolPolicy"]
  rsvpPolicy?: RsvpHabitRuntimePolicy
  blockedReason?: string
  friendStore: FileFriendStore
  results: unknown[]
  errors: string[]
  producedRefs: HabitRunReceipt["producedRefs"]
  surfaceAttempts: HabitRunReceipt["surfaceAttempts"]
}

function isUsageData(value: unknown): value is UsageData {
  const usage = value as Partial<UsageData> | null
  return !!usage
    && typeof usage.input_tokens === "number"
    && typeof usage.output_tokens === "number"
    && typeof usage.total_tokens === "number"
}

function extractUsageFromHabitResults(results: unknown[]): UsageData | undefined {
  const aggregate: UsageData = {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  }
  let found = false
  for (const result of results) {
    if (!result || typeof result !== "object") continue
    const usage = (result as { usage?: unknown }).usage
    if (!isUsageData(usage)) continue
    found = true
    aggregate.input_tokens += usage.input_tokens
    aggregate.output_tokens += usage.output_tokens
    aggregate.reasoning_tokens += typeof usage.reasoning_tokens === "number" ? usage.reasoning_tokens : 0
    aggregate.total_tokens += usage.total_tokens
  }
  return found ? aggregate : undefined
}

function habitRunLedgerBase(habitRun: PreparedHabitRun) {
  const target = {
    habitName: habitRun.habit.name,
    runId: habitRun.runId,
    trigger: habitRun.trigger,
    operationId: habitRun.operationId,
  }
  return {
    agent: getAgentName(),
    triggerType: "habit" as const,
    sourceKind: "private-runtime" as const,
    senseOrHabit: habitRun.habit.name,
    startedAt: habitRun.startedAt,
    target,
    idempotencyScope: target,
    provider: "unknown",
    model: "unknown",
    sessionRef: {
      channel: "inner",
      keyHash: runLedgerHash({ habitName: habitRun.habit.name, runId: habitRun.runId }),
    },
  }
}

function recordHabitRunLedger(
  habitRun: PreparedHabitRun,
  lifecycle: RunLedgerLifecycle,
  endedAt?: string,
): void {
  const usage = extractUsageFromHabitResults(habitRun.results)
  const record = createRunLedgerRecord({
    ...habitRunLedgerBase(habitRun),
    lifecycle,
    ...(endedAt ? { endedAt } : {}),
    ...(lifecycle === "completed" || lifecycle === "error"
      ? { usage: usageMetadataFromUsageData(usage, usage ? "provider" : "none") }
      : {}),
  })
  appendRunLedgerRecordNonFatal(habitRun.agentRoot, record)
  if (habitRun.rsvpPolicy) {
    try {
      recordRsvpSpendLedgerRun(habitRun.agentRoot, record)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "rsvp",
        event: "rsvp.spend_ledger_record_error",
        message: "failed to record RSVP spend ledger row",
        meta: { runId: record.runId, lifecycle, error: String(error) },
      })
    }
  }
}

function reserveHabitAutonomyBudget(habitRun: PreparedHabitRun, nowIso: string): AutonomyBudgetDecision {
  const target: Record<string, unknown> = {
    habitName: habitRun.habit.name,
    runId: habitRun.runId,
    trigger: habitRun.trigger,
    operationId: habitRun.operationId,
  }
  if (habitRun.rsvpPolicy) {
    target.rsvpSnapshotRef = habitRun.rsvpPolicy.snapshotRef
    target.rsvpBudgetRef = habitRun.rsvpPolicy.budgetRef
    target.rsvpIdempotencyRef = habitRun.rsvpPolicy.idempotencyRef
  }
  const agentName = getAgentName()
  return reserveAutonomyBudget(habitRun.agentRoot, {
    agent: agentName,
    triggerType: "habit",
    sourceKind: "private-runtime",
    senseOrHabit: habitRun.habit.name,
    target,
    idempotencyKey: `habit:${habitRun.habit.name}:${habitRun.runId}`,
    now: nowIso,
  }, resolveAutonomyBudgetPolicy(habitRun.agentRoot, agentName))
}

/**
 * Cap on consecutive `instinct` follow-on turns triggered by `hasPendingWork()`
 * with no externally-queued work in between. Without this cap, a turn that
 * writes anything back into the private-runtime pending dir as a side effect of
 * processing (e.g. a surface tool routing a response) puts the worker into
 * a self-sustaining loop where the next turn's drain produces another write,
 * and so on. Real workflows rarely chain more than 2–3 instinct turns; an
 * external trigger (habit, poke, chat) resets the counter so legitimate
 * follow-on work is unaffected.
 *
 * Three feels right: legitimate cascading follow-ups (e.g. processing a
 * batch of delegated returns) get through; a true self-loop caps fast.
 */
export const MAX_CONSECUTIVE_INSTINCT_TURNS = 3

/**
 * Habit recursion detector thresholds. The instinct cap above protects
 * against pending-dir self-loops; this protects against the *external*
 * IPC self-loop where heartbeat-shaped messages get re-issued faster
 * than their cadence — e.g. a hook misconfigured to repost on every
 * heartbeat, a daemon retry storm, or a stuck timer firing back-to-back.
 *
 * MIN_INTERVAL_MS — two of the same habit within this window is suspect
 * regardless of cadence (no realistic habit fires every few seconds).
 * BURST_THRESHOLD over BURST_WINDOW_MS catches slower runaways that stay
 * just under MIN_INTERVAL_MS.
 *
 * Detection is observation-only: it emits warn-level nerves events, it
 * does not drop the message. An operator (or follow-up auto-recovery)
 * decides what to do with the signal.
 */
export const HABIT_RECURSION_MIN_INTERVAL_MS = 5_000
export const HABIT_RECURSION_BURST_WINDOW_MS = 60_000
export const HABIT_RECURSION_BURST_THRESHOLD = 5
export const HEARTBEAT_OK_REST_SUPPRESSION_MS = 20 * 60_000

function defaultHasPendingWork(pendingDir?: string): boolean {
  if (pendingDir) return hasPendingMessages(pendingDir)
  const agentArgIndex = process.argv.indexOf("--agent")
  const agentName = agentArgIndex >= 0 ? process.argv[agentArgIndex + 1] : undefined
  return agentName ? hasPendingMessages(getPrivateRuntimePendingDir(agentName)) : false
}

function isHeartbeatOkRestResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false
  const maybeResult = result as { turnOutcome?: unknown; restStatus?: unknown }
  return maybeResult.turnOutcome === "rested" && maybeResult.restStatus === "HEARTBEAT_OK"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .filter((text) => text.trim().length > 0)
    .join("\n")
    .trim()
}

function resultMessages(result: unknown): unknown[] {
  if (Array.isArray(result)) return result.flatMap((entry) => resultMessages(entry))
  return isRecord(result) && Array.isArray(result.messages) ? result.messages : []
}

function latestAssistantText(results: unknown[]): string | null {
  for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex--) {
    const messages = resultMessages(results[resultIndex])
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = messages[messageIndex]
      if (!isRecord(message) || message.role !== "assistant") continue
      const text = contentToText(message.content)
      if (text.length > 0) return text.replace(/^checkpoint\s*:\s*/i, "").trim() || text
    }
  }
  return null
}

function deriveHabitSummarySnapshot(habitRun: PreparedHabitRun): HabitRunSummarySnapshot {
  const assistant = latestAssistantText(habitRun.results)
  if (assistant) return { summary: assistant, decisions: [], nextLikelyStep: null }
  if (habitRun.errors.length > 0) {
    return {
      summary: `Habit ${habitRun.habit.name} finished with errors: ${habitRun.errors.join("; ")}`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  const surfaced = habitRun.surfaceAttempts.find((attempt) =>
    attempt.result !== "blocked" && attempt.result !== "failed" && attempt.result !== "unavailable")
  if (surfaced) {
    return {
      summary: `Habit ${habitRun.habit.name} surfaced via ${surfaced.recipient}/${surfaced.channel}.`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  const produced = habitRun.producedRefs.find((ref) => ref.kind !== "none")
  if (produced) {
    return {
      summary: `Habit ${habitRun.habit.name} produced ${produced.kind}: ${produced.locator}.`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  if (habitRun.results.some(isHeartbeatOkRestResult)) {
    return {
      summary: `Habit ${habitRun.habit.name} rested with HEARTBEAT_OK.`,
      decisions: [],
      nextLikelyStep: null,
    }
  }
  return {
    summary: `Habit ${habitRun.habit.name} completed without additional surfaced output.`,
    decisions: [],
    nextLikelyStep: null,
  }
}

function readHabitForRun(agentRoot: string, habitName: string, errors: string[]): HabitFile {
  const habitPath = path.join(agentRoot, "habits", `${habitName}.md`)
  try {
    return parseHabitFile(fs.readFileSync(habitPath, "utf-8"), habitPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    errors.push(`habit file could not be read: ${reason}`)
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.habit_file_read_error",
      message: "habit file could not be read for habit session",
      meta: { habitName, habitPath, reason },
    })
    return createDegradedHabitFile(habitPath, "read_error")
  }
}

async function prepareHabitRun(habitName: string, trigger: HabitRunReceipt["trigger"], startedAt: string): Promise<PreparedHabitRun> {
  const agentRoot = getAgentRoot()
  const errors: string[] = []
  const habit = applyHabitRuntimeState(agentRoot, readHabitForRun(agentRoot, habitName, errors))
  if (habit.status === "degraded" && habit.degradedDetail !== null) {
    errors.push(habit.degradedDetail)
  }
  const lifecycleBlockedReason = privateRuntimeHabitRejectionReason(habit, "private-runtime-worker")
  const blockedReason = isRsvpHabitName(habitName) && !habit.rsvp
    ? "RSVP habit metadata is required before private runtime execution"
    : lifecycleBlockedReason
  if (blockedReason && !errors.includes(blockedReason)) errors.push(blockedReason)
  const runId = createHabitRunId(habitName, new Date(startedAt))
  const operationId = habit.continuity.mode === "stateful" ? `habit:${habit.name}` : null
  const priorSessionSummary = readPriorSessionSummary(agentRoot, operationId)
  const paths = createHabitSessionPaths(agentRoot, runId, habit.name)
  const friendStore = new FileFriendStore(path.join(agentRoot, "friends"))
  const permissionEnvelope = await normalizeHabitPermissionEnvelope(habit, { agentRoot, friendStore })
  const rsvpPolicy = habit.rsvp ? rsvpHabitRuntimePolicy(habit.rsvp) : undefined
  const requestedTools = blockedReason ? [] : habit.rsvp ? [...RSVP_HABIT_ALLOWED_TOOLS] : habit.tools ?? null
  const toolPolicy = filterHabitToolsForEnvelope(
    [...baseToolDefinitions, surfaceToolDefinition],
    requestedTools,
    permissionEnvelope,
    riskProfileForHabitPolicy,
  )
  return {
    agentRoot,
    habit,
    runId,
    operationId,
    trigger,
    startedAt,
    priorSessionSummary,
    paths,
    permissionEnvelope,
    toolPolicy,
    ...(rsvpPolicy ? { rsvpPolicy } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    friendStore,
    results: [],
    errors,
    producedRefs: [],
    surfaceAttempts: [],
  }
}

function riskProfileForHabitPolicy(definition: ToolDefinition, name: string): ToolRiskProfile {
  const probeArgs: Record<string, string> = name === "shell" ? { command: "touch /tmp/habit-policy-probe" } : {}
  return riskProfileForTool(definition, name, probeArgs)
}

function readPriorSessionSummary(agentRoot: string, operationId: string | null): PriorHabitSessionSummaryInfo | undefined {
  if (operationId === null) return undefined
  try {
    const summary = readHabitSessionSummary(agentRoot, { operationId, which: "latest" })
    if (!summary) return { mode: "stateful", summary: null, sources: {}, warnings: [] }
    return {
      mode: "stateful",
      summary: summary.summary,
      sources: summary.sources,
      warnings: summary.warnings,
    }
  } catch (error) {
    return {
      mode: "stateful",
      summary: null,
      sources: {},
      warnings: [`prior summary read failed: ${String(error)}`],
    }
  }
}

export function createPrivateRuntimeWorker(
  runTurn: (options: PrivateRuntimeWorkerRunOptions) => Promise<unknown> = (options) => runPrivateRuntimeTurn(options),
  hasPendingWork: (pendingDir?: string) => boolean = defaultHasPendingWork,
  nowSource: () => number = () => Date.now(),
): PrivateRuntimeWorkerController {
  let running = false
  const queue: QueueEntry[] = []
  const lastFireByHabit = new Map<string, number>()
  const recentHabitFires: number[] = []
  const startedHabitLedgerRunIds = new Set<string>()
  let heartbeatOkRestedAt: number | null = null

  function recordHabitStartIfNeeded(habitRun: PreparedHabitRun): void {
    if (startedHabitLedgerRunIds.has(habitRun.runId)) return
    recordHabitRunLedger(habitRun, "started")
    startedHabitLedgerRunIds.add(habitRun.runId)
  }

  function recordHabitCompletion(
    habitRun: PreparedHabitRun,
    endedAt = habitRun.startedAt,
  ): void {
    recordHabitStartIfNeeded(habitRun)
    recordHabitRunLedger(habitRun, habitRun.errors.length > 0 ? "error" : "completed", endedAt)
    completeHabitRun({
      agentRoot: habitRun.agentRoot,
      habit: habitRun.habit,
      runId: habitRun.runId,
      trigger: habitRun.trigger,
      startedAt: habitRun.startedAt,
      endedAt,
      operationId: habitRun.operationId,
      permissionEnvelope: habitRun.permissionEnvelope,
      toolPolicy: habitRun.toolPolicy,
      producedRefs: habitRun.producedRefs,
      surfaceAttempts: habitRun.surfaceAttempts,
      errors: habitRun.errors,
      summarySnapshot: deriveHabitSummarySnapshot(habitRun),
    })
  }

  function clearHeartbeatRestShield(): void {
    heartbeatOkRestedAt = null
  }

  function shouldReuseHeartbeatOkRest(habitName: string): boolean {
    if (habitName !== "heartbeat" || heartbeatOkRestedAt === null) return false
    if (nowSource() - heartbeatOkRestedAt > HEARTBEAT_OK_REST_SUPPRESSION_MS) return false
    if (hasPendingWork()) {
      clearHeartbeatRestShield()
      return false
    }
    return true
  }

  async function reuseHeartbeatOkRest(habitName: string): Promise<void> {
    const nowIso = new Date(nowSource()).toISOString()
    const habitRun = await prepareHabitRun(habitName, "overdue", nowIso)
    if (habitRun.blockedReason) {
      clearHeartbeatRestShield()
      recordHabitCompletion(habitRun, nowIso)
      return
    }
    habitRun.results.push({ turnOutcome: "rested", restStatus: "HEARTBEAT_OK" })
    recordHabitCompletion(habitRun, nowIso)
    emitNervesEvent({
      level: "info",
      component: "senses",
      event: "senses.heartbeat_ok_rest_reused",
      message: "heartbeat skipped because previous HEARTBEAT_OK rest is still valid and no pending work exists",
        meta: {
          habitName,
          quietWindowMs: HEARTBEAT_OK_REST_SUPPRESSION_MS,
          restedAgoMs: nowSource() - heartbeatOkRestedAt!,
        },
      })
  }

  function recordHabitFireForRecursion(habitName: string): void {
    const now = nowSource()
    const previous = lastFireByHabit.get(habitName)
    if (previous !== undefined) {
      const intervalMs = now - previous
      if (intervalMs < HABIT_RECURSION_MIN_INTERVAL_MS) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.habit_recursion_suspected",
          message: "habit fired suspiciously fast after the previous fire — possible self-recursion or duplicate dispatch",
          meta: {
            habitName,
            intervalMs,
            thresholdMs: HABIT_RECURSION_MIN_INTERVAL_MS,
          },
        })
      }
    }
    lastFireByHabit.set(habitName, now)
    recentHabitFires.push(now)
    while (recentHabitFires.length > 0 && now - recentHabitFires[0]! > HABIT_RECURSION_BURST_WINDOW_MS) {
      recentHabitFires.shift()
    }
    if (recentHabitFires.length >= HABIT_RECURSION_BURST_THRESHOLD) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.habit_recursion_burst",
        message: "habit messages arriving in a burst — possible runaway loop",
        meta: {
          count: recentHabitFires.length,
          windowMs: HABIT_RECURSION_BURST_WINDOW_MS,
          thresholdCount: HABIT_RECURSION_BURST_THRESHOLD,
          lastHabitName: habitName,
        },
      })
    }
  }

  async function run(
    reason: PrivateRuntimeWorkerReason,
    taskId?: string,
    habitName?: string,
    awaitName?: string,
    trigger?: HabitRunReceipt["trigger"],
    privateTurnDecision?: PrivateTurnDecision,
    noSend?: true,
  ): Promise<void> {
    if (running) {
      queue.push({ reason, taskId, habitName, awaitName, trigger, privateTurnDecision, noSend })
      return
    }

    running = true
    try {
      let nextReason = reason
      let nextTaskId = taskId
      let nextHabitName = habitName
      let nextAwaitName = awaitName
      let nextTrigger = trigger
      let nextPrivateTurnDecision = privateTurnDecision
      let nextNoSend = reason === "habit" ? noSend : undefined
      let nextHabitRun: PreparedHabitRun | null = null
      let consecutiveInstinctTurns = reason === "instinct" ? 1 : 0

      runLoop: do {
        const currentReason = nextReason
        const currentHabitName = nextHabitName
        const currentTrigger = nextTrigger ?? "overdue"
        const currentNoSend = nextNoSend
        const currentHabitRun: PreparedHabitRun | null = currentReason === "habit" && currentHabitName
          ? nextHabitRun && nextHabitRun.habit.name === currentHabitName
            ? nextHabitRun
            : await prepareHabitRun(currentHabitName, currentTrigger, new Date(nowSource()).toISOString())
          : null
        nextHabitRun = null
        let currentHabitRunFinalized = false
        const finalizeCurrentHabitRun = (): void => {
          if (!currentHabitRun || currentHabitRunFinalized) return
          recordHabitCompletion(currentHabitRun, new Date(nowSource()).toISOString())
          currentHabitRunFinalized = true
        }
        const turnErrors: string[] = []
        if (!(currentReason === "habit" && currentHabitName === "heartbeat")) {
          clearHeartbeatRestShield()
        }
        let turnResult: unknown
        let blockedAutonomyTurn = false
        try {
          const turnStartedAt = new Date(nowSource()).toISOString()
          const autonomyDecision = currentHabitRun && !currentHabitRun.blockedReason
            ? reserveHabitAutonomyBudget(currentHabitRun, turnStartedAt)
            : null
          if (currentHabitRun) recordHabitStartIfNeeded(currentHabitRun)
          if (currentHabitRun?.blockedReason) {
            blockedAutonomyTurn = true
            turnResult = {
              turnOutcome: "blocked",
              reason: currentHabitRun.blockedReason,
            }
            clearHeartbeatRestShield()
          } else if (autonomyDecision && !autonomyDecision.allowed) {
            blockedAutonomyTurn = true
            const reason = `autonomy budget blocked: ${autonomyDecision.reason}`
            turnErrors.push(reason)
            turnResult = {
              turnOutcome: "blocked",
              reason,
              autonomyReceiptId: autonomyDecision.receiptId,
            }
            clearHeartbeatRestShield()
          } else {
            const turnOptions: PrivateRuntimeWorkerRunOptions = {
              reason: nextReason,
              taskId: nextTaskId,
              habitName: nextHabitName,
              awaitName: nextAwaitName,
              ...(currentNoSend ? { noSend: true } : {}),
              ...(nextPrivateTurnDecision ? { privateTurnDecision: nextPrivateTurnDecision } : {}),
              ...(currentHabitRun
                ? {
                  trigger: currentHabitRun.trigger,
                  preparedHabit: {
                    runId: currentHabitRun.runId,
                    trigger: currentHabitRun.trigger,
                    operationId: currentHabitRun.operationId,
                    habit: currentHabitRun.habit,
                    priorSessionSummary: currentHabitRun.priorSessionSummary,
                  },
                  habitSession: {
                    runId: currentHabitRun.runId,
                    sessionPath: currentHabitRun.paths.sessionPath,
                    pendingDir: currentHabitRun.paths.pendingDir,
                    permissionEnvelope: currentHabitRun.permissionEnvelope,
                    toolPolicy: currentHabitRun.toolPolicy,
                    ...(currentHabitRun.rsvpPolicy ? { rsvpPolicy: currentHabitRun.rsvpPolicy } : {}),
                    friendStore: currentHabitRun.friendStore,
                    recordProducedRef: (ref) => { currentHabitRun.producedRefs.push(ref) },
                    recordSurfaceAttempt: (attempt) => { currentHabitRun.surfaceAttempts.push(attempt) },
                    recordError: (error) => { currentHabitRun.errors.push(error) },
                  },
                }
                : {}),
            }
            turnResult = await runTurn(turnOptions)
          }
        } catch (error) {
          clearHeartbeatRestShield()
          turnErrors.push(error instanceof Error ? error.message : String(error))
          emitNervesEvent({
            level: "error",
            component: "senses",
            event: "senses.private_runtime_worker_error",
            message: "private-runtime worker turn failed",
            meta: {
              reason: nextReason,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        }
        if (currentReason === "habit" && currentHabitName === "heartbeat") {
          heartbeatOkRestedAt = isHeartbeatOkRestResult(turnResult) ? nowSource() : null
        }
        if (currentHabitRun) {
          currentHabitRun.results.push(turnResult)
          currentHabitRun.errors.push(...turnErrors)
        }

        // Drain queue first. Externally-queued work resets the instinct cap
        // because a real outside trigger arrived between turns.
        while (queue.length > 0) {
          const next = queue.shift()!
          if (next.reason === "habit" && next.habitName === "heartbeat" && shouldReuseHeartbeatOkRest(next.habitName)) {
            finalizeCurrentHabitRun()
            await reuseHeartbeatOkRest(next.habitName)
            continue
          }
          if (!(next.reason === "habit" && next.habitName === "heartbeat")) {
            clearHeartbeatRestShield()
          }
          finalizeCurrentHabitRun()
          nextReason = next.reason
          nextTaskId = next.taskId
          nextHabitName = next.habitName
          nextAwaitName = next.awaitName
          nextTrigger = next.trigger
          nextPrivateTurnDecision = next.privateTurnDecision
          nextNoSend = next.reason === "habit" ? next.noSend : undefined
          consecutiveInstinctTurns = nextReason === "instinct" ? consecutiveInstinctTurns + 1 : 0
          continue runLoop
        }

        if (blockedAutonomyTurn) {
          finalizeCurrentHabitRun()
          break
        }

        // Then check hasPendingWork fallback. This is the loop site: any
        // tool that writes to the private-runtime pending dir during a turn
        // would cause hasPendingWork() to be true here, producing a
        // self-sustaining "instinct" loop with no external input. Cap it.
        if (hasPendingWork(currentHabitRun?.paths.pendingDir)) {
          clearHeartbeatRestShield()
          if (consecutiveInstinctTurns >= MAX_CONSECUTIVE_INSTINCT_TURNS) {
            emitNervesEvent({
              level: "warn",
              component: "senses",
              event: "senses.private_runtime_worker_instinct_loop_capped",
              message: "private-runtime worker stopped chaining instinct turns; pending work remains for next external trigger",
              meta: {
                consecutiveInstinctTurns,
                cap: MAX_CONSECUTIVE_INSTINCT_TURNS,
                lastReason: nextReason,
              },
            })
            finalizeCurrentHabitRun()
            break
          }
          if (currentReason === "habit" && currentHabitName && currentHabitRun) {
            consecutiveInstinctTurns += 1
            nextReason = "habit"
            nextTaskId = undefined
            nextHabitName = currentHabitName
            nextAwaitName = undefined
            nextTrigger = currentTrigger
            nextPrivateTurnDecision = undefined
            nextNoSend = currentNoSend
            nextHabitRun = currentHabitRun
          } else {
            finalizeCurrentHabitRun()
            consecutiveInstinctTurns += 1
            nextReason = "instinct"
            nextTaskId = undefined
            nextHabitName = undefined
            nextAwaitName = undefined
            nextTrigger = undefined
            nextPrivateTurnDecision = undefined
            nextNoSend = undefined
          }
          continue
        }

        finalizeCurrentHabitRun()
        break
      } while (true)
    } finally {
      running = false
    }
  }

  async function handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return
    const maybeMessage = message as Partial<PrivateRuntimeWorkerMessage>
    if (maybeMessage.type === "habit") {
      /* v8 ignore next -- defensive fallback: live habit dispatch always sets habitName @preserve */
      const habitName = maybeMessage.habitName ?? "(unnamed)"
      if (shouldReuseHeartbeatOkRest(habitName)) {
        await reuseHeartbeatOkRest(habitName)
        return
      }
      recordHabitFireForRecursion(habitName)
      await run("habit", undefined, maybeMessage.habitName, undefined, maybeMessage.trigger ?? "overdue", maybeMessage.privateTurnDecision, maybeMessage.noSend)
      return
    }
    if (maybeMessage.type === "await") {
      clearHeartbeatRestShield()
      /* v8 ignore next -- defensive fallback: live await dispatch always sets awaitName @preserve */
      const awaitName = maybeMessage.awaitName ?? "(unnamed)"
      recordHabitFireForRecursion(`await:${awaitName}`)
      await run("await", undefined, undefined, maybeMessage.awaitName, undefined, maybeMessage.privateTurnDecision)
      return
    }
    if (maybeMessage.type === "heartbeat") {
      // Backward compatibility: heartbeat -> habit/heartbeat
      if (shouldReuseHeartbeatOkRest("heartbeat")) {
        await reuseHeartbeatOkRest("heartbeat")
        return
      }
      recordHabitFireForRecursion("heartbeat")
      await run("habit", undefined, "heartbeat", undefined, "overdue", maybeMessage.privateTurnDecision)
      return
    }
    if (maybeMessage.type === "poke") {
      clearHeartbeatRestShield()
      await run("instinct", maybeMessage.taskId, undefined, undefined, undefined, maybeMessage.privateTurnDecision)
      return
    }
    if (
      maybeMessage.type === "chat" ||
      maybeMessage.type === "message"
    ) {
      clearHeartbeatRestShield()
      await run("instinct", undefined, undefined, undefined, undefined, maybeMessage.privateTurnDecision)
      return
    }
    if (maybeMessage.type === "shutdown") {
      process.exit(0)
    }
  }

  return { run, handleMessage }
}

export async function startPrivateRuntimeWorker(
  options: StartPrivateRuntimeWorkerOptions = {},
): Promise<PrivateRuntimeWorkerController> {
  const worker = createPrivateRuntimeWorker()
  if (options.attachProcessListeners ?? true) {
    process.on("message", (message) => {
      void worker.handleMessage(message)
    })
    process.on("disconnect", () => {
      process.exit(0)
    })
  }
  for (const message of options.bufferedMessages ?? []) {
    void worker.handleMessage(message)
  }
  return worker
}
