import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"

import { detectBundleState, renderBundleStateHint } from "../../heart/bundle-state"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"

function initGit(dir: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" })
}

function makeInitialCommit(dir: string): void {
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8")
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" })
}

describe("detectBundleState", () => {
  it("returns [not_a_git_repo] when .git is absent", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-no-git" })
    try {
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toEqual(["not_a_git_repo"])
    } finally {
      tmp.cleanup()
    }
  })

  it("returns [no_remote_configured, first_commit_never_happened] after fresh git init", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-fresh-init" })
    try {
      initGit(tmp.agentRoot)
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toEqual(["no_remote_configured", "first_commit_never_happened"])
    } finally {
      tmp.cleanup()
    }
  })

  it("returns [first_commit_never_happened] when git + remote exist but no commit", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-remote-no-commit" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toEqual(["first_commit_never_happened"])
    } finally {
      tmp.cleanup()
    }
  })

  it("returns [no_remote_configured] when git + commit exist but no remote", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-no-remote" })
    try {
      initGit(tmp.agentRoot)
      makeInitialCommit(tmp.agentRoot)
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toEqual(["no_remote_configured"])
    } finally {
      tmp.cleanup()
    }
  })

  it("returns [] for a fully-configured bundle", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-happy" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      makeInitialCommit(tmp.agentRoot)
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toEqual([])
    } finally {
      tmp.cleanup()
    }
  })

  it("flags pending_sync_exists when state/pending-sync.json is present", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-pending" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      makeInitialCommit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      fs.writeFileSync(
        path.join(tmp.agentRoot, "state", "pending-sync.json"),
        JSON.stringify({ error: "test", failedAt: new Date().toISOString() }),
        "utf-8",
      )
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toEqual(["pending_sync_exists"])
    } finally {
      tmp.cleanup()
    }
  })

  it("surfaces remote_push_failed when pending-sync classification is push_rejected", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-push-rejected" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      makeInitialCommit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      fs.writeFileSync(
        path.join(tmp.agentRoot, "state", "pending-sync.json"),
        JSON.stringify({
          error: "push rejected",
          failedAt: new Date().toISOString(),
          classification: "push_rejected",
          conflictFiles: [],
        }),
        "utf-8",
      )
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toContain("pending_sync_exists")
      expect(issues).toContain("remote_push_failed")
      expect(issues).not.toContain("pull_rebase_conflict")
    } finally {
      tmp.cleanup()
    }
  })

  it("surfaces pull_rebase_conflict when pending-sync classification is pull_rebase_conflict", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-rebase-conflict" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      makeInitialCommit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      fs.writeFileSync(
        path.join(tmp.agentRoot, "state", "pending-sync.json"),
        JSON.stringify({
          error: "rebase left conflicts",
          failedAt: new Date().toISOString(),
          classification: "pull_rebase_conflict",
          conflictFiles: ["journal/entry.md", "friends/ari.json"],
        }),
        "utf-8",
      )
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toContain("pending_sync_exists")
      expect(issues).toContain("pull_rebase_conflict")
    } finally {
      tmp.cleanup()
    }
  })

  it("tolerates pending-sync without classification (backward-compat)", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-legacy-pending" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      makeInitialCommit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      // Pre-alpha.288 schema: no classification field
      fs.writeFileSync(
        path.join(tmp.agentRoot, "state", "pending-sync.json"),
        JSON.stringify({ error: "legacy", failedAt: new Date().toISOString() }),
        "utf-8",
      )
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toContain("pending_sync_exists")
      expect(issues).not.toContain("remote_push_failed")
      expect(issues).not.toContain("pull_rebase_conflict")
    } finally {
      tmp.cleanup()
    }
  })

  it("tolerates malformed pending-sync.json", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-malformed-pending" })
    try {
      initGit(tmp.agentRoot)
      execFileSync("git", ["remote", "add", "origin", "https://example.test/repo.git"], {
        cwd: tmp.agentRoot,
        stdio: "pipe",
      })
      makeInitialCommit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      fs.writeFileSync(
        path.join(tmp.agentRoot, "state", "pending-sync.json"),
        "this is not valid json {{",
        "utf-8",
      )
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toContain("pending_sync_exists")
      expect(issues).not.toContain("remote_push_failed")
      expect(issues).not.toContain("pull_rebase_conflict")
    } finally {
      tmp.cleanup()
    }
  })

  it("returns multiple issues simultaneously when several conditions apply", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-multi" })
    try {
      // Fresh git init + pending-sync file = three issues
      initGit(tmp.agentRoot)
      fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
      fs.writeFileSync(
        path.join(tmp.agentRoot, "state", "pending-sync.json"),
        JSON.stringify({ error: "test", failedAt: new Date().toISOString() }),
        "utf-8",
      )
      const issues = detectBundleState(tmp.agentRoot)
      expect(issues).toContain("no_remote_configured")
      expect(issues).toContain("first_commit_never_happened")
      expect(issues).toContain("pending_sync_exists")
      expect(issues).toHaveLength(3)
    } finally {
      tmp.cleanup()
    }
  })

  it("treats missing git binary as no_remote_configured (graceful degradation)", () => {
    const tmp = createTmpBundle({ agentName: "bundle-state-no-git-bin" })
    try {
      // Fake .git dir so we go into the git path, inject a throwing exec
      fs.mkdirSync(path.join(tmp.agentRoot, ".git"), { recursive: true })
      const throwing = vi.fn(() => {
        throw new Error("git: command not found")
      })
      const issues = detectBundleState(tmp.agentRoot, {
        execFileSync: throwing as never,
      })
      expect(issues).toContain("no_remote_configured")
      expect(issues).toContain("first_commit_never_happened")
    } finally {
      tmp.cleanup()
    }
  })
})

describe("renderBundleStateHint", () => {
  it("returns empty string when issues array is empty", () => {
    expect(renderBundleStateHint([])).toBe("")
  })

  it("renders first-person hint text for a single issue", () => {
    const text = renderBundleStateHint(["not_a_git_repo"])
    expect(text).toContain("not a git repo")
    expect(text).toContain("bundle_check_sync_status")
    expect(text).toContain("i have the bundle_* tools")
  })

  it("renders all issues comma-separated for multi-issue arrays", () => {
    const text = renderBundleStateHint([
      "not_a_git_repo",
      "no_remote_configured",
      "first_commit_never_happened",
      "pending_sync_exists",
    ])
    expect(text).toContain("not a git repo")
    expect(text).toContain("no remote configured")
    expect(text).toContain("first commit never happened")
    expect(text).toContain("pending sync from a prior turn")
  })
})
