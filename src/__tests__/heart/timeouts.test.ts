/**
 * Layer 2 — Unit 2a: failing tests for `runWithTimeouts`.
 *
 * `runWithTimeouts` is the soft/hard timeout pattern wrapper used by the
 * boot sync probe. Soft = "log a warning, keep going". Hard = "abort the
 * underlying op via AbortSignal".
 *
 * Tests use vi.useFakeTimers + manual promise control so they don't actually
 * wait for wall-clock time. The implementation lands in Unit 2b at
 * `src/heart/timeouts.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

describe("runWithTimeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    delete process.env["OURO_BOOT_TIMEOUT_GIT_SOFT"]
    delete process.env["OURO_BOOT_TIMEOUT_GIT_HARD"]
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env["OURO_BOOT_TIMEOUT_GIT_SOFT"]
    delete process.env["OURO_BOOT_TIMEOUT_GIT_HARD"]
  })

  it("returns result when op completes before soft timeout — no classification, no warnings", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")
    const promise = runWithTimeouts(
      async () => "completed-fast",
      { softMs: 8000, hardMs: 15000, label: "git-pull" },
    )
    await vi.runAllTimersAsync()
    const outcome = await promise
    expect(outcome.result).toBe("completed-fast")
    expect(outcome.classification).toBeUndefined()
    expect(outcome.warnings).toEqual([])
  })

  it("emits a warning when op completes between soft and hard timeouts", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")

    let resolveOp: ((value: string) => void) | null = null
    const opPromise = new Promise<string>((resolve) => {
      resolveOp = resolve
    })

    const promise = runWithTimeouts(
      () => opPromise,
      { softMs: 100, hardMs: 1000, label: "git-pull" },
    )

    // Cross the soft timeout
    await vi.advanceTimersByTimeAsync(150)
    // Resolve before hard timeout
    resolveOp!("slow-but-ok")
    await vi.advanceTimersByTimeAsync(0)

    const outcome = await promise
    expect(outcome.result).toBe("slow-but-ok")
    expect(outcome.classification).toBeUndefined()
    expect(outcome.warnings.length).toBe(1)
    expect(outcome.warnings[0]).toContain("git-pull")
    expect(outcome.warnings[0]).toMatch(/soft|exceed|warn/i)
  })

  it("aborts and returns classification timeout-hard when op exceeds hard timeout", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")

    let receivedSignal: AbortSignal | null = null
    const promise = runWithTimeouts(
      (signal) => {
        receivedSignal = signal
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted")
            ;(err as { name?: string }).name = "AbortError"
            reject(err)
          })
        })
      },
      { softMs: 100, hardMs: 1000, label: "git-fetch" },
    )

    // Push past hard timeout
    await vi.advanceTimersByTimeAsync(1500)

    const outcome = await promise
    expect(outcome.result).toBeUndefined()
    expect(outcome.classification).toBe("timeout-hard")
    expect(receivedSignal).not.toBeNull()
    expect(receivedSignal!.aborted).toBe(true)
    // Soft warning must also have fired before hard
    expect(outcome.warnings.length).toBeGreaterThanOrEqual(1)
  })

  it("provides the AbortSignal to the op so it can detect abort", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")
    let signalSeen = false
    const promise = runWithTimeouts(
      async (signal) => {
        signalSeen = signal instanceof AbortSignal
        return "ok"
      },
      { softMs: 8000, hardMs: 15000, label: "live-check" },
    )
    await vi.runAllTimersAsync()
    await promise
    expect(signalSeen).toBe(true)
  })

  it("honours OURO_BOOT_TIMEOUT_GIT_SOFT env override (smaller value trips soft sooner)", async () => {
    process.env["OURO_BOOT_TIMEOUT_GIT_SOFT"] = "5"
    const { runWithTimeouts } = await import("../../heart/timeouts")

    let resolveOp: ((value: string) => void) | null = null
    const opPromise = new Promise<string>((resolve) => {
      resolveOp = resolve
    })

    const promise = runWithTimeouts(
      () => opPromise,
      { softMs: 8000, hardMs: 15000, label: "git-pull", envKey: "GIT" },
    )

    // 10ms passes — that's past the override 5ms but well under the original 8000ms default.
    await vi.advanceTimersByTimeAsync(10)
    resolveOp!("ok")
    await vi.advanceTimersByTimeAsync(0)

    const outcome = await promise
    expect(outcome.warnings.length).toBe(1)
    expect(outcome.classification).toBeUndefined()
  })

  it("honours OURO_BOOT_TIMEOUT_GIT_HARD env override (smaller value forces hard abort sooner)", async () => {
    process.env["OURO_BOOT_TIMEOUT_GIT_HARD"] = "20"
    const { runWithTimeouts } = await import("../../heart/timeouts")

    const promise = runWithTimeouts(
      (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted")
          ;(err as { name?: string }).name = "AbortError"
          reject(err)
        })
      }),
      { softMs: 8000, hardMs: 15000, label: "git-pull", envKey: "GIT" },
    )

    await vi.advanceTimersByTimeAsync(50)
    const outcome = await promise
    expect(outcome.classification).toBe("timeout-hard")
  })

  it("preserves a non-abort error thrown by the op (rethrows wrapped, classification undefined)", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")
    // Attach the rejection handler before any async tick so vitest doesn't
    // see an unhandled rejection.
    const promise = runWithTimeouts(
      async () => {
        throw new Error("404 not found")
      },
      { softMs: 8000, hardMs: 15000, label: "git-pull" },
    )
    await expect(promise).rejects.toThrow(/404/)
    // Drain timers afterwards so the test ends cleanly.
    await vi.advanceTimersByTimeAsync(20000)
  })

  it("does NOT trip soft warning when op completes very fast", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")
    const promise = runWithTimeouts(
      async () => "instant",
      { softMs: 100, hardMs: 1000, label: "git-pull" },
    )
    await vi.advanceTimersByTimeAsync(0)
    const outcome = await promise
    expect(outcome.warnings).toEqual([])
  })

  it("clears timers after op completes (no further warnings/aborts after resolve)", async () => {
    const { runWithTimeouts } = await import("../../heart/timeouts")
    let resolveOp: ((value: string) => void) | null = null
    const opPromise = new Promise<string>((resolve) => {
      resolveOp = resolve
    })

    const promise = runWithTimeouts(
      () => opPromise,
      { softMs: 100, hardMs: 1000, label: "git-pull" },
    )

    // Resolve at 50ms — well before soft.
    await vi.advanceTimersByTimeAsync(50)
    resolveOp!("done")
    await vi.advanceTimersByTimeAsync(0)
    const outcome = await promise

    // Advance past hard — there should be no abort, no warning.
    await vi.advanceTimersByTimeAsync(2000)
    expect(outcome.warnings).toEqual([])
    expect(outcome.classification).toBeUndefined()
  })

  it("ignores invalid env override values (non-numeric)", async () => {
    process.env["OURO_BOOT_TIMEOUT_GIT_SOFT"] = "not-a-number"
    process.env["OURO_BOOT_TIMEOUT_GIT_HARD"] = "garbage"
    const { runWithTimeouts } = await import("../../heart/timeouts")

    const promise = runWithTimeouts(
      async () => "ok",
      { softMs: 100, hardMs: 1000, label: "git-pull", envKey: "GIT" },
    )
    await vi.advanceTimersByTimeAsync(50)
    const outcome = await promise
    expect(outcome.result).toBe("ok")
    expect(outcome.classification).toBeUndefined()
    expect(outcome.warnings).toEqual([])
  })

  it("works without an envKey (no env override consultation)", async () => {
    process.env["OURO_BOOT_TIMEOUT_GIT_SOFT"] = "1"
    const { runWithTimeouts } = await import("../../heart/timeouts")
    // No envKey supplied — env is ignored.
    const promise = runWithTimeouts(
      async () => "ok",
      { softMs: 100, hardMs: 1000, label: "anonymous" },
    )
    await vi.advanceTimersByTimeAsync(50)
    const outcome = await promise
    expect(outcome.result).toBe("ok")
    // No env consulted, so no soft trip even though OURO_BOOT_TIMEOUT_GIT_SOFT=1.
    expect(outcome.warnings).toEqual([])
  })
})
