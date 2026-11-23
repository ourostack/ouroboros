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

  it("stops waiting when the turn's signal aborts, and the turn behind still waits for the one ahead", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const releaseFirst = deferred()
    const firstEntered = deferred()
    const order: string[] = []

    const first = withTurnExecutionLease(async () => {
      firstEntered.resolve()
      await releaseFirst.promise
      order.push("first:end")
    })
    await firstEntered.promise

    const controller = new AbortController()
    const waiting = withTurnExecutionLease(async () => {
      order.push("aborted:ran")
    }, controller.signal)
    const third = withTurnExecutionLease(async () => {
      order.push("third:ran")
    })

    controller.abort(new Error("turn deadline"))
    await expect(waiting).rejects.toThrow("turn deadline")
    await Promise.resolve()
    expect(order).toEqual([])

    releaseFirst.resolve()
    await Promise.all([first, third])
    expect(order).toEqual(["first:end", "third:ran"])
  })

  it("rejects at once when the signal is already aborted and a turn is ahead", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const hold = deferred()
    const entered = deferred()
    const first = withTurnExecutionLease(async () => { entered.resolve(); await hold.promise })
    await entered.promise
    const controller = new AbortController()
    controller.abort(new Error("shut down"))
    let ran = false

    await expect(withTurnExecutionLease(async () => { ran = true }, controller.signal)).rejects.toThrow("shut down")
    expect(ran).toBe(false)
    hold.resolve()
    await first
    await expect(withTurnExecutionLease(async () => "next")).resolves.toBe("next")
  })

  it("still runs an already-aborted turn when nothing is ahead of it", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const controller = new AbortController()
    controller.abort(new Error("late"))
    await expect(withTurnExecutionLease(async () => "ran", controller.signal)).resolves.toBe("ran")
  })

  it("reports a non-Error abort reason as text", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const hold = deferred()
    const entered = deferred()
    const first = withTurnExecutionLease(async () => { entered.resolve(); await hold.promise })
    await entered.promise
    const controller = new AbortController()
    const waiting = withTurnExecutionLease(async () => undefined, controller.signal)
    controller.abort("superseded")
    await expect(waiting).rejects.toBe("superseded")
    hold.resolve()
    await first
  })

  it("runs signalled work after the turn ahead when nothing aborts", async () => {
    const { withTurnExecutionLease } = await import("../../heart/turn-execution-lease")
    const hold = deferred()
    const entered = deferred()
    const first = withTurnExecutionLease(async () => { entered.resolve(); await hold.promise })
    await entered.promise
    const controller = new AbortController()
    const second = withTurnExecutionLease(async () => "done", controller.signal)
    hold.resolve()
    await first
    await expect(second).resolves.toBe("done")
    controller.abort(new Error("after the fact"))
  })
})
