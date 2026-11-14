import { describe, expect, it, vi } from "vitest"

import { repeatEvery } from "../../senses/repeat-while"

describe("repeatEvery", () => {
  it("waits one interval before the first tick unless asked to start now, and stops when told", async () => {
    vi.useFakeTimers()
    try {
      const tick = vi.fn()
      const stop = repeatEvery(tick, 3_000)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(tick).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(tick).toHaveBeenCalledTimes(1)
      stop()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(tick).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a tick that throws or rejects and keeps going", async () => {
    vi.useFakeTimers()
    try {
      const tick = vi.fn().mockImplementationOnce(() => { throw new Error("sync") }).mockRejectedValueOnce(new Error("async")).mockResolvedValue(undefined)
      const stop = repeatEvery(tick, 1_000, { now: true })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(tick).toHaveBeenCalledTimes(3)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
