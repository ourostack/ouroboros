import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SyncConfig } from "../../heart/config"

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

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

  it("returns error on pull failure", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error("fatal: Could not read from remote repository")
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("fatal: Could not read from remote repository")
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
})

describe("postTurnPush", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  it("stages only specific changed files, not entire directories", async () => {
    const addCalls: string[][] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "status") return Buffer.from(" M arc/episodes/ep-1.json\n")
      if (argv?.[0] === "add") addCalls.push(argv)
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    // Should stage the specific file, not the directory
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0]).toEqual(["add", "--", "arc/episodes/ep-1.json"])
  })

  it("runs git status, add, commit, push when sync-tracked files changed", async () => {
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0])
      if (argv[0] === "status") return Buffer.from(" M arc/episodes/ep-1.json\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(commands).toContain("status")
    expect(commands).toContain("add")
    expect(commands).toContain("commit")
    expect(commands).toContain("push")
  })

  it("skips commit and push when no sync-tracked changes", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "status") return Buffer.from(" M state/sessions/foo.json\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    const calls = vi.mocked(childProcess.execFileSync).mock.calls.map((c) => (c[1] as string[])?.[0])
    expect(calls).not.toContain("commit")
    expect(calls).not.toContain("push")
  })

  it("retries with pull-rebase-push on push rejection", async () => {
    let pushCount = 0
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "status") return Buffer.from(" M arc/cares/care-1.json\n")
      if (argv?.[0] === "push") {
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

  it("writes pending-sync.json on second push failure", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-push-fail-"))
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "status") return Buffer.from(" M arc/episodes/ep-1.json\n")
      if (argv?.[0] === "push") throw new Error("push failed")
      if (argv?.[0] === "pull") throw new Error("rebase failed")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig)

    expect(result.ok).toBe(false)
    const pendingPath = path.join(tmpDir, "state", "pending-sync.json")
    expect(fs.existsSync(pendingPath)).toBe(true)
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"))
    expect(pending.error).toContain("rebase failed")
    expect(pending.paths).toContain("arc/episodes/ep-1.json")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("emits nerves events", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "status") return Buffer.from("")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    postTurnPush("/fake/agent/root", defaultConfig)

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "heart",
        event: "heart.sync_push_start",
      }),
    )
  })
})
