import { afterEach, describe, expect, it, vi } from "vitest"

import { createPhaseTimer } from "./phase-timer"

afterEach(() => { vi.useRealTimers() })

describe("createPhaseTimer", () => {
  it("reports phases relative to start and stays silent when the test passes", () => {
    vi.useFakeTimers()
    const write = vi.fn()
    let t = 100
    const timer = createPhaseTimer("case", { watchdogMs: 50, now: () => t, write })
    t = 130; timer.mark("fixture")
    t = 400; timer.mark("callback")
    timer.done()
    vi.advanceTimersByTime(1000)
    expect(timer.report()).toBe("phase timings for case (ms since start): fixture=30 callback=300")
    expect(write).not.toHaveBeenCalled()
  })

  it("appends timings to a thrown Error and leaves other values alone", () => {
    const timer = createPhaseTimer("case", { now: () => 0 })
    expect(timer.report()).toContain("no phase reached")
    const error = new Error("boom")
    expect((timer.annotate(error) as Error).message).toBe("boom\nphase timings for case (ms since start): no phase reached")
    expect(timer.annotate("text")).toBe("text")
  })

  it("prints once from the watchdog when the test is still running", () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const timer = createPhaseTimer("case", { watchdogMs: 50, now: () => 0, write })
    timer.mark("fixture")
    vi.advanceTimersByTime(200)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toContain("fixture=0; still running after 50ms")
    timer.done()
  })

  it("writes to stderr by default", () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const timer = createPhaseTimer("case", { watchdogMs: 5 })
    vi.advanceTimersByTime(10)
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
    timer.done()
  })
})
