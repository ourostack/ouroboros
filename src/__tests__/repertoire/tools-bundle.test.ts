/**
 * Tests for the agent-callable bundle management tools.
 *
 * Each tool is exercised with a real git subprocess against a tmp bundle
 * created by createTmpBundle — these are integration tests, not mocks.
 * The `getAgentRoot` function is mocked so we can point it at the
 * per-test tmp bundle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(),
}))

import { getAgentRoot } from "../../heart/identity"
import { bundleToolDefinitions } from "../../repertoire/tools-bundle"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"
import { __testHooks, setSyncOwnerNotifier } from "../../heart/sync"
import { tryAcquireSyncLockSync } from "../../heart/sync-lock"

function tool(name: string) {
  const def = bundleToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

function initGit(dir: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" })
}

function addRemoteDirect(dir: string, url: string, name = "origin"): void {
  execFileSync("git", ["remote", "add", name, url], { cwd: dir, stdio: "pipe" })
}

/** An empty bare repo beside the bundle, for a first push. */
/**
 * Moves fake time on while real I/O (the first-push probe's git ls-remote) gets
 * its turn between steps, until the promise settles.
 */
async function advanceUntilSettled(pending: Promise<unknown>): Promise<void> {
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  for (let step = 0; !settled && step < 5000; step++) {
    await vi.advanceTimersByTimeAsync(250)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function emptyRemote(bundleRoot: string): string {
  const remote = `${bundleRoot}-remote.git`
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" })
  return remote
}

function commitFile(dir: string, relPath: string, content: string, message: string): void {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
  execFileSync("git", ["add", "--", relPath], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" })
}

async function invoke(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const def = tool(name)
  const result = await def.handler(args as Record<string, string>)
  return JSON.parse(result) as Record<string, unknown>
}

describe("tools-bundle", () => {
  let tmp: ReturnType<typeof createTmpBundle>

  beforeEach(() => {
    tmp = createTmpBundle({ agentName: "bundle-tools-test" })
    vi.mocked(getAgentRoot).mockReturnValue(tmp.agentRoot)
  })

  afterEach(() => {
    tmp.cleanup()
  })

  describe("bundle_check_sync_status", () => {
    it("reports not-a-git-repo for an empty bundle", async () => {
      const result = await invoke("bundle_check_sync_status")
      expect(result.ok).toBe(true)
      expect(result.isGitRepo).toBe(false)
      expect(result.hasRemote).toBe(false)
      expect(result.firstCommitExists).toBe(false)
      expect(result.bundleStateIssues).toContain("not_a_git_repo")
    })

    it("reports git-repo with no remote after init", async () => {
      initGit(tmp.agentRoot)
      const result = await invoke("bundle_check_sync_status")
      expect(result.isGitRepo).toBe(true)
      expect(result.hasRemote).toBe(false)
      expect(result.firstCommitExists).toBe(false)
      expect(result.remoteUrl).toBeNull()
    })

    it("reports remote URL when configured", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://example.test/repo.git")
      const result = await invoke("bundle_check_sync_status")
      expect(result.hasRemote).toBe(true)
      expect(result.remoteUrl).toBe("https://example.test/repo.git")
    })

    it("reports firstCommitExists + dirtyFileCount after a commit", async () => {
      initGit(tmp.agentRoot)
      // Commit everything from createTmpBundle (agent.json) first so the
      // dirty count only reflects what we add next.
      execFileSync("git", ["add", "-A"], { cwd: tmp.agentRoot, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmp.agentRoot, stdio: "pipe" })
      fs.writeFileSync(path.join(tmp.agentRoot, "dirty.txt"), "x", "utf-8")
      const result = await invoke("bundle_check_sync_status")
      expect(result.firstCommitExists).toBe(true)
      expect(result.dirtyFileCount).toBe(1)
    })

    it("reports pendingSyncExists when state/pending-sync.json is present", async () => {
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      fs.writeFileSync(path.join(tmp.agentRoot, "state", "pending-sync.json"), "{}", "utf-8")
      const result = await invoke("bundle_check_sync_status")
      expect(result.pendingSyncExists).toBe(true)
    })
  })

  describe("bundle_init_git", () => {
    it("initializes .git and writes a minimal .gitignore", async () => {
      const result = await invoke("bundle_init_git")
      expect(result.ok).toBe(true)
      expect(result.alreadyInit).toBe(false)
      expect(result.gitignoreWritten).toBe(true)
      expect(fs.existsSync(path.join(tmp.agentRoot, ".git"))).toBe(true)
      expect(fs.readFileSync(path.join(tmp.agentRoot, ".gitignore"), "utf-8")).toContain("state/")
    })

    it("refuses when already initialized and force is absent", async () => {
      initGit(tmp.agentRoot)
      const result = await invoke("bundle_init_git")
      expect(result.ok).toBe(false)
      expect(result.alreadyInit).toBe(true)
      expect(String(result.error)).toContain("force")
    })

    it("does NOT overwrite an existing .gitignore", async () => {
      fs.writeFileSync(path.join(tmp.agentRoot, ".gitignore"), "custom\n", "utf-8")
      const result = await invoke("bundle_init_git")
      expect(result.ok).toBe(true)
      expect(result.gitignoreWritten).toBe(false)
      expect(fs.readFileSync(path.join(tmp.agentRoot, ".gitignore"), "utf-8")).toBe("custom\n")
    })

    it("accepts force: true to proceed despite existing .git", async () => {
      initGit(tmp.agentRoot)
      const result = await invoke("bundle_init_git", { force: true })
      expect(result.ok).toBe(true)
      expect(result.alreadyInit).toBe(true)
    })
  })

  describe("bundle_add_remote", () => {
    beforeEach(() => {
      initGit(tmp.agentRoot)
    })

    it("adds an https remote", async () => {
      const result = await invoke("bundle_add_remote", { url: "https://example.test/repo.git" })
      expect(result.ok).toBe(true)
      expect(result.url).toBe("https://example.test/repo.git")
      expect(result.name).toBe("origin")
    })

    it("adds a git@ remote", async () => {
      const result = await invoke("bundle_add_remote", { url: "git@github.com:user/repo.git" })
      expect(result.ok).toBe(true)
    })

    it("accepts a custom remote name", async () => {
      const result = await invoke("bundle_add_remote", {
        url: "https://example.test/repo.git",
        name: "upstream",
      })
      expect(result.ok).toBe(true)
      expect(result.name).toBe("upstream")
    })

    it("refuses non-string url argument", async () => {
      const result = await invoke("bundle_add_remote", { url: 12345 as unknown as string })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("invalid remote url")
    })

    it("refuses empty URL", async () => {
      const result = await invoke("bundle_add_remote", { url: "" })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("invalid remote url")
    })

    it("refuses whitespace-only URL", async () => {
      const result = await invoke("bundle_add_remote", { url: "   " })
      expect(result.ok).toBe(false)
    })

    it("refuses file:// URL (unrecognized scheme)", async () => {
      const result = await invoke("bundle_add_remote", { url: "file:///tmp/foo" })
      expect(result.ok).toBe(false)
    })

    it("refuses when remote already exists without force", async () => {
      addRemoteDirect(tmp.agentRoot, "https://existing.test/repo.git")
      const result = await invoke("bundle_add_remote", { url: "https://new.test/repo.git" })
      expect(result.ok).toBe(false)
      expect(result.previousUrl).toBe("https://existing.test/repo.git")
    })

    it("updates URL via set-url when force: true", async () => {
      addRemoteDirect(tmp.agentRoot, "https://existing.test/repo.git")
      const result = await invoke("bundle_add_remote", {
        url: "https://new.test/repo.git",
        force: true,
      })
      expect(result.ok).toBe(true)
      expect(result.previousUrl).toBe("https://existing.test/repo.git")
      expect(result.url).toBe("https://new.test/repo.git")
    })

    it("refuses when bundle is not a git repo", async () => {
      const freshTmp = createTmpBundle({ agentName: "bundle-no-git" })
      try {
        vi.mocked(getAgentRoot).mockReturnValue(freshTmp.agentRoot)
        const result = await invoke("bundle_add_remote", { url: "https://x.test/y.git" })
        expect(result.ok).toBe(false)
        expect(String(result.error)).toContain("not a git repo")
      } finally {
        freshTmp.cleanup()
      }
    })
  })

  describe("bundle_list_first_commit", () => {
    it("refuses when not a git repo", async () => {
      const result = await invoke("bundle_list_first_commit")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("not a git repo")
    })

    it("returns empty groups for a freshly-init'd bundle (only agent.json from tmpdir helper)", async () => {
      initGit(tmp.agentRoot)
      const result = await invoke("bundle_list_first_commit")
      expect(result.ok).toBe(true)
      const groups = result.groups as Record<string, unknown>
      // The createTmpBundle helper writes agent.json in the root.
      // It'll show up in the "(root)" group.
      expect(groups["(root)"]).toBeDefined()
    })

    it("groups files by top-level directory with sizes", async () => {
      initGit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "friends"), { recursive: true })
      fs.writeFileSync(path.join(tmp.agentRoot, "friends", "ari.json"), "{}", "utf-8")
      fs.mkdirSync(path.join(tmp.agentRoot, "desk", "_record", "notes"), { recursive: true })
      fs.writeFileSync(path.join(tmp.agentRoot, "desk", "_record", "notes", "entry.md"), "hi", "utf-8")
      const result = await invoke("bundle_list_first_commit")
      expect(result.ok).toBe(true)
      const groups = result.groups as Record<string, { files: unknown[]; totalBytes: number; fileCount: number }>
      expect(groups.friends).toBeDefined()
      expect(groups.friends.fileCount).toBe(1)
      expect(groups.desk).toBeDefined()
      expect(groups.desk.fileCount).toBe(1)
      expect(result.totalFiles as number).toBeGreaterThanOrEqual(2)
    })

    it("excludes gitignored files", async () => {
      initGit(tmp.agentRoot)
      fs.writeFileSync(path.join(tmp.agentRoot, ".gitignore"), "secret.txt\n", "utf-8")
      fs.writeFileSync(path.join(tmp.agentRoot, "secret.txt"), "nope", "utf-8")
      const result = await invoke("bundle_list_first_commit")
      const groups = result.groups as Record<string, { files: Array<{ path: string }> }>
      for (const group of Object.values(groups)) {
        for (const f of group.files) {
          expect(f.path).not.toBe("secret.txt")
        }
      }
    })

    it("refuses when HEAD already exists", async () => {
      initGit(tmp.agentRoot)
      commitFile(tmp.agentRoot, "file.txt", "x", "first")
      const result = await invoke("bundle_list_first_commit")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("already has commits")
    })
  })

  describe("bundle_do_first_commit", () => {
    beforeEach(() => {
      initGit(tmp.agentRoot)
    })

    it("commits everything from the default list when files is omitted", async () => {
      fs.writeFileSync(path.join(tmp.agentRoot, "a.txt"), "a", "utf-8")
      fs.writeFileSync(path.join(tmp.agentRoot, "b.txt"), "b", "utf-8")
      const result = await invoke("bundle_do_first_commit")
      expect(result.ok).toBe(true)
      expect(typeof result.commitSha).toBe("string")
      expect((result.commitSha as string).length).toBeGreaterThan(0)
      expect(result.fileCount as number).toBeGreaterThanOrEqual(2)
    })

    it("commits only the explicit files when passed", async () => {
      fs.writeFileSync(path.join(tmp.agentRoot, "wanted.txt"), "yes", "utf-8")
      fs.writeFileSync(path.join(tmp.agentRoot, "ignored.txt"), "no", "utf-8")
      const result = await invoke("bundle_do_first_commit", { files: ["wanted.txt"] })
      expect(result.ok).toBe(true)
      expect(result.fileCount).toBe(1)
      // Verify ignored.txt is not tracked
      const tracked = execFileSync("git", ["ls-files"], { cwd: tmp.agentRoot }).toString()
      expect(tracked).toContain("wanted.txt")
      expect(tracked).not.toContain("ignored.txt")
    })

    it("refuses empty files array (Directive A)", async () => {
      fs.writeFileSync(path.join(tmp.agentRoot, "x.txt"), "x", "utf-8")
      const result = await invoke("bundle_do_first_commit", { files: [] })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("non-empty")
    })

    it("refuses files outside bundle root (../escape)", async () => {
      const result = await invoke("bundle_do_first_commit", { files: ["../escape.txt"] })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("outside bundle root")
    })

    it("refuses absolute paths outside bundle root", async () => {
      const result = await invoke("bundle_do_first_commit", { files: ["/etc/passwd"] })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("outside bundle root")
    })

    it("refuses when HEAD already exists", async () => {
      commitFile(tmp.agentRoot, "first.txt", "x", "init")
      const result = await invoke("bundle_do_first_commit")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("already has commits")
    })

    it("refuses when bundle is not a git repo", async () => {
      const freshTmp = createTmpBundle({ agentName: "bundle-no-git-first" })
      try {
        vi.mocked(getAgentRoot).mockReturnValue(freshTmp.agentRoot)
        const result = await invoke("bundle_do_first_commit")
        expect(result.ok).toBe(false)
        expect(String(result.error)).toContain("not a git repo")
      } finally {
        freshTmp.cleanup()
      }
    })

    it("refuses non-array files argument", async () => {
      const result = await invoke("bundle_do_first_commit", { files: "oops" as unknown as string[] })
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("array")
    })

    it("uses a custom commit message when provided", async () => {
      fs.writeFileSync(path.join(tmp.agentRoot, "x.txt"), "x", "utf-8")
      const result = await invoke("bundle_do_first_commit", { message: "custom: initial import" })
      expect(result.ok).toBe(true)
      expect(result.message).toBe("custom: initial import")
      const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: tmp.agentRoot }).toString().trim()
      expect(log).toBe("custom: initial import")
    })
  })

  describe("bundle_push", () => {
    it("refuses when not a git repo", async () => {
      const result = await invoke("bundle_push")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("not a git repo")
    })

    it("refuses when no remote is configured", async () => {
      initGit(tmp.agentRoot)
      const result = await invoke("bundle_push")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("not configured")
    })

    it("refuses when no commits exist", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://example.test/repo.git")
      const result = await invoke("bundle_push")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("no commits")
    })

    it("refuses first push without a confirmation token (Directive D)", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, emptyRemote(tmp.agentRoot))
      commitFile(tmp.agentRoot, "file.txt", "x", "init")
      const result = await invoke("bundle_push")
      expect(result.ok).toBe(false)
      expect(result.kind).toBe("confirmation_required")
      expect(String(result.error)).toContain("confirmation token")
    })

    it("says it couldn't reach GitHub, rather than asking for a first-push token, when the remote cannot be asked", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://unresolvable.test.invalid/repo.git")
      commitFile(tmp.agentRoot, "file.txt", "x", "init")
      for (const args of [{}, { confirmation_token: "anything" }]) {
        const result = await invoke("bundle_push", args)
        expect(result.ok).toBe(false)
        expect(result.kind).toBe("remote_unreachable")
        expect(String(result.error)).toMatch(/^I couldn't reach GitHub to check whether this would be my first push, so I didn't sync: git ls-remote failed: /)
      }
    })

    it("ignores a remote argument: it syncs only with agent.json's sync.remote", async () => {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "upstream", "https://unresolvable.test.invalid/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      commitFile(tmp.agentRoot, "file.txt", "x", "init")
      const result = await invoke("bundle_push", { remote: "upstream" })
      expect(result).toEqual({ ok: false, error: 'remote "origin" not configured — run bundle_add_remote first' })
    })
  })

  describe("bundle_pull_rebase", () => {
    it("refuses when not a git repo", async () => {
      const result = await invoke("bundle_pull_rebase")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("not a git repo")
    })

    it("refuses when no remote is configured", async () => {
      initGit(tmp.agentRoot)
      const result = await invoke("bundle_pull_rebase")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("not configured")
    })

    it("refuses a first sync without a confirmation token, like bundle_push", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, emptyRemote(tmp.agentRoot))
      commitFile(tmp.agentRoot, "clean.txt", "x", "init")
      const result = await invoke("bundle_pull_rebase")
      expect(result.ok).toBe(false)
      expect(result.kind).toBe("confirmation_required")
      expect(String(result.error)).toContain("bundle_pull_rebase")
    })

    it("refuses an invalid or foreign confirmation token", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, emptyRemote(tmp.agentRoot))
      commitFile(tmp.agentRoot, "clean.txt", "x", "init")
      const bogus = await invoke("bundle_pull_rebase", { confirmation_token: "not-a-token" })
      expect(bogus.kind).toBe("confirmation_required")
      expect(String(bogus.error)).toContain("invalid or expired")

      const review = await invoke("bundle_first_push_review")
      const other = createTmpBundle({ agentName: "bundle-tools-other" })
      try {
        initGit(other.agentRoot)
        addRemoteDirect(other.agentRoot, emptyRemote(other.agentRoot))
        commitFile(other.agentRoot, "clean.txt", "x", "init")
        vi.mocked(getAgentRoot).mockReturnValue(other.agentRoot)
        const foreign = await invoke("bundle_pull_rebase", { confirmation_token: String(review.confirmationToken) })
        expect(foreign.kind).toBe("confirmation_required")
        expect(String(foreign.error)).toContain("different bundle")
      } finally {
        other.cleanup()
      }
    })

    it("has no discard_changes parameter and one-sentence descriptions", () => {
      for (const name of ["bundle_push", "bundle_pull_rebase"]) {
        const fn = tool(name).tool.function
        expect(fn.description).toBe("Sync my bundle with its remote now.")
        expect(Object.keys((fn.parameters as { properties: Record<string, unknown> }).properties).sort()).toEqual(["confirmation_token"])
      }
    })

    it("ignores a remote argument", async () => {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "upstream", "https://unresolvable.test.invalid/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      execFileSync("git", ["add", "-A"], { cwd: tmp.agentRoot, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmp.agentRoot, stdio: "pipe" })
      const result = await invoke("bundle_pull_rebase", { remote: "upstream" })
      expect(result).toEqual({ ok: false, error: 'remote "origin" not configured — run bundle_add_remote first' })
    })
  })
})

