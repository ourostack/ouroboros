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

export function createInnerDialogWorker(
  runTurn: (options: InnerDialogWorkerRunOptions) => Promise<unknown> = (options) => runInnerDialogTurn(options),
  hasPendingWork: () => boolean = () => hasPendingMessages(getInnerDialogPendingDir(getAgentName())),
): InnerDialogWorkerController {
  let running = false
  const queue: QueueEntry[] = []

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

        // Drain queue first
        if (queue.length > 0) {
          const next = queue.shift()!
          nextReason = next.reason
          nextTaskId = next.taskId
          nextHabitName = next.habitName
          continue
        }

        // Then check hasPendingWork fallback
        if (hasPendingWork()) {
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
      await run("habit", undefined, maybeMessage.habitName)
      return
    }
    if (maybeMessage.type === "heartbeat") {
      // Backward compatibility: heartbeat -> habit/heartbeat
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
