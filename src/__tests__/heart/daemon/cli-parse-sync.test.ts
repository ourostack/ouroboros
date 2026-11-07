import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"
import { syncPausedPath } from "../../../heart/sync"
import { tryAcquireSyncLockSync, type SyncLockHandle } from "../../../heart/sync-lock"

// Real git: a bare remote, an owner clone and the agent bundle, with HOME
// pointing at an empty directory so no gitconfig supplies an identity.

const AGENT = "butler"
const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"]).toString().trim()
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM"]
const savedEnv: Record<string, string | undefined> = {}

let root: string

function git(cwd: string, args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, stdio: "pipe" }).toString().trim()
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content, "utf-8")
}

function agentJson(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    version: 2,
    enabled: true,
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    context: { maxTokens: 80000, contextMargin: 20 },
    sync: { enabled: true, remote: "origin" },
    ...extra,
  }, null, 2)}\n`
}

function setup(options: { remote?: boolean; agentJson?: string } = {}): { bundlesRoot: string; agent: string; remote: string; owner: string } {
  const bundlesRoot = path.join(root, "bundles")
  const remote = path.join(root, "remote.git")
  const owner = path.join(root, "owner")
  const agent = path.join(bundlesRoot, `${AGENT}.ouro`)
  fs.mkdirSync(bundlesRoot, { recursive: true })
  git(root, ["init", "-q", "--bare", "-b", "main", remote])
  git(root, ["clone", "-q", remote, owner])
  git(owner, ["checkout", "-q", "-b", "main"])
  write(owner, ".gitignore", "state/\n")
  write(owner, "agent.json", options.agentJson ?? agentJson())
  write(owner, "friends/.keep", "")
  git(owner, [...OWNER, "add", "-A"])
  git(owner, [...OWNER, "commit", "-q", "-m", "seed"])
  git(owner, [...OWNER, "push", "-q", "-u", "origin", "main"])
  git(bundlesRoot, ["clone", "-q", remote, agent])
  if (options.remote === false) git(agent, ["remote", "remove", "origin"])
  return { bundlesRoot, agent, remote, owner }
}

function remoteHead(remote: string): string {
  return git(remote, ["--git-dir", remote, "rev-parse", "main"])
}

function pause(agent: string): string {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  fs.mkdirSync(path.join(agent, "state"), { recursive: true })
  fs.writeFileSync(syncPausedPath(agent), JSON.stringify({ startedAt: new Date().toISOString(), expiresAt }))
  return expiresAt
}

function makeDeps(bundlesRoot: string, overrides: Partial<OuroCliDeps> = {}): { deps: OuroCliDeps; output: string[]; exitCodes: number[] } {
  const output: string[] = []
  const exitCodes: number[] = []
  const deps = {
    socketPath: path.join(root, "no-daemon.sock"),
    sendCommand: async () => ({ ok: true, summary: "" }),
    startDaemonProcess: async () => ({ pid: null }),
    writeStdout: (text: string) => { output.push(text) },
    checkSocketAlive: async () => false,
    cleanupStaleSocket: () => {},
    fallbackPendingMessage: () => "",
    setExitCode: (code: number) => { exitCodes.push(code) },
    bundlesRoot,
    ...overrides,
  } as OuroCliDeps
  return { deps, output, exitCodes }
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-sync-")))
  const home = path.join(root, "empty-home")
  fs.mkdirSync(home)
  process.env.HOME = home
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  delete process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe("ouro sync CLI parsing", () => {
  it("parses 'sync' with no agent", () => {
    expect(parseOuroCommand(["sync"])).toEqual({ kind: "sync" })
  })

  it("parses 'sync --agent <name>'", () => {
    expect(parseOuroCommand(["sync", "--agent", "slugger"])).toEqual({ kind: "sync", agent: "slugger" })
  })

  it("rejects extra arguments", () => {
    expect(() => parseOuroCommand(["sync", "now"])).toThrow("Usage: ouro sync [--agent <name>]")
  })

  it("usage() lists 'ouro sync'", () => {
    expect(usage()).toContain("ouro sync [--agent <name>]")
  })
})

describe("ouro sync", () => {
  it('ouro sync prints "synced <agent>: up to date with origin/main" and exits 0', async () => {
    const { bundlesRoot, agent, remote } = setup()
    write(agent, "journal/today.md", "hello\n")
    const { deps, output, exitCodes } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe(`synced ${AGENT}: up to date with origin/main`)
    expect(output).toEqual([result])
    expect(exitCodes).toEqual([])
    expect(remoteHead(remote)).toBe(git(agent, ["rev-parse", "HEAD"]))
    expect(git(remote, ["--git-dir", remote, "show", "main:journal/today.md"])).toBe("hello")
  })

  it('ouro sync busy prints "sync busy: another sync holds the lock (pid <n>)" and exits 1', async () => {
    const { bundlesRoot, agent, remote } = setup()
    const before = remoteHead(remote)
    const lock = tryAcquireSyncLockSync(agent)
    if ("busy" in lock) throw new Error("lock unexpectedly busy")
    const { deps, exitCodes } = makeDeps(bundlesRoot, { syncLockWaitMs: 0 })
    try {
      const result = await runOuroCli(["sync", "--agent", AGENT], deps)
      expect(result).toBe(`sync busy: another sync holds the lock (pid ${process.pid})`)
      expect(exitCodes).toEqual([1])
      expect(remoteHead(remote)).toBe(before)
    } finally {
      (lock as SyncLockHandle).release()
    }
  })

  it("ouro sync names a busy lock whose holder is unknown", async () => {
    const { bundlesRoot, agent } = setup()
    // A fresh lock file that does not parse: busy, holder unknown.
    write(agent, ".git/ouro-sync.lock", "")
    const { deps, exitCodes } = makeDeps(bundlesRoot, { syncLockWaitMs: 0 })

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe("sync busy: another sync holds the lock")
    expect(exitCodes).toEqual([1])
  })

  it("ouro sync uses the configured sync.branch", async () => {
    const { bundlesRoot, agent, remote } = setup({ agentJson: agentJson({ sync: { enabled: true, remote: "origin", branch: "trunk" } }) })
    git(agent, ["push", "-q", "origin", "HEAD:trunk"])
    write(agent, "journal/today.md", "hello\n")
    const { deps } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe(`synced ${AGENT}: up to date with origin/trunk`)
    expect(git(remote, ["--git-dir", remote, "show", "trunk:journal/today.md"])).toBe("hello")
  })

  it("ouro sync while paused prints the pause and exits 1, pushing nothing", async () => {
    const { bundlesRoot, agent, remote } = setup()
    const before = remoteHead(remote)
    const until = pause(agent)
    write(agent, "journal/today.md", "hello\n")
    const { deps, exitCodes } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe(`sync paused until ${until}`)
    expect(exitCodes).toEqual([1])
    expect(remoteHead(remote)).toBe(before)
  })

  it("ouro sync reports a failure and exits 1", async () => {
    const { bundlesRoot, agent } = setup()
    git(agent, ["remote", "set-url", "origin", path.join(root, "missing.git")])
    const { deps, exitCodes } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toMatch(/^sync failed for butler: git fetch failed: /)
    expect(exitCodes).toEqual([1])
  })

  it("ouro sync without a remote commits locally and says so", async () => {
    const { bundlesRoot, agent } = setup({ remote: false })
    write(agent, "journal/today.md", "hello\n")
    const { deps, exitCodes } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe(`synced ${AGENT}: committed locally; no remote "origin"`)
    expect(exitCodes).toEqual([])
    expect(git(agent, ["status", "--porcelain"])).toBe("")
  })

  it("ouro sync says so when the bundle is not a git repo", async () => {
    const { bundlesRoot, agent } = setup({ remote: false })
    fs.rmSync(path.join(agent, ".git"), { recursive: true, force: true })
    const { deps, exitCodes } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe(`sync failed for ${AGENT}: my bundle is not a git repository`)
    expect(exitCodes).toEqual([1])
  })

  it("ouro sync refuses a bundle with sync off", async () => {
    const { bundlesRoot } = setup({ agentJson: agentJson({ sync: { enabled: false } }) })
    const { deps, exitCodes } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync", "--agent", AGENT], deps)

    expect(result).toBe(`sync is off for ${AGENT}: agent.json has no "sync": { "enabled": true }`)
    expect(exitCodes).toEqual([1])
  })

  it("ouro sync without --agent uses the only agent", async () => {
    const { bundlesRoot } = setup()
    const { deps } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["sync"], deps)

    expect(result).toBe(`synced ${AGENT}: up to date with origin/main`)
  })
})

describe("CLI mutations sync through syncNow", () => {
  it("a friend update CLI mutation while paused pushes nothing", async () => {
    const { bundlesRoot, agent, remote } = setup()
    const friendId = "friend-1"
    write(agent, `friends/${friendId}.json`, `${JSON.stringify({
      id: friendId, name: "Jordan", trustLevel: "acquaintance", externalIds: [], tenantMemberships: [],
      toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z", schemaVersion: 1,
    }, null, 2)}\n`)
    git(agent, [...OWNER, "add", "-A"])
    git(agent, [...OWNER, "commit", "-q", "-m", "friend"])
    git(agent, [...OWNER, "push", "-q", "origin", "HEAD:main"])
    const before = remoteHead(remote)
    const localBefore = git(agent, ["rev-parse", "HEAD"])
    pause(agent)
    const { deps } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["friend", "update", friendId, "--trust", "family", "--agent", AGENT], deps)

    expect(result).toContain(`updated: ${friendId}`)
    expect(JSON.parse(fs.readFileSync(path.join(agent, "friends", `${friendId}.json`), "utf-8")).trustLevel).toBe("family")
    expect(remoteHead(remote)).toBe(before)
    expect(git(agent, ["rev-parse", "HEAD"])).toBe(localBefore)
  })

  it("a CLI mutation while paused reports the pause and pushes nothing", async () => {
    const { bundlesRoot, agent, remote } = setup()
    const before = remoteHead(remote)
    const until = pause(agent)
    const { deps } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["config", "model", "--agent", AGENT, "claude-sonnet-4-6"], deps)

    expect(result).toContain(`bundle sync: paused until ${until}; nothing pushed`)
    expect(remoteHead(remote)).toBe(before)
  })

  it("a CLI mutation awaits the push and reports it after it lands", async () => {
    const { bundlesRoot, agent, remote } = setup()
    const { deps } = makeDeps(bundlesRoot)

    const result = await runOuroCli(["config", "model", "--agent", AGENT, "claude-sonnet-4-6"], deps)

    expect(result).toContain("bundle sync: ran post-change sync (remote: origin)")
    // The push finished before the command returned.
    expect(remoteHead(remote)).toBe(git(agent, ["rev-parse", "HEAD"]))
    expect(JSON.parse(git(remote, ["--git-dir", remote, "show", "main:agent.json"])).humanFacing.model).toBe("claude-sonnet-4-6")
    expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)
  })
})

vi.setConfig({ testTimeout: 30_000 })