// ── Real remotes: the tools sync by merge and leave nothing in progress ──

describe("bundle sync tools against a real remote", () => {
  const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]
  let root: string
  let agent: string
  let owner: string
  let remote: string
  let savedHome: string | undefined
  let savedNoSystem: string | undefined
  const notices: string[] = []

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
  }

  function ownerCommit(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(owner, rel)), { recursive: true })
    fs.writeFileSync(path.join(owner, rel), content)
    git(owner, [...OWNER, "add", "-A"])
    git(owner, [...OWNER, "commit", "-q", "-m", `owner ${rel}`])
    git(owner, [...OWNER, "push", "-q", "origin", "main"])
  }

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bundle-sync-tools-")))
    savedHome = process.env.HOME
    savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM
    process.env.HOME = path.join(root, "empty-home")
    fs.mkdirSync(process.env.HOME)
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    remote = path.join(root, "remote.git")
    owner = path.join(root, "owner")
    agent = path.join(root, "butler.ouro")
    git(root, ["init", "-q", "--bare", "-b", "main", remote])
    git(root, ["clone", "-q", remote, owner])
    git(owner, ["checkout", "-q", "-b", "main"])
    fs.writeFileSync(path.join(owner, ".gitignore"), "state/\n")
    fs.writeFileSync(path.join(owner, "agent.json"), JSON.stringify({ version: 2, sync: { enabled: true, remote: "origin" } }))
    fs.writeFileSync(path.join(owner, "notes.md"), "seed\n")
    git(owner, [...OWNER, "add", "-A"])
    git(owner, [...OWNER, "commit", "-q", "-m", "seed"])
    git(owner, [...OWNER, "push", "-q", "-u", "origin", "main"])
    git(root, ["clone", "-q", remote, agent])
    vi.mocked(getAgentRoot).mockReturnValue(agent)
    notices.length = 0
    setSyncOwnerNotifier((_name, notice) => { notices.push(notice.text) })
  })

  afterEach(() => {
    setSyncOwnerNotifier(null)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem
    fs.rmSync(root, { recursive: true, force: true })
  })

  function inProgress(): string[] {
    const gitDir = path.join(agent, ".git")
    const found = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "AUTO_MERGE"].filter((name) => fs.existsSync(path.join(gitDir, name)))
    if (git(agent, ["stash", "list"]) !== "") found.push("stash")
    return found
  }

  it("bundle_pull_rebase never leaves MERGE_HEAD or a stash", async () => {
    // A real conflict: the owner and the agent both change notes.md, and the
    // agent also has an uncommitted change elsewhere.
    ownerCommit("notes.md", "owner\n")
    fs.writeFileSync(path.join(agent, "notes.md"), "agent\n")
    git(agent, [...OWNER, "commit", "-q", "-am", "agent edit"])
    fs.writeFileSync(path.join(agent, "journal.md"), "uncommitted\n")
    const head = git(agent, ["rev-parse", "HEAD"])

    const result = await invoke("bundle_pull_rebase")

    expect(result.ok).toBe(false)
    expect(result.kind).toBe("pull_rebase_conflict")
    expect(result.conflictFiles).toEqual(["notes.md"])
    expect(inProgress()).toEqual([])
    expect(git(agent, ["status", "--porcelain", "--untracked-files=no"])).toBe("")
    expect(fs.readFileSync(path.join(agent, "notes.md"), "utf-8")).toBe("agent\n")
    expect(fs.readFileSync(path.join(agent, "journal.md"), "utf-8")).toBe("uncommitted\n")
    // The uncommitted change was committed, not stashed; the merge was aborted.
    expect(git(agent, ["rev-parse", "HEAD~1"])).toBe(head)
    expect(fs.existsSync(path.join(agent, ".git", "ouro-sync.lock"))).toBe(false)

    // bundle_push takes the same path.
    const again = await invoke("bundle_push")
    expect(again.ok).toBe(false)
    expect(again.kind).toBe("pull_rebase_conflict")
    expect(inProgress()).toEqual([])
  })

  it("merges a clean remote change and pushes the agent's work", async () => {
    ownerCommit("owner.md", "from owner\n")
    fs.writeFileSync(path.join(agent, "journal.md"), "from agent\n")

    const result = await invoke("bundle_pull_rebase")

    expect(result).toEqual({ ok: true, remote: "origin", branch: "main", firstPush: false })
    expect(inProgress()).toEqual([])
    expect(git(remote, ["--git-dir", remote, "rev-parse", "main"])).toBe(git(agent, ["rev-parse", "HEAD"]))
    expect(fs.readFileSync(path.join(agent, "owner.md"), "utf-8")).toBe("from owner\n")
    expect(git(remote, ["--git-dir", remote, "show", "main:journal.md"])).toBe("from agent")
    expect(fs.existsSync(path.join(agent, "state", "pending-sync.json"))).toBe(false)
  })

  it("a successful sync leaves a repair_restore_incomplete record for a person to clear", async () => {
    const record = { error: "restore incomplete", classification: "repair_restore_incomplete", repairRef: "refs/ouro/repair/x", failedAt: "2026-11-05T00:00:00.000Z" }
    fs.mkdirSync(path.join(agent, "state"), { recursive: true })
    fs.writeFileSync(path.join(agent, "state", "pending-sync.json"), JSON.stringify(record))
    fs.writeFileSync(path.join(agent, "journal.md"), "x\n")

    const result = await invoke("bundle_push")

    expect(result).toEqual({ ok: true, remote: "origin", branch: "main", firstPush: false })
    expect(JSON.parse(fs.readFileSync(path.join(agent, "state", "pending-sync.json"), "utf-8"))).toEqual(record)
  })

  it("keeps a first-push token when the sync is busy, and spends it once the sync runs", async () => {
    const empty = path.join(root, "empty.git")
    git(root, ["init", "-q", "--bare", "-b", "main", empty])
    git(agent, ["remote", "set-url", "origin", empty])
    const review = await invoke("bundle_first_push_review")
    const token = String(review.confirmationToken)

    const lock = tryAcquireSyncLockSync(agent)
    if ("busy" in lock) throw new Error("lock unexpectedly busy")
    // The first-push probe asks the remote before the lock wait; its timeout is a fake timer too.
    __testHooks.fetchTimeoutMs = 3_600_000
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
    try {
      const pending = invoke("bundle_push", { confirmation_token: token })
      await advanceUntilSettled(pending)
      expect(await pending).toMatchObject({ ok: false, busy: true, firstPush: true })
    } finally {
      vi.useRealTimers()
      delete __testHooks.fetchTimeoutMs
      lock.release()
    }

    expect(await invoke("bundle_push", { confirmation_token: token })).toEqual({ ok: true, remote: "origin", branch: "main", firstPush: true })
    expect(git(empty, ["--git-dir", empty, "rev-parse", "main"])).toBe(git(agent, ["rev-parse", "HEAD"]))

    // Spent: the next first push (to another empty remote) needs a new token.
    const another = path.join(root, "another.git")
    git(root, ["init", "-q", "--bare", "-b", "main", another])
    git(agent, ["remote", "set-url", "origin", another])
    expect(await invoke("bundle_push", { confirmation_token: token })).toMatchObject({ ok: false, kind: "confirmation_required" })
  })

  it("falls back to origin when agent.json names an empty remote, and uses its branch", async () => {
    fs.writeFileSync(path.join(agent, "agent.json"), JSON.stringify({ version: 2, sync: { enabled: true, remote: "", branch: "main" } }))
    const result = await invoke("bundle_push")
    expect(result).toEqual({ ok: true, remote: "origin", branch: "main", firstPush: false })
  })

  it("reports a pause and changes nothing", async () => {
    const until = new Date(Date.now() + 3600_000).toISOString()
    fs.mkdirSync(path.join(agent, "state"), { recursive: true })
    fs.writeFileSync(path.join(agent, "state", "sync-paused"), JSON.stringify({ startedAt: new Date().toISOString(), expiresAt: until }))
    fs.writeFileSync(path.join(agent, "journal.md"), "x\n")
    const before = git(remote, ["--git-dir", remote, "rev-parse", "main"])

    const result = await invoke("bundle_push")

    expect(result).toMatchObject({ ok: false, paused: true, pausedUntil: until, error: `sync paused until ${until}` })
    expect(git(remote, ["--git-dir", remote, "rev-parse", "main"])).toBe(before)
  })

  it("reports a busy lock", async () => {
    const lock = tryAcquireSyncLockSync(agent)
    if ("busy" in lock) throw new Error("lock unexpectedly busy")
    // The first-push probe asks the remote before the lock wait; its timeout is a fake timer too.
    __testHooks.fetchTimeoutMs = 3_600_000
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] })
    try {
      const pending = invoke("bundle_push")
      await advanceUntilSettled(pending)
      const result = await pending
      expect(result).toMatchObject({ ok: false, busy: true, holderPid: process.pid })
      expect(String(result.error)).toBe(`bundle sync lock is held by pid ${process.pid}`)
    } finally {
      vi.useRealTimers()
      delete __testHooks.fetchTimeoutMs
      lock.release()
    }
  })

  it("reports a failure without a kind when the pending-sync record cannot be read", async () => {
    // The push fails on the remote side; state/pending-sync.json is a
    // directory, so no classification can be read back.
    const failing = path.join(root, "failing-receive-pack.sh")
    fs.writeFileSync(failing, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    git(agent, ["config", "remote.origin.receivepack", failing])
    fs.mkdirSync(path.join(agent, "state", "pending-sync.json"), { recursive: true })
    fs.writeFileSync(path.join(agent, "journal.md"), "x\n")
    const result = await invoke("bundle_push")
    expect(result.ok).toBe(false)
    expect(result.kind).toBeUndefined()
    expect(result.conflictFiles).toBeUndefined()
    expect(String(result.error)).toMatch(/push/)
  })

  it("bundle_check_sync_status counts against origin/main without an upstream", async () => {
    ownerCommit("owner.md", "x\n")
    git(agent, ["fetch", "-q", "origin", "main"])
    git(agent, ["branch", "--unset-upstream"])
    fs.writeFileSync(path.join(agent, "journal.md"), "y\n")
    git(agent, [...OWNER, "add", "-A"])
    git(agent, [...OWNER, "commit", "-q", "-m", "agent"])

    const status = await invoke("bundle_check_sync_status")

    expect(status).toMatchObject({ ahead: 1, behind: 1, hasRemote: true })
  })

  it("bundle_check_sync_status reports zero counts before the branch was ever fetched", async () => {
    git(agent, ["update-ref", "-d", "refs/remotes/origin/main"])
    const status = await invoke("bundle_check_sync_status")
    expect(status).toMatchObject({ ahead: 0, behind: 0 })
  })
})
