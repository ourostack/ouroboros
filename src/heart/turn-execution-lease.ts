import { AsyncLocalStorage } from "node:async_hooks"

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
  return leaseContext.run(true, async () => {
    try {
      return await work()
    } finally {
      release()
    }
  })
}
