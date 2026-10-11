import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  checkAgentHomes,
  machineDisplayName,
  moveAgentHomeHere,
  readUpstreamAgentHome,
} from "../../../heart/daemon/agent-home"

// These tests drive real git against a local bare remote; give them room.
vi.setConfig({ testTimeout: 30_000 })

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

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>
}

describe("machineDisplayName", () => {
  it("uses the hostname without .local, or the machine id when the hostname is blank", () => {
    expect(machineDisplayName("Aris-MBP.local", HERE)).toBe("Aris-MBP")
    expect(machineDisplayName(" ", HERE)).toBe(HERE)
  })
})

/** Real git: a bare remote, plus clones that stand in for machines. */
function gitFixture(tmp: string) {
  const remote = path.join(tmp, "remote.git")
  const clone = (dir: string): string => {
    git(tmp, "clone", "-q", remote, dir)
    git(dir, "config", "user.email", "test@ouro.bot")
    git(dir, "config", "user.name", "test")
    return dir
  }
  const commitFile = (dir: string, file: string, text: string): void => {
    fs.writeFileSync(path.join(dir, file), text)
    git(dir, "add", file)
    git(dir, "commit", "-q", "-m", `edit ${file}`)
  }
  return {
    remote,
    clone,
    commitFile,
    /** Create the remote with an agent.json, and return a clone as this machine's bundle. */
    seed(bundleRoot: string, config: Record<string, unknown>): string {
      git(tmp, "init", "--bare", "-q", "-b", "main", remote)
      const seed = clone(path.join(tmp, "seed"))
      git(seed, "checkout", "-q", "-b", "main")
      fs.writeFileSync(path.join(seed, "agent.json"), `${JSON.stringify({ ...config, sync: { enabled: true, remote: "origin" } }, null, 2)}\n`)
      fs.writeFileSync(path.join(seed, "notes.md"), "notes\n")
      git(seed, "add", ".")
      git(seed, "commit", "-q", "-m", "seed")
      git(seed, "push", "-q", "origin", "main")
      return clone(bundleRoot)
    },
    remoteHome(): unknown {
      return (JSON.parse(git(remote, "show", "main:agent.json")) as { home?: unknown }).home
    },
  }
}

