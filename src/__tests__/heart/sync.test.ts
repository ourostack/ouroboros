import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SyncConfig } from "../../heart/config"

vi.mock("child_process", () => ({
  execSync: vi.fn(),
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
    vi.mocked(childProcess.execSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  it("runs git pull when sync is enabled", async () => {
    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(childProcess.execSync).toHaveBeenCalledWith(
      "git pull origin",
      expect.objectContaining({ cwd: "/fake/agent/root" }),
    )
  })

  it("returns error on pull failure", async () => {
    vi.mocked(childProcess.execSync).mockImplementation(() => {
      throw new Error("fatal: Could not read from remote repository")
    })

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("fatal: Could not read from remote repository")
  })

  it("returns ok true on success", async () => {
    vi.mocked(childProcess.execSync).mockReturnValue(Buffer.from("Already up to date.\n"))

    const { preTurnPull } = await import("../../heart/sync")
    const result = preTurnPull("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("uses configured remote name", async () => {
    const config: SyncConfig = { enabled: true, remote: "upstream" }

    const { preTurnPull } = await import("../../heart/sync")
    preTurnPull("/fake/agent/root", config)

    expect(childProcess.execSync).toHaveBeenCalledWith(
      "git pull upstream",
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
    vi.mocked(childProcess.execSync).mockReset()
    vi.mocked(emitNervesEvent).mockReset()
  })

  it("runs git status, add, commit, push when sync-tracked files changed", async () => {
    const calls: string[] = []
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      calls.push(String(cmd))
      if (String(cmd).includes("status")) return Buffer.from(" M arc/episodes/ep-1.json\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    expect(calls.some((c) => c.includes("git status"))).toBe(true)
    expect(calls.some((c) => c.includes("git commit"))).toBe(true)
    expect(calls.some((c) => c.includes("git push"))).toBe(true)
  })

  it("skips commit and push when no sync-tracked changes", async () => {
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      if (String(cmd).includes("status")) return Buffer.from(" M state/sessions/foo.json\n")
      return Buffer.from("")
    })

    const { postTurnPush } = await import("../../heart/sync")
    const result = postTurnPush("/fake/agent/root", defaultConfig)

    expect(result.ok).toBe(true)
    // Should not have called commit or push
    const calls = vi.mocked(childProcess.execSync).mock.calls.map((c) => String(c[0]))
    expect(calls.some((c) => c.includes("git commit"))).toBe(false)
    expect(calls.some((c) => c.includes("git push"))).toBe(false)
  })

  it("retries with pull-rebase-push on push rejection", async () => {
    let pushCount = 0
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      const cmdStr = String(cmd)
      if (cmdStr.includes("status")) return Buffer.from(" M arc/cares/care-1.json\n")
      if (cmdStr.includes("git push")) {
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
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      const cmdStr = String(cmd)
      if (cmdStr.includes("status")) return Buffer.from(" M arc/episodes/ep-1.json\n")
      if (cmdStr.includes("git push")) throw new Error("push failed")
      if (cmdStr.includes("git pull --rebase")) throw new Error("rebase failed")
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
    vi.mocked(childProcess.execSync).mockImplementation((cmd) => {
      if (String(cmd).includes("status")) return Buffer.from("")
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
