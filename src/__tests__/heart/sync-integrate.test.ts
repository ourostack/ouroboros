import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"
import {
  __testHooks,
  commitLocalChanges,
  fetchRemote,
  integrateFetched,
  postTurnPush,
  preTurnPull,
  pushAsync,
  setSyncOwnerNotifier,
  SYNC_FILE_SIZE_LIMIT_BYTES,
  syncNow,
  type SyncOwnerNotice,
} from "../../heart/sync"
import { tryAcquireSyncLockSync, type SyncLockHandle } from "../../heart/sync-lock"
import type { SyncConfig } from "../../heart/config"

// Real git, no mocks: a bare "remote", an owner clone (the Mac) and the agent's bundle,
// with HOME pointing at an empty directory so no gitconfig supplies an identity.

const AGENT = "butler"
const CONFIG: SyncConfig = { enabled: true, remote: "origin", branch: "main" }
const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
const TACIT_LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"]).toString().trim()
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "PATH", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]

let root: string
let notices: Array<{ agentName: string; notice: SyncOwnerNotice }>
let events: LogEvent[]
let unregisterSink: () => void

function git(cwd: string, args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, stdio: "pipe" }).toString().trim()
}

function ownerGit(cwd: string, args: string[]): string {
  return git(cwd, [...OWNER, ...args])
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content, "utf-8")
}

function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf-8")
}

function tacitWith(changes: Record<number, string>): string {
  return TACIT_LINES.map((line, i) => changes[i + 1] ?? line).join("\n") + "\n"
}

function ownerCommitAndPush(owner: string, files: Record<string, string | null>, message = "owner edit"): void {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) ownerGit(owner, ["rm", "-q", rel])
    else write(owner, rel, content)
  }
  ownerGit(owner, ["add", "-A"])
  ownerGit(owner, ["commit", "-q", "-m", message])
  ownerGit(owner, ["push", "-q", "origin", "main"])
}

function setup(options: { agentBranch?: "clone" | "master" } = {}): { remote: string; owner: string; agent: string } {
  const remote = path.join(root, "remote.git")
  const owner = path.join(root, "owner")
  const agent = path.join(root, `${AGENT}.ouro`)
  git(root, ["init", "-q", "--bare", "-b", "main", remote])
  git(root, ["clone", "-q", remote, owner])
  ownerGit(owner, ["checkout", "-q", "-b", "main"])
  write(owner, ".gitignore", "state/\n")
  write(owner, "psyche/TACIT.md", tacitWith({}))
  write(owner, "psyche/OLD.md", "old psyche file\n")
  write(owner, "notes.md", "notes\n")
  ownerGit(owner, ["add", "-A"])
  ownerGit(owner, ["commit", "-q", "-m", "seed"])
  ownerGit(owner, ["push", "-q", "-u", "origin", "main"])
  if (options.agentBranch === "master") {
    git(root, ["init", "-q", "-b", "master", agent])
    git(agent, ["remote", "add", "origin", remote])
    git(agent, ["fetch", "-q", "origin", "main"])
    git(agent, ["reset", "-q", "--hard", "origin/main"])
  } else {
    git(root, ["clone", "-q", remote, agent])
  }
  return { remote, owner, agent }
}

function remoteShow(remote: string, spec: string): string {
  return git(remote, ["--git-dir", remote, "show", spec])
}

function pendingSync(agent: string): Record<string, unknown> | null {
  const file = path.join(agent, "state", "pending-sync.json")
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown> : null
}

