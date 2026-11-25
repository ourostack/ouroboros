import { afterEach, describe, expect, it, vi } from "vitest"

import { createPhaseTimer } from "./phase-timer"

afterEach(() => { vi.useRealTimers() })

describe("createPhaseTimer", () => {
  it("records completed phase durations and the entered phase, silent when fast", () => {
    vi.useFakeTimers()
    const write = vi.fn()
    let t = 100
    const timer = createPhaseTimer("case", { watchdogMs: 50, now: () => t, write })
    t = 110; timer.enter("fixture")
    t = 140; timer.enter("propose")
    t = 150
    expect(timer.report()).toBe("phase timings for case at 50ms: completed fixture=30ms; latest observed phase propose (entered at 40ms, 10ms so far)")
    t = 160; timer.done()
    expect(timer.report()).toContain("completed fixture=30ms propose=20ms; latest observed phase none")
    vi.advanceTimersByTime(1000)
    expect(write).not.toHaveBeenCalled()
  })

  it("reports no phase before the first enter", () => {
    const timer = createPhaseTimer("case", { now: () => 0 })
    expect(timer.report()).toBe("phase timings for case at 0ms: completed none; latest observed phase none")
  })

  it("appends the report to a thrown Error and leaves other values alone", () => {
    const timer = createPhaseTimer("case", { now: () => 0 })
    timer.enter("callback")
    const error = new Error("boom")
    expect((timer.annotate(error) as Error).message).toBe(`boom\n${timer.report()}`)
    expect(timer.annotate("text")).toBe("text")
  })

  it("prints once while still running and still prints for a case that later succeeds", () => {
    vi.useFakeTimers()
    const write = vi.fn()
    let t = 0
    const timer = createPhaseTimer("case", { watchdogMs: 50, now: () => t, write })
    timer.enter("callback")
    t = 60
    vi.advanceTimersByTime(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toContain("latest observed phase callback (entered at 0ms, 60ms so far); slow: still running, watchdog scheduled for 50ms")
    t = 90; timer.done()
    expect(timer.report()).toContain("completed callback=90ms")
    expect(write).toHaveBeenCalledTimes(1)
  })

  it("reports actual elapsed time when the watchdog callback is delayed by synchronous work", () => {
    vi.useFakeTimers()
    const write = vi.fn()
    let t = 0
    const timer = createPhaseTimer("case", { watchdogMs: 50, now: () => t, write })
    timer.enter("mutate")
    t = 4900
    vi.advanceTimersByTime(50)
    expect(write.mock.calls[0]![0]).toContain("at 4900ms")
    timer.done()
  })

  it("writes to stderr by default using the monotonic clock", () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const timer = createPhaseTimer("case", { watchdogMs: 5 })
    vi.advanceTimersByTime(10)
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
    timer.done()
  })
})
