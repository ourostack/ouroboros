import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"
import {
  __testHooks,
  clearPendingSync,
  commitLocalChanges,
  fetchRemote,
  integrateFetched,
  pendingSyncPath,
  postTurnPush,
  preTurnPull,
  pushAsync,
  setSyncOwnerNotifier,
  skippedSyncFilesPath,
  STALE_INDEX_LOCK_MS,
  SYNC_FILE_SIZE_LIMIT_BYTES,
  syncNow,
  type SyncOwnerNotice,
  type SyncResult,
} from "../../heart/sync"
import { tryAcquireSyncLockSync, type SyncLockHandle } from "../../heart/sync-lock"

// Real git throughout. The scenarios the M1c brief names live in
// sync-integrate.test.ts; this file covers the edges: failure records, the
// index-lock and size guards, the lock, pause markers and owner notices.

const AGENT = "agent"
const CONFIG = { enabled: true, remote: "origin", branch: "main" }
const ID = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]

let root: string
let events: LogEvent[]
let unregister: () => void
let notices: SyncOwnerNotice[]
let savedGlobal: string | undefined

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...ID, ...args], { cwd, stdio: "pipe" }).toString().trim()
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content, "utf-8")
}

function sparse(dir: string, rel: string, bytes: number): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), "")
  fs.truncateSync(path.join(dir, rel), bytes)
}

function localBundle(): string {
  const bundle = path.join(root, `${AGENT}.ouro`)
  git(root, ["init", "-q", "-b", "main", bundle])
  write(bundle, ".gitignore", "state/\n")
  return bundle
}

function bundleWithRemote(seed = true): { bundle: string; remote: string; owner: string } {
  const remote = path.join(root, "remote.git")
  const owner = path.join(root, "owner")
  const bundle = path.join(root, `${AGENT}.ouro`)
  git(root, ["init", "-q", "--bare", "-b", "main", remote])
  git(root, ["clone", "-q", remote, owner])
  if (seed) {
    write(owner, ".gitignore", "state/\n")
    write(owner, "notes.md", "notes\n")
    write(owner, "psyche/TACIT.md", "a\nb\nc\nd\ne\nf\n")
    git(owner, ["add", "-A"])
    git(owner, ["commit", "-q", "-m", "seed"])
    git(owner, ["push", "-q", "origin", "HEAD:main"])
  }
  git(root, ["clone", "-q", remote, bundle])
  return { bundle, remote, owner }
}

function ownerPush(owner: string, rel: string, content: string): void {
  write(owner, rel, content)
  git(owner, ["add", "-A"])
  git(owner, ["commit", "-q", "-m", `owner ${rel}`])
  git(owner, ["push", "-q", "origin", "HEAD:main"])
}

function pending(bundle: string): Record<string, unknown> | null {
  return fs.existsSync(pendingSyncPath(bundle)) ? JSON.parse(fs.readFileSync(pendingSyncPath(bundle), "utf-8")) as Record<string, unknown> : null
}

function lock(bundle: string): SyncLockHandle {
  const handle = tryAcquireSyncLockSync(bundle)
  if ("busy" in handle) throw new Error("lock unexpectedly busy")
  return handle
}

async function settled(result: SyncResult & { push?: Promise<SyncResult> }): Promise<SyncResult> {
  return result.push ? await result.push : result
}

function emitted(event: string): LogEvent[] {
  return events.filter((e) => e.event === event)
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-edges-")))
  savedGlobal = process.env.GIT_CONFIG_GLOBAL
  events = []
  unregister = registerGlobalLogSink((entry) => { events.push(entry) })
  notices = []
  setSyncOwnerNotifier((_agent, notice) => { notices.push(notice) })
})

afterEach(() => {
  unregister()
  setSyncOwnerNotifier(null)
  __testHooks.fetchTimeoutMs = undefined
  __testHooks.pushTimeoutMs = undefined
  __testHooks.preTurnLockWaitMs = undefined
  __testHooks.extraGitConfig = undefined
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal
  vi.doUnmock("../../senses/telegram")
  fs.chmodSync(root, 0o755)
  for (const dir of [path.join(root, `${AGENT}.ouro`, ".git")]) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755)
  fs.rmSync(root, { recursive: true, force: true })
})

