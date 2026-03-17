import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  ensureSafeRepoWorkspace,
  getActiveSafeWorkspaceSelection,
  resetSafeWorkspaceSelection,
  resolveSafeRepoPath,
} from "../../heart/safe-workspace"

function spawnResult(stdout = "", stderr = "", status = 0) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    status,
  } as any
}

describe("safe workspace acquisition", () => {
  beforeEach(() => {
    resetSafeWorkspaceSelection()
    vi.restoreAllMocks()
  })

  it("fast-forwards main clones and creates a dedicated worktree before edits", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("main\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args.join(" ") === "pull --ff-only origin main") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const selection = ensureSafeRepoWorkspace({
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      canonicalRepoUrl: "https://github.com/ouroborosbot/ouroboros.git",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 123,
    })

    expect(selection.runtimeKind).toBe("clone-main")
    expect(selection.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-main-123")
    expect(selection.cleanupAfterMerge).toBe(false)
    expect(selection.note).toContain("fast-forwarded")
    expect(spawnSync).toHaveBeenCalledWith("git", ["pull", "--ff-only", "origin", "main"], expect.any(Object))
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-B", "slugger/safe-workspace-123", "/bundle/state/workspaces/ouroboros-main-123", "origin/main"],
      expect.any(Object),
    )
  })

  it("defaults non-main clones to origin/main in a dedicated worktree", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("feature/thing\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const selection = ensureSafeRepoWorkspace({
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 456,
    })

    expect(selection.runtimeKind).toBe("clone-non-main")
    expect(selection.sourceBranch).toBe("feature/thing")
    expect(selection.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-origin-main-456")
    expect(selection.note).toContain("feature/thing")
    expect(selection.note).toContain("origin/main")
    expect(spawnSync).not.toHaveBeenCalledWith("git", ["pull", "--ff-only", "origin", "main"], expect.any(Object))
  })

  it("creates scratch clones from the canonical repo when not running inside a clone", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("", "fatal: not a git repository", 128)
      if (args[0] === "clone") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const selection = ensureSafeRepoWorkspace({
      repoRoot: "/installed/@ouro.bot/cli",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      canonicalRepoUrl: "https://github.com/ouroborosbot/ouroboros.git",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 789,
    })

    expect(selection.runtimeKind).toBe("installed-runtime")
    expect(selection.cleanupAfterMerge).toBe(true)
    expect(selection.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-scratch-789")
    expect(selection.sourceCloneUrl).toBe("https://github.com/ouroborosbot/ouroboros.git")
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "--branch", "main", "https://github.com/ouroborosbot/ouroboros.git", "/bundle/state/workspaces/ouroboros-scratch-789"],
      expect.any(Object),
    )
  })

  it("maps repo paths into the chosen safe workspace and leaves unrelated paths alone", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("main\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args.join(" ") === "pull --ff-only origin main") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const mapped = resolveSafeRepoPath({
      requestedPath: "/repo/src/file.ts",
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 222,
    })

    expect(mapped.selection?.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-main-222")
    expect(mapped.resolvedPath).toBe("/bundle/state/workspaces/ouroboros-main-222/src/file.ts")
    expect(getActiveSafeWorkspaceSelection()?.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-main-222")

    const untouched = resolveSafeRepoPath({
      requestedPath: "/tmp/notes.txt",
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 333,
    })

    expect(untouched.resolvedPath).toBe("/tmp/notes.txt")
  })
})
