import { AsyncLocalStorage } from "node:async_hooks"
import { emitNervesEvent } from "../nerves/runtime"

const leaseContext = new AsyncLocalStorage<boolean>()
let queueTail = Promise.resolve()
/** Turns holding or waiting for the lease. */
let queuedTurns = 0

function untilReadyOrAborted(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    void previous.then(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    })
  })
}

/**
 * Run `work` once every turn queued ahead of it has finished. With a signal,
 * an abort (turn deadline, supersession, shutdown) ends the wait instead of
 * leaving the turn queued behind one that may never finish. A turn that finds
 * the lease free runs as before, whatever its signal says.
 */
export async function withTurnExecutionLease<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (leaseContext.getStore()) return work()

  let resolveTail!: () => void
  const previous = queueTail
  const mustWait = queuedTurns > 0
  queuedTurns += 1
  queueTail = new Promise<void>((resolve) => {
    resolveTail = resolve
  })
  const release = (): void => {
    queuedTurns -= 1
    resolveTail()
  }

  if (signal && mustWait) {
    try {
      await untilReadyOrAborted(previous, signal)
    } catch (error) {
      // Give up this place in line only when the turn ahead ends, so the turn
      // behind still runs after it rather than alongside it.
      void previous.then(release)
      emitNervesEvent({
        level: "warn",
        component: "heart",
        event: "heart.turn_execution_lease_abandoned",
        message: "turn stopped waiting for the turn ahead of it",
        meta: { reason: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  } else {
    await previous
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.turn_execution_lease_acquired",
    message: "turn execution lease acquired",
  })
  return leaseContext.run(true, async () => {
    try {
      return await work()
    } finally {
      release()
    }
  })
}
