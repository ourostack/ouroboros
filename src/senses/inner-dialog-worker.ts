import * as path from "path"
import { runInnerDialogTurn } from "./inner-dialog"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { getInnerDialogPendingDir, hasPendingMessages } from "../mind/pending"
import { recordHabitRun } from "../heart/habits/habit-runtime-state"

export type InnerDialogWorkerReason = "boot" | "habit" | "instinct"

export interface InnerDialogWorkerMessage {
  type: "heartbeat" | "habit" | "shutdown" | "poke" | "chat" | "message" | string
  taskId?: string
  habitName?: string
}

export interface InnerDialogWorkerRunOptions {
  reason: InnerDialogWorkerReason
  taskId?: string
  habitName?: string
}

export interface InnerDialogWorkerController {
  run(reason: InnerDialogWorkerReason, taskId?: string, habitName?: string): Promise<void>
  handleMessage(message: unknown): Promise<void>
}

interface QueueEntry {
  reason: InnerDialogWorkerReason
  taskId?: string
  habitName?: string
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

export function createInnerDialogWorker(
  runTurn: (options: InnerDialogWorkerRunOptions) => Promise<unknown> = (options) => runInnerDialogTurn(options),
  hasPendingWork: () => boolean = () => hasPendingMessages(getInnerDialogPendingDir(getAgentName())),
  nowSource: () => number = () => Date.now(),
): InnerDialogWorkerController {
  let running = false
  const queue: QueueEntry[] = []
  const lastFireByHabit = new Map<string, number>()
  const recentHabitFires: number[] = []

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

  async function run(reason: InnerDialogWorkerReason, taskId?: string, habitName?: string): Promise<void> {
    if (running) {
      queue.push({ reason, taskId, habitName })
      return
    }

    running = true
    try {
      let nextReason = reason
      let nextTaskId = taskId
      let nextHabitName = habitName
      let consecutiveInstinctTurns = reason === "instinct" ? 1 : 0

      do {
        try {
          await runTurn({ reason: nextReason, taskId: nextTaskId, habitName: nextHabitName })
        } catch (error) {
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

        // Record lastRun after a habit turn without dirtying the tracked habit file.
        if (nextReason === "habit" && nextHabitName) {
          try {
            const agentRoot = getAgentRoot()
            recordHabitRun(agentRoot, nextHabitName, new Date().toISOString(), {
              definitionPath: path.join(agentRoot, "habits", `${nextHabitName}.md`),
            })
          } catch {
            // Habit file/state may be unavailable during the turn — skip gracefully
          }
        }

        // Drain queue first. Externally-queued work resets the instinct cap
        // because a real outside trigger arrived between turns.
        if (queue.length > 0) {
          const next = queue.shift()!
          nextReason = next.reason
          nextTaskId = next.taskId
          nextHabitName = next.habitName
          consecutiveInstinctTurns = nextReason === "instinct" ? consecutiveInstinctTurns + 1 : 0
          continue
        }

        // Then check hasPendingWork fallback. This is the loop site: any
        // tool that writes to the inner-dialog pending dir during a turn
        // would cause hasPendingWork() to be true here, producing a
        // self-sustaining "instinct" loop with no external input. Cap it.
        if (hasPendingWork()) {
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
            break
          }
          consecutiveInstinctTurns += 1
          nextReason = "instinct"
          nextTaskId = undefined
          nextHabitName = undefined
          continue
        }

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
      recordHabitFireForRecursion(habitName)
      await run("habit", undefined, maybeMessage.habitName)
      return
    }
    if (maybeMessage.type === "heartbeat") {
      // Backward compatibility: heartbeat -> habit/heartbeat
      recordHabitFireForRecursion("heartbeat")
      await run("habit", undefined, "heartbeat")
      return
    }
    if (maybeMessage.type === "poke") {
      await run("instinct", maybeMessage.taskId)
      return
    }
    if (
      maybeMessage.type === "chat" ||
      maybeMessage.type === "message"
    ) {
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
