/**
 * Layer 2 — Unit 6: slow-remote integration test.
 *
 * The headline safety property of the boot sync probe is that it can never
 * hang the boot. A genuinely-hung remote (network black hole, dead DNS)
 * has to be cut by the hard timeout via AbortSignal — even when the
 * underlying child process is happily blocked on a TCP connect that the
 * kernel's keep-alive will not give up on for minutes.
 *
 * This test simulates that scenario: the injected `preTurnPullAsync` mock
 * never resolves on its own — only the AbortSignal fires it. The
 * orchestrator must abort the probe within the configured hard window
 * and still return a clean result.
 */
import { describe, expect, it, vi } from "vitest"
import type { BundleSyncRow } from "../../../heart/daemon/agent-discovery"

const preTurnPullAsyncMock = vi.hoisted(() => vi.fn())
vi.mock("../../../heart/sync", () => ({
  preTurnPullAsync: preTurnPullAsyncMock,
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeRow(agent: string): BundleSyncRow {
  return {
    agent,
    enabled: true,
    remote: "origin",
    gitInitialized: true,
    remoteUrl: `https://example.com/${agent}.git`,
  }
}

describe("runBootSyncProbe — slow remote (hard timeout safety)", () => {
  it("aborts a hung pull within the hard timeout window and does not hang the boot", async () => {
    vi.useFakeTimers()

    let abortReceived = false
    preTurnPullAsyncMock.mockImplementation((_root: string, _config: unknown, opts: { signal?: AbortSignal } | undefined) => {
      // Simulate a hung remote: never resolves until the signal aborts.
      return new Promise((resolve) => {
        opts?.signal?.addEventListener("abort", () => {
          abortReceived = true
          resolve({ ok: false, error: "aborted" })
        })
      })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const HARD_MS = 1500
    const startWallClock = Date.now()
    const promise = runBootSyncProbe(
      [makeRow("alice")],
      { bundlesRoot: "/fake/bundles", softMs: 800, hardMs: HARD_MS },
    )

    // Advance fake time past the hard timeout. The orchestrator's internal
    // setTimeout fires, AbortController aborts, the probe rejects, and the
    // orchestrator records a timeout-hard finding.
    await vi.advanceTimersByTimeAsync(HARD_MS + 200)
    const result = await promise
    const wallClockDelta = Date.now() - startWallClock

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("timeout-hard")
    expect(result.findings[0].advisory).toBe(false)
    expect(abortReceived).toBe(true)
    // Real-world wall-clock guard — fake timers control the in-process
    // clock; if the test took longer than a few seconds, it means the
    // orchestrator was actually hanging on something real (which would be
    // a regression).
    expect(wallClockDelta).toBeLessThan(5000)

    vi.useRealTimers()
  })

  it("aborts each of multiple hung agents independently within hardMs each", async () => {
    vi.useFakeTimers()

    const aborted: string[] = []
    preTurnPullAsyncMock.mockImplementation((root: string, _config: unknown, opts: { signal?: AbortSignal } | undefined) => {
      return new Promise((resolve) => {
        opts?.signal?.addEventListener("abort", () => {
          aborted.push(root)
          resolve({ ok: false, error: "aborted" })
        })
      })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const HARD_MS = 500
    const promise = runBootSyncProbe(
      [makeRow("alice"), makeRow("bob"), makeRow("carol")],
      { bundlesRoot: "/fake/bundles", softMs: 100, hardMs: HARD_MS },
    )

    // Three agents probed sequentially, each with HARD_MS=500. Total worst
    // case is 3 * 500 = 1500ms.
    await vi.advanceTimersByTimeAsync(HARD_MS * 3 + 200)
    const result = await promise

    expect(result.findings).toHaveLength(3)
    for (const finding of result.findings) {
      expect(finding.classification).toBe("timeout-hard")
    }
    expect(aborted).toHaveLength(3)

    vi.useRealTimers()
  })
})