describe("not a git repo", () => {
  it("every entry point says the bundle is not a git repository", async () => {
    const bundle = path.join(root, "plain.ouro")
    fs.mkdirSync(bundle)
    for (const result of [await preTurnPull(bundle, CONFIG), postTurnPush(bundle, CONFIG), await syncNow(bundle, CONFIG, AGENT, 0)]) {
      expect(result.ok).toBe(false)
      expect(result.error).toBe("my bundle is not a git repository")
    }
    expect(emitted("heart.sync_not_a_repo")).toHaveLength(3)
  })

  it("a broken .git fails the pull with git's message", async () => {
    const bundle = path.join(root, "broken.ouro")
    fs.mkdirSync(path.join(bundle, ".git"), { recursive: true })
    const result = await preTurnPull(bundle, CONFIG)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^git remote failed: /)
  })

  it("a push in a directory git cannot read is recorded, not thrown", async () => {
    const bundle = path.join(root, "broken.ouro")
    fs.mkdirSync(path.join(bundle, ".git"), { recursive: true })
    const handle = lock(bundle)
    const result = await pushAsync(bundle, CONFIG, handle)
    expect(result.ok).toBe(false)
    expect(pending(bundle)).toMatchObject({ classification: "unknown" })
    lock(bundle).release()
  })
})