function held(handle: ReturnType<typeof tryAcquireSyncLockSync>): SyncLockHandle {
  if ("busy" in handle) throw new Error("lock unexpectedly busy")
  return handle
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-integrate-")))
  const home = path.join(root, "empty-home")
  fs.mkdirSync(home)
  process.env.HOME = home
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  for (const key of ["XDG_CONFIG_HOME", "GIT_SSH_COMMAND", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[key]
  notices = []
  setSyncOwnerNotifier((agentName, notice) => { notices.push({ agentName, notice }) })
  events = []
  unregisterSink = registerGlobalLogSink((entry) => { events.push(entry) })
})

afterEach(() => {
  unregisterSink()
  setSyncOwnerNotifier(null)
  __testHooks.fetchTimeoutMs = undefined
  __testHooks.pushTimeoutMs = undefined
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe("bundle sync merges and never rebases or stashes", () => {
  it("commits with the agent identity when HOME has no gitconfig", () => {
    const { agent } = setup()
    write(agent, "journal/today.md", "hello\n")

    expect(commitLocalChanges(agent, AGENT, "sync: post-turn update")).toEqual({ committed: true, skipped: [] })
    expect(git(agent, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"])).toBe("butler <butler@ouro.local>|butler <butler@ouro.local>|sync: post-turn update")
    expect(commitLocalChanges(agent, AGENT, "sync: post-turn update")).toEqual({ committed: false, skipped: [] })
  })

  it("fast-forwards to the owner's commit", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })

    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true })
    expect(git(agent, ["rev-parse", "HEAD"])).toBe(git(owner, ["rev-parse", "HEAD"]))
    expect(read(agent, "notes.md")).toBe("owner notes\n")
  })

  it("owner wins conflicting hunks and keeps the agent's other hunks", async () => {
    const { remote, owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 2: "owner 2" }) })
    write(agent, "psyche/TACIT.md", tacitWith({ 2: "agent 2", 18: "agent 18" }))

    expect(await syncNow(agent, CONFIG, AGENT, 1000)).toEqual({ ok: true })
    const expected = tacitWith({ 2: "owner 2", 18: "agent 18" })
    expect(read(agent, "psyche/TACIT.md")).toBe(expected)
    expect(remoteShow(remote, "main:psyche/TACIT.md") + "\n").toBe(expected)
    expect(git(agent, ["log", "-1", "--format=%s|%an <%ae>"])).toBe("sync: owner's psyche edit wins|butler <butler@ouro.local>")
    expect(git(agent, ["status", "--porcelain"])).toBe("")
    expect(pendingSync(agent)).toBeNull()
  })

  it("owner deleted a psyche file the agent edited: the file is gone", async () => {
    const { remote, owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/OLD.md": null })
    write(agent, "psyche/OLD.md", "agent edit\n")

    expect(await syncNow(agent, CONFIG, AGENT, 1000)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(agent, "psyche", "OLD.md"))).toBe(false)
    expect(git(remote, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).split("\n")).not.toContain("psyche/OLD.md")
    expect(git(agent, ["log", "-1", "--format=%s"])).toBe("sync: owner's psyche edit wins")
    expect(git(agent, ["status", "--porcelain"])).toBe("")
  })

  it("owner modified a psyche file the agent deleted: the owner's file is kept", async () => {
    const { remote, owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/OLD.md": "owner kept it\n" })
    fs.rmSync(path.join(agent, "psyche", "OLD.md"))

    expect(await syncNow(agent, CONFIG, AGENT, 1000)).toEqual({ ok: true })
    expect(read(agent, "psyche/OLD.md")).toBe("owner kept it\n")
    expect(remoteShow(remote, "main:psyche/OLD.md")).toBe("owner kept it")
  })

  it("aborts and records a non-psyche conflict, and tells the owner once for the same paths", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })
    write(agent, "notes.md", "agent notes\n")

    const first = await preTurnPull(agent, CONFIG)
    expect(first.ok).toBe(false)
    expect(first.error).toContain("notes.md")
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(read(agent, "notes.md")).toBe("agent notes\n")
    expect(git(agent, ["status", "--porcelain"])).toBe("")
    expect(pendingSync(agent)).toMatchObject({ classification: "pull_rebase_conflict", conflictFiles: ["notes.md"] })

    await preTurnPull(agent, CONFIG)
    await preTurnPull(agent, CONFIG)
    const conflictNotices = notices.filter((n) => n.notice.noticeId.startsWith("sync-conflict:"))
    expect(conflictNotices).toHaveLength(1)
    expect(conflictNotices[0].agentName).toBe(AGENT)
    expect(conflictNotices[0].notice.text).toContain("notes.md")
    expect(pendingSync(agent)).toMatchObject({ classification: "pull_rebase_conflict", consecutiveFailures: 3 })
  })

  it("repairs a merge left in progress", () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }) })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "merge", "origin/main"])).toThrow()
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(true)

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    expect(events.some((e) => e.event === "heart.sync_repaired")).toBe(true)
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(read(agent, "psyche/TACIT.md")).toBe(tacitWith({ 5: "owner 5" }))
    expect(git(agent, ["log", "--format=%B"])).not.toContain("<<<<<<<")
    expect(git(agent, ["status", "--porcelain"])).toBe("")
  })

  it("repairs a rebase left in progress", () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }) })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "rebase", "origin/main"])).toThrow()
    expect(fs.existsSync(path.join(agent, ".git", "rebase-merge"))).toBe(true)

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    expect(events.some((e) => e.event === "heart.sync_repaired")).toBe(true)
    expect(fs.existsSync(path.join(agent, ".git", "rebase-merge"))).toBe(false)
    expect(git(agent, ["symbolic-ref", "--short", "HEAD"])).toBe("main")
    expect(read(agent, "psyche/TACIT.md")).toBe(tacitWith({ 5: "owner 5" }))
  })

  it("an unpushed owner-wins merge, then the remote advances: integrate merges again with no replayed conflict", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 2: "owner 2" }) })
    write(agent, "psyche/TACIT.md", tacitWith({ 2: "agent 2", 18: "agent 18" }))
    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true })

    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 2: "owner 2 again" }) })
    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true })

    expect(read(agent, "psyche/TACIT.md")).toBe(tacitWith({ 2: "owner 2 again", 18: "agent 18" }))
    expect(git(agent, ["log", "--format=%s"]).split("\n").filter((s) => s === "sync: owner's psyche edit wins")).toHaveLength(1)
    expect(pendingSync(agent)).toBeNull()
  })

  it("push rejected becomes pending-sync, and the next integrate + push clears it", async () => {
    const { remote, owner, agent } = setup()
    ownerCommitAndPush(owner, { "owner.md": "from the mac\n" })
    write(agent, "agent.md", "from the butler\n")
    commitLocalChanges(agent, AGENT, "sync: post-turn update")

    const rejected = await pushAsync(agent, CONFIG, held(tryAcquireSyncLockSync(agent)))
    expect(rejected.ok).toBe(false)
    expect(pendingSync(agent)).toMatchObject({ classification: "push_rejected" })
    held(tryAcquireSyncLockSync(agent)).release()

    expect(await syncNow(agent, CONFIG, AGENT, 1000)).toEqual({ ok: true })
    expect(pendingSync(agent)).toBeNull()
    expect(remoteShow(remote, "main:owner.md")).toBe("from the mac")
    expect(remoteShow(remote, "main:agent.md")).toBe("from the butler")
  })

  it("a fetch that hangs is killed with its process group at the timeout", async () => {
    const { agent } = setup()
    const pidFile = path.join(root, "ssh-pids")
    const script = path.join(root, "slow-ssh.sh")
    fs.writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! >> "${pidFile}"\necho $$ >> "${pidFile}"\nwait\n`, { mode: 0o755 })
    process.env.GIT_SSH_COMMAND = script
    git(agent, ["remote", "set-url", "origin", "ssh://git@hang.invalid/repo.git"])
    __testHooks.fetchTimeoutMs = 1500

    const started = Date.now()
    const result = await fetchRemote(agent, CONFIG)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(10_000)

    const pids = fs.readFileSync(pidFile, "utf-8").trim().split("\n").map(Number)
    expect(pids).toHaveLength(2)
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    const deadline = Date.now() + 3000
    while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(pids.filter(alive)).toEqual([])
  })

  it("no remote: commits locally, ok, no pending record", async () => {
    const agent = path.join(root, `${AGENT}.ouro`)
    git(root, ["init", "-q", "-b", "main", agent])

    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true })
    write(agent, "psyche/SOUL.md", "soul\n")
    const post = postTurnPush(agent, CONFIG)
    expect(post.ok).toBe(true)
    expect(await post.push).toEqual({ ok: true })
    expect(git(agent, ["log", "-1", "--format=%s|%an"])).toBe("sync: post-turn update|butler")
    write(agent, "psyche/SOUL.md", "soul 2\n")
    expect(await syncNow(agent, CONFIG, AGENT, 1000)).toEqual({ ok: true })
    expect(git(agent, ["status", "--porcelain"])).toBe("")
    expect(pendingSync(agent)).toBeNull()
  })

  it("no upstream configured and local branch is master: pushes HEAD to origin main", async () => {
    const { remote, owner, agent } = setup({ agentBranch: "master" })
    ownerCommitAndPush(owner, { "owner.md": "owner\n" })
    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true })
    expect(read(agent, "owner.md")).toBe("owner\n")

    write(agent, "agent.md", "agent\n")
    const post = postTurnPush(agent, CONFIG)
    expect(post.ok).toBe(true)
    expect(await post.push).toEqual({ ok: true })
    expect(remoteShow(remote, "main:agent.md")).toBe("agent")
    expect(git(remote, ["--git-dir", remote, "branch", "--format=%(refname:short)"])).toBe("main")
  })

  it("sync-paused: no git runs, including syncNow", async () => {
    const { agent } = setup()
    const binDir = path.join(root, "bin")
    const gitLog = path.join(root, "git-calls")
    fs.mkdirSync(binDir)
    fs.writeFileSync(path.join(binDir, "git"), `#!/bin/sh\necho "$@" >> "${gitLog}"\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    write(agent, "state/sync-paused", JSON.stringify({ startedAt: new Date().toISOString(), expiresAt }))
    write(agent, "notes.md", "changed while paused\n")

    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true, paused: true, pausedUntil: expiresAt })
    const post = postTurnPush(agent, CONFIG)
    expect(post).toEqual({ ok: true, paused: true, pausedUntil: expiresAt })
    expect(await syncNow(agent, CONFIG, AGENT, 1000)).toEqual({ ok: true, paused: true, pausedUntil: expiresAt })
    expect(fs.existsSync(gitLog)).toBe(false)
  })

  it("an expired pause marker is removed and sync resumes", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })
    write(agent, "state/sync-paused", JSON.stringify({ startedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" }))

    expect(await preTurnPull(agent, CONFIG)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(agent, "state", "sync-paused"))).toBe(false)
    expect(events.some((e) => e.event === "heart.sync_pause_expired")).toBe(true)
    expect(read(agent, "notes.md")).toBe("owner notes\n")
  })

  it("commit, then push holds one lock with no gap: a pre-turn pull started between them waits", async () => {
    const { remote, agent } = setup()
    write(agent, "agent.md", "agent\n")

    const post = postTurnPush(agent, CONFIG)
    expect(post.ok).toBe(true)
    expect(git(agent, ["status", "--porcelain"])).toBe("")
    expect("busy" in tryAcquireSyncLockSync(agent)).toBe(true)

    const order: string[] = []
    const pull = preTurnPull(agent, CONFIG).then((r) => { order.push("pull"); return r })
    const push = post.push!.then((r) => { order.push("push"); return r })
    expect(await push).toEqual({ ok: true })
    expect(await pull).toEqual({ ok: true })
    expect(order).toEqual(["push", "pull"])
    expect(remoteShow(remote, "main:agent.md")).toBe("agent")
  })

  it("the same non-psyche conflict twice pushes HEAD to sync-conflict/<agent>", async () => {
    const { remote, owner, agent } = setup()
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })
    write(agent, "notes.md", "agent notes\n")

    expect((await preTurnPull(agent, CONFIG)).ok).toBe(false)
    expect(() => git(remote, ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/sync-conflict/butler"])).toThrow()

    write(agent, "journal.md", "a later turn\n")
    expect((await preTurnPull(agent, CONFIG)).ok).toBe(false)
    expect(git(remote, ["--git-dir", remote, "rev-parse", "refs/heads/sync-conflict/butler"])).toBe(git(agent, ["rev-parse", "HEAD"]))

    expect((await preTurnPull(agent, CONFIG)).ok).toBe(false)
    const branchNotices = notices.filter((n) => n.notice.noticeId.startsWith("sync-conflict-branch:"))
    expect(branchNotices).toHaveLength(1)
    expect(branchNotices[0].notice.text).toContain("sync-conflict/butler")
    expect(remoteShow(remote, "main:notes.md")).toBe("owner notes")
  })

  it("\"would be overwritten\" is recorded as a failure", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "big.bin": "small on the mac\n" })
    fs.writeFileSync(path.join(agent, "big.bin"), "")
    fs.truncateSync(path.join(agent, "big.bin"), SYNC_FILE_SIZE_LIMIT_BYTES + 1)

    const result = await preTurnPull(agent, CONFIG)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("would be overwritten")
    expect(pendingSync(agent)).toMatchObject({ classification: "unknown", conflictFiles: [] })
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(fs.statSync(path.join(agent, "big.bin")).size).toBe(SYNC_FILE_SIZE_LIMIT_BYTES + 1)
  })
})
