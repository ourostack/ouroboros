import { afterEach, describe, expect, it, vi } from "vitest"
import * as nervesRuntime from "../../nerves/runtime"
import { markTerminationGuard, signalHandlersBesidesGuards } from "../../heart/termination-guard"

describe("termination guards", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("counts the process's own handlers and not other guards, and says which way the guards go", () => {
    const events = vi.spyOn(nervesRuntime, "emitNervesEvent")
    const guard = markTerminationGuard(() => undefined)
    const own = (): void => undefined
    vi.spyOn(process, "rawListeners").mockReturnValueOnce([guard]).mockReturnValueOnce([guard, own])

    expect(signalHandlersBesidesGuards("SIGTERM")).toEqual([])
    expect(signalHandlersBesidesGuards("SIGTERM")).toEqual([own])

    expect(events.mock.calls.map(([event]) => event.meta)).toEqual([
      { signal: "SIGTERM", handlers: 0 },
      { signal: "SIGTERM", handlers: 1 },
    ])
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: "heart.termination_guard_signal" }))
  })
})