describe("commitLocalChanges", () => {
  it("leaves oversized files uncommitted, records them, and commits the rest", () => {
    const bundle = localBundle()
    write(bundle, "notes.md", "hi\n")
    sparse(bundle, "big.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)

    const result = commitLocalChanges(bundle, AGENT, "m")
    expect(result).toEqual({ committed: true, skipped: [{ path: "big.jsonl", bytes: SYNC_FILE_SIZE_LIMIT_BYTES + 1 }] })
    expect(git(bundle, ["ls-files"]).split("\n")).toEqual([".gitignore", "notes.md"])
    expect(JSON.parse(fs.readFileSync(skippedSyncFilesPath(bundle), "utf-8")).files).toHaveLength(1)
    expect(emitted("heart.sync_oversized_files_skipped")).toHaveLength(1)
  })

  it("commits nothing when every change is over the limit, then forgets the skip once it is gone", () => {
    const bundle = localBundle()
    write(bundle, "notes.md", "hi\n")
    commitLocalChanges(bundle, AGENT, "m")
    sparse(bundle, "big.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    expect(commitLocalChanges(bundle, AGENT, "m").committed).toBe(false)
    expect(fs.existsSync(skippedSyncFilesPath(bundle))).toBe(true)
    fs.rmSync(path.join(bundle, "big.jsonl"))
    expect(commitLocalChanges(bundle, AGENT, "m")).toEqual({ committed: false, skipped: [] })
    expect(fs.existsSync(skippedSyncFilesPath(bundle))).toBe(false)
  })

  it("unstages both sides of a rename whose new path is over the limit", () => {
    const bundle = localBundle()
    sparse(bundle, "old.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    git(bundle, ["add", "old.jsonl"])
    git(bundle, ["commit", "-q", "-m", "big from before the guard"])
    fs.renameSync(path.join(bundle, "old.jsonl"), path.join(bundle, "new.jsonl"))
    write(bundle, "notes.md", "n\n")
    expect(commitLocalChanges(bundle, AGENT, "m").committed).toBe(true)
    expect(git(bundle, ["ls-files"]).split("\n")).toEqual([".gitignore", "notes.md", "old.jsonl"])
  })

  it("still commits when the skipped-files record cannot be written or removed", () => {
    const bundle = localBundle()
    fs.mkdirSync(path.join(skippedSyncFilesPath(bundle), "blocker"), { recursive: true })
    write(bundle, "notes.md", "hi\n")
    sparse(bundle, "big.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    expect(commitLocalChanges(bundle, AGENT, "m").committed).toBe(true)
    fs.rmSync(path.join(bundle, "big.jsonl"))
    write(bundle, "notes.md", "again\n")
    expect(commitLocalChanges(bundle, AGENT, "m").committed).toBe(true)
  })

  it("refuses to commit unmerged paths", () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    git(bundle, ["commit", "-q", "-am", "agent"])
    git(bundle, ["fetch", "-q"])
    expect(() => git(bundle, ["merge", "origin/main"])).toThrow()
    fs.rmSync(path.join(bundle, ".git", "MERGE_HEAD"))
    expect(() => commitLocalChanges(bundle, AGENT, "m")).toThrow("unmerged paths in the index: notes.md")
  })

  it("removes an empty index.lock left by a dead git process, and keeps one with content", () => {
    const bundle = localBundle()
    const lockPath = path.join(bundle, ".git", "index.lock")
    const old = new Date(Date.now() - STALE_INDEX_LOCK_MS - 60_000)
    fs.writeFileSync(lockPath, "")
    fs.utimesSync(lockPath, old, old)
    write(bundle, "notes.md", "hi\n")
    expect(commitLocalChanges(bundle, AGENT, "m").committed).toBe(true)
    expect(emitted("heart.sync_stale_lock_cleared")).toHaveLength(1)

    fs.writeFileSync(lockPath, "live commit")
    fs.utimesSync(lockPath, old, old)
    write(bundle, "notes.md", "again\n")
    expect(() => commitLocalChanges(bundle, AGENT, "m")).toThrow(/index\.lock/)
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  it("reports, rather than throws, when a stale index.lock cannot be removed", () => {
    const bundle = localBundle()
    const lockPath = path.join(bundle, ".git", "index.lock")
    const old = new Date(Date.now() - STALE_INDEX_LOCK_MS - 60_000)
    fs.writeFileSync(lockPath, "")
    fs.utimesSync(lockPath, old, old)
    write(bundle, "notes.md", "hi\n")
    fs.chmodSync(path.join(bundle, ".git"), 0o555)
    try {
      expect(() => commitLocalChanges(bundle, AGENT, "m")).toThrow()
    } finally {
      fs.chmodSync(path.join(bundle, ".git"), 0o755)
    }
    expect(emitted("heart.sync_stale_lock_clear_failed")).toHaveLength(1)
  })
})

describe("postTurnPush", () => {
  it("records a commit failure, counting repeats from the first one", () => {
    const bundle = localBundle()
    const lockPath = path.join(bundle, ".git", "index.lock")
    fs.writeFileSync(lockPath, "")
    write(bundle, "notes.md", "hi\n")
    expect(postTurnPush(bundle, CONFIG, AGENT).ok).toBe(false)
    const first = pending(bundle)!
    expect(first).toMatchObject({ classification: "unknown", conflictFiles: [], consecutiveFailures: 1 })
    expect(postTurnPush(bundle, CONFIG, AGENT).ok).toBe(false)
    expect(pending(bundle)).toMatchObject({ consecutiveFailures: 2, firstFailedAt: first.firstFailedAt })
    expect("busy" in tryAcquireSyncLockSync(bundle)).toBe(false)
  })

  it("continues the count from a record written before the count existed, and restarts after a non-object", () => {
    const bundle = localBundle()
    fs.writeFileSync(path.join(bundle, ".git", "index.lock"), "")
    write(bundle, "notes.md", "hi\n")
    write(bundle, "state/pending-sync.json", JSON.stringify({ error: "old", failedAt: "2026-06-01T00:00:00.000Z", classification: "unknown" }))
    postTurnPush(bundle, CONFIG)
    expect(pending(bundle)).toMatchObject({ consecutiveFailures: 2, firstFailedAt: "2026-06-01T00:00:00.000Z" })
    write(bundle, "state/pending-sync.json", "[1]")
    postTurnPush(bundle, CONFIG)
    expect(pending(bundle)).toMatchObject({ consecutiveFailures: 1 })
  })

  it("still returns the failure when the record cannot be written", () => {
    const bundle = localBundle()
    fs.writeFileSync(path.join(bundle, ".git", "index.lock"), "")
    write(bundle, "notes.md", "hi\n")
    fs.writeFileSync(path.join(bundle, "state"), "not a directory")
    const result = postTurnPush(bundle, CONFIG)
    expect(result.ok).toBe(false)
  })

  it("skips when another sync holds the lock", () => {
    const bundle = localBundle()
    const handle = lock(bundle)
    write(bundle, "notes.md", "hi\n")
    expect(postTurnPush(bundle, CONFIG)).toEqual({ ok: true, busy: true, holderPid: process.pid })
    handle.release()
    expect(git(bundle, ["status", "--porcelain"])).toBe("?? .gitignore\n?? notes.md")
  })

  it("with nothing to push, clears the failure record and releases the lock", () => {
    const { bundle } = bundleWithRemote()
    write(bundle, "state/pending-sync.json", JSON.stringify({ error: "old", failedAt: "2026-06-01T00:00:00.000Z", classification: "push_rejected" }))
    expect(postTurnPush(bundle, CONFIG)).toEqual({ ok: true })
    expect(pending(bundle)).toBeNull()
    lock(bundle).release()
  })

  it("pushes commits an earlier failure left behind even when nothing changed", async () => {
    const { bundle, remote } = bundleWithRemote()
    write(bundle, "notes.md", "stranded\n")
    git(bundle, ["commit", "-q", "-am", "stranded"])
    expect(await settled(postTurnPush(bundle, CONFIG))).toEqual({ ok: true })
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("stranded")
  })

  it("an empty repo with a remote has nothing to push", () => {
    const bundle = path.join(root, "empty.ouro")
    git(root, ["init", "-q", "-b", "main", bundle])
    git(bundle, ["remote", "add", "origin", path.join(root, "nowhere.git")])
    expect(postTurnPush(bundle, CONFIG)).toEqual({ ok: true })
  })

  it("first push to an empty remote creates the branch", async () => {
    const { bundle, remote } = bundleWithRemote(false)
    expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true })
    write(bundle, "notes.md", "first\n")
    expect(await settled(postTurnPush(bundle, CONFIG))).toEqual({ ok: true })
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("first")
  })

  it("while a non-psyche conflict is unresolved, commits and does not push", async () => {
    const { bundle, owner, remote } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    expect((await preTurnPull(bundle, CONFIG)).ok).toBe(false)
    write(bundle, "journal.md", "later\n")
    expect(postTurnPush(bundle, CONFIG)).toEqual({ ok: true })
    expect(git(bundle, ["status", "--porcelain"])).toBe("")
    expect(pending(bundle)).toMatchObject({ classification: "pull_rebase_conflict" })
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("owner")
  })

  it("a push to an unreachable remote is recorded as unknown", async () => {
    const { bundle } = bundleWithRemote()
    git(bundle, ["remote", "set-url", "origin", path.join(root, "missing.git")])
    write(bundle, "notes.md", "x\n")
    const result = await settled(postTurnPush(bundle, CONFIG))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^git push failed: /)
    expect(pending(bundle)).toMatchObject({ classification: "unknown" })
  })

  it("a push that hangs is killed at the timeout and recorded", async () => {
    const { bundle } = bundleWithRemote()
    const saved = process.env.GIT_SSH_COMMAND
    const script = path.join(root, "ssh.sh")
    fs.writeFileSync(script, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 })
    process.env.GIT_SSH_COMMAND = script
    try {
      git(bundle, ["remote", "set-url", "origin", "ssh://git@hang.invalid/r.git"])
      __testHooks.pushTimeoutMs = 300
      write(bundle, "notes.md", "x\n")
      expect(await settled(postTurnPush(bundle, CONFIG))).toEqual({ ok: false, error: "git push timed out after 300 ms" })
    } finally {
      if (saved === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = saved
    }
  })
})

describe("integrate", () => {
  it("a fetch with an already-aborted signal runs nothing", async () => {
    const { bundle } = bundleWithRemote()
    const controller = new AbortController()
    controller.abort()
    expect(await fetchRemote(bundle, CONFIG, controller.signal)).toEqual({ ok: false, error: "git fetch aborted" })
  })

  it("repairs a rebase --apply left in progress", () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "psyche/TACIT.md", "a\nOWNER\nc\nd\ne\nf\n")
    write(bundle, "psyche/TACIT.md", "a\nAGENT\nc\nd\ne\nf\n")
    git(bundle, ["commit", "-q", "-am", "agent"])
    git(bundle, ["fetch", "-q"])
    expect(() => git(bundle, ["rebase", "--apply", "origin/main"])).toThrow()
    expect(fs.existsSync(path.join(bundle, ".git", "rebase-apply"))).toBe(true)
    expect(integrateFetched(bundle, CONFIG, AGENT)).toEqual({ ok: true })
    expect(emitted("heart.sync_repaired")[0].meta).toMatchObject({ rebase: true, merge: false })
    expect(fs.readFileSync(path.join(bundle, "psyche", "TACIT.md"), "utf-8")).toBe("a\nOWNER\nc\nd\ne\nf\n")
  })

  it("a merge commit refused by a hook is aborted and recorded", () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "owner.md", "o\n")
    write(bundle, "agent.md", "a\n")
    fs.writeFileSync(path.join(bundle, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    __testHooks.extraGitConfig = ["-c", `core.hooksPath=${path.join(bundle, ".git", "hooks")}`]
    git(bundle, ["fetch", "-q"])
    const result = integrateFetched(bundle, CONFIG, AGENT)
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(bundle, ".git", "MERGE_HEAD"))).toBe(false)
    expect(pending(bundle)).toMatchObject({ classification: "unknown" })
  })

  it("an owner-wins merge refused by a hook is aborted and recorded", () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "psyche/TACIT.md", "a\nOWNER\nc\nd\ne\nf\n")
    write(bundle, "psyche/TACIT.md", "a\nAGENT\nc\nd\ne\nf\n")
    fs.writeFileSync(path.join(bundle, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    __testHooks.extraGitConfig = ["-c", `core.hooksPath=${path.join(bundle, ".git", "hooks")}`]
    git(bundle, ["fetch", "-q"])
    const result = integrateFetched(bundle, CONFIG, AGENT)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^git merge failed: /)
    expect(fs.existsSync(path.join(bundle, ".git", "MERGE_HEAD"))).toBe(false)
    expect(emitted("heart.sync_merge_failed")).toHaveLength(1)
  })

  it("a resolution commit refused by a hook leaves no merge in progress", () => {
    const { bundle, owner } = bundleWithRemote()
    git(owner, ["rm", "-q", "psyche/TACIT.md"])
    git(owner, ["commit", "-q", "-m", "owner deletes"])
    git(owner, ["push", "-q", "origin", "HEAD:main"])
    write(bundle, "psyche/TACIT.md", "agent edit\n")
    fs.writeFileSync(path.join(bundle, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    git(bundle, ["fetch", "-q"])
    // The hook also blocks the local commit, so commit first with hooks off.
    git(bundle, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "agent edit"])
    __testHooks.extraGitConfig = ["-c", `core.hooksPath=${path.join(bundle, ".git", "hooks")}`]
    expect(integrateFetched(bundle, CONFIG, AGENT).ok).toBe(false)
    expect(fs.existsSync(path.join(bundle, ".git", "MERGE_HEAD"))).toBe(false)
  })

  it("a resolved conflict clears its record; a pending push failure stays until the push", async () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    expect((await preTurnPull(bundle, CONFIG)).ok).toBe(false)

    // The owner resolves by taking the agent's side and pushing it.
    git(owner, ["fetch", "-q", path.join(bundle, ".git"), "HEAD:refs/heads/agent-side"])
    git(owner, ["merge", "-q", "-X", "theirs", "--no-edit", "agent-side"])
    git(owner, ["push", "-q", "origin", "HEAD:main"])
    expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true })
    expect(pending(bundle)).toBeNull()
    expect(fs.existsSync(path.join(bundle, "state", "sync-conflict.json"))).toBe(false)

    write(bundle, "local.md", "unpushed\n")
    git(bundle, ["add", "-A"])
    git(bundle, ["commit", "-q", "-m", "unpushed"])
    write(bundle, "state/pending-sync.json", JSON.stringify({ error: "push failed", failedAt: "2026-06-01T00:00:00.000Z", classification: "push_rejected" }))
    expect(await preTurnPull(bundle, CONFIG, { agentName: AGENT })).toEqual({ ok: true })
    expect(pending(bundle)).toMatchObject({ classification: "push_rejected" })
  })

  it("an unwritable conflict record still reports the conflict", async () => {
    const { bundle, owner } = bundleWithRemote()
    fs.mkdirSync(path.join(bundle, "state", "sync-conflict.json"), { recursive: true })
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    expect((await preTurnPull(bundle, CONFIG)).ok).toBe(false)
    expect(notices).toHaveLength(1)
    git(bundle, ["reset", "-q", "--hard", "origin/main"])
    expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true })
  })

  it("a conflict record without a hash is ignored", async () => {
    const { bundle, owner } = bundleWithRemote()
    write(bundle, "state/sync-conflict.json", JSON.stringify({ paths: [] }))
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    expect((await preTurnPull(bundle, CONFIG)).ok).toBe(false)
    expect(notices.map((n) => n.noticeId)).toEqual([expect.stringMatching(/^sync-conflict:agent:[0-9a-f]{16}$/)])
  })

  it("a conflict branch the remote refuses is reported and retried next time", async () => {
    const { bundle, owner, remote } = bundleWithRemote()
    write(owner, "unrelated.md", "x\n")
    git(owner, ["checkout", "-q", "-b", "elsewhere"])
    git(owner, ["add", "-A"])
    git(owner, ["commit", "-q", "-m", "unrelated"])
    git(owner, ["push", "-q", "origin", "HEAD:refs/heads/sync-conflict/agent"])
    git(owner, ["checkout", "-q", "main"])
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    await preTurnPull(bundle, CONFIG)
    await preTurnPull(bundle, CONFIG)
    expect(emitted("heart.sync_conflict_branch_push_error")).toHaveLength(1)
    expect(git(remote, ["--git-dir", remote, "log", "-1", "--format=%s", "sync-conflict/agent"])).toBe("unrelated")
    expect(notices.filter((n) => n.noticeId.startsWith("sync-conflict-branch:"))).toHaveLength(0)
  })
})

