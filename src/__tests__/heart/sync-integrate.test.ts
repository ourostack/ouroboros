import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  __testHooks.killGraceMs = undefined
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

  it("repair after a stranded rebase keeps edits made since", () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }) })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    write(agent, "other.md", "uncommitted before rebase\n")
    git(agent, [...OWNER, "commit", "-q", "-m", "agent edit", "--", "psyche/TACIT.md"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "rebase", "--autostash", "origin/main"])).toThrow()
    write(agent, "other.md", "rewritten during the stranded rebase\n")
    write(agent, "journal/new.md", "brand new file\n")

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    expect(read(agent, "other.md")).toBe("rewritten during the stranded rebase\n")
    expect(read(agent, "journal/new.md")).toBe("brand new file\n")
    expect(git(agent, ["show", "HEAD:other.md"])).toBe("rewritten during the stranded rebase")
    expect(git(agent, ["symbolic-ref", "--short", "HEAD"])).toBe("main")
    expect(git(agent, ["for-each-ref", "--format=%(refname)", "refs/ouro-sync/repair/"])).toMatch(/^refs\/ouro-sync\/repair\/\d{4}-\d{2}-\d{2}T/)
    expect(git(agent, ["status", "--porcelain"])).toBe("")
  })

  it("repair keeps a commit made on the rebase's detached HEAD", () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }) })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "rebase", "origin/main"])).toThrow()
    // What the old postTurnPush did while a rebase stayed stranded.
    write(agent, "journal/turn.md", "a whole turn of memories\n")
    git(agent, [...OWNER, "add", "-A"])
    git(agent, [...OWNER, "commit", "-q", "-m", "sync: post-turn update"])
    const stranded = git(agent, ["rev-parse", "HEAD"])

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    expect(read(agent, "journal/turn.md")).toBe("a whole turn of memories\n")
    expect(git(agent, ["show", "HEAD:journal/turn.md"])).toBe("a whole turn of memories")
    expect(git(agent, ["for-each-ref", "--contains", stranded, "--format=%(refname)", "refs/ouro-sync/repair/"])).not.toBe("")
  })

  it("repair after a stranded merge keeps an edit to the conflicted file in a recoverable ref", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }), "other.md": "owner other\n" })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "merge", "origin/main"])).toThrow()
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5", 15: "agent wrote line 15 while merge stranded" }))
    write(agent, "notes.md", "agent notes while stranded\n")

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    await new Promise((r) => setImmediate(r))
    expect(read(agent, "notes.md")).toBe("agent notes while stranded\n")
    expect(read(agent, "psyche/TACIT.md")).toBe(tacitWith({ 5: "owner 5" }))
    const ref = git(agent, ["for-each-ref", "--format=%(refname)", "refs/ouro-sync/repair/"])
    expect(git(agent, ["show", `${ref}:psyche/TACIT.md`])).toContain("agent wrote line 15 while merge stranded")
    expect(pendingSync(agent)).toMatchObject({ conflictFiles: ["psyche/TACIT.md"], error: expect.stringContaining(ref) })
    const repairNotices = notices.filter((n) => n.notice.noticeId.startsWith("sync-repair:"))
    expect(repairNotices).toHaveLength(1)
    expect(repairNotices[0].notice.text).toContain(ref)
    expect(repairNotices[0].notice.text).toContain("psyche/TACIT.md")
  })

  it("repair succeeds when a merged file was edited after the merge stranded", () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }), "other.md": "owner other\n" })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "merge", "origin/main"])).toThrow()
    write(agent, "other.md", "agent edited a file the merge had staged\n")

    // `merge --abort` and `reset --merge` both refuse here ("not uptodate"); repair must not wedge.
    const result = integrateFetched(agent, CONFIG, AGENT)
    expect(events.find((e) => e.event === "heart.sync_repaired")?.meta).toMatchObject({ abortedWith: "reset --hard" })
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(read(agent, "other.md")).toBe("agent edited a file the merge had staged\n")
    expect(git(agent, ["show", "HEAD:other.md"])).toBe("agent edited a file the merge had staged")
    // The kept edit and the owner's other.md now genuinely conflict: the normal conflict path, not a wedge.
    expect(result).toEqual({ ok: false, error: expect.stringContaining("conflicts in other.md") })
    expect(pendingSync(agent)).toMatchObject({ classification: "pull_rebase_conflict" })
    expect(postTurnPush(agent, CONFIG, AGENT).ok).toBe(true)
  })

  it("repair falls back to reset --merge when merge --abort refuses", () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })
    write(agent, "notes.md", "agent notes\n")
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "merge", "origin/main"])).toThrow()
    write(agent, "journal.md", "kept\n")
    // No real git refuses `merge --abort` and then accepts `reset --merge`; simulate the refusal.
    __testHooks.mergeAbortArgs = ["merge", "--abort", "--no-such-option"]
    try {
      integrateFetched(agent, CONFIG, AGENT)
    } finally {
      __testHooks.mergeAbortArgs = undefined
    }
    expect(events.find((e) => e.event === "heart.sync_repaired")?.meta).toMatchObject({ abortedWith: "reset --merge" })
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(git(agent, ["show", "HEAD:journal.md"])).toBe("kept")
    expect(read(agent, "notes.md")).toBe("agent notes\n")
  })

  it("postTurnPush logs the end of its synchronous commit before the network push ends", async () => {
    const { agent } = setup()
    write(agent, "journal.md", "a turn\n")
    events.length = 0
    const post = postTurnPush(agent, CONFIG, AGENT)
    const beforePush = events.map((entry) => entry.event).filter((name) => name.startsWith("heart.sync_"))
    await post.push
    const all = events.map((entry) => entry.event).filter((name) => name.startsWith("heart.sync_"))
    expect(beforePush).toEqual(["heart.sync_push_start", "heart.sync_commit_end"])
    expect(all.indexOf("heart.sync_commit_end")).toBeLessThan(all.indexOf("heart.sync_push_end"))
    expect(events.find((entry) => entry.event === "heart.sync_commit_end")?.meta).toEqual({ agentRoot: agent })
  })

  it("postTurnPush repairs a stranded merge before it commits", async () => {
    const { owner, agent } = setup()
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })
    write(agent, "notes.md", "agent notes\n")
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "merge", "origin/main"])).toThrow()
    write(agent, "journal.md", "a turn while stranded\n")

    const post = postTurnPush(agent, CONFIG, AGENT)
    expect(post.ok).toBe(true)
    await post.push
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(git(agent, ["show", "HEAD:journal.md"])).toBe("a turn while stranded")
    expect(git(agent, ["log", "--format=%B"])).not.toContain("<<<<<<<")
    expect(read(agent, "notes.md")).toBe("agent notes\n")
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

  it("a timed-out fetch gets SIGTERM first, so sudo can relay it, then SIGKILL after the grace", async () => {
    const { agent } = setup()
    const record = path.join(root, "ssh-signals")
    const script = path.join(root, "stubborn-ssh.sh")
    // Like an ssh run under sudo: it gets the SIGTERM (relayed, in production) and outlives it.
    fs.writeFileSync(script, `#!/bin/sh\ntrap 'echo TERM >> "${record}"' TERM\nwhile :; do sleep 0.1; done\n`, { mode: 0o755 })
    process.env.GIT_SSH_COMMAND = script
    git(agent, ["remote", "set-url", "origin", "ssh://git@hang.invalid/repo.git"])
    __testHooks.fetchTimeoutMs = 600
    __testHooks.killGraceMs = 700
    const kills: Array<{ pid: number; sig: string; at: number }> = []
    const realKill = process.kill.bind(process)
    const spy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      if (pid < 0) kills.push({ pid, sig: String(sig), at: Date.now() })
      return realKill(pid, sig)
    })
    // Only this fetch's group: an earlier test's grace timer can still fire into the spy.
    const mine = (): typeof kills => {
      const term = kills.find((k) => k.sig === "SIGTERM")
      return term ? kills.filter((k) => k.pid === term.pid) : []
    }
    const waitForKills = async (): Promise<void> => {
      const deadline = Date.now() + 5000
      while (mine().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    }
    try {
      const result = await fetchRemote(agent, CONFIG)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("timed out")
      await waitForKills()
      const first = mine()
      expect(first.map((k) => k.sig)).toEqual(["SIGTERM", "SIGKILL"])
      expect(first[1]!.at - first[0]!.at).toBeGreaterThanOrEqual(650)
      expect(fs.readFileSync(record, "utf-8")).toContain("TERM")

      // An abort after the timeout has ended git signals nothing more.
      kills.length = 0
      const controller = new AbortController()
      const pending = fetchRemote(agent, CONFIG, controller.signal)
      await new Promise((r) => setTimeout(r, 900))
      controller.abort()
      await pending
      await waitForKills()
      await new Promise((r) => setTimeout(r, 300))
      expect(mine().map((k) => k.sig)).toEqual(["SIGTERM", "SIGKILL"])
    } finally {
      spy.mockRestore()
    }
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

describe("repair never loses a stranded state's work (fix round 2)", () => {
  function strandMerge(owner: string, agent: string, ownerFiles: Record<string, string> = {}): void {
    ownerCommitAndPush(owner, { "psyche/TACIT.md": tacitWith({ 5: "owner 5" }), ...ownerFiles })
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "merge", "origin/main"])).toThrow()
  }
  const repairRefs = (agent: string): string[] =>
    git(agent, ["for-each-ref", "--format=%(refname)", "refs/ouro-sync/repair/"]).split("\n").filter(Boolean)
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

  it("repair leaves a stranded merge alone when the snapshot fails", async () => {
    const { owner, agent } = setup()
    strandMerge(owner, agent)
    const edited = tacitWith({ 5: "agent 5", 15: "line 15 while stranded" })
    write(agent, "psyche/TACIT.md", edited)
    write(agent, "secret.txt", "x\n")
    const secret = path.join(agent, "secret.txt")
    fs.chmodSync(secret, 0o000)
    try {
      for (let i = 0; i < 2; i++) {
        const result = integrateFetched(agent, CONFIG, AGENT)
        expect(result.ok).toBe(false)
        expect(result.error).toContain("Permission denied")
        expect(postTurnPush(agent, CONFIG, AGENT).ok).toBe(false)
      }
      await tick()
      expect(fs.statSync(secret).mode & 0o777).toBe(0)
      expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(true)
      expect(read(agent, "psyche/TACIT.md")).toBe(edited)
      expect(git(agent, ["diff", "--name-only", "--diff-filter=U"])).toBe("psyche/TACIT.md")
      expect(repairRefs(agent)).toEqual([])
      expect(pendingSync(agent)).toMatchObject({ classification: "repair_snapshot_failed", error: expect.stringContaining("Permission denied") })
      expect(notices.filter((n) => n.notice.noticeId.startsWith("sync-repair-snapshot:"))).toHaveLength(1)
    } finally {
      fs.chmodSync(secret, 0o644)
    }
    // Once the file is readable again, repair goes ahead and keeps the edit.
    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(agent, ".git", "MERGE_HEAD"))).toBe(false)
    expect(git(agent, ["show", `${repairRefs(agent)[0]}:psyche/TACIT.md`])).toContain("line 15 while stranded")
  })

  it("repair restores a change set larger than ARG_MAX", () => {
    const { owner, agent } = setup()
    // The owner pushes 25,000 paths of about 80 bytes each (2 MB of names), built in one write-tree.
    const hash = (content: string): string =>
      execFileSync(REAL_GIT, ["hash-object", "-w", "--stdin"], { cwd: owner, input: content }).toString().trim()
    const name = (i: number): string => `journal/${"x".repeat(60)}-${String(i).padStart(6, "0")}.md`
    const env = { ...process.env, GIT_INDEX_FILE: path.join(root, "big.index") }
    const entry = hash("entry\n")
    const lines = Array.from({ length: 25_000 }, (_, i) => `100644 ${entry}\t${name(i)}`)
    lines.push(`100644 ${hash(tacitWith({ 5: "owner 5" }))}\tpsyche/TACIT.md`)
    execFileSync(REAL_GIT, ["read-tree", "HEAD"], { cwd: owner, env })
    execFileSync(REAL_GIT, ["update-index", "--index-info"], { cwd: owner, env, input: lines.join("\n") + "\n" })
    const tree = execFileSync(REAL_GIT, ["write-tree"], { cwd: owner, env }).toString().trim()
    const commit = ownerGit(owner, ["commit-tree", tree, "-p", "HEAD", "-m", "owner adds a big journal"])
    ownerGit(owner, ["update-ref", "refs/heads/main", commit])
    ownerGit(owner, ["push", "-q", "origin", "main"])

    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5" }))
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(() => git(agent, [...OWNER, "rebase", "origin/main"])).toThrow()
    write(agent, "notes.md", "tracked edit while stranded\n")

    const started = Date.now()
    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    events.push({ event: "test.timing", meta: { ms: Date.now() - started } } as unknown as LogEvent)
    expect(read(agent, "notes.md")).toBe("tracked edit while stranded\n")
    expect(git(agent, ["show", "HEAD:notes.md"])).toBe("tracked edit while stranded")
    expect(fs.readdirSync(path.join(agent, "journal"))).toHaveLength(25_000)
    expect(git(agent, ["status", "--porcelain"])).toBe("")
    expect(events.some((e) => e.event === "heart.sync_repaired")).toBe(true)
  }, 120_000)

  it("a restore that fails partway names the ref and keeps the pending record", async () => {
    const { owner, agent } = setup()
    write(agent, "ro/kept.md", "agent only\n")
    git(agent, [...OWNER, "add", "-A"])
    git(agent, [...OWNER, "commit", "-q", "-m", "agent file"])
    strandMerge(owner, agent)
    write(agent, "notes.md", "notes edit while stranded\n")
    write(agent, "ro/kept.md", "edit while stranded\n")
    const ro = path.join(agent, "ro")
    fs.chmodSync(ro, 0o555)
    let result
    try {
      result = integrateFetched(agent, CONFIG, AGENT)
    } finally {
      fs.chmodSync(ro, 0o755)
    }
    const [ref] = repairRefs(agent)
    expect(result).toEqual({ ok: false, error: expect.stringContaining(ref) })
    expect(read(agent, "notes.md")).toBe("notes edit while stranded\n")
    expect(pendingSync(agent)).toMatchObject({ classification: "repair_restore_incomplete", repairRef: ref })
    await tick()
    const restoreNotices = notices.filter((n) => n.notice.noticeId.startsWith("sync-repair-restore:"))
    expect(restoreNotices).toHaveLength(1)
    expect(restoreNotices[0].notice.text).toContain(ref)
    // A later failure does not overwrite it.
    ownerCommitAndPush(owner, { "notes.md": "owner notes\n" })
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(integrateFetched(agent, CONFIG, AGENT).ok).toBe(false)
    expect(pendingSync(agent)).toMatchObject({ classification: "repair_restore_incomplete", repairRef: ref })
    // Later syncs succeed, but only a person clears this record.
    ownerCommitAndPush(owner, { "notes.md": "notes edit while stranded\n" })
    git(agent, ["fetch", "-q", "origin", "main"])
    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    const post = postTurnPush(agent, CONFIG, AGENT)
    await post.push
    expect(pendingSync(agent)).toMatchObject({ classification: "repair_restore_incomplete", repairRef: ref })
  })

  it("repair reuses the newest repair ref when the snapshot tree matches it", () => {
    const { owner, agent } = setup()
    strandMerge(owner, agent)
    write(agent, "psyche/TACIT.md", tacitWith({ 5: "agent 5", 15: "edited" }))
    const env = { ...process.env, GIT_INDEX_FILE: path.join(root, "probe.index") }
    execFileSync(REAL_GIT, ["read-tree", "HEAD"], { cwd: agent, env })
    execFileSync(REAL_GIT, ["add", "-A"], { cwd: agent, env })
    const tree = execFileSync(REAL_GIT, ["write-tree"], { cwd: agent, env }).toString().trim()
    const existing = "refs/ouro-sync/repair/2026-11-01T00-00-00.000Z"
    git(agent, ["update-ref", existing, git(agent, [...OWNER, "commit-tree", tree, "-p", "HEAD", "-m", "earlier"])])

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    expect(repairRefs(agent)).toEqual([existing])
    expect(pendingSync(agent)).toMatchObject({ repairRef: existing })
  })

  it("repair prunes old refs, keeping the newest ten, those under 30 days and the pending one", () => {
    const { owner, agent } = setup()
    const make = (ref: string, daysAgo: number): void => {
      const date = `${Math.floor(Date.now() / 1000) - daysAgo * 86_400} +0000`
      const commit = execFileSync(REAL_GIT, [...OWNER, "commit-tree", git(agent, ["rev-parse", "HEAD^{tree}"]), "-m", ref], {
        cwd: agent,
        env: { ...process.env, GIT_COMMITTER_DATE: date },
      }).toString().trim()
      git(agent, ["update-ref", ref, commit])
    }
    const old = (i: number): string => `refs/ouro-sync/repair/2026-01-${String(i).padStart(2, "0")}T00-00-00.000Z`
    for (let i = 1; i <= 13; i++) make(old(i), 40)
    const recent = "refs/ouro-sync/repair/2025-12-01T00-00-00.000Z"
    make(recent, 1)
    write(agent, "state/pending-sync.json", JSON.stringify({ error: "x", failedAt: "2026-01-01T00:00:00.000Z", classification: "unknown", conflictFiles: [], repairRef: old(1) }))
    strandMerge(owner, agent)

    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    const refs = repairRefs(agent)
    // The new ref plus the nine newest old ones, the recent one and the pending one.
    expect(refs).toHaveLength(12)
    for (const gone of [old(2), old(3), old(4)]) expect(refs).not.toContain(gone)
    for (const kept of [old(1), recent, ...[5, 6, 7, 8, 9, 10, 11, 12, 13].map(old)]) expect(refs).toContain(kept)
  })

  it("the repair notice claims kept edits only for conflicted paths that differ from HEAD", async () => {
    const { owner, agent } = setup()
    strandMerge(owner, agent)
    git(agent, ["checkout", "--ours", "--", "psyche/TACIT.md"])
    expect(integrateFetched(agent, CONFIG, AGENT)).toEqual({ ok: true })
    await tick()
    expect(notices.filter((n) => n.notice.noticeId.startsWith("sync-repair:"))).toEqual([])
    expect(pendingSync(agent)).toBeNull()
  })
})
