import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

describe("playHatchAnimation", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  async function runWithTimers(fn: () => Promise<void>): Promise<void> {
    const p = fn()
    // Flush all pending timers (animation waits)
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5000)
    await p
  }

  it("writes egg emoji, then snake emoji with hatchling name", async () => {
    const { playHatchAnimation } = await import("../../../heart/daemon/hatch-animation")
    const chunks: string[] = []
    const writer = (text: string) => { chunks.push(text) }

    await runWithTimers(() => playHatchAnimation("Slugger", writer))

    const output = chunks.join("")
    expect(output).toContain("\uD83E\uDD5A") // egg emoji
    expect(output).toContain("\uD83D\uDC0D") // snake emoji
    expect(output).toContain("Slugger")
  })

  it("custom writer receives all output chunks", async () => {
    const { playHatchAnimation } = await import("../../../heart/daemon/hatch-animation")
    const writer = vi.fn()

    await runWithTimers(() => playHatchAnimation("TestBot", writer))

    expect(writer).toHaveBeenCalled()
    expect(writer.mock.calls.length).toBeGreaterThan(1) // multiple chunks
  })

  it("uses process.stderr.write as default writer", async () => {
    const { playHatchAnimation } = await import("../../../heart/daemon/hatch-animation")
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      await runWithTimers(() => playHatchAnimation("DefaultWriter"))

      expect(stderrSpy).toHaveBeenCalled()
      const allText = stderrSpy.mock.calls.map((c) => c[0]).join("")
      expect(allText).toContain("DefaultWriter")
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it("output contains the hatchling name", async () => {
    const { playHatchAnimation } = await import("../../../heart/daemon/hatch-animation")
    const chunks: string[] = []
    const writer = (text: string) => { chunks.push(text) }

    await runWithTimers(() => playHatchAnimation("MyAgent", writer))

    const output = chunks.join("")
    expect(output).toContain("MyAgent")
  })
})