describe("syncNow and the lock", () => {
  it("syncNow reports a busy lock with the holder", async () => {
    const bundle = localBundle()
    const handle = lock(bundle)
    const result = await syncNow(bundle, CONFIG, AGENT, 0)
    handle.release()
    expect(result).toEqual({ ok: false, busy: true, holderPid: process.pid, error: `bundle sync lock is held by pid ${process.pid}` })
  })

  it("syncNow reports a busy lock whose holder is unknown", async () => {
    const bundle = localBundle()
    fs.writeFileSync(path.join(bundle, ".git", "ouro-sync.lock"), "")
    expect(await syncNow(bundle, CONFIG, AGENT, 0)).toEqual({ ok: false, busy: true, holderPid: null, error: "bundle sync lock is held" })
  })

  it("syncNow returns an integrate failure without pushing, and releases the lock", async () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    const result = await syncNow(bundle, CONFIG, AGENT, 0)
    expect(result.ok).toBe(false)
    expect(emitted("heart.sync_now_error")).toHaveLength(1)
    lock(bundle).release()
  })

  it("preTurnPull skips when the lock stays busy", async () => {
    const bundle = localBundle()
    const handle = lock(bundle)
    __testHooks.preTurnLockWaitMs = 150
    expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true, busy: true, holderPid: process.pid })
    handle.release()
  })
})

