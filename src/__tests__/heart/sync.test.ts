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
    // Only git status should be called
    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
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
        return Buffer.from("UU journal/entry.md\nUU friends/ari.json\n")
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
    expect(pending.conflictFiles).toEqual(["journal/entry.md", "friends/ari.json"])

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