describe("moveAgentHomeHere", () => {
  let tmp: string
  let bundlesRoot: string
  let fixture: ReturnType<typeof gitFixture>

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"))
    bundlesRoot = path.join(tmp, "AgentBundles")
    fs.mkdirSync(bundlesRoot)
    fixture = gitFixture(tmp)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const move = (overrides: Partial<Parameters<typeof moveAgentHomeHere>[0]> = {}) =>
    moveAgentHomeHere({ agent: "slugger", machineId: HERE, machineName: "here-mac", bundlesRoot, now: NOW, ...overrides })
  const bundle = () => path.join(bundlesRoot, "slugger.ouro")

  it("fails without changing anything when agent.json is unreadable", () => {
    expect(move({ agent: "ghost" })).toEqual(expect.objectContaining({ ok: false, changed: false, message: expect.stringContaining("cannot read") }))
  })

  it("records the home and the previous home locally when bundle sync is off", () => {
    writeBundle(bundlesRoot, "slugger", agentConfig({ home: { machineId: THERE, machineName: "there-mac" } }))
    expect(move()).toEqual({
      ok: true,
      changed: true,
      message: "slugger now lives on here-mac (here) (moved from there-mac (there)); bundle sync is off, so only this machine sees the change",
    })
    expect(readJson(path.join(bundle(), "agent.json")).home).toEqual({
      machineId: HERE,
      machineName: "here-mac",
      since: "2026-10-10T12:00:00.000Z",
      previous: { machineId: THERE, machineName: "there-mac" },
    })
  })

  it("says so when sync is on but the bundle is not a git repo", () => {
    writeBundle(bundlesRoot, "slugger", agentConfig({ sync: { enabled: true } }))
    expect(move().message).toBe("slugger now lives on here-mac (here); the bundle is not a git repo, so only this machine sees the change")
  })

  it("leaves an agent already homed here unchanged", () => {
    writeBundle(bundlesRoot, "slugger", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    expect(move()).toEqual({ ok: true, changed: false, message: "slugger already lives on this machine (here-mac (here))" })
    const root = fixture.seed(path.join(tmp, "git-bundle"), agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    expect(move({ bundlesRoot: tmp, agent: "git-bundle" }).changed).toBe(false)
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("1")
  })

  it("commits only agent.json and publishes the move", () => {
    const root = fixture.seed(bundle(), agentConfig())
    fs.writeFileSync(path.join(root, "notes.md"), "local edit\n")
    fs.writeFileSync(path.join(root, "scratch.md"), "untracked\n")

    expect(move()).toEqual({ ok: true, changed: true, message: "slugger now lives on here-mac (here)" })
    expect(fixture.remoteHome()).toEqual({ machineId: HERE, machineName: "here-mac", since: "2026-10-10T12:00:00.000Z" })
    expect(git(root, "log", "-1", "--format=%s")).toBe("home: slugger moves to here-mac")
    expect(git(root, "status", "--porcelain")).toBe("M notes.md\n?? scratch.md")
  })

  it("brings a bundle that is behind its remote up to date before moving", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const other = fixture.clone(path.join(tmp, "other"))
    fixture.commitFile(other, "diary.md", "from the other machine\n")
    git(other, "push", "-q")

    expect(move().ok).toBe(true)
    expect(fs.readFileSync(path.join(root, "diary.md"), "utf-8")).toBe("from the other machine\n")
    expect(fixture.remoteHome()).toEqual(expect.objectContaining({ machineId: HERE }))
  })

  it("commits locally when the bundle has no remote", () => {
    const root = writeBundle(bundlesRoot, "slugger", agentConfig({ sync: { enabled: true, remote: " " } }))
    git(root, "init", "-q")
    git(root, "config", "user.email", "test@ouro.bot")
    git(root, "config", "user.name", "test")
    git(root, "add", "agent.json")
    git(root, "commit", "-q", "-m", "seed")
    expect(move().message).toBe("slugger now lives on here-mac (here); the bundle has no remote, so only this machine sees the change")
    expect(git(root, "log", "-1", "--format=%s")).toBe("home: slugger moves to here-mac")
  })

  it("refuses when agent.json has uncommitted changes", () => {
    const root = fixture.seed(bundle(), agentConfig())
    fs.writeFileSync(path.join(root, "agent.json"), `${JSON.stringify(agentConfig({ sync: { enabled: true }, note: "local" }))}\n`)
    const result = move()
    expect(result.ok).toBe(false)
    expect(result.message).toContain("agent.json has uncommitted changes, so nothing changed")
    expect(fixture.remoteHome()).toBeUndefined()
  })

  it("refuses to publish unpushed bundle commits as a side effect", () => {
    const root = fixture.seed(bundle(), agentConfig())
    fixture.commitFile(root, "diary.md", "never pushed\n")
    const head = git(root, "rev-parse", "HEAD")

    const result = move()
    expect(result).toEqual({
      ok: false,
      changed: false,
      message: `slugger's bundle has 1 unpushed commit, so nothing changed; fix bundle sync first, because a move must not publish them as a side effect (run \`git -C ${root} push\` to see why they did not publish)`,
    })
    expect(git(root, "rev-parse", "HEAD")).toBe(head)
    expect(fixture.remoteHome()).toBeUndefined()

    fixture.commitFile(root, "diary2.md", "also never pushed\n")
    fs.mkdirSync(path.join(root, "state"))
    fs.writeFileSync(path.join(root, "state", "pending-sync.json"), JSON.stringify({ error: "File is 113 MB; exceeds GitHub's 100 MB limit" }))
    expect(move().message).toContain("has 2 unpushed commits, so nothing changed; fix bundle sync first, because a move must not publish them as a side effect (the last bundle push failed with: File is 113 MB; exceeds GitHub's 100 MB limit)")
  })

  it("refuses a bundle whose history has diverged from its remote", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const other = fixture.clone(path.join(tmp, "other"))
    fixture.commitFile(other, "diary.md", "remote side\n")
    git(other, "push", "-q")
    fixture.commitFile(root, "local.md", "local side\n")

    const result = move()
    expect(result.ok).toBe(false)
    expect(result.message).toContain("slugger's bundle has 1 unpushed commit, so nothing changed")
    expect(fixture.remoteHome()).toBeUndefined()
  })

  it("refuses when the remote cannot be reached", () => {
    fixture.seed(bundle(), agentConfig())
    fs.renameSync(fixture.remote, `${fixture.remote}.gone`)
    expect(move().message).toContain("could not reach slugger's bundle remote, so nothing changed")
  })

  it("refuses when the bundle branch has no upstream", () => {
    const root = fixture.seed(bundle(), agentConfig())
    git(root, "checkout", "-q", "-b", "detached-work")
    expect(move().message).toContain("slugger's bundle branch has no upstream to publish the move to, so nothing changed")
  })

  it("refuses when local edits block catching up with the remote", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const other = fixture.clone(path.join(tmp, "other"))
    fixture.commitFile(other, "notes.md", "remote edit\n")
    git(other, "push", "-q")
    fs.writeFileSync(path.join(root, "notes.md"), "local edit\n")
    expect(move().message).toContain("could not bring slugger's bundle up to date with its remote, so nothing changed")
  })

  it("restores agent.json when the commit fails", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const before = fs.readFileSync(path.join(root, "agent.json"), "utf-8")
    const result = move({
      execFileSync: (command, args, options) => {
        if (args[0] === "commit") throw new Error("commit refused")
        return execFileSync(command, args, options)
      },
    })
    expect(result).toEqual({ ok: false, changed: false, message: "could not commit the move, so nothing changed: commit refused" })
    expect(fs.readFileSync(path.join(root, "agent.json"), "utf-8")).toBe(before)
  })

  it("loses cleanly to another machine that claims the agent at the same time", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const rival = fixture.clone(path.join(tmp, "rival"))
    let raced = false
    const result = move({
      execFileSync: (command, args, options) => {
        if (args[0] === "commit" && !raced) {
          raced = true
          // The other machine publishes its own move between our read and our push.
          const rivalRoot = path.join(tmp, "rival-bundles")
          fs.mkdirSync(rivalRoot)
          fs.renameSync(rival, path.join(rivalRoot, "slugger.ouro"))
          expect(moveAgentHomeHere({ agent: "slugger", machineId: THERE, machineName: "there-mac", bundlesRoot: rivalRoot }).ok).toBe(true)
        }
        return execFileSync(command, args, options)
      },
    })
    expect(result).toEqual({
      ok: false,
      changed: false,
      message: "another machine changed slugger's home while this move was being published (it now names there-mac (there)), so this move was undone; run `ouro move slugger here` again to take it over",
    })
    expect(fixture.remoteHome()).toEqual(expect.objectContaining({ machineId: THERE }))
    expect(readJson(path.join(root, "agent.json")).home).toEqual(expect.objectContaining({ machineId: THERE }))
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  it("retries once when the remote moved on for an unrelated reason", () => {
    fixture.seed(bundle(), agentConfig())
    const other = fixture.clone(path.join(tmp, "other"))
    let pushes = 0
    const result = move({
      execFileSync: (command, args, options) => {
        if (args[0] === "push" && ++pushes === 1) {
          fixture.commitFile(other, "diary.md", "unrelated\n")
          git(other, "push", "-q")
        }
        return execFileSync(command, args, options)
      },
    })
    expect(result.ok).toBe(true)
    expect(pushes).toBe(2)
    expect(fixture.remoteHome()).toEqual(expect.objectContaining({ machineId: HERE }))
  })

  it("undoes the move when it cannot be pushed", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const before = fs.readFileSync(path.join(root, "agent.json"), "utf-8")
    const head = git(root, "rev-parse", "HEAD")
    const result = move({
      execFileSync: (command, args, options) => {
        if (args[0] === "push") throw "pre-receive hook declined"
        return execFileSync(command, args, options)
      },
    })
    expect(result).toEqual({ ok: false, changed: false, message: "could not push the move, so nothing changed: pre-receive hook declined" })
    expect(fs.readFileSync(path.join(root, "agent.json"), "utf-8")).toBe(before)
    expect(git(root, "rev-parse", "HEAD")).toBe(head)
    expect(git(root, "status", "--porcelain")).toBe("")
  })

  it("says what to run when the failed move cannot be undone", () => {
    const root = fixture.seed(bundle(), agentConfig())
    const result = move({
      execFileSync: (command, args, options) => {
        if (args[0] === "push") throw new Error("rejected")
        if (args[0] === "reset") throw new Error("index locked")
        return execFileSync(command, args, options)
      },
    })
    expect(result.message).toBe(`the move could not be pushed (rejected) and its local commit could not be undone (index locked); run \`git -C ${root} reset --soft HEAD~1\` and restore agent.json`)
  })

  it("reports an unexpected git failure without changing anything", () => {
    fixture.seed(bundle(), agentConfig())
    const result = move({
      execFileSync: (command, args, options) => {
        if (args[0] === "status") throw new Error("git exploded")
        return execFileSync(command, args, options)
      },
    })
    expect(result).toEqual({ ok: false, changed: false, message: "could not move slugger, so nothing changed: git exploded" })
  })
})

