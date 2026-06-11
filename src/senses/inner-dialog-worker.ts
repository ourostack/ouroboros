import * as fs from "fs"
import * as path from "path"
import { runInnerDialogTurn } from "./inner-dialog"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { getInnerDialogPendingDir, hasPendingMessages } from "../mind/pending"
import { recordHabitRun } from "../heart/habits/habit-runtime-state"
import { parseHabitFile, type HabitFile } from "../heart/habits/habit-parser"
import {
  buildHabitRunReceipt,
  createHabitSessionPaths,
  filterHabitToolsForEnvelope,
  normalizeHabitPermissionEnvelope,
} from "../heart/habits/habit-session"
import {
  createHabitRunId,
  writeHabitRunReceipt,
  type FlightRecorderProducedRef,
  type HabitRunReceipt,
} from "../arc/flight-recorder"
import { FileFriendStore } from "../mind/friends/store-file"
import { baseToolDefinitions, type HabitSessionToolContext, type ToolDefinition, type ToolRiskProfile } from "../repertoire/tools-base"
import { surfaceToolDefinition } from "../repertoire/tools-surface"

export type InnerDialogWorkerReason = "boot" | "habit" | "instinct" | "await"

export interface InnerDialogWorkerMessage {
  type: "heartbeat" | "habit" | "await" | "shutdown" | "poke" | "chat" | "message" | string
  taskId?: string
  habitName?: string
  awaitName?: string
  trigger?: HabitRunReceipt["trigger"]
}

export interface InnerDialogWorkerRunOptions {
  reason: InnerDialogWorkerReason
  taskId?: string
  habitName?: string
  awaitName?: string
  trigger?: HabitRunReceipt["trigger"]
  habitSession?: HabitSessionToolContext
}

export interface InnerDialogWorkerController {
  run(reason: InnerDialogWorkerReason, taskId?: string, habitName?: string, awaitName?: string, trigger?: HabitRunReceipt["trigger"]): Promise<void>
  handleMessage(message: unknown): Promise<void>
}

interface QueueEntry {
  reason: InnerDialogWorkerReason
  taskId?: string
  habitName?: string
  awaitName?: string
  trigger?: HabitRunReceipt["trigger"]
}

interface PreparedHabitRun {
  agentRoot: string
  habit: HabitFile
  runId: string
  trigger: HabitRunReceipt["trigger"]
  startedAt: string
  paths: ReturnType<typeof createHabitSessionPaths>
  permissionEnvelope: HabitRunReceipt["permissionEnvelope"]
  toolPolicy: HabitRunReceipt["toolPolicy"]
  friendStore: FileFriendStore
  results: unknown[]
  errors: string[]
  producedRefs: FlightRecorderProducedRef[]
  surfaceAttempts: HabitRunReceipt["surfaceAttempts"]
}

