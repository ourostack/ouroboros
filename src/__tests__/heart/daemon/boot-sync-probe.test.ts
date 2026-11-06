/**
 * Layer 2 — Unit 4a: failing tests for `runBootSyncProbe`.
 *
 * The boot sync-probe orchestrator runs `preTurnPullAsync` over each
 * sync-enabled bundle, wraps it in `runWithTimeouts`, classifies failures,
 * and aggregates findings. It's the integration point between the three
 * Layer-2 primitives (`classifySyncFailure` + `runWithTimeouts` +
 * `preTurnPullAsync`) and `ouro up`'s pre-flight phase.
 *
 * Tests use mocked `preTurnPullAsync` so we don't actually run git,
 * mocked timers so we can simulate hangs deterministically, and mocked
 * nerves runtime to keep the test surface clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BundleSyncRow } from "../../../heart/daemon/agent-discovery"

const preTurnPullAsyncMock = vi.hoisted(() => vi.fn())
vi.mock("../../../heart/sync", () => ({
  preTurnPullAsync: preTurnPullAsyncMock,
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const fakeAgentRoot = (agent: string): string => `/fake/bundles/${agent}.ouro`

function row(agent: string, overrides: Partial<BundleSyncRow> = {}): BundleSyncRow {
  return {
    agent,
    enabled: true,
    remote: "origin",
    gitInitialized: true,
    remoteUrl: `https://example.com/${agent}.git`,
    ...overrides,
  }
}

describe("runBootSyncProbe", () => {
  beforeEach(() => {
    preTurnPullAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns no findings when all bundles probe healthy", async () => {
    preTurnPullAsyncMock.mockResolvedValue({ ok: true })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice"), row("bob")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(result.findings).toEqual([])
    expect(preTurnPullAsyncMock).toHaveBeenCalledTimes(2)
    expect(preTurnPullAsyncMock).toHaveBeenCalledWith(
      fakeAgentRoot("alice"),
      expect.objectContaining({ enabled: true, remote: "origin" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("emits a not-found-404 finding (non-advisory) when remote returns 404", async () => {
    preTurnPullAsyncMock.mockResolvedValueOnce({ ok: true })
    preTurnPullAsyncMock.mockResolvedValueOnce({
      ok: false,
      error: "fatal: ... 404 ... not found",
    })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice"), row("bob")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].agent).toBe("bob")
    expect(result.findings[0].classification).toBe("not-found-404")
    expect(result.findings[0].advisory).toBe(false)
  })

  it("emits a dirty-working-tree finding (advisory) when local has uncommitted changes", async () => {
    preTurnPullAsyncMock.mockResolvedValueOnce({
      ok: false,
      error: "error: Your local changes to the following files would be overwritten by merge:\n\tagent.json",
    })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("dirty-working-tree")
    expect(result.findings[0].advisory).toBe(true)
  })

  it("emits a timeout-hard finding (non-advisory) when probe exceeds the hard timeout", async () => {
    vi.useFakeTimers()
    let abortReceived: AbortSignal | null = null
    preTurnPullAsyncMock.mockImplementation((_root, _config, opts) => {
      abortReceived = opts?.signal ?? null
      // Simulate a hung remote — promise never resolves until the signal aborts.
      return new Promise((resolve) => {
        opts?.signal?.addEventListener("abort", () => {
          resolve({ ok: false, error: "aborted" })
        })
      })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const promise = runBootSyncProbe(
      [row("alice")],
      { bundlesRoot: "/fake/bundles", softMs: 100, hardMs: 500 },
    )
    await vi.advanceTimersByTimeAsync(700)
    const result = await promise

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("timeout-hard")
    expect(result.findings[0].advisory).toBe(false)
    expect(abortReceived).not.toBeNull()
    expect(abortReceived!.aborted).toBe(true)
    // Daemon does NOT hang: total elapsed simulated time was 700ms (well under
    // the 15s real-world hard cap).
    expect(result.durationMs).toBeLessThan(2000)
  })

  it("does NOT probe bundles where sync is disabled", async () => {
    preTurnPullAsyncMock.mockResolvedValue({ ok: true })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice", { enabled: false }), row("bob")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(preTurnPullAsyncMock).toHaveBeenCalledTimes(1)
    expect(preTurnPullAsyncMock).toHaveBeenCalledWith(
      fakeAgentRoot("bob"),
      expect.any(Object),
      expect.any(Object),
    )
    expect(result.findings).toEqual([])
  })

  it("does NOT probe bundles where gitInitialized is false (emits an advisory finding)", async () => {
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice", { gitInitialized: false })],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(preTurnPullAsyncMock).not.toHaveBeenCalled()
    // Sync was supposed to be on, but the bundle isn't a git repo. Surface
    // an advisory finding so the operator sees it without blocking the boot.
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].agent).toBe("alice")
    expect(result.findings[0].classification).toBe("unknown")
    expect(result.findings[0].advisory).toBe(true)
    expect(result.findings[0].error).toMatch(/not a git repo|git init/i)
  })

  it("emits multiple mixed findings correctly", async () => {
    preTurnPullAsyncMock.mockImplementation((root: string) => {
      if (root.includes("alice")) return Promise.resolve({ ok: true })
      if (root.includes("bob")) return Promise.resolve({ ok: false, error: "Authentication failed" })
      if (root.includes("carol")) return Promise.resolve({
        ok: false,
        error: "error: Your local changes to the following files would be overwritten by merge",
      })
      return Promise.resolve({ ok: true })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice"), row("bob"), row("carol")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(result.findings).toHaveLength(2)

    const bobFinding = result.findings.find((f) => f.agent === "bob")
    const carolFinding = result.findings.find((f) => f.agent === "carol")
    expect(bobFinding?.classification).toBe("auth-failed")
    expect(bobFinding?.advisory).toBe(false)
    expect(carolFinding?.classification).toBe("dirty-working-tree")
    expect(carolFinding?.advisory).toBe(true)
  })

  it("emits an unknown finding when the error doesn't match any pattern", async () => {
    preTurnPullAsyncMock.mockResolvedValue({ ok: false, error: "some weird unmatched error" })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("unknown")
    expect(result.findings[0].advisory).toBe(true)
  })

  it("emits the merge-conflict classification with conflictFiles when a rebase conflict surfaces", async () => {
    preTurnPullAsyncMock.mockResolvedValue({
      ok: false,
      error: "CONFLICT (content): Merge conflict in agent.json",
    })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("merge-conflict")
    expect(result.findings[0].advisory).toBe(true)
    // conflictFiles is populated by the classifier (best-effort via `git status`).
    expect(result.findings[0].conflictFiles).toBeDefined()
  })

  it("emits a network-down finding (non-advisory) for ENOTFOUND-style errors", async () => {
    preTurnPullAsyncMock.mockResolvedValue({
      ok: false,
      error: "fatal: unable to access ...: Could not resolve host: nope.invalid",
    })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("network-down")
    expect(result.findings[0].advisory).toBe(false)
  })

  it("preserves warnings from soft-timeout in the finding when probe completes between soft and hard", async () => {
    vi.useFakeTimers()
    preTurnPullAsyncMock.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true }), 200)
      })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const promise = runBootSyncProbe(
      [row("alice")],
      { bundlesRoot: "/fake/bundles", softMs: 100, hardMs: 500 },
    )
    await vi.advanceTimersByTimeAsync(250)
    const result = await promise

    // No failure, but a soft-warning is recorded as an advisory finding so
    // the operator sees that the probe was slow even when it eventually
    // succeeded.
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("timeout-soft")
    expect(result.findings[0].advisory).toBe(true)
    expect(result.findings[0].warnings.length).toBeGreaterThanOrEqual(1)
  })

  it("returns durationMs reflecting how long the orchestrator ran", async () => {
    vi.useFakeTimers()
    preTurnPullAsyncMock.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true }), 50)
      })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const promise = runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("uses default timeouts (8s soft, 15s hard) when not overridden", async () => {
    vi.useFakeTimers()
    let abortFiredAt = -1
    preTurnPullAsyncMock.mockImplementation((_root, _config, opts) => {
      const start = Date.now()
      return new Promise((resolve) => {
        opts?.signal?.addEventListener("abort", () => {
          abortFiredAt = Date.now() - start
          resolve({ ok: false, error: "aborted" })
        })
      })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const promise = runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    // Advance well past 15s default hard timeout.
    await vi.advanceTimersByTimeAsync(20000)
    await promise
    // Hard abort should have fired around 15s.
    expect(abortFiredAt).toBeGreaterThan(14000)
    expect(abortFiredAt).toBeLessThan(16000)
  })

  it("emits an unknown finding when the probe result has ok=false but no error string", async () => {
    // Edge case: preTurnPullAsync returned `{ ok: false }` with no `error`.
    // The orchestrator should fall back to the placeholder error text.
    preTurnPullAsyncMock.mockResolvedValue({ ok: false })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("unknown")
    expect(result.findings[0].error).toMatch(/unknown sync error/)
  })

  it("aggregates findings sorted by agent name for stable rendering", async () => {
    preTurnPullAsyncMock.mockImplementation((root: string) => {
      if (root.includes("zelda")) return Promise.resolve({ ok: false, error: "404 not found" })
      if (root.includes("bob")) return Promise.resolve({ ok: false, error: "Authentication failed" })
      return Promise.resolve({ ok: true })
    })

    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("zelda"), row("alice"), row("bob")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(result.findings.map((f) => f.agent)).toEqual(["bob", "zelda"])
  })
})
