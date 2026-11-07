/**
 * A signal during a push: the git child's process group dies and the bundle
 * lock is released. One test runs a real child process that has no SIGTERM
 * handler of its own (like the agent worker); the rest run in-process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync, spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { __testHooks, abortInFlightSync, postTurnPush, syncGroupExists } from "../../heart/sync"

const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
const SYNC_SOURCE = path.resolve(__dirname, "../../heart/sync.ts")

let bundleDir: string
let syncBundle: string
let root: string
let savedHome: string | undefined
let savedNoSystem: string | undefined

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A bundle whose push hangs on the remote side, recording the hanging process. */
function setup(name = "butler", { ignoreTerm = false } = {}): { agent: string; remote: string; started: string; gate: string } {
  const remote = path.join(root, `${name}-remote.git`)
  const owner = path.join(root, `${name}-owner`)
  const agent = path.join(root, `${name}.ouro`)
  git(root, ["init", "-q", "--bare", "-b", "main", remote])
  git(root, ["clone", "-q", remote, owner])
  git(owner, ["checkout", "-q", "-b", "main"])
  fs.writeFileSync(path.join(owner, ".gitignore"), "state/\n")
  fs.writeFileSync(path.join(owner, "notes.md"), "seed\n")
  git(owner, [...OWNER, "add", "-A"])
  git(owner, [...OWNER, "commit", "-q", "-m", "seed"])
  git(owner, [...OWNER, "push", "-q", "-u", "origin", "main"])
  git(root, ["clone", "-q", remote, agent])
  const started = path.join(root, `${name}-push-started`)
  const gate = path.join(root, `${name}-push-gate`)
  const wrapper = path.join(root, `${name}-hanging-receive-pack.sh`)
  fs.writeFileSync(wrapper, `#!/bin/sh\n${ignoreTerm ? "trap '' TERM\n" : ""}echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${started}'\nwhile [ ! -f '${gate}' ]; do sleep 0.05; done\nexec git receive-pack "$@"\n`, { mode: 0o755 })
  git(agent, ["config", "remote.origin.receivepack", wrapper])
  fs.writeFileSync(path.join(agent, "journal.md"), "turn\n")
  return { agent, remote, started, gate }
}

function hanging(started: string): { pid: number; pgid: number } {
  const [pid, pgid] = fs.readFileSync(started, "utf-8").trim().split(" ").map(Number)
  return { pid, pgid }
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL")
  } catch {
    // Already gone.
  }
}

beforeAll(async () => {
  // The child process runs sync.ts as one CommonJS file.
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-termination-bundle-"))
  syncBundle = path.join(bundleDir, "sync.cjs")
  const { build } = await import("rolldown")
  await build({ input: SYNC_SOURCE, platform: "node", external: [/^node:/], output: { file: syncBundle, format: "cjs", codeSplitting: false }, logLevel: "silent" })
}, 60_000)

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true })
})

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-termination-")))
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