/**
 * Cap on consecutive `instinct` follow-on turns triggered by `hasPendingWork()`
 * with no externally-queued work in between. Without this cap, a turn that
 * writes anything back into the inner-dialog pending dir as a side effect of
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

function isHeartbeatOkRestResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false
  const maybeResult = result as { turnOutcome?: unknown; restStatus?: unknown }
  return maybeResult.turnOutcome === "rested" && maybeResult.restStatus === "HEARTBEAT_OK"
}

function fallbackHabitFile(habitName: string): HabitFile {
  return {
    name: habitName,
    title: habitName,
    cadence: null,
    status: "active",
    lastRun: null,
    created: null,
    tools: [],
    origin: null,
    surface: { family: false, originator: false, extra: [] },
    body: "",
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
    return fallbackHabitFile(habitName)
  }
}

async function prepareHabitRun(habitName: string, trigger: HabitRunReceipt["trigger"], startedAt: string): Promise<PreparedHabitRun> {
  const agentRoot = getAgentRoot()
  const errors: string[] = []
  const habit = readHabitForRun(agentRoot, habitName, errors)
  const runId = createHabitRunId(habitName, new Date(startedAt))
  const paths = createHabitSessionPaths(agentRoot, runId, habit.name)
  const friendStore = new FileFriendStore(path.join(agentRoot, "friends"))
  const permissionEnvelope = await normalizeHabitPermissionEnvelope(habit, { agentRoot, friendStore })
  const toolPolicy = filterHabitToolsForEnvelope(
    [...baseToolDefinitions, surfaceToolDefinition],
    habit.tools ?? null,
    permissionEnvelope,
    riskProfileForHabitPolicy,
  )
  return {
    agentRoot,
    habit,
    runId,
    trigger,
    startedAt,
    paths,
    permissionEnvelope,
    toolPolicy,
    friendStore,
    results: [],
    errors,
    producedRefs: [],
    surfaceAttempts: [],
  }
}

function riskProfileForHabitPolicy(definition: ToolDefinition): ToolRiskProfile {
  if (typeof definition.riskProfile === "function") return definition.riskProfile({})
  return definition.riskProfile ?? { mutates: "none", risk: "low" }
}

export function createInnerDialogWorker(
  runTurn: (options: InnerDialogWorkerRunOptions) => Promise<unknown> = (options) => runInnerDialogTurn(options),
  hasPendingWork: (pendingDir?: string) => boolean = (pendingDir) => hasPendingMessages(pendingDir ?? getInnerDialogPendingDir(getAgentName())),
  nowSource: () => number = () => Date.now(),
): InnerDialogWorkerController {
  let running = false
  const queue: QueueEntry[] = []
  const lastFireByHabit = new Map<string, number>()
  const recentHabitFires: number[] = []
  let heartbeatOkRestedAt: number | null = null

  function habitOutcomeForTurn(turnResults: unknown[], errors: string[]): { outcome: HabitRunReceipt["outcome"]; producedRefs: FlightRecorderProducedRef[] } {
    if (errors.length > 0) return { outcome: "error", producedRefs: [] }
    const toolNames = new Set<string>()
    const results = turnResults.flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    for (const turnResult of results) {
      if (!turnResult || typeof turnResult !== "object" || !Array.isArray((turnResult as { messages?: unknown }).messages)) continue
      for (const message of (turnResult as { messages: Array<Record<string, unknown>> }).messages) {
        const toolCalls = message.tool_calls
        if (!Array.isArray(toolCalls)) continue
        for (const call of toolCalls) {
          const functionName = (call as { function?: { name?: unknown } }).function?.name
          if (typeof functionName === "string") toolNames.add(functionName)
        }
      }
    }
    if (toolNames.has("send_message") || toolNames.has("surface")) {
      return { outcome: "surfaced", producedRefs: [{ kind: "surface", locator: "tool:send_message_or_surface" }] }
    }
    if (toolNames.has("diary_write") || toolNames.has("note")) {
      return { outcome: "wrote_record", producedRefs: [{ kind: "desk_record", locator: "desk/_record" }] }
    }
    if ([...toolNames].some((name) => name.startsWith("mcp__desk__"))) {
      return { outcome: "updated_desk", producedRefs: [{ kind: "desk_task", locator: "desk/" }] }
    }
    return { outcome: "no_change", producedRefs: [] }
  }

  function recordHabitCompletion(
    habitRun: PreparedHabitRun,
    endedAt = habitRun.startedAt,
  ): void {
    try {
      recordHabitRun(habitRun.agentRoot, habitRun.habit.name, endedAt, {
        definitionPath: path.join(habitRun.agentRoot, "habits", `${habitRun.habit.name}.md`),
      })
      const { outcome, producedRefs } = habitOutcomeForTurn(habitRun.results, habitRun.errors)
      writeHabitRunReceipt(habitRun.agentRoot, buildHabitRunReceipt({
        agentRoot: habitRun.agentRoot,
        habit: habitRun.habit,
        runId: habitRun.runId,
        trigger: habitRun.trigger,
        startedAt: habitRun.startedAt,
        endedAt,
        outcome,
        permissionEnvelope: habitRun.permissionEnvelope,
        toolPolicy: habitRun.toolPolicy,
        producedRefs: habitRun.producedRefs.length > 0 ? habitRun.producedRefs : producedRefs,
        surfaceAttempts: habitRun.surfaceAttempts,
        errors: habitRun.errors,
      }))
    } catch {
      // Habit file/state may be unavailable during the turn — skip gracefully
    }
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

  async function run(reason: InnerDialogWorkerReason, taskId?: string, habitName?: string, awaitName?: string, trigger?: HabitRunReceipt["trigger"]): Promise<void> {
    if (running) {
      queue.push({ reason, taskId, habitName, awaitName, trigger })
      return
    }

    running = true
    try {
      let nextReason = reason
      let nextTaskId = taskId
      let nextHabitName = habitName
      let nextAwaitName = awaitName
      let nextTrigger = trigger
      let nextHabitRun: PreparedHabitRun | null = null
      let consecutiveInstinctTurns = reason === "instinct" ? 1 : 0

      runLoop: do {
        const currentReason = nextReason
        const currentHabitName = nextHabitName
        const currentTrigger = nextTrigger ?? "overdue"
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
        try {
          const turnOptions: InnerDialogWorkerRunOptions = {
            reason: nextReason,
            taskId: nextTaskId,
            habitName: nextHabitName,
            awaitName: nextAwaitName,
            ...(currentHabitRun
              ? {
                trigger: currentHabitRun.trigger,
                habitSession: {
                  runId: currentHabitRun.runId,
                  sessionPath: currentHabitRun.paths.sessionPath,
                  pendingDir: currentHabitRun.paths.pendingDir,
                  permissionEnvelope: currentHabitRun.permissionEnvelope,
                  toolPolicy: currentHabitRun.toolPolicy,
                  friendStore: currentHabitRun.friendStore,
                  recordProducedRef: (ref) => { currentHabitRun.producedRefs.push(ref) },
                  recordSurfaceAttempt: (attempt) => { currentHabitRun.surfaceAttempts.push(attempt) },
                  recordError: (error) => { currentHabitRun.errors.push(error) },
                },
              }
              : {}),
          }
          turnResult = await runTurn(turnOptions)
        } catch (error) {
          clearHeartbeatRestShield()
          turnErrors.push(error instanceof Error ? error.message : String(error))
          emitNervesEvent({
            level: "error",
            component: "senses",
            event: "senses.inner_dialog_worker_error",
            message: "inner dialog worker turn failed",
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
          consecutiveInstinctTurns = nextReason === "instinct" ? consecutiveInstinctTurns + 1 : 0
          continue runLoop
        }

        // Then check hasPendingWork fallback. This is the loop site: any
        // tool that writes to the inner-dialog pending dir during a turn
        // would cause hasPendingWork() to be true here, producing a
        // self-sustaining "instinct" loop with no external input. Cap it.
        if (hasPendingWork(currentHabitRun?.paths.pendingDir)) {
          clearHeartbeatRestShield()
          if (consecutiveInstinctTurns >= MAX_CONSECUTIVE_INSTINCT_TURNS) {
            emitNervesEvent({
              level: "warn",
              component: "senses",
              event: "senses.inner_dialog_worker_instinct_loop_capped",
              message: "inner dialog worker stopped chaining instinct turns; pending work remains for next external trigger",
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
            nextHabitRun = currentHabitRun
          } else {
            finalizeCurrentHabitRun()
            consecutiveInstinctTurns += 1
            nextReason = "instinct"
            nextTaskId = undefined
            nextHabitName = undefined
            nextAwaitName = undefined
            nextTrigger = undefined
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
    const maybeMessage = message as Partial<InnerDialogWorkerMessage>
    if (maybeMessage.type === "habit") {
      /* v8 ignore next -- defensive fallback: live habit dispatch always sets habitName @preserve */
      const habitName = maybeMessage.habitName ?? "(unnamed)"
      if (shouldReuseHeartbeatOkRest(habitName)) {
        await reuseHeartbeatOkRest(habitName)
        return
      }
      recordHabitFireForRecursion(habitName)
      await run("habit", undefined, maybeMessage.habitName, undefined, maybeMessage.trigger ?? "overdue")
      return
    }
    if (maybeMessage.type === "await") {
      clearHeartbeatRestShield()
      /* v8 ignore next -- defensive fallback: live await dispatch always sets awaitName @preserve */
      const awaitName = maybeMessage.awaitName ?? "(unnamed)"
      recordHabitFireForRecursion(`await:${awaitName}`)
      await run("await", undefined, undefined, maybeMessage.awaitName)
      return
    }
    if (maybeMessage.type === "heartbeat") {
      // Backward compatibility: heartbeat -> habit/heartbeat
      if (shouldReuseHeartbeatOkRest("heartbeat")) {
        await reuseHeartbeatOkRest("heartbeat")
        return
      }
      recordHabitFireForRecursion("heartbeat")
      await run("habit", undefined, "heartbeat", undefined, "overdue")
      return
    }
    if (maybeMessage.type === "poke") {
      clearHeartbeatRestShield()
      await run("instinct", maybeMessage.taskId)
      return
    }
    if (
      maybeMessage.type === "chat" ||
      maybeMessage.type === "message"
    ) {
      clearHeartbeatRestShield()
      await run("instinct")
      return
    }
    if (maybeMessage.type === "shutdown") {
      process.exit(0)
    }
  }

  return { run, handleMessage }
}

export async function startInnerDialogWorker(): Promise<void> {
  const worker = createInnerDialogWorker()
  process.on("message", (message) => {
    void worker.handleMessage(message)
  })
  process.on("disconnect", () => {
    process.exit(0)
  })
  await worker.run("boot")
}
