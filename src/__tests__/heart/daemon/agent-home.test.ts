import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { checkAgentHomes, machineDisplayName, moveAgentHomeHere } from "../../../heart/daemon/agent-home"

const HERE = "machine_here"
const THERE = "machine_there"
const NOW = () => new Date("2026-10-10T12:00:00.000Z")

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function agentConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, vault: { email: "a@ouro.bot", serverUrl: "https://vault.ouro.bot" }, ...extra }
}

function writeBundle(bundlesRoot: string, agent: string, config: Record<string, unknown>): string {
  const root = path.join(bundlesRoot, `${agent}.ouro`)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "agent.json"), `${JSON.stringify(config, null, 2)}\n`)
  return root
}

function readHome(bundlesRoot: string, agent: string): unknown {
  return (JSON.parse(fs.readFileSync(path.join(bundlesRoot, `${agent}.ouro`, "agent.json"), "utf-8")) as { home?: unknown }).home
}

describe("machineDisplayName", () => {
  it("uses the hostname without .local, or the machine id when the hostname is blank", () => {
    expect(machineDisplayName("Aris-MBP.local", HERE)).toBe("Aris-MBP")
    expect(machineDisplayName(" ", HERE)).toBe(HERE)
  })
})

describe("moveAgentHomeHere", () => {
  let tmp: string
  let bundlesRoot: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"))
    bundlesRoot = path.join(tmp, "AgentBundles")
    fs.mkdirSync(bundlesRoot)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** A sync-enabled bundle cloned from a bare remote, as on a real machine. */
  function syncedBundle(agent: string, config: Record<string, unknown>): { root: string; remote: string } {
    const remote = path.join(tmp, `${agent}-remote.git`)
    git(tmp, "init", "--bare", "-q", "-b", "main", remote)
    const seed = path.join(tmp, `${agent}-seed`)
    git(tmp, "clone", "-q", remote, seed)
    git(seed, "config", "user.email", "test@ouro.bot")
    git(seed, "config", "user.name", "test")
    git(seed, "checkout", "-q", "-b", "main")
    fs.writeFileSync(path.join(seed, "agent.json"), `${JSON.stringify({ ...config, sync: { enabled: true } }, null, 2)}\n`)
    git(seed, "add", "agent.json")
    git(seed, "commit", "-q", "-m", "seed")
    git(seed, "push", "-q", "origin", "main")
    const root = path.join(bundlesRoot, `${agent}.ouro`)
    git(tmp, "clone", "-q", remote, root)
    git(root, "config", "user.email", "test@ouro.bot")
    git(root, "config", "user.name", "test")
    return { root, remote }
  }

  function remoteHome(remote: string): unknown {
    return (JSON.parse(git(remote, "show", "main:agent.json")) as { home?: unknown }).home
  }

  it("fails without changing anything when agent.json is unreadable", () => {
    const result = moveAgentHomeHere({ agent: "ghost", machineId: HERE, machineName: "here-mac", bundlesRoot })
    expect(result.ok).toBe(false)
    expect(result.changed).toBe(false)
    expect(result.message).toContain("cannot read")
  })

  it("records the home and the previous home locally when bundle sync is off", () => {
    writeBundle(bundlesRoot, "solo", agentConfig({ home: { machineId: THERE, machineName: "there-mac", since: "2026-01-01T00:00:00.000Z" } }))
    const result = moveAgentHomeHere({ agent: "solo", machineId: HERE, machineName: "here-mac", bundlesRoot, now: NOW })
    expect(result).toEqual({
      ok: true,
      changed: true,
      message: "solo now lives on here-mac (moved from there-mac); bundle sync is off, so only this machine sees the change",
    })
    expect(readHome(bundlesRoot, "solo")).toEqual({
      machineId: HERE,
      machineName: "here-mac",
      since: "2026-10-10T12:00:00.000Z",
      previous: { machineId: THERE, machineName: "there-mac" },
    })
  })

  it("leaves an agent already homed here unchanged", () => {
    writeBundle(bundlesRoot, "solo", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    const before = fs.readFileSync(path.join(bundlesRoot, "solo.ouro", "agent.json"), "utf-8")
    const result = moveAgentHomeHere({ agent: "solo", machineId: HERE, machineName: "here-mac", bundlesRoot })
    expect(result).toEqual({ ok: true, changed: false, message: "solo already lives on this machine (here-mac)" })
    expect(fs.readFileSync(path.join(bundlesRoot, "solo.ouro", "agent.json"), "utf-8")).toBe(before)
  })

  it("commits only agent.json and publishes the move to the remote", () => {
    const { root, remote } = syncedBundle("slugger", agentConfig())
    fs.writeFileSync(path.join(root, "notes.md"), "unrelated local edit\n")
    const result = moveAgentHomeHere({ agent: "slugger", machineId: HERE, machineName: "here-mac", bundlesRoot, now: NOW })
    expect(result).toEqual({ ok: true, changed: true, message: "slugger now lives on here-mac" })
    expect(remoteHome(remote)).toEqual({ machineId: HERE, machineName: "here-mac", since: "2026-10-10T12:00:00.000Z" })
    expect(git(root, "log", "-1", "--format=%s")).toBe("home: slugger moves to here-mac")
    expect(git(root, "status", "--porcelain")).toBe("?? notes.md")
  })

  it("commits locally when the bundle has no remote", () => {
    const root = writeBundle(bundlesRoot, "local", agentConfig({ sync: { enabled: true } }))
    git(root, "init", "-q")
    git(root, "config", "user.email", "test@ouro.bot")
    git(root, "config", "user.name", "test")
    git(root, "add", "agent.json")
    git(root, "commit", "-q", "-m", "seed")
    const result = moveAgentHomeHere({ agent: "local", machineId: HERE, machineName: "here-mac", bundlesRoot })
    expect(result.ok).toBe(true)
    expect(result.message).toBe("local now lives on here-mac; the bundle has no remote, so only this machine sees the change")
    expect(git(root, "log", "-1", "--format=%s")).toBe("home: local moves to here-mac")
  })

  it("refuses to move when the bundle cannot be synced first", () => {
    const { root } = syncedBundle("slugger", agentConfig())
    const before = fs.readFileSync(path.join(root, "agent.json"), "utf-8")
    const result = moveAgentHomeHere({
      agent: "slugger",
      machineId: HERE,
      machineName: "here-mac",
      bundlesRoot,
      pull: () => ({ ok: false, error: "network down" }),
    })
    expect(result).toEqual({ ok: false, changed: false, message: "could not sync slugger before moving it, so nothing changed: network down" })
    expect(fs.readFileSync(path.join(root, "agent.json"), "utf-8")).toBe(before)
  })

  it("restores agent.json when the commit fails", () => {
    const { root } = syncedBundle("slugger", agentConfig())
    const before = fs.readFileSync(path.join(root, "agent.json"), "utf-8")
    const result = moveAgentHomeHere({
      agent: "slugger",
      machineId: HERE,
      machineName: "here-mac",
      bundlesRoot,
      execFileSync: (command, args, options) => {
        if (args[0] === "commit") throw new Error("commit refused")
        return execFileSync(command, args, options)
      },
    })
    expect(result).toEqual({ ok: false, changed: false, message: "could not commit the move, so nothing changed: commit refused" })
    expect(fs.readFileSync(path.join(root, "agent.json"), "utf-8")).toBe(before)
  })

  it("retries from a fresh pull when another machine pushed first", () => {
    const { root, remote } = syncedBundle("slugger", agentConfig())
    let pushes = 0
    const result = moveAgentHomeHere({
      agent: "slugger",
      machineId: HERE,
      machineName: "here-mac",
      bundlesRoot,
      execFileSync: (command, args, options) => {
        if (args[0] === "push" && ++pushes === 1) throw new Error("rejected: fetch first")
        return execFileSync(command, args, options)
      },
    })
    expect(result.ok).toBe(true)
    expect(pushes).toBe(2)
    expect(remoteHome(remote)).toEqual(expect.objectContaining({ machineId: HERE }))
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("2")
  })

  it("undoes the move when it cannot be published", () => {
    const { root, remote } = syncedBundle("slugger", agentConfig())
    const before = fs.readFileSync(path.join(root, "agent.json"), "utf-8")
    const head = git(root, "rev-parse", "HEAD")
    const result = moveAgentHomeHere({
      agent: "slugger",
      machineId: HERE,
      machineName: "here-mac",
      bundlesRoot,
      execFileSync: (command, args, options) => {
        if (args[0] === "push") throw "rejected"
        return execFileSync(command, args, options)
      },
    })
    expect(result).toEqual({
      ok: false,
      changed: false,
      message: "could not publish the move, so nothing changed (another machine may have changed slugger at the same time): rejected",
    })
    expect(fs.readFileSync(path.join(root, "agent.json"), "utf-8")).toBe(before)
    expect(git(root, "rev-parse", "HEAD")).toBe(head)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(remoteHome(remote)).toBeUndefined()
  })
})

describe("checkAgentHomes", () => {
  let bundlesRoot: string

  beforeEach(() => {
    bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-check-"))
  })

  afterEach(() => {
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  })

  it("is ok when every running agent is homed here", () => {
    writeBundle(bundlesRoot, "ouroboros", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    writeBundle(bundlesRoot, "slugger", agentConfig({ home: { machineId: THERE, machineName: "there-mac" } }))
    expect(checkAgentHomes({ managedAgents: ["ouroboros"], machineId: HERE, bundlesRoot })).toEqual({
      name: "agent-home",
      status: "ok",
      message: "every running agent is homed here",
    })
  })

  it("reports a lease conflict when a running agent is now homed elsewhere or unclaimed", () => {
    writeBundle(bundlesRoot, "ouroboros", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    writeBundle(bundlesRoot, "slugger", agentConfig({ home: { machineId: THERE, machineName: "there-mac" } }))
    writeBundle(bundlesRoot, "stray", agentConfig())
    expect(checkAgentHomes({ managedAgents: ["ouroboros", "slugger", "stray"], machineId: HERE, bundlesRoot })).toEqual({
      name: "agent-home",
      status: "critical",
      message: "lease conflict: running slugger (now homed on there-mac), stray (not homed here); run `ouro up` here to stop them",
    })
    expect(checkAgentHomes({ managedAgents: ["ouroboros", "slugger"], machineId: HERE, bundlesRoot }).message)
      .toBe("lease conflict: running slugger (now homed on there-mac); run `ouro up` here to stop it")
  })

  it("warns about agents homed here but not running, and agents running without a home", () => {
    writeBundle(bundlesRoot, "newcomer", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    writeBundle(bundlesRoot, "legacy", agentConfig())
    // Holding a home makes "legacy" unclaimed; check fallback separately below.
    expect(checkAgentHomes({ managedAgents: [], machineId: HERE, bundlesRoot })).toEqual({
      name: "agent-home",
      status: "warn",
      message: "homed here but not running: newcomer; run `ouro up` to start",
    })
    expect(checkAgentHomes({ managedAgents: ["legacy"], machineId: "machine_other", bundlesRoot })).toEqual({
      name: "agent-home",
      status: "warn",
      message: "running without a home, so another machine may run it too: legacy; claim with `ouro move <agent> here`",
    })
    writeBundle(bundlesRoot, "legacy2", agentConfig())
    expect(checkAgentHomes({ managedAgents: ["legacy", "legacy2"], machineId: "machine_other", bundlesRoot }).message)
      .toBe("running without a home, so another machine may run them too: legacy, legacy2; claim with `ouro move <agent> here`")
  })
})
