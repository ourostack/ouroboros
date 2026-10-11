import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SyncConfig } from "../../heart/config"

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

// The sync module checks `.git` presence before touching git at all. We wrap
// fs with a partial mock so that existsSync claims `.git` paths exist by
// default (letting the mocked git commands take over for the fake agent root
// used in most tests) and delegates to real fs for everything else (so tmpDir
// tests that write pending-sync.json still work). Individual tests override
// via `existsSyncMock.mockImplementationOnce` to exercise the not-a-repo path.
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
import { emitNervesEvent } from "../../nerves/runtime"

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const defaultConfig: SyncConfig = { enabled: true, remote: "origin" }

describe("preTurnPull", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
    // Default: git remote returns a configured remote, so pull proceeds.
    // Tests that need different behavior (errors, no remote) override this.
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from("origin\n"))
  })

  it("runs git pull with argv array when sync is enabled", async () => {
    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "git",
      ["pull", "origin"],
      expect.objectContaining({ cwd: "/fake/agent/root" }),
    )
  })

  it("returns an actionable error when the bundle is not a git repo", async () => {
    // Override the default spy: pretend .git does NOT exist for this bundle.
    existsSyncMock.mockImplementationOnce(() => false)

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a git repo")
    expect(result.error).toContain("git init")
    expect(result.error).toContain("/fake/agent/root")
    // No git invocations should have happened
    expect(childProcess.execFileSync).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "heart",
        event: "heart.sync_not_a_repo",
        message: "pre-turn pull failed: bundle is not a git repo",
      }),
    )
  })

  it("skips pull when no remote is configured (local-only mode)", async () => {
    const calls: Array<string[]> = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      calls.push(args as string[])
      const argv = args as string[]
      if (argv[0] === "remote") return Buffer.from("") // no remotes
      throw new Error(`unexpected git invocation: ${argv.join(" ")}`)
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(calls).toEqual([["remote"]]) // only the check, no pull
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "heart",
        event: "heart.sync_pull_end",
        message: "pre-turn pull skipped: no remote configured",
      }),
    )
  })

  it("returns error when the git remote check itself fails", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("fatal: not a git repository")
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a git repository")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "heart.sync_pull_error",
        message: "pre-turn pull failed: git remote check failed",
      }),
    )
  })

  it("returns error on pull failure (remote check passes, pull throws)", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "remote") return Buffer.from("origin\n")
      throw new Error("fatal: Could not read from remote repository")
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("fatal: Could not read from remote repository")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "heart.sync_pull_error",
        message: "pre-turn pull failed",
      }),
    )
  })

  it("returns ok true on success", async () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from("Already up to date.\n"))

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("uses configured remote name in argv array", async () => {
    const config: SyncConfig = { enabled: true, remote: "upstream" }

    const { preTurnPull } = await import("../../heart/sync")
    preTurnPull("/fake/agent/root", config)

    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "git",
      ["pull", "upstream"],
      expect.objectContaining({ cwd: "/fake/agent/root" }),
    )
  })

  it("emits nerves events", async () => {
    const { preTurnPull } = await import("../../heart/sync")
    preTurnPull("/fake/agent/root", defaultConfig)

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "heart",
        event: "heart.sync_pull_start",
      }),
    )
  })

  it("handles non-Error throw from the remote check", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw "string error" // eslint-disable-line no-throw-literal
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("string error")
  })

  it("handles non-Error throw from the pull itself", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "remote") return Buffer.from("origin\n")
      throw "pull-string-error" // eslint-disable-line no-throw-literal
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("pull-string-error")
  })
})

