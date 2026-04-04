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

  it("handles non-Error throw", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw "string error" // eslint-disable-line no-throw-literal
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toBe("string error")
  })
})

describe("trackSyncWrite / drainSyncWrites", () => {
  beforeEach(async () => {
    const { drainSyncWrites } = await import("../../heart/sync")
    drainSyncWrites() // clear any stale state
  })

  it("collects written paths and drains them", async () => {
    const { trackSyncWrite, drainSyncWrites } = await import("../../heart/sync")

    trackSyncWrite("/agent/arc/episodes/ep-1.json")
    trackSyncWrite("/agent/arc/obligations/ob-1.json")

    const paths = drainSyncWrites()
    expect(paths).toHaveLength(2)
    expect(paths).toContain("/agent/arc/episodes/ep-1.json")
    expect(paths).toContain("/agent/arc/obligations/ob-1.json")
  })

  it("returns empty array when no writes tracked", async () => {
    const { drainSyncWrites } = await import("../../heart/sync")
    expect(drainSyncWrites()).toEqual([])
  })

  it("clears the set after drain", async () => {
    const { trackSyncWrite, drainSyncWrites } = await import("../../heart/sync")

    trackSyncWrite("/agent/arc/cares/care-1.json")
    drainSyncWrites()

    expect(drainSyncWrites()).toEqual([])
  })

  it("deduplicates paths", async () => {
    const { trackSyncWrite, drainSyncWrites } = await import("../../heart/sync")

    trackSyncWrite("/agent/diary/facts.jsonl")
    trackSyncWrite("/agent/diary/facts.jsonl")

    expect(drainSyncWrites()).toHaveLength(1)
  })
})

describe("postTurnPush", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  it("stages only the specific files passed in writtenPaths", async () => {
    const addCalls: string[][] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "add") addCalls.push(argv)
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [
      "/fake/agent/root/arc/episodes/ep-1.json",
    ])

    expect(result.ok).toBe(true)
    expect(addCalls).toHaveLength(1)
    expect(addCalls[0]).toEqual(["add", "--", "arc/episodes/ep-1.json"])
  })

  it("runs git add, commit, push for written paths", async () => {
    const commands: string[] = []
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      commands.push(argv[0])
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [
      "/fake/agent/root/arc/episodes/ep-1.json",
    ])

    expect(result.ok).toBe(true)
    expect(commands).toContain("add")
    expect(commands).toContain("commit")
    expect(commands).toContain("push")
  })

  it("skips commit and push when writtenPaths is empty", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [])

    expect(result.ok).toBe(true)
    expect(childProcess.execFileSync).not.toHaveBeenCalled()
  })

  it("skips paths outside the agent root", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [
      "/some/other/path/file.json",
    ])

    expect(result.ok).toBe(true)
    // No git commands should run since the path is outside agentRoot
    expect(childProcess.execFileSync).not.toHaveBeenCalled()
  })

  it("retries with pull-rebase-push on push rejection", async () => {
    let pushCount = 0
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "push") {
        pushCount++
        if (pushCount === 1) throw new Error("rejected")
        return Buffer.from("")
      }
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [
      "/fake/agent/root/arc/cares/care-1.json",
    ])

    expect(result.ok).toBe(true)
    expect(pushCount).toBe(2)
  })

  it("writes pending-sync.json on second push failure", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-push-fail-"))
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "push") throw new Error("push failed")
      if (argv?.[0] === "pull") throw new Error("rebase failed")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig, [
      path.join(tmpDir, "arc/episodes/ep-1.json"),
    ])

    expect(result.ok).toBe(false)
    const pendingPath = path.join(tmpDir, "state", "pending-sync.json")
    expect(fs.existsSync(pendingPath)).toBe(true)
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"))
    expect(pending.error).toContain("rebase failed")
    expect(pending.paths).toContain("arc/episodes/ep-1.json")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("emits nerves events", async () => {
    const { postTurnPush } = await import("../../heart/sync")
    postTurnPush("/fake/agent/root", defaultConfig, [])

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
      if (argv?.[0] === "add") throw new Error("add failed")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [
      "/fake/agent/root/arc/episodes/ep-1.json",
    ])

    expect(result.ok).toBe(false)
    expect(result.error).toContain("add failed")
  })

  it("handles non-Error throw in outer catch", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "add") throw "string error" // eslint-disable-line no-throw-literal
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig, [
      "/fake/agent/root/arc/episodes/ep-1.json",
    ])

    expect(result.ok).toBe(false)
    expect(result.error).toBe("string error")
  })

  it("handles non-Error throw in retry catch", async () => {
    vi.mocked(childProcess.execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv?.[0] === "push") throw new Error("push rejected")
      if (argv?.[0] === "pull") throw "rebase string error" // eslint-disable-line no-throw-literal
      return Buffer.from("")
    })

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-push-nonerr-"))
    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush(tmpDir, defaultConfig, [
      path.join(tmpDir, "arc/cares/care-1.json"),
    ])

    expect(result.ok).toBe(false)
    expect(result.error).toBe("rebase string error")

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
