import { describe, expect, it } from "vitest"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("turn execution lease", () => {
  it("serializes concurrent work in arrival order", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const secondEntered = deferred()
    const order: string[] = []

    const first = withTurnExecutionLease(async () => {
      order.push("first:start")
      firstEntered.resolve()
      await releaseFirst.promise
      order.push("first:end")
    })
    await firstEntered.promise

    const second = withTurnExecutionLease(async () => {
      order.push("second:start")
      secondEntered.resolve()
      order.push("second:end")
    })
    await Promise.resolve()
    expect(order).toEqual(["first:start"])

    releaseFirst.resolve()
    await Promise.all([first, second, secondEntered.promise])
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })

  it("allows nested work to reuse the held lease", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const order: string[] = []

    await withTurnExecutionLease(async () => {
      order.push("outer:start")
      await withTurnExecutionLease(async () => {
        order.push("inner")
      })
      order.push("outer:end")
    })

    expect(order).toEqual(["outer:start", "inner", "outer:end"])
  })

  it("releases the queue after work throws", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")

    await expect(withTurnExecutionLease(async () => {
      throw new Error("boom")
    })).rejects.toThrow("boom")

    await expect(withTurnExecutionLease(async () => "recovered")).resolves.toBe("recovered")
  })
})
