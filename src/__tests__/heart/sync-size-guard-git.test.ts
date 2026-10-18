import { describe, it, expect, afterEach } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { postTurnPush, SYNC_FILE_SIZE_LIMIT_BYTES } from "../../heart/sync"

// Real git, no mocks: proves the size guard keeps an oversized file out of the
// commit that reaches the remote, and that a later small change still syncs.

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

function makeBundleWithRemote(): { bundle: string; remote: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-size-guard-git-"))
  roots.push(root)
  const remote = path.join(root, "remote.git")
  const bundle = path.join(root, "bundle.ouro")
  git(root, ["init", "-q", "--bare", "-b", "main", remote])
  git(root, ["init", "-q", "-b", "main", bundle])
  git(bundle, ["config", "user.email", "agent@example.invalid"])
  git(bundle, ["config", "user.name", "Agent"])
  git(bundle, ["config", "commit.gpgsign", "false"])
  git(bundle, ["remote", "add", "origin", remote])
  fs.writeFileSync(path.join(bundle, ".gitignore"), "state/\n", "utf-8")
  git(bundle, ["add", ".gitignore"])
  git(bundle, ["commit", "-q", "-m", "init"])
  git(bundle, ["push", "-q", "-u", "origin", "main"])
  return { bundle, remote }
}

