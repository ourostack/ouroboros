import { runInnerDialogTurn } from "./inner-dialog"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentName } from "../heart/identity"
import { getInnerDialogPendingDir, hasPendingMessages } from "../mind/pending"

export type InnerDialogWorkerReason = "boot" | "heartbeat" | "instinct"

export interface InnerDialogWorkerMessage {
  type: "heartbeat" | "shutdown" | "poke" | "chat" | "message" | string
  taskId?: string
}

export interface InnerDialogWorkerRunOptions {
  reason: InnerDialogWorkerReason
  taskId?: string
}

export interface InnerDialogWorkerController {
  run(reason: InnerDialogWorkerReason, taskId?: string): Promise<void>
  handleMessage(message: unknown): Promise<void>
}

export function createInnerDialogWorker(
  runTurn: (options: InnerDialogWorkerRunOptions) => Promise<unknown> = (options) => runInnerDialogTurn(options),
  hasPendingWork: () => boolean = () => hasPendingMessages(getInnerDialogPendingDir(getAgentName())),
): InnerDialogWorkerController {
  let running = false
  let rerunRequested = false
  let rerunReason: InnerDialogWorkerReason = "instinct"
  let rerunTaskId: string | undefined

  async function run(reason: InnerDialogWorkerReason, taskId?: string): Promise<void> {
    if (running) {
      rerunRequested = true
      rerunReason = reason
      if (taskId !== undefined) {
        rerunTaskId = taskId
      }
      return
    }

    running = true
    try {
      let nextReason = reason
      let nextTaskId = taskId

      do {
        rerunRequested = false
        try {
          await runTurn({ reason: nextReason, taskId: nextTaskId })
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
        if (!rerunRequested && hasPendingWork()) {
          rerunRequested = true
          rerunReason = "instinct"
        }
        nextReason = rerunReason
        nextTaskId = rerunTaskId
        rerunReason = "instinct"
        rerunTaskId = undefined
      } while (rerunRequested)
    } finally {
      running = false
    }
  }

  async function handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return
    const maybeMessage = message as Partial<InnerDialogWorkerMessage>
    if (maybeMessage.type === "heartbeat") {
      await run("heartbeat")
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