describe("signals during a sync", () => {
  it("SIGTERM during push leaves no lock and no git child", async () => {
    const { agent, remote, started, gate } = setup()
    const before = git(remote, ["--git-dir", remote, "rev-parse", "main"])
    const script = [
      `const sync = require(${JSON.stringify(syncBundle)})`,
      `const result = sync.postTurnPush(${JSON.stringify(agent)}, { enabled: true, remote: "origin" }, "butler")`,
      `if (!result.ok || !result.push) { console.error(JSON.stringify(result)); process.exit(3) }`,
      `setInterval(() => {}, 1000)`,
    ].join("\n")
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, OURO_NERVES_SILENT: "1" } })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }))
    })
    let group: { pid: number; pgid: number } | undefined
    try {
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)
      expect(group.pgid).not.toBe(child.pid)
      expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(true)

      child.kill("SIGTERM")
      const exit = await exited

      expect(exit).toEqual({ code: null, signal: "SIGTERM" })
      expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
      await waitFor(() => !alive(group!.pid), 5_000)
      expect(alive(group.pid)).toBe(false)
      expect(alive(-group.pgid)).toBe(false)
      expect(git(remote, ["--git-dir", remote, "rev-parse", "main"])).toBe(before)
    } finally {
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
      child.kill("SIGKILL")
    }
  }, 30_000)

  it("a process.once stop handler still finishes its graceful shutdown, and the sync children are dead", async () => {
    // Like telegram-entry.ts: process.once("SIGTERM", stop), where stop is async.
    const { agent, remote, started, gate } = setup()
    const before = git(remote, ["--git-dir", remote, "rev-parse", "main"])
    const done = path.join(root, "graceful-done")
    const script = [
      `const fs = require("fs")`,
      `const sync = require(${JSON.stringify(syncBundle)})`,
      `process.once("SIGTERM", () => { setTimeout(() => { fs.writeFileSync(${JSON.stringify(done)}, "ok"); process.exit(0) }, 300) })`,
      `const result = sync.postTurnPush(${JSON.stringify(agent)}, { enabled: true, remote: "origin" }, "butler")`,
      `if (!result.ok || !result.push) process.exit(3)`,
      `setInterval(() => {}, 1000)`,
    ].join("\n")
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, OURO_NERVES_SILENT: "1" } })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }))
    })
    let group: { pid: number; pgid: number } | undefined
    try {
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)

      child.kill("SIGTERM")
      // Synchronously at the signal: the git group is killed and the lock released,
      // before the graceful handler's 300 ms are up.
      await waitFor(() => !alive(group!.pid), 250)
      const exit = await exited

      expect(exit).toEqual({ code: 0, signal: null })
      expect(fs.readFileSync(done, "utf-8")).toBe("ok")
      expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
      expect(alive(-group.pgid)).toBe(false)
      expect(git(remote, ["--git-dir", remote, "rev-parse", "main"])).toBe(before)
    } finally {
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
      child.kill("SIGKILL")
    }
  }, 30_000)

  it("a signal in a process that handles it itself aborts the push without exiting", async () => {
    const { agent, started, gate } = setup()
    const otherListener = (): void => {}
    process.on("SIGTERM", otherListener)
    const listenersBefore = process.listeners("SIGTERM")
    let group: { pid: number; pgid: number } | undefined
    try {
      const result = postTurnPush(agent, { enabled: true, remote: "origin" }, "butler")
      expect(result.ok).toBe(true)
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)

      process.emit("SIGTERM", "SIGTERM")

      expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
      const pushed = await result.push!
      expect(pushed.ok).toBe(false)
      await waitFor(() => !alive(group!.pid), 5_000)
      // The guard is gone once nothing is held.
      expect(process.listeners("SIGTERM")).toEqual(listenersBefore)
    } finally {
      process.removeListener("SIGTERM", otherListener)
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
    }
  }, 30_000)

  it("the daemon's handler aborts the push directly", async () => {
    const { agent, started, gate } = setup()
    let group: { pid: number; pgid: number } | undefined
    try {
      const result = postTurnPush(agent, { enabled: true, remote: "origin" }, "butler")
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)
      // The group dies before the abort reaches it: killing it again is harmless.
      killGroup(group.pgid)

      abortInFlightSync()

      expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
      expect((await result.push!).ok).toBe(false)
      // Nothing left to abort.
      expect(() => abortInFlightSync()).not.toThrow()
    } finally {
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
    }
  }, 30_000)

  /**
   * Records the signals (not the existence probes) sent to one process group.
   * Other tests' groups are left out: their own timers may still fire while
   * this test runs, which is what made this test flaky.
   */
  function recordSignals(pgid: () => number | undefined): { kills: Array<{ sig: string; at: number }>; probes: () => number; restore: () => void } {
    const kills: Array<{ sig: string; at: number }> = []
    let probes = 0
    const realKill = process.kill.bind(process)
    const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      const group = pgid()
      if (group !== undefined && pid === -group) {
        if (sig === 0) probes++
        else kills.push({ sig: String(sig), at: Date.now() })
      }
      return realKill(pid, sig)
    })
    return { kills, probes: () => probes, restore: () => spy.mockRestore() }
  }

  it("shutdown sends the push's group SIGTERM first, so sudo can relay it, then SIGKILL after the grace to what outlived it", async () => {
    const { agent, started, gate } = setup("butler", { ignoreTerm: true })
    let group: { pid: number; pgid: number } | undefined
    __testHooks.killGraceMs = 400
    const signals = recordSignals(() => group?.pgid)
    try {
      const result = postTurnPush(agent, { enabled: true, remote: "origin" }, "butler")
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)

      abortInFlightSync()

      expect(signals.kills.map((k) => k.sig)).toEqual(["SIGTERM"])
      expect((await result.push!).ok).toBe(false)
      // The wrapper ignores SIGTERM, so the group is still there for the SIGKILL.
      await waitFor(() => signals.kills.length >= 2, 5_000)
      expect(signals.kills.map((k) => k.sig)).toEqual(["SIGTERM", "SIGKILL"])
      expect(signals.kills[1]!.at - signals.kills[0]!.at).toBeGreaterThanOrEqual(350)
      await waitFor(() => !alive(group!.pid), 5_000)
    } finally {
      signals.restore()
      __testHooks.killGraceMs = undefined
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
    }
  }, 30_000)

  it("sends no SIGKILL to a group the SIGTERM ended, and stops probing it", async () => {
    const { agent, started, gate } = setup()
    let group: { pid: number; pgid: number } | undefined
    __testHooks.killGraceMs = 600
    const signals = recordSignals(() => group?.pgid)
    try {
      const result = postTurnPush(agent, { enabled: true, remote: "origin" }, "butler")
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)

      abortInFlightSync()

      expect((await result.push!).ok).toBe(false)
      await waitFor(() => !alive(group!.pid), 5_000)
      await new Promise((resolve) => setTimeout(resolve, 900))
      expect(signals.kills.map((k) => k.sig)).toEqual(["SIGTERM"])
      // The probe found the group gone and cleared both timers.
      const probes = signals.probes()
      expect(probes).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(signals.probes()).toBe(probes)
    } finally {
      signals.restore()
      __testHooks.killGraceMs = undefined
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
    }
  }, 30_000)

  it("at the grace, sends no SIGKILL when the group is already gone, even before a probe saw it", async () => {
    const { agent, started, gate } = setup()
    let group: { pid: number; pgid: number } | undefined
    __testHooks.killGraceMs = 300
    __testHooks.killProbeMs = 60_000
    const signals = recordSignals(() => group?.pgid)
    try {
      const result = postTurnPush(agent, { enabled: true, remote: "origin" }, "butler")
      await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
      group = hanging(started)
      // Killed in the same tick as the abort, so git is still in flight when the SIGTERM goes out.
      killGroup(group.pgid)
      abortInFlightSync()

      expect((await result.push!).ok).toBe(false)
      await waitFor(() => !syncGroupExists(group!.pgid), 5_000)
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(signals.kills.map((k) => k.sig)).toEqual(["SIGKILL", "SIGTERM"])
    } finally {
      signals.restore()
      __testHooks.killGraceMs = undefined
      __testHooks.killProbeMs = undefined
      fs.writeFileSync(gate, "")
      if (group) killGroup(group.pgid)
    }
  }, 30_000)

  it("counts a group as still there when the probe is refused (a member this uid cannot signal)", () => {
    const refused = (): never => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    }
    const gone = (): never => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
    }
    expect(syncGroupExists(123, refused)).toBe(true)
    expect(syncGroupExists(123, gone)).toBe(false)
    expect(syncGroupExists(123, () => true)).toBe(true)
  })

  it("SIGINT aborts too, and two pushes at once are both aborted", async () => {
    const first = setup("first")
    const second = setup("second")
    const otherListener = (): void => {}
    process.on("SIGINT", otherListener)
    const listenersBefore = process.listeners("SIGINT")
    const groups: number[] = []
    try {
      const a = postTurnPush(first.agent, { enabled: true, remote: "origin" }, "first")
      const b = postTurnPush(second.agent, { enabled: true, remote: "origin" }, "second")
      for (const { started } of [first, second]) {
        await waitFor(() => fs.existsSync(started) && fs.readFileSync(started, "utf-8").includes(" "))
        groups.push(hanging(started).pgid)
      }

      process.emit("SIGINT", "SIGINT")

      for (const { agent } of [first, second]) expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
      expect((await a.push!).ok).toBe(false)
      expect((await b.push!).ok).toBe(false)
      expect(process.listeners("SIGINT")).toEqual(listenersBefore)
    } finally {
      process.removeListener("SIGINT", otherListener)
      for (const { gate } of [first, second]) fs.writeFileSync(gate, "")
      for (const pgid of groups) killGroup(pgid)
    }
  }, 30_000)
})