describe("pause marker", () => {
  it("an unreadable marker is removed and sync runs", async () => {
    const bundle = localBundle()
    for (const content of ["not json", "null", JSON.stringify({ expiresAt: 5 })]) {
      write(bundle, "state/sync-paused", content)
      expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true })
      expect(fs.existsSync(path.join(bundle, "state", "sync-paused"))).toBe(false)
    }
    expect(emitted("heart.sync_pause_expired").map((e) => e.meta?.expiresAt)).toEqual([null, null, null])
  })
})

describe("owner notices", () => {
  it("default notice goes through the Telegram owner notice", async () => {
    const send = vi.fn(async () => undefined)
    vi.doMock("../../senses/telegram", () => ({ sendTelegramOwnerNotice: send }))
    setSyncOwnerNotifier(null)
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    await preTurnPull(bundle, CONFIG)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(AGENT, expect.objectContaining({ noticeId: expect.stringMatching(/^sync-conflict:agent:/), signal: expect.any(AbortSignal) }))
  })

  it("default notice is queued for the agent to relay, with or without Telegram", async () => {
    vi.doMock("../../senses/telegram", () => ({ sendTelegramOwnerNotice: async () => { throw new Error("no telegram for this agent") } }))
    setSyncOwnerNotifier(null)
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    await preTurnPull(bundle, CONFIG)
    await vi.waitFor(() => expect(emitted("heart.sync_owner_notice_telegram_skipped")).toHaveLength(1))
    const { getPrivateRuntimePendingDir } = await import("../../mind/pending")
    const pendingDir = getPrivateRuntimePendingDir(AGENT, bundle)
    const queued = fs.readdirSync(pendingDir).map((name) => JSON.parse(fs.readFileSync(path.join(pendingDir, name), "utf-8")) as Record<string, unknown>)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ from: AGENT, friendId: "self", channel: "inner", key: "dialog", packetId: expect.stringMatching(/^sync-conflict:agent:/) })
    expect(String(queued[0].content)).toMatch(/^a notice for my owner: /)
    expect(emitted("heart.sync_owner_notice_telegram_skipped")[0].meta).toMatchObject({ error: "no telegram for this agent" })
  })

  it("a notice that cannot be sent is logged", async () => {
    setSyncOwnerNotifier(() => { throw new Error("no telegram") })
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    await preTurnPull(bundle, CONFIG)
    await vi.waitFor(() => expect(emitted("heart.sync_owner_notice_error")).toHaveLength(1))
    expect(emitted("heart.sync_owner_notice_error")[0].meta).toMatchObject({ error: "no telegram" })
  })

  it("a non-Error failure is logged as text", async () => {
    setSyncOwnerNotifier(() => Promise.reject("offline"))
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    await preTurnPull(bundle, CONFIG)
    await vi.waitFor(() => expect(emitted("heart.sync_owner_notice_error")).toHaveLength(1))
    expect(emitted("heart.sync_owner_notice_error")[0].meta).toMatchObject({ error: "offline" })
  })
})

