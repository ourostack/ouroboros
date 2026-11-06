/**
 * `preTurnPullAsync` is the signal-aware pull the boot sync probe runs under
 * its hard timeout. Real git: an abort must kill the fetch's whole process
 * group, and an abort before the start runs no git.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { preTurnPullAsync } from "../../heart/sync"
import { tryAcquireSyncLockSync } from "../../heart/sync-lock"

const CONFIG = { enabled: true, remote: "origin", branch: "main" }
let root: string
let savedSsh: string | undefined

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function bundleWithRemote(): { bundle: string; remote: string } {
  const remote = path.join(root, "remote.git")
  const seed = path.join(root, "seed")
  const bundle = path.join(root, "agent.ouro")
  git(root, ["init", "-q", "--bare", "-b", "main", remote])
  git(root, ["init", "-q", "-b", "main", seed])
  fs.writeFileSync(path.join(seed, "notes.md"), "seed\n")
  git(seed, ["add", "-A"])
  git(seed, ["commit", "-q", "-m", "seed"])
  git(seed, ["push", "-q", remote, "HEAD:main"])
  git(root, ["clone", "-q", remote, bundle])
  return { bundle, remote }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-signal-")))
  savedSsh = process.env.GIT_SSH_COMMAND
})

afterEach(() => {
  if (savedSsh === undefined) delete process.env.GIT_SSH_COMMAND
  else process.env.GIT_SSH_COMMAND = savedSsh
  fs.rmSync(root, { recursive: true, force: true })
})

describe("preTurnPullAsync (signal-aware)", () => {
  it("without a signal: fetches and merges the configured remote branch", async () => {
    const { bundle, remote } = bundleWithRemote()
    git(bundle, ["remote", "rename", "origin", "home"])
    const other = path.join(root, "other")
    git(root, ["clone", "-q", remote, other])
    fs.writeFileSync(path.join(other, "notes.md"), "other\n")
    git(other, ["commit", "-q", "-am", "other"])
    git(other, ["push", "-q", "origin", "main"])

    expect(await preTurnPullAsync(bundle, { ...CONFIG, remote: "home" })).toEqual({ ok: true })
    expect(fs.readFileSync(path.join(bundle, "notes.md"), "utf-8")).toBe("other\n")
  })

  it("defaults the branch to main when the config names none", async () => {
    const { bundle } = bundleWithRemote()
    expect(await preTurnPullAsync(bundle, { enabled: true, remote: "origin" })).toEqual({ ok: true })
  })

  it("when the signal is already aborted, runs no git and returns ok=false", async () => {
    const { bundle } = bundleWithRemote()
    const controller = new AbortController()
    controller.abort()
    expect(await preTurnPullAsync(bundle, CONFIG, { signal: controller.signal })).toEqual({ ok: false, error: "aborted before pull started" })
  })

  it("when the signal aborts mid-fetch, the fetch's process group is killed", async () => {
    const { bundle } = bundleWithRemote()
    const pidFile = path.join(root, "pids")
    const script = path.join(root, "ssh.sh")
    fs.writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! >> "${pidFile}"\necho $$ >> "${pidFile}"\nwait\n`, { mode: 0o755 })
    process.env.GIT_SSH_COMMAND = script
    git(bundle, ["remote", "set-url", "origin", "ssh://git@hang.invalid/repo.git"])
    const controller = new AbortController()

    const pending = preTurnPullAsync(bundle, CONFIG, { signal: controller.signal })
    const until = Date.now() + 5000
    while ((!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf-8").trim().split("\n").length < 2) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 25))
    }
    controller.abort()
    expect(await pending).toEqual({ ok: false, error: "git fetch aborted" })

    const pids = fs.readFileSync(pidFile, "utf-8").trim().split("\n").map(Number)
    const deadline = Date.now() + 3000
    while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(pids.filter(alive)).toEqual([])
  })

  it("an abort while waiting for the lock ends the wait", async () => {
    const { bundle } = bundleWithRemote()
    const held = tryAcquireSyncLockSync(bundle)
    if ("busy" in held) throw new Error("lock unexpectedly busy")
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await preTurnPullAsync(bundle, CONFIG, { signal: controller.signal })
    held.release()
    expect(result.ok).toBe(false)
    expect(result.error).toContain("aborted while waiting for the sync lock")
  })

  it("says the bundle is not a git repository", async () => {
    const bundle = path.join(root, "plain.ouro")
    fs.mkdirSync(bundle)
    const result = await preTurnPullAsync(bundle, CONFIG)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("my bundle is not a git repository")
  })

  it("a fetch failure is returned with git's message", async () => {
    const { bundle } = bundleWithRemote()
    git(bundle, ["remote", "set-url", "origin", path.join(root, "missing.git")])
    const result = await preTurnPullAsync(bundle, CONFIG)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^git fetch failed: /)
  })
})