describe("postTurnPush", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  it("returns an actionable error when the bundle is not a git repo", async () => {
    existsSyncMock.mockImplementationOnce(() => false)

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a git repo")
    expect(result.error).toContain("git init")
    expect(result.error).toContain("/fake/agent/root")
    // No git invocations should have happened
    expect(childProcess.execFileSync).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "heart",
        event: "heart.sync_not_a_repo",
        message: "post-turn push failed: bundle is not a git repo",
      }),
    )
  })

  /** Helper: mock execFileSync to route by git subcommand */
  function mockGitCommands(handlers: Record<string, () => Buffer | string>) {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const subcmd = (args as string[])?.[0]
      const handler = handlers[subcmd ?? ""]
      if (handler) return Buffer.from(String(handler()))
      return Buffer.from("")
    })
  }

  it("discovers dirty files via git status --porcelain", async () => {
    const calls: string[][] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      calls.push(argv)
      if (argv[0] === "status") return Buffer.from(" M arc/episodes/ep-1.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(calls[0]).toEqual(["status", "--porcelain"])
  })

  it("runs git add -A, commit, and push for dirty files", async () => {
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0])
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(commands).toContain("status")
    expect(commands).toContain("add")
    expect(commands).toContain("commit")
    expect(commands).toContain("remote")
    expect(commands).toContain("push")
  })

  it("returns early with success when no dirty files", async () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from(""))

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    // git status, then the remote check of the clean-tree path; nothing is committed
    expect(vi.mocked(childProcess.execFileSync).mock.calls.map((call) => (call[1] as string[])[0])).toEqual(["status", "remote"])
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "heart.sync_push_end",
        message: "post-turn push: no changes to sync",
      }),
    )
  })

  it("commits but skips push when no remote configured", async () => {
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0])
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("") // no remote
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(commands).toContain("add")
    expect(commands).toContain("commit")
    expect(commands).toContain("remote")
    expect(commands).not.toContain("push")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "heart.sync_push_end",
        message: "post-turn push: committed locally, no remote configured",
      }),
    )
  })

  it("retries with pull-rebase-push on push rejection", async () => {
    let pushCount = 0
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "push") {
        pushCount++
        if (pushCount === 1) throw new Error("rejected")
        return Buffer.from("")
      }
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(pushCount).toBe(2)
  })

  it("writes pending-sync with classification: push_rejected when the second push fails after a successful rebase", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-push-rejected-"))
    let pushCount = 0
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "push") {
        pushCount++
        throw new Error("rejected again")
      }
      if (argv[0] === "pull") return Buffer.from("")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    expect(pushCount).toBe(2) // first push + second push (both failed)
    const pendingPath = path.join(tmpDir, "state", "pending-sync.json")
    expect(fs.existsSync(pendingPath)).toBe(true)
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"))
    expect(pending.classification).toBe("push_rejected")
    expect(pending.conflictFiles).toEqual([])
    expect(pending.error).toContain("rejected again")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes pending-sync with classification: pull_rebase_conflict when rebase surfaces merge conflicts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-rebase-conflict-"))
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status" && argv[1] === "--porcelain" && argv.length === 2) {
        return Buffer.from(" M file.json\n")
      }
      if (argv[0] === "status" && argv[1] === "--porcelain=v1") {
        // Simulate unmerged files after rebase conflict
        return Buffer.from("UU desk/_record/notes/entry.md\nUU friends/ari.json\n")
      }
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "push") throw new Error("push rejected")
      if (argv[0] === "pull") throw new Error("rebase conflict")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    const pendingPath = path.join(tmpDir, "state", "pending-sync.json")
    expect(fs.existsSync(pendingPath)).toBe(true)
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"))
    expect(pending.classification).toBe("pull_rebase_conflict")
    expect(pending.conflictFiles).toEqual(["desk/_record/notes/entry.md", "friends/ari.json"])

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes pending-sync.json on second push failure", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-push-fail-"))
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "push") throw new Error("push failed")
      if (argv[0] === "pull") throw new Error("rebase failed")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    const pendingPath = path.join(tmpDir, "state", "pending-sync.json")
    expect(fs.existsSync(pendingPath)).toBe(true)
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"))
    expect(pending.error).toContain("rebase failed")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns error when git status itself fails", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("fatal: not a git repository")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("fatal: not a git repository")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "heart.sync_push_error",
        message: "post-turn push: git status failed",
      }),
    )
  })

  it("returns error when git status throws non-Error", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw "git status string error" // eslint-disable-line no-throw-literal
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("git status string error")
  })

  it("emits start event", async () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from(""))

    const { postTurnPush } = await import("../../heart/sync")
    postTurnPush("/fake/agent/root", defaultConfig)

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "heart",
        event: "heart.sync_push_start",
      }),
    )
  })

  it("handles git add failure gracefully", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add") throw new Error("add failed")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("add failed")
  })

  it("handles non-Error throw in outer catch", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add") throw "string error" // eslint-disable-line no-throw-literal
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("string error")
  })

  it("handles non-Error throw in retry catch", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "push") throw new Error("push rejected")
      if (argv[0] === "pull") throw "rebase string error" // eslint-disable-line no-throw-literal
      return Buffer.from("")
    })

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-push-nonerr-"))
    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("rebase string error")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("counts changed files from porcelain output", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file1.json\n M file2.json\n?? new.txt\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    postTurnPush("/fake/agent/root", defaultConfig)

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "heart.sync_push_end",
        message: "post-turn push complete",
        meta: expect.objectContaining({ changedCount: 3 }),
      }),
    )
  })
})

