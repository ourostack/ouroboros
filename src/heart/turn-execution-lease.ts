import { AsyncLocalStorage } from "node:async_hooks"
import { emitNervesEvent } from "../nerves/runtime"

const leaseContext = new AsyncLocalStorage<boolean>()
let queueTail = Promise.resolve()

export async function withTurnExecutionLease<T>(work: () => Promise<T>): Promise<T> {
  if (leaseContext.getStore()) return work()

  let release!: () => void
  const previous = queueTail
  queueTail = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
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