describe("readUpstreamAgentHome", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-upstream-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("reads the lease another machine pushed, without touching the working tree", async () => {
    const fixture = gitFixture(tmp)
    const root = fixture.seed(path.join(tmp, "slugger.ouro"), agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    const rivalRoot = path.join(tmp, "rival")
    fs.mkdirSync(rivalRoot)
    fixture.clone(path.join(rivalRoot, "slugger.ouro"))
    expect(moveAgentHomeHere({ agent: "slugger", machineId: THERE, machineName: "there-mac", bundlesRoot: rivalRoot }).ok).toBe(true)

    await expect(readUpstreamAgentHome(root)).resolves.toEqual(expect.objectContaining({
      machineId: THERE,
      previous: { machineId: HERE, machineName: "here-mac" },
    }))
    expect((readJson(path.join(root, "agent.json")).home as { machineId: string }).machineId).toBe(HERE)
  })

  it("is unknown when sync is off, the bundle is not a git repo, or git fails", async () => {
    const off = writeBundle(tmp, "off", agentConfig())
    const noGit = writeBundle(tmp, "nogit", agentConfig({ sync: { enabled: true } }))
    await expect(readUpstreamAgentHome(off)).resolves.toBeUndefined()
    await expect(readUpstreamAgentHome(noGit)).resolves.toBeUndefined()
    fs.mkdirSync(path.join(noGit, ".git"))
    await expect(readUpstreamAgentHome(noGit, async () => { throw new Error("offline") })).resolves.toBeUndefined()
    await expect(readUpstreamAgentHome(path.join(tmp, "missing"))).resolves.toBeUndefined()
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

  const noUpstream = async () => undefined

  it("is ok when every running agent is homed here", async () => {
    writeBundle(bundlesRoot, "ouroboros", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    writeBundle(bundlesRoot, "slugger", agentConfig({ home: { machineId: THERE, machineName: "there-mac" } }))
    await expect(checkAgentHomes({ managedAgents: ["ouroboros"], machineId: HERE, bundlesRoot })).resolves.toEqual({
      health: { name: "agent-home", status: "ok", message: "every running agent is homed here" },
      displaced: [],
    })
  })

  it("stops agents homed elsewhere on disk, unclaimed here, or moved away upstream", async () => {
    writeBundle(bundlesRoot, "ouroboros", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    writeBundle(bundlesRoot, "slugger", agentConfig({ home: { machineId: THERE, machineName: "there-mac" } }))
    writeBundle(bundlesRoot, "stray", agentConfig())
    writeBundle(bundlesRoot, "mover", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    const result = await checkAgentHomes({
      managedAgents: ["ouroboros", "slugger", "stray", "mover", "gone"],
      machineId: HERE,
      bundlesRoot,
      readUpstreamHome: async (root) => {
        if (root.endsWith("mover.ouro")) return { machineId: THERE, machineName: "there-mac", since: "" }
        if (root.endsWith("ouroboros.ouro")) return { machineId: HERE, machineName: "here-mac", since: "" }
        return null
      },
    })
    expect(result.displaced).toEqual(["slugger", "stray", "mover"])
    expect(result.health).toEqual({
      name: "agent-home",
      status: "critical",
      message: "lease conflict: stopped slugger (homed on there-mac (there)), stray (not homed here, and this machine runs only its own agents), mover (moved to there-mac (there) upstream) on this machine",
    })
  })

  it("warns about agents homed here but not running, agents running without a home, and a home that looks like this machine", async () => {
    writeBundle(bundlesRoot, "newcomer", agentConfig({ home: { machineId: HERE, machineName: "here-mac" } }))
    writeBundle(bundlesRoot, "legacy", agentConfig())
    await expect(checkAgentHomes({ managedAgents: [], machineId: HERE, bundlesRoot, readUpstreamHome: noUpstream })).resolves.toEqual({
      health: { name: "agent-home", status: "warn", message: "homed here but not running: newcomer; run `ouro up` to start" },
      displaced: [],
    })

    const replaced = await checkAgentHomes({
      managedAgents: ["legacy"],
      machineId: "machine_new",
      hostnameAliases: ["Here-Mac.local"],
      bundlesRoot,
      readUpstreamHome: noUpstream,
    })
    expect(replaced.health.status).toBe("warn")
    expect(replaced.health.message).toBe(
      "running without a home, so another machine may run it too: legacy; claim with `ouro move <agent> here`; "
      + "newcomer is homed on here-mac (here), which has this machine's name but a different id; if this machine's identity was replaced, run `ouro move newcomer here`",
    )

    writeBundle(bundlesRoot, "legacy2", agentConfig())
    const two = await checkAgentHomes({ managedAgents: ["legacy", "legacy2"], machineId: "machine_other", bundlesRoot, readUpstreamHome: noUpstream })
    expect(two.health.message).toBe("running without a home, so another machine may run them too: legacy, legacy2; claim with `ouro move <agent> here`")
  })
})