describe("fix round 1", () => {
  it("a global merge.autoStash=true has no effect", async () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "big.jsonl", "{}\n")
    expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true })
    ownerPush(owner, "big.jsonl", "{\"owner\":1}\n")
    sparse(bundle, "big.jsonl", SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    const global = path.join(root, "global.gitconfig")
    fs.writeFileSync(global, `[user]\n\tname = T\n\temail = t@example.invalid\n[merge]\n\tautoStash = true\n`)
    process.env.GIT_CONFIG_GLOBAL = global

    const result = await preTurnPull(bundle, CONFIG)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("would be overwritten")
    expect(git(bundle, ["stash", "list"])).toBe("")
    expect(fs.statSync(path.join(bundle, "big.jsonl")).size).toBe(SYNC_FILE_SIZE_LIMIT_BYTES + 1)
  })

  it("repository hooks do not run during sync", () => {
    const bundle = localBundle()
    fs.writeFileSync(path.join(bundle, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    write(bundle, "notes.md", "hi\n")
    expect(commitLocalChanges(bundle, AGENT, "m").committed).toBe(true)
  })

  it("a pause written while preTurnPull or syncNow waits for the lock is honoured", async () => {
    const bundle = localBundle()
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    for (const run of [() => preTurnPull(bundle, CONFIG), () => syncNow(bundle, CONFIG, AGENT, 5000)]) {
      const handle = lock(bundle)
      const pendingRun = run()
      await new Promise((r) => setTimeout(r, 150))
      write(bundle, "state/sync-paused", JSON.stringify({ startedAt: new Date().toISOString(), expiresAt }))
      handle.release()
      expect(await pendingRun).toEqual({ ok: true, paused: true, pausedUntil: expiresAt })
      fs.rmSync(path.join(bundle, "state", "sync-paused"))
    }
    // Neither run committed the untracked .gitignore: HEAD is still unborn.
    expect(() => git(bundle, ["rev-parse", "--verify", "-q", "HEAD"])).toThrow()
  })

  it("a pause longer than 24 hours is garbage", async () => {
    const bundle = localBundle()
    const now = Date.now()
    const hours = (h: number): string => new Date(now + h * 3_600_000).toISOString()
    for (const marker of [{ startedAt: hours(0), expiresAt: hours(25) }, { expiresAt: hours(25) }, { startedAt: "not a date", expiresAt: hours(25) }]) {
      write(bundle, "state/sync-paused", JSON.stringify(marker))
      expect(await preTurnPull(bundle, CONFIG)).toEqual({ ok: true })
      expect(fs.existsSync(path.join(bundle, "state", "sync-paused"))).toBe(false)
    }
    write(bundle, "state/sync-paused", JSON.stringify({ startedAt: hours(-20), expiresAt: hours(3) }))
    expect((await preTurnPull(bundle, CONFIG)).paused).toBe(true)
  })

  it("a stale pause marker that cannot be removed is logged and sync goes on", () => {
    const bundle = localBundle()
    write(bundle, "state/sync-paused", JSON.stringify({ expiresAt: "2026-01-01T00:00:00.000Z" }))
    write(bundle, "notes.md", "hi\n")
    fs.chmodSync(path.join(bundle, "state"), 0o555)
    try {
      const result = postTurnPush(bundle, CONFIG)
      expect(result.ok).toBe(true)
    } finally {
      fs.chmodSync(path.join(bundle, "state"), 0o755)
    }
    expect(emitted("heart.sync_pause_clear_failed")).toHaveLength(1)
    expect(git(bundle, ["log", "--oneline"]).split("\n")).toHaveLength(1)
  })

  it("syncNow on an unborn HEAD with a remote has nothing to push", async () => {
    const bundle = path.join(root, "empty.ouro")
    git(root, ["init", "-q", "-b", "main", bundle])
    const remote = path.join(root, "empty-remote.git")
    git(root, ["init", "-q", "--bare", "-b", "main", remote])
    git(bundle, ["remote", "add", "origin", remote])
    expect(await syncNow(bundle, CONFIG, AGENT, 0)).toEqual({ ok: true })
    expect(pending(bundle)).toBeNull()
  })

  it("the conflict branch is pushed again only when HEAD has moved", async () => {
    const { bundle, owner } = bundleWithRemote()
    ownerPush(owner, "notes.md", "owner\n")
    write(bundle, "notes.md", "agent\n")
    for (let i = 0; i < 4; i++) await preTurnPull(bundle, CONFIG)
    expect(emitted("heart.sync_conflict_branch_pushed")).toHaveLength(1)
    write(bundle, "journal.md", "new turn\n")
    await preTurnPull(bundle, CONFIG)
    expect(emitted("heart.sync_conflict_branch_pushed")).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(path.join(bundle, "state", "sync-conflict.json"), "utf-8")).branchPushedHead).toBe(git(bundle, ["rev-parse", "HEAD"]))
  })
})

describe("clearPendingSync", () => {
  it("tolerates a record it cannot remove", () => {
    const bundle = localBundle()
    fs.mkdirSync(path.join(pendingSyncPath(bundle), "x"), { recursive: true })
    expect(() => clearPendingSync(bundle)).not.toThrow()
    expect(fs.existsSync(pendingSyncPath(bundle))).toBe(true)
  })
})
