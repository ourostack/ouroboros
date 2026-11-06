/**
 * Layer 2 — Unit 3a: failing tests for `preTurnPullAsync` (signal-aware).
 *
 * The async sibling of `preTurnPull` is the one wired into `runBootSyncProbe`.
 * It accepts an optional `AbortSignal` and propagates it to the underlying
 * `child_process` invocations so a hung fetch can be killed by the boot
 * timeout wrapper.
 *
 * The existing sync `preTurnPull` is preserved unchanged (back-compat for the
 * per-turn pipeline), so all 26 of its tests in `sync.test.ts` still pass.
 *
 * Tests use vi-mocked child_process with an async `execFile` shim that
 * resolves/rejects based on the passed signal — same idiom that real
 * Node uses, but deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SyncConfig } from "../../heart/config"

// Mock child_process: provide both sync execFileSync (for the legacy
// callers within sync.ts that aren't relevant here) and an async execFile
// that the new preTurnPullAsync uses.
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}))

// Intentionally NOT mocking ../../nerves/runtime so the global capture
// sees the events we emit (e.g., heart.sync_pull_aborted from the
// already-aborted-signal path). Mocking the runtime would make the
// nerves source-coverage gate flag the events as declared-but-not-observed.

const existsSyncMock = vi.hoisted(() => vi.fn())
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  existsSyncMock.mockImplementation((target: string) => {
    if (typeof target === "string" && target.endsWith("/.git")) return true
    return actual.existsSync(target)
  })
  return { ...actual, existsSync: existsSyncMock }
})

import * as childProcess from "child_process"

const defaultConfig: SyncConfig = { enabled: true, remote: "origin" }

describe("preTurnPullAsync (signal-aware)", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(childProcess.execFile).mockReset()
    // Default sync remote-check returns "origin"
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from("origin\n"))
    // Default async execFile callback resolves with "" stdout
    vi.mocked(childProcess.execFile).mockImplementation(((..._args: unknown[]) => {
      const callback = _args[_args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      // Defer resolve to next tick so we can interleave with abort.
      queueMicrotask(() => callback(null, "", ""))
      return {} as unknown
    }) as typeof childProcess.execFile)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("without signal — runs git pull and returns ok=true (back-compat shape)", async () => {
    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(true)
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["pull", "origin"],
      expect.objectContaining({ cwd: "/fake/agent/root" }),
      expect.any(Function),
    )
  })

  it("when signal is already aborted at call time, skips the pull and returns ok=false", async () => {
    const { preTurnPullAsync } = await import("../../heart/sync")
    const ac = new AbortController()
    ac.abort()
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig, { signal: ac.signal })
    expect(result.ok).toBe(false)
    // The pull should NOT have been invoked because the signal was already aborted.
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it("when signal aborts mid-fetch, the child process receives AbortSignal", async () => {
    // Simulate a slow fetch that we then abort.
    let abortHandler: (() => void) | null = null
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const opts = args[2] as { signal?: AbortSignal }
      const callback = args[args.length - 1] as (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
      // Hold the callback until aborted, then reject with an AbortError.
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          const err = Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })
          callback(err, "", "")
        })
        abortHandler = () => { /* signal listener handles it */ }
      }
      return {} as unknown
    }) as typeof childProcess.execFile)

    const { preTurnPullAsync } = await import("../../heart/sync")
    const ac = new AbortController()
    const promise = preTurnPullAsync("/fake/agent/root", defaultConfig, { signal: ac.signal })
    // Trigger the abort
    ac.abort()
    const result = await promise
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/abort/i)
    expect(abortHandler).not.toBeNull()
    // Verify the signal was actually passed to the child.
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["pull", "origin"],
      expect.objectContaining({ signal: ac.signal }),
      expect.any(Function),
    )
  })

  it("returns ok=false with error message when execFile rejects with a non-abort error", async () => {
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
      queueMicrotask(() => callback(new Error("fatal: 404 not found"), "", ""))
      return {} as unknown
    }) as typeof childProcess.execFile)

    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("404")
  })

  it("skips the pull entirely when bundle is not a git repo", async () => {
    existsSyncMock.mockImplementationOnce(() => false)
    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a git repo")
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it("skips the pull when no remote is configured (local-only mode)", async () => {
    // First call (sync remote check) returns empty.
    vi.mocked(childProcess.execFileSync).mockReturnValueOnce(Buffer.from(""))
    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(true)
    expect(childProcess.execFile).not.toHaveBeenCalled()
  })

  it("uses configured remote name in argv", async () => {
    const { preTurnPullAsync } = await import("../../heart/sync")
    const config: SyncConfig = { enabled: true, remote: "upstream" }
    await preTurnPullAsync("/fake/agent/root", config)
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["pull", "upstream"],
      expect.any(Object),
      expect.any(Function),
    )
  })

  it("returns ok=false when the remote check itself throws (async path)", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("fatal: not a git repository")
    })
    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a git repository")
  })

  it("returns ok=false with stringified error when the remote check throws a non-Error value", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      // Throw a plain string — exercises the `err instanceof Error ? ... : String(err)` branch.
      throw "raw-string-error"
    })
    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("raw-string-error")
  })

  it("returns ok=false with stringified error when execFile callback returns a non-Error", async () => {
    vi.mocked(childProcess.execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: unknown, stdout: string, stderr: string) => void
      // Pass a non-Error truthy value as err — exercises the `err instanceof Error ? ... : String(err)` branch.
      queueMicrotask(() => callback("plain string failure", "", ""))
      return {} as unknown
    }) as typeof childProcess.execFile)

    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("plain string failure")
  })

  it("propagates an injected signal to the child even when the signal never aborts", async () => {
    const ac = new AbortController()
    const { preTurnPullAsync } = await import("../../heart/sync")
    const result = await preTurnPullAsync("/fake/agent/root", defaultConfig, { signal: ac.signal })
    expect(result.ok).toBe(true)
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["pull", "origin"],
      expect.objectContaining({ signal: ac.signal }),
      expect.any(Function),
    )
  })
})
