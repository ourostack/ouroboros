/**
 * A signal during a push: the git child's process group dies and the bundle
 * lock is released. One test runs a real child process that has no SIGTERM
 * handler of its own (like the agent worker); the rest run in-process.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { execFileSync, spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { abortInFlightSync, postTurnPush } from "../../heart/sync"

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
function setup(name = "butler"): { agent: string; remote: string; started: string; gate: string } {
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
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${started}'\nwhile [ ! -f '${gate}' ]; do sleep 0.05; done\nexec git receive-pack "$@"\n`, { mode: 0o755 })
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
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OURO_NERVES_SILENT: "1" } })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
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

      expect({ ...exit, stderr }).toEqual({ code: null, signal: "SIGTERM", stderr: "" })
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
