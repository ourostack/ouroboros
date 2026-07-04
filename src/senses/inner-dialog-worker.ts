import type {
  PrivateRuntimeWorkerController,
  PrivateRuntimeWorkerMessage,
  PrivateRuntimeWorkerReason,
  PrivateRuntimeWorkerRunOptions,
} from "./private-runtime-worker"
import { emitNervesEvent } from "../nerves/runtime"
import * as innerDialog from "./inner-dialog"
import * as privateRuntimeWorker from "./private-runtime-worker"

export type InnerDialogWorkerReason = PrivateRuntimeWorkerReason
export type InnerDialogWorkerMessage = PrivateRuntimeWorkerMessage
export type InnerDialogWorkerRunOptions = PrivateRuntimeWorkerRunOptions
export type InnerDialogWorkerController = PrivateRuntimeWorkerController

export const MAX_CONSECUTIVE_INSTINCT_TURNS = 3
export const HABIT_RECURSION_MIN_INTERVAL_MS = 5_000
export const HABIT_RECURSION_BURST_WINDOW_MS = 60_000
export const HABIT_RECURSION_BURST_THRESHOLD = 5
export const HEARTBEAT_OK_REST_SUPPRESSION_MS = 20 * 60_000

export function createInnerDialogWorker(
  runTurn: (options: InnerDialogWorkerRunOptions) => Promise<unknown> = (options) => {
    return innerDialog.runInnerDialogTurn(options)
  },
  hasPendingWork?: (pendingDir?: string) => boolean,
  nowSource?: () => number,
): InnerDialogWorkerController {
  return privateRuntimeWorker.createPrivateRuntimeWorker(runTurn, hasPendingWork, nowSource)
}

export async function startInnerDialogWorker(): Promise<void> {
  emitNervesEvent({
    level: "info",
    component: "senses",
    event: "senses.inner_dialog_worker_compat_start",
    message: "legacy inner-dialog worker startup delegated to private-runtime worker",
    meta: { target: "private-runtime-worker" },
  })
  await privateRuntimeWorker.startPrivateRuntimeWorker()
}
