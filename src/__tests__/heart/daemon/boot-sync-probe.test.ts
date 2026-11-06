/**
 * Layer 2 — Unit 4a: failing tests for `runBootSyncProbe`.
 *
 * The boot sync-probe orchestrator runs `probeSync` over each
 * sync-enabled bundle, wraps it in `runWithTimeouts`, classifies failures,
 * and aggregates findings. It's the integration point between the three
 * Layer-2 primitives (`classifySyncFailure` + `runWithTimeouts` +
 * `probeSync`) and `ouro up`'s pre-flight phase.
 *
 * Tests use mocked `probeSync` so we don't actually run git,
 * mocked timers so we can simulate hangs deterministically, and mocked
 * nerves runtime to keep the test surface clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { BundleSyncRow } from "../../../heart/daemon/agent-discovery"
import { runBootSyncProbe } from "../../../heart/daemon/boot-sync-probe"
import { tryAcquireSyncLockSync } from "../../../heart/sync-lock"

const probeSyncMock = vi.hoisted(() => vi.fn())
vi.mock("../../../heart/sync", () => ({
  probeSync: probeSyncMock,
  NOT_A_REPO_ERROR: "my bundle is not a git repository",
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
    probeSyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns no findings when all bundles probe healthy", async () => {
    probeSyncMock.mockResolvedValue({ ok: true })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice"), row("bob")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(result.findings).toEqual([])
    expect(probeSyncMock).toHaveBeenCalledTimes(2)
    expect(probeSyncMock).toHaveBeenCalledWith(
      fakeAgentRoot("alice"),
      expect.objectContaining({ enabled: true, remote: "origin" }),
      expect.any(AbortSignal),
    )
  })

  it("emits a not-found-404 finding (non-advisory) when remote returns 404", async () => {
    probeSyncMock.mockResolvedValueOnce({ ok: true })
    probeSyncMock.mockResolvedValueOnce({
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
    probeSyncMock.mockResolvedValueOnce({
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
    probeSyncMock.mockImplementation((_root, _config, signal) => {
      abortReceived = signal ?? null
      // Simulate a hung remote — promise never resolves until the signal aborts.
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
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
    probeSyncMock.mockResolvedValue({ ok: true })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe(
      [row("alice", { enabled: false }), row("bob")],
      { bundlesRoot: "/fake/bundles" },
    )
    expect(probeSyncMock).toHaveBeenCalledTimes(1)
    expect(probeSyncMock).toHaveBeenCalledWith(
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
    expect(probeSyncMock).not.toHaveBeenCalled()
    // Sync was supposed to be on, but the bundle isn't a git repo. Surface
    // an advisory finding so the operator sees it without blocking the boot.
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].agent).toBe("alice")
    expect(result.findings[0].classification).toBe("unknown")
    expect(result.findings[0].advisory).toBe(true)
    expect(result.findings[0].error).toBe("my bundle is not a git repository")
  })

  it("emits multiple mixed findings correctly", async () => {
    probeSyncMock.mockImplementation((root: string) => {
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
    probeSyncMock.mockResolvedValue({ ok: false, error: "some weird unmatched error" })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("unknown")
    expect(result.findings[0].advisory).toBe(true)
  })

  it("emits the merge-conflict classification with conflictFiles when a rebase conflict surfaces", async () => {
    probeSyncMock.mockResolvedValue({
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
    probeSyncMock.mockResolvedValue({
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
    probeSyncMock.mockImplementation(() => {
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
    probeSyncMock.mockImplementation(() => {
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
    probeSyncMock.mockImplementation((_root, _config, signal) => {
      const start = Date.now()
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
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
    // Edge case: probeSync returned `{ ok: false }` with no `error`.
    // The orchestrator should fall back to the placeholder error text.
    probeSyncMock.mockResolvedValue({ ok: false })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("alice")], { bundlesRoot: "/fake/bundles" })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].classification).toBe("unknown")
    expect(result.findings[0].error).toMatch(/unknown sync error/)
  })

  it("returns each bundle's status sorted by agent name", async () => {
    probeSyncMock.mockImplementation((root: string) => {
      if (root.includes("zelda")) return Promise.resolve({ ok: true, ahead: 2, behind: 0 })
      if (root.includes("bob")) return Promise.resolve({ ok: true, ahead: 0, behind: 3 })
      return Promise.resolve({ ok: true })
    })
    const { runBootSyncProbe } = await import("../../../heart/daemon/boot-sync-probe")
    const result = await runBootSyncProbe([row("zelda"), row("alice"), row("bob")], { bundlesRoot: "/fake/bundles" })
    expect(result.statuses).toEqual([
      { agent: "bob", text: "0 ahead, 3 behind origin/main" },
      { agent: "zelda", text: "2 ahead, 0 behind origin/main" },
    ])
  })

  it("aggregates findings sorted by agent name for stable rendering", async () => {
    probeSyncMock.mockImplementation((root: string) => {
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

// ── Real git: the probe fetches only ─────────────────────────────────────

describe("runBootSyncProbe against real git", () => {
  const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
  let root: string
  let savedHome: string | undefined
  let savedNoSystem: string | undefined

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
  }

  function write(dir: string, rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content, "utf-8")
  }

  function commitAll(dir: string, message: string): void {
    git(dir, [...OWNER, "add", "-A"])
    git(dir, [...OWNER, "commit", "-q", "-m", message])
  }

  /** Every file under `state/` with its content, so a write of any kind shows. */
  function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (rel: string): void => {
      const full = path.join(dir, rel)
      if (!fs.existsSync(full)) return
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const child = path.join(rel, entry.name)
        if (entry.isDirectory()) walk(child)
        else out[child] = fs.readFileSync(path.join(dir, child), "utf-8")
      }
    }
    walk("state")
    return out
  }

  function setup(options: { emptyRemote?: boolean } = {}): { bundlesRoot: string; agent: string; owner: string; remote: string } {
    const bundlesRoot = path.join(root, "bundles")
    const remote = path.join(root, "remote.git")
    const owner = path.join(root, "owner")
    const agent = path.join(bundlesRoot, "butler.ouro")
    fs.mkdirSync(bundlesRoot, { recursive: true })
    git(root, ["init", "-q", "--bare", "-b", "main", remote])
    if (options.emptyRemote) {
      git(root, ["init", "-q", "-b", "main", agent])
      git(agent, ["remote", "add", "origin", remote])
      write(agent, "notes.md", "local\n")
      commitAll(agent, "local")
      return { bundlesRoot, agent, owner, remote }
    }
    git(root, ["clone", "-q", remote, owner])
    git(owner, ["checkout", "-q", "-b", "main"])
    write(owner, ".gitignore", "state/\n")
    write(owner, "notes.md", "seed\n")
    commitAll(owner, "seed")
    git(owner, [...OWNER, "push", "-q", "-u", "origin", "main"])
    git(bundlesRoot, ["clone", "-q", remote, agent])
    return { bundlesRoot, agent, owner, remote }
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../../../heart/sync")>("../../../heart/sync")
    probeSyncMock.mockImplementation(actual.probeSync)
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "boot-probe-git-")))
    savedHome = process.env.HOME
    savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.HOME = path.join(root, "empty-home")
    fs.mkdirSync(process.env.HOME)
    process.env.GIT_CONFIG_NOSYSTEM = "1"
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("boot probe writes nothing under state/", async () => {
    const { bundlesRoot, agent, owner } = setup()
    // A conflict a pull would record in state/pending-sync.json, plus an
    // expired pause marker a pull would delete.
    write(owner, "notes.md", "owner\n")
    commitAll(owner, "owner edit")
    git(owner, [...OWNER, "push", "-q", "origin", "main"])
    write(agent, "notes.md", "agent\n")
    commitAll(agent, "agent edit")
    write(agent, "state/sync-paused", JSON.stringify({ startedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" }))
    write(agent, "state/sessions/s.json", "{}\n")
    const before = snapshot(agent)
    const head = git(agent, ["rev-parse", "HEAD"])

    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })

    expect(snapshot(agent)).toEqual(before)
    expect(git(agent, ["rev-parse", "HEAD"])).toBe(head)
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(git(agent, ["rev-parse", "refs/remotes/origin/main"])).toBe(git(owner, ["rev-parse", "HEAD"]))
    expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
    expect(result.findings).toEqual([])
    expect(result.statuses).toEqual([{ agent: "butler", text: "1 ahead, 1 behind origin/main" }])
  })

  it("reports a pause from the marker's expiresAt and fetches nothing", async () => {
    const { bundlesRoot, agent, owner } = setup()
    const tracked = git(agent, ["rev-parse", "refs/remotes/origin/main"])
    write(owner, "notes.md", "owner\n")
    commitAll(owner, "owner edit")
    git(owner, [...OWNER, "push", "-q", "origin", "main"])
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    write(agent, "state/sync-paused", JSON.stringify({ startedAt: new Date().toISOString(), expiresAt }))

    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })

    expect(result.statuses).toEqual([{ agent: "butler", text: `sync paused until ${expiresAt}` }])
    expect(git(agent, ["rev-parse", "refs/remotes/origin/main"])).toBe(tracked)
  })

  it("does not wait for a held lock", async () => {
    const { bundlesRoot, agent } = setup()
    const lock = tryAcquireSyncLockSync(agent)
    if ("busy" in lock) throw new Error("lock unexpectedly busy")
    try {
      const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
      expect(result.statuses).toEqual([{ agent: "butler", text: `sync busy: another sync holds the lock (pid ${process.pid})` }])
    } finally {
      lock.release()
    }
  })

  it("reports a busy lock whose holder is unknown", async () => {
    const { bundlesRoot, agent } = setup()
    // A fresh lock that does not parse is busy, holder unknown.
    write(agent, ".git/ouro-sync.lock", "")
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.statuses).toEqual([{ agent: "butler", text: "sync busy: another sync holds the lock" }])
  })

  it("clears a lock this pid left in an earlier life before probing", async () => {
    const { bundlesRoot, agent } = setup()
    write(agent, ".git/ouro-sync.lock", JSON.stringify({ pid: process.pid, token: "earlier-life", procStart: null }))
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.statuses).toEqual([{ agent: "butler", text: "0 ahead, 0 behind origin/main" }])
  })

  it("survives an unreadable lock file", async () => {
    const { bundlesRoot, agent } = setup()
    const lockPath = path.join(agent, ".git", "ouro-sync.lock")
    write(agent, ".git/ouro-sync.lock", "{}")
    fs.chmodSync(lockPath, 0o000)
    try {
      const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0].error).toMatch(/EACCES/)
    } finally {
      fs.chmodSync(lockPath, 0o600)
    }
  })

  it("says nothing about a bundle without a remote", async () => {
    const { bundlesRoot, agent } = setup()
    git(agent, ["remote", "remove", "origin"])
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.findings).toEqual([])
    expect(result.statuses).toEqual([])
  })

  it("counts against an empty remote", async () => {
    const empty = setup({ emptyRemote: true })
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot: empty.bundlesRoot })
    expect(result.statuses).toEqual([{ agent: "butler", text: "1 ahead, 0 behind origin/main" }])

  })

  it("counts commits behind on an unborn HEAD", async () => {
    const { bundlesRoot, agent, remote } = setup()
    fs.rmSync(agent, { recursive: true, force: true })
    git(root, ["init", "-q", "-b", "main", agent])
    git(agent, ["remote", "add", "origin", remote])
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.statuses).toEqual([{ agent: "butler", text: "0 ahead, 1 behind origin/main" }])
  })

  it("turns a fetch failure into a finding", async () => {
    const { bundlesRoot, agent } = setup()
    git(agent, ["remote", "set-url", "origin", path.join(root, "missing.git")])
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].error).toMatch(/git fetch failed/)
    expect(result.statuses).toEqual([])
  })

  it("turns a broken repo into a finding", async () => {
    const { bundlesRoot, agent } = setup()
    fs.writeFileSync(path.join(agent, ".git", "config"), "[[[ not a config\n")
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].error).toMatch(/git remote failed/)
  })

  it("reports the bundle is not a git repository when .git is gone", async () => {
    const { bundlesRoot, agent } = setup()
    fs.rmSync(path.join(agent, ".git"), { recursive: true, force: true })
    const result = await runBootSyncProbe([row("butler")], { bundlesRoot })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].error).toBe("my bundle is not a git repository")
  })
})
