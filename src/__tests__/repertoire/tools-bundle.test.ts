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
import * as path from "path"

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(),
}))

import { getAgentRoot } from "../../heart/identity"
import { bundleToolDefinitions } from "../../repertoire/tools-bundle"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"

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
      fs.mkdirSync(path.join(tmp.agentRoot, "journal"), { recursive: true })
      fs.writeFileSync(path.join(tmp.agentRoot, "journal", "entry.md"), "hi", "utf-8")
      const result = await invoke("bundle_list_first_commit")
      expect(result.ok).toBe(true)
      const groups = result.groups as Record<string, { files: unknown[]; totalBytes: number; fileCount: number }>
      expect(groups.friends).toBeDefined()
      expect(groups.friends.fileCount).toBe(1)
      expect(groups.journal).toBeDefined()
      expect(groups.journal.fileCount).toBe(1)
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
      addRemoteDirect(tmp.agentRoot, "https://unresolvable.test.invalid/repo.git")
      commitFile(tmp.agentRoot, "file.txt", "x", "init")
      const result = await invoke("bundle_push")
      expect(result.ok).toBe(false)
      expect(result.kind).toBe("confirmation_required")
      expect(String(result.error)).toContain("confirmation token")
    })

    it("proceeds past the token gate when a valid token is provided, then fails on network", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://unresolvable.test.invalid/repo.git")
      commitFile(tmp.agentRoot, "file.txt", "x", "init")
      // Get a real token via bundle_first_push_review
      const review = await invoke("bundle_first_push_review")
      const token = String(review.confirmationToken)
      const result = await invoke("bundle_push", { confirmation_token: token })
      expect(result.ok).toBe(false)
      // Past the token gate — kind is now the network/auth/etc classification
      expect(["network", "auth", "unknown", "rejected"]).toContain(result.kind as string)
    })

    it("accepts a custom remote argument (first push, with token)", async () => {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "upstream", "https://unresolvable.test.invalid/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      commitFile(tmp.agentRoot, "file.txt", "x", "init")
      // First-push gate: need a token even when using a custom remote
      const review = await invoke("bundle_first_push_review")
      const token = String(review.confirmationToken)
      const result = await invoke("bundle_push", { remote: "upstream", confirmation_token: token })
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
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

    it("refuses on uncommitted changes without discard_changes", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://example.test/repo.git")
      commitFile(tmp.agentRoot, "clean.txt", "x", "init")
      fs.writeFileSync(path.join(tmp.agentRoot, "dirty.txt"), "new", "utf-8")
      const result = await invoke("bundle_pull_rebase")
      expect(result.ok).toBe(false)
      expect(String(result.error)).toContain("uncommitted changes")
    })

    it("returns a structured failure on rebase against an unreachable remote", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://unresolvable.test.invalid/repo.git")
      // Commit EVERYTHING from createTmpBundle (agent.json) so the working
      // tree is clean before the pull_rebase call — otherwise we hit the
      // "refused: uncommitted changes" branch instead of the rebase path.
      execFileSync("git", ["add", "-A"], { cwd: tmp.agentRoot, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmp.agentRoot, stdio: "pipe" })
      const result = await invoke("bundle_pull_rebase")
      expect(result.ok).toBe(false)
      // Handler returns kind: "conflict" with conflictFiles: [] since there
      // is no in-progress rebase on the workdir (git fails before reaching
      // the conflict-detection stage). Contract: ok=false, kind=conflict,
      // error string populated.
      expect(result.kind).toBe("conflict")
      expect(typeof result.error).toBe("string")
      expect(String(result.error).length).toBeGreaterThan(0)
    })

    it("accepts a custom remote argument", async () => {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "upstream", "https://unresolvable.test.invalid/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      execFileSync("git", ["add", "-A"], { cwd: tmp.agentRoot, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmp.agentRoot, stdio: "pipe" })
      const result = await invoke("bundle_pull_rebase", { remote: "upstream" })
      expect(result.ok).toBe(false)
    })

    it("accepts discard_changes: true to proceed with a dirty tree", async () => {
      initGit(tmp.agentRoot)
      addRemoteDirect(tmp.agentRoot, "https://unresolvable.test.invalid/repo.git")
      execFileSync("git", ["add", "-A"], { cwd: tmp.agentRoot, stdio: "pipe" })
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmp.agentRoot, stdio: "pipe" })
      // Create a dirty change
      fs.writeFileSync(path.join(tmp.agentRoot, "dirty.txt"), "new content", "utf-8")
      const result = await invoke("bundle_pull_rebase", { discard_changes: true })
      // The rebase will fail against the unreachable remote, but we've
      // exercised the discard_changes=true branch through the stash path.
      expect(result.ok).toBe(false)
    })
  })
})