function sparseFile(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "")
  fs.truncateSync(filePath, bytes)
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("postTurnPush size guard against a real git remote", () => {
  it("pushes small files, leaves the oversized one uncommitted and records it", () => {
    const { bundle, remote } = makeBundleWithRemote()
    fs.writeFileSync(path.join(bundle, "notes.md"), "hello\n", "utf-8")
    sparseFile(path.join(bundle, "arc", "history", "2026-06-22.jsonl"), SYNC_FILE_SIZE_LIMIT_BYTES + 1024)

    const result = postTurnPush(bundle, { enabled: true, remote: "origin" })

    expect(result).toEqual({ ok: true })
    const pushedFiles = git(remote, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).split("\n")
    expect(pushedFiles).toEqual([".gitignore", "notes.md"])
    expect(git(bundle, ["status", "--porcelain"])).toBe("?? arc/")
    const skipped = JSON.parse(fs.readFileSync(path.join(bundle, "state", "sync-skipped-files.json"), "utf-8"))
    expect(skipped.files).toEqual([{ path: "arc/history/2026-06-22.jsonl", bytes: SYNC_FILE_SIZE_LIMIT_BYTES + 1024 }])
    expect(fs.existsSync(path.join(bundle, "state", "pending-sync.json"))).toBe(false)
  })

  it("keeps the last committed version when a tracked file grows past the limit", () => {
    const { bundle, remote } = makeBundleWithRemote()
    fs.writeFileSync(path.join(bundle, "log.jsonl"), "{}\n", "utf-8")
    expect(postTurnPush(bundle, { enabled: true, remote: "origin" }).ok).toBe(true)

    sparseFile(path.join(bundle, "log.jsonl"), SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    fs.writeFileSync(path.join(bundle, "notes.md"), "later\n", "utf-8")
    expect(postTurnPush(bundle, { enabled: true, remote: "origin" }).ok).toBe(true)

    expect(git(remote, ["--git-dir", remote, "show", "main:log.jsonl"])).toBe("{}")
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("later")
    expect(git(bundle, ["status", "--porcelain"])).toBe("M log.jsonl")
  })

  it("rebases over another machine's push while a grown file stays unstaged", () => {
    const { bundle, remote } = makeBundleWithRemote()
    fs.writeFileSync(path.join(bundle, "log.jsonl"), "{}\n", "utf-8")
    expect(postTurnPush(bundle, { enabled: true, remote: "origin" }).ok).toBe(true)

    // Another machine pushes a change.
    const other = path.join(path.dirname(remote), "other")
    git(path.dirname(remote), ["clone", "-q", remote, other])
    git(other, ["config", "user.email", "other@example.invalid"])
    git(other, ["config", "user.name", "Other"])
    fs.writeFileSync(path.join(other, "from-other.md"), "hi\n", "utf-8")
    git(other, ["add", "from-other.md"])
    git(other, ["commit", "-q", "-m", "other machine"])
    git(other, ["push", "-q", "origin", "main"])

    // Here, a tracked file grows past the limit and a small file changes.
    sparseFile(path.join(bundle, "log.jsonl"), SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    fs.writeFileSync(path.join(bundle, "notes.md"), "mine\n", "utf-8")

    expect(postTurnPush(bundle, { enabled: true, remote: "origin" })).toEqual({ ok: true })
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("mine")
    expect(git(remote, ["--git-dir", remote, "show", "main:from-other.md"])).toBe("hi")
    expect(git(remote, ["--git-dir", remote, "show", "main:log.jsonl"])).toBe("{}")
    expect(fs.statSync(path.join(bundle, "log.jsonl")).size).toBe(SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    expect(fs.existsSync(path.join(bundle, "state", "pending-sync.json"))).toBe(false)
  })

  it("clears a stale failure record once the clean bundle matches its upstream", () => {
    const { bundle } = makeBundleWithRemote()
    fs.mkdirSync(path.join(bundle, "state"), { recursive: true })
    fs.writeFileSync(path.join(bundle, "state", "pending-sync.json"), JSON.stringify({ error: "old", failedAt: "2026-06-29T15:02:17.371Z" }), "utf-8")
    fs.writeFileSync(path.join(bundle, "state", "sync-skipped-files.json"), JSON.stringify({ files: [{ path: "gone", bytes: 1 }] }), "utf-8")

    expect(postTurnPush(bundle, { enabled: true, remote: "origin" })).toEqual({ ok: true })
    expect(fs.existsSync(path.join(bundle, "state", "pending-sync.json"))).toBe(false)
    expect(fs.existsSync(path.join(bundle, "state", "sync-skipped-files.json"))).toBe(false)
  })

  it("pushes commits left unpushed by an earlier failure even when nothing changed", () => {
    const { bundle, remote } = makeBundleWithRemote()
    fs.writeFileSync(path.join(bundle, "notes.md"), "stranded\n", "utf-8")
    git(bundle, ["add", "notes.md"])
    git(bundle, ["commit", "-q", "-m", "stranded commit"])
    fs.mkdirSync(path.join(bundle, "state"), { recursive: true })
    fs.writeFileSync(path.join(bundle, "state", "pending-sync.json"), JSON.stringify({ error: "push failed" }), "utf-8")

    expect(postTurnPush(bundle, { enabled: true, remote: "origin" })).toEqual({ ok: true })
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("stranded")
    expect(fs.existsSync(path.join(bundle, "state", "pending-sync.json"))).toBe(false)
  })

  it("keeps the old path of a committed big file renamed past the limit", () => {
    const { bundle, remote } = makeBundleWithRemote()
    // A big file committed before the guard existed.
    sparseFile(path.join(bundle, "old", "big.jsonl"), SYNC_FILE_SIZE_LIMIT_BYTES + 1)
    git(bundle, ["add", "old/big.jsonl"])
    git(bundle, ["commit", "-q", "-m", "big file from before the guard"])
    git(bundle, ["push", "-q", "origin", "main"])

    fs.mkdirSync(path.join(bundle, "new"), { recursive: true })
    fs.renameSync(path.join(bundle, "old", "big.jsonl"), path.join(bundle, "new", "big.jsonl"))
    fs.writeFileSync(path.join(bundle, "notes.md"), "after rename\n", "utf-8")

    expect(postTurnPush(bundle, { enabled: true, remote: "origin" })).toEqual({ ok: true })
    const pushedFiles = git(remote, ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).split("\n")
    expect(pushedFiles).toContain("old/big.jsonl")
    expect(pushedFiles).not.toContain("new/big.jsonl")
    expect(git(remote, ["--git-dir", remote, "show", "main:notes.md"])).toBe("after rename")
  })
})