describe("postTurnPush stale index.lock recovery", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  function makeBundleWithLock(ageMs: number, content = ""): { tmpDir: string; lockPath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-index-lock-"))
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true })
    const lockPath = path.join(tmpDir, ".git", "index.lock")
    fs.writeFileSync(lockPath, content, "utf-8")
    const stamp = new Date(Date.now() - ageMs)
    fs.utimesSync(lockPath, stamp, stamp)
    return { tmpDir, lockPath }
  }

  it("removes an index.lock left behind by a dead git process and commits", async () => {
    const { tmpDir, lockPath } = makeBundleWithLock(60 * 60 * 1000)
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add" && fs.existsSync(lockPath)) throw new Error("fatal: Unable to create 'index.lock': File exists.")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "heart",
        event: "heart.sync_stale_lock_cleared",
        meta: expect.objectContaining({ agentRoot: tmpDir }),
      }),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("keeps an old index.lock that has content, since a live commit may hold it", async () => {
    const { tmpDir, lockPath } = makeBundleWithLock(60 * 60 * 1000, "DIRC")
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add") throw new Error("fatal: Unable to create 'index.lock': File exists.")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reports, rather than throws, when a stale index.lock cannot be removed", async () => {
    const { tmpDir, lockPath } = makeBundleWithLock(60 * 60 * 1000)
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted")
    })
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add") throw new Error("fatal: Unable to create 'index.lock': File exists.")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)
    rmSpy.mockRestore()

    expect(result.ok).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "heart.sync_stale_lock_clear_failed" }),
    )
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("still returns the commit failure when pending-sync cannot be written", async () => {
    const { tmpDir } = makeBundleWithLock(5 * 1000)
    fs.writeFileSync(path.join(tmpDir, "state"), "not a directory", "utf-8")
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add") throw new Error("fatal: Unable to create 'index.lock': File exists.")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("index.lock")
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("leaves a fresh index.lock alone and records the failure as pending sync", async () => {
    const { tmpDir, lockPath } = makeBundleWithLock(5 * 1000)
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "add") throw new Error("fatal: Unable to create 'index.lock': File exists.")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    const pending = JSON.parse(fs.readFileSync(path.join(tmpDir, "state", "pending-sync.json"), "utf-8"))
    expect(pending.classification).toBe("unknown")
    expect(pending.error).toContain("index.lock")
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("postTurnPush size guard and persistent failure record", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  function makeBundle(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "sync-size-guard-"))
  }

  function sparseFile(root: string, relativePath: string, bytes: number): void {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "")
    fs.truncateSync(filePath, bytes)
  }

  it("unstages files over the size limit, records them and commits the rest", async () => {
    const { postTurnPush, SYNC_FILE_SIZE_LIMIT_BYTES } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    sparseFile(tmpDir, "arc/huge.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    sparseFile(tmpDir, "arc/small.json", 10)
    const calls: string[][] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      calls.push(argv)
      if (argv[0] === "status") return Buffer.from("?? arc/\n")
      if (argv[0] === "diff" && argv.includes("--name-status")) return Buffer.from("A\0arc/huge.jsonl\0A\0arc/small.json\0A\0arc/gone.json\0D\0arc/old.json\0")
      if (argv[0] === "diff" && argv.includes("--quiet")) throw new Error("exit 1: staged changes")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      return Buffer.from("")
    })

    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(true)
    expect(calls).toContainEqual(["--literal-pathspecs", "reset", "-q", "--", "arc/huge.jsonl"])
    expect(calls.map((argv) => argv[0])).toContain("commit")
    expect(calls.map((argv) => argv[0])).toContain("push")
    const skipped = JSON.parse(fs.readFileSync(path.join(tmpDir, "state", "sync-skipped-files.json"), "utf-8"))
    expect(skipped.limitBytes).toBe(SYNC_FILE_SIZE_LIMIT_BYTES)
    expect(skipped.files).toEqual([{ path: "arc/huge.jsonl", bytes: SYNC_FILE_SIZE_LIMIT_BYTES + 1 }])
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "heart.sync_oversized_files_skipped",
    }))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("commits nothing when every changed file is over the limit", async () => {
    const { postTurnPush, SYNC_FILE_SIZE_LIMIT_BYTES } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    sparseFile(tmpDir, "huge.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0] === "--literal-pathspecs" ? argv[1] : argv[0])
      if (argv[0] === "status") return Buffer.from("?? huge.jsonl\n")
      if (argv[0] === "diff" && argv.includes("--name-status")) return Buffer.from("A\0huge.jsonl\0")
      return Buffer.from("")
    })

    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(true)
    expect(commands).toContain("reset")
    expect(commands).not.toContain("commit")
    expect(commands).not.toContain("push")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "heart.sync_push_end",
      message: "post-turn push: only oversized files changed, nothing committed",
    }))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("clears the skipped-files record once no file is over the limit", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "state", "sync-skipped-files.json"), "{}", "utf-8")
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "state", "sync-skipped-files.json"))).toBe(false)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("still syncs when the skipped-files record cannot be written", async () => {
    const { postTurnPush, SYNC_FILE_SIZE_LIMIT_BYTES } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    sparseFile(tmpDir, "huge.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    fs.writeFileSync(path.join(tmpDir, "state"), "not a directory", "utf-8")
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from("?? huge.jsonl\n")
      if (argv[0] === "diff" && argv.includes("--name-status")) return Buffer.from("A\0huge.jsonl\0")
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("passes a large output buffer to git status so a huge change list cannot overflow it", async () => {
    const { postTurnPush, SYNC_GIT_MAX_BUFFER_BYTES } = await import("../../heart/sync")
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from(""))

    postTurnPush("/fake/agent/root", defaultConfig)

    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain"],
      expect.objectContaining({ maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES }),
    )
  })

  it("records a git status failure and counts repeated failures from the first one", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("spawnSync git ENOBUFS")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(false)
    const first = JSON.parse(fs.readFileSync(path.join(tmpDir, "state", "pending-sync.json"), "utf-8"))
    expect(first.error).toContain("ENOBUFS")
    expect(first.consecutiveFailures).toBe(1)
    expect(first.firstFailedAt).toBe(first.failedAt)

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(false)
    const second = JSON.parse(fs.readFileSync(path.join(tmpDir, "state", "pending-sync.json"), "utf-8"))
    expect(second.consecutiveFailures).toBe(2)
    expect(second.firstFailedAt).toBe(first.firstFailedAt)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("continues the failure count from a record written before the count existed", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "state", "pending-sync.json"), JSON.stringify({
      error: "old", failedAt: "2026-06-21T22:00:00.000Z", classification: "unknown", conflictFiles: [],
    }), "utf-8")
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("still failing")
    })

    postTurnPush(tmpDir, defaultConfig)

    const record = JSON.parse(fs.readFileSync(path.join(tmpDir, "state", "pending-sync.json"), "utf-8"))
    expect(record.firstFailedAt).toBe("2026-06-21T22:00:00.000Z")
    expect(record.consecutiveFailures).toBe(2)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("starts a fresh count when the previous record is not an object", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "state", "pending-sync.json"), "[]", "utf-8")
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("failing")
    })

    postTurnPush(tmpDir, defaultConfig)

    const record = JSON.parse(fs.readFileSync(path.join(tmpDir, "state", "pending-sync.json"), "utf-8"))
    expect(record.consecutiveFailures).toBe(1)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each([
    ["a push", (pushCount: number) => pushCount === 0, "origin\n"],
    ["a push after rebase", (pushCount: number) => pushCount === 1, "origin\n"],
    ["a local-only commit", () => true, ""],
  ])("removes the failure record after %s succeeds", async (_label, pushSucceeds, remote) => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "state", "pending-sync.json"), JSON.stringify({ error: "old" }), "utf-8")
    let pushCount = 0
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from(remote)
      if (argv[0] === "push") {
        const ok = pushSucceeds(pushCount)
        pushCount++
        if (!ok) throw new Error("rejected")
      }
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "state", "pending-sync.json"))).toBe(false)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function cleanTreeBundleWithRecord(): string {
    const tmpDir = makeBundle()
    fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "state", "pending-sync.json"), JSON.stringify({ error: "old" }), "utf-8")
    fs.writeFileSync(path.join(tmpDir, "state", "sync-skipped-files.json"), JSON.stringify({ files: [] }), "utf-8")
    return tmpDir
  }

  it.each([
    ["no remote is configured", "", "0"],
    ["nothing is ahead of the upstream", "origin\n", "0\n"],
  ])("clears the failure and skipped-files records on a clean tree when %s", async (_label, remote, ahead) => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = cleanTreeBundleWithRecord()
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0])
      if (argv[0] === "remote") return Buffer.from(remote)
      if (argv[0] === "rev-list") return Buffer.from(ahead)
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "state", "pending-sync.json"))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, "state", "sync-skipped-files.json"))).toBe(false)
    expect(commands).not.toContain("push")
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("pushes commits an earlier failed push left behind when the tree is clean", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = cleanTreeBundleWithRecord()
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0])
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "rev-list") return Buffer.from("2560\n")
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    expect(commands).toContain("push")
    expect(commands).not.toContain("commit")
    expect(fs.existsSync(path.join(tmpDir, "state", "pending-sync.json"))).toBe(false)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("keeps the failure record on a clean tree when the upstream cannot be compared", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = cleanTreeBundleWithRecord()
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "rev-list") throw new Error("fatal: no upstream configured for branch 'main'")
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "state", "pending-sync.json"))).toBe(true)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "heart.sync_upstream_unknown" }))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("keeps the failure record when the ahead count is not a number", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const tmpDir = cleanTreeBundleWithRecord()
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "remote") return Buffer.from("origin\n")
      if (argv[0] === "rev-list") return Buffer.from("garbage")
      return Buffer.from("")
    })

    expect(postTurnPush(tmpDir, defaultConfig).ok).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "state", "pending-sync.json"))).toBe(true)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("unstages both sides of a rename whose new path is over the limit", async () => {
    const { postTurnPush, SYNC_FILE_SIZE_LIMIT_BYTES } = await import("../../heart/sync")
    const tmpDir = makeBundle()
    sparseFile(tmpDir, "new/big.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    const calls: string[][] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      calls.push(argv)
      if (argv[0] === "status") return Buffer.from("R  old/big.jsonl -> new/big.jsonl\n")
      if (argv[0] === "diff" && argv.includes("--name-status")) return Buffer.from("R100\0old/big.jsonl\0new/big.jsonl\0C090\0a.json\0b.json\0")
      return Buffer.from("")
    })

    postTurnPush(tmpDir, defaultConfig)

    expect(calls).toContainEqual(["--literal-pathspecs", "reset", "-q", "--", "new/big.jsonl", "old/big.jsonl"])
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("commits quietly, with a large output buffer and a long timeout", async () => {
    const { postTurnPush, SYNC_GIT_MAX_BUFFER_BYTES, SYNC_GIT_TIMEOUT_MS } = await import("../../heart/sync")
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "status") return Buffer.from(" M file.json\n")
      if (argv[0] === "remote") return Buffer.from("origin\n")
      return Buffer.from("")
    })

    postTurnPush("/fake/agent/root", defaultConfig)

    for (const command of [["add", "-A"], ["commit", "-q", "-m", "sync: post-turn update"], ["push", "origin"]]) {
      expect(childProcess.execFileSync).toHaveBeenCalledWith(
        "git",
        command,
        expect.objectContaining({ timeout: SYNC_GIT_TIMEOUT_MS, maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES }),
      )
    }
  })

  it("clearPendingSync tolerates a record it cannot remove", async () => {
    const { clearPendingSync } = await import("../../heart/sync")
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
      throw new Error("EPERM")
    })

    expect(() => clearPendingSync("/fake/agent/root")).not.toThrow()
    rmSpy.mockRestore()
  })
})
