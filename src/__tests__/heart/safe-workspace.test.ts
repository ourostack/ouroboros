import { beforeEach, describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"
import {
  ensureSafeRepoWorkspace,
  getActiveSafeWorkspaceSelection,
  resetSafeWorkspaceSelection,
  resolveSafeRepoPath,
  resolveSafeShellExecution,
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
    expect(selection.workspaceBranch).toBe("slugger/safe-workspace-123")
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
    expect(selection.workspaceBranch).toBe("slugger/safe-workspace-456")
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
    expect(selection.workspaceBranch).toBe("main")
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

  it("maps relative repo-local paths into the chosen safe workspace", () => {
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
      requestedPath: "src/file.ts",
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 223,
    })

    expect(mapped.selection?.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-main-223")
    expect(mapped.resolvedPath).toBe("/bundle/state/workspaces/ouroboros-main-223/src/file.ts")
  })

  it("routes repo-root shell commands into the chosen safe workspace", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("main\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args.join(" ") === "pull --ff-only origin main") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const routed = resolveSafeShellExecution("cd /repo && git status", {
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 612,
    })

    expect(routed.selection?.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-main-612")
    expect(routed.cwd).toBe("/bundle/state/workspaces/ouroboros-main-612")
    expect(routed.command).toBe("cd /bundle/state/workspaces/ouroboros-main-612 && git status")
  })

  it("routes plain repo-local shell commands into the chosen safe workspace cwd", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("feature/thing\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const routed = resolveSafeShellExecution("git status --short", {
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 613,
    })

    expect(routed.selection?.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-origin-main-613")
    expect(routed.cwd).toBe("/bundle/state/workspaces/ouroboros-origin-main-613")
    expect(routed.command).toBe("git status --short")
  })

  it("leaves unrelated shell commands untouched", () => {
    const routed = resolveSafeShellExecution("date", {
      repoRoot: "/repo",
      agentName: "slugger",
    })

    expect(routed.selection).toBeNull()
    expect(routed.cwd).toBeUndefined()
    expect(routed.command).toBe("date")
  })

  it("leaves empty shell commands untouched without acquiring a workspace", () => {
    const routed = resolveSafeShellExecution("   ", {
      repoRoot: "/repo",
      agentName: "slugger",
    })

    expect(routed.selection).toBeNull()
    expect(routed.cwd).toBeUndefined()
    expect(routed.command).toBe("   ")
  })

  it("reuses the active selection and leaves already-mapped workspace paths unchanged", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("main\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args.join(" ") === "pull --ff-only origin main") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const first = ensureSafeRepoWorkspace({
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 444,
    })
    const second = ensureSafeRepoWorkspace({
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync: vi.fn(() => {
        throw new Error("should not reacquire")
      }) as any,
    })

    expect(second).toBe(first)

    const alreadyMapped = resolveSafeRepoPath({
      requestedPath: "/bundle/state/workspaces/ouroboros-main-444/src/file.ts",
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
    })

    expect(alreadyMapped.selection).toBe(first)
    expect(alreadyMapped.resolvedPath).toBe("/bundle/state/workspaces/ouroboros-main-444/src/file.ts")

    const alreadyMappedShell = resolveSafeShellExecution("git -C /bundle/state/workspaces/ouroboros-main-444 status", {
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
    })

    expect(alreadyMappedShell.selection).toBe(first)
    expect(alreadyMappedShell.cwd).toBe("/bundle/state/workspaces/ouroboros-main-444")
    expect(alreadyMappedShell.command).toBe("git -C /bundle/state/workspaces/ouroboros-main-444 status")
  })

  it("removes pre-existing workspace roots before creating worktrees and scratch clones", () => {
    const mkdirSync = vi.fn() as any
    const rmSync = vi.fn() as any
    const existsSync = vi.fn(() => true) as any

    const cloneWorktree = ensureSafeRepoWorkspace({
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync: vi.fn((command: string, args: string[]) => {
        expect(command).toBe("git")
        if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
        if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("feature/cleanup\n")
        if (args.join(" ") === "fetch origin") return spawnResult()
        if (args[0] === "worktree" && args[1] === "add") return spawnResult()
        throw new Error(`unexpected git args: ${args.join(" ")}`)
      }) as any,
      existsSync,
      mkdirSync,
      rmSync,
      now: () => 555,
    })

    expect(cloneWorktree.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-origin-main-555")
    expect(rmSync).toHaveBeenCalledWith("/bundle/state/workspaces/ouroboros-origin-main-555", { recursive: true, force: true })

    resetSafeWorkspaceSelection()
    existsSync.mockClear()
    rmSync.mockClear()

    const scratch = ensureSafeRepoWorkspace({
      repoRoot: "/installed/@ouro.bot/cli",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      canonicalRepoUrl: "https://github.com/ouroborosbot/ouroboros.git",
      spawnSync: vi.fn((command: string, args: string[]) => {
        expect(command).toBe("git")
        if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("", "fatal: not a git repository", 128)
        if (args[0] === "clone") return spawnResult()
        throw new Error(`unexpected git args: ${args.join(" ")}`)
      }) as any,
      existsSync,
      mkdirSync,
      rmSync,
      now: () => 556,
    })

    expect(scratch.workspaceRoot).toBe("/bundle/state/workspaces/ouroboros-scratch-556")
    expect(rmSync).toHaveBeenCalledWith("/bundle/state/workspaces/ouroboros-scratch-556", { recursive: true, force: true })
  })

  it("falls back to stdout details when git fails without stderr", () => {
    emitNervesEvent({ component: "workspace", event: "workspace.test_safe_stdout_fallback", message: "safe workspace stdout fallback test", meta: {} })
    expect(() =>
      ensureSafeRepoWorkspace({
        repoRoot: "/repo",
        agentName: "slugger",
        workspaceRoot: "/bundle/state/workspaces",
        spawnSync: vi.fn((command: string, args: string[]) => {
          expect(command).toBe("git")
          if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
          if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { stdout: Buffer.from("stdout-detail\n"), stderr: undefined, status: 1 } as any
          }
          throw new Error(`unexpected git args: ${args.join(" ")}`)
        }) as any,
        existsSync: vi.fn(() => false) as any,
        mkdirSync: vi.fn() as any,
        rmSync: vi.fn() as any,
      }),
    ).toThrow("git branch read failed: stdout-detail")
  })

  it("falls back to exit status when git fails without stderr or stdout", () => {
    emitNervesEvent({ component: "workspace", event: "workspace.test_safe_exit_fallback", message: "safe workspace exit fallback test", meta: {} })
    expect(() =>
      ensureSafeRepoWorkspace({
        repoRoot: "/repo",
        agentName: "slugger",
        workspaceRoot: "/bundle/state/workspaces",
        spawnSync: vi.fn((command: string, args: string[]) => {
          expect(command).toBe("git")
          if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
          if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { stdout: undefined, stderr: undefined, status: 7 } as any
          }
          throw new Error(`unexpected git args: ${args.join(" ")}`)
        }) as any,
        existsSync: vi.fn(() => false) as any,
        mkdirSync: vi.fn() as any,
        rmSync: vi.fn() as any,
      }),
    ).toThrow("git branch read failed: exit 7")

    resetSafeWorkspaceSelection()

    expect(() =>
      ensureSafeRepoWorkspace({
        repoRoot: "/repo",
        agentName: "slugger",
        workspaceRoot: "/bundle/state/workspaces",
        spawnSync: vi.fn((command: string, args: string[]) => {
          expect(command).toBe("git")
          if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
          if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { stdout: undefined, stderr: undefined, status: null } as any
          }
          throw new Error(`unexpected git args: ${args.join(" ")}`)
        }) as any,
        existsSync: vi.fn(() => false) as any,
        mkdirSync: vi.fn() as any,
        rmSync: vi.fn() as any,
      }),
    ).toThrow("git branch read failed: exit unknown")
  })

  it("surfaces git stderr details and tolerates cleanup-hook failures for scratch clones", () => {
    const registered: Array<() => void> = []
    vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "exit") {
        registered.push(listener)
      }
      return process
    }) as any)

    expect(() =>
      ensureSafeRepoWorkspace({
        repoRoot: "/repo",
        agentName: "slugger",
        workspaceRoot: "/bundle/state/workspaces",
        spawnSync: vi.fn((command: string, args: string[]) => {
          expect(command).toBe("git")
          if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
          if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("", "detached head", 1)
          throw new Error(`unexpected git args: ${args.join(" ")}`)
        }) as any,
        existsSync: vi.fn(() => false) as any,
        mkdirSync: vi.fn() as any,
        rmSync: vi.fn() as any,
      }),
    ).toThrow("git branch read failed: detached head")

    resetSafeWorkspaceSelection()
    const rmSync = vi.fn(() => {
      throw new Error("cleanup failed")
    }) as any

    ensureSafeRepoWorkspace({
      repoRoot: "/installed/@ouro.bot/cli",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      canonicalRepoUrl: "https://github.com/ouroborosbot/ouroboros.git",
      spawnSync: vi.fn((command: string, args: string[]) => {
        expect(command).toBe("git")
        if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("", "fatal: not a git repository", 128)
        if (args[0] === "clone") return spawnResult()
        throw new Error(`unexpected git args: ${args.join(" ")}`)
      }) as any,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync,
      now: () => 557,
    })

    expect(registered.length).toBeGreaterThanOrEqual(1)
    expect(() => registered.at(-1)?.()).not.toThrow()
    expect(rmSync).toHaveBeenCalledWith("/bundle/state/workspaces/ouroboros-scratch-557", { recursive: true, force: true })
  })

  it("covers default option fallbacks and the already-registered cleanup-hook path", async () => {
    vi.resetModules()

    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("", "fatal: not a git repository", 128)
      if (args[0] === "clone") return { stdout: undefined, stderr: undefined, status: 0 } as any
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })
    const existsSync = vi.fn(() => false)
    const mkdirSync = vi.fn()
    const rmSync = vi.fn()
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      return process
    }) as any)

    vi.doMock("../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
      return {
        ...actual,
        getAgentName: () => {
          throw new Error("agent unavailable")
        },
        getRepoRoot: () => "/installed/default-runtime",
        getAgentRepoWorkspacesRoot: (agentName: string) => `/bundle/defaults/${agentName}`,
        HARNESS_CANONICAL_REPO_URL: "https://example.com/canonical.git",
      }
    })
    vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process")
      return { ...actual, spawnSync }
    })
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs")
      return { ...actual, existsSync, mkdirSync, rmSync }
    })

    const mod = await import("../../heart/safe-workspace")
    mod.resetSafeWorkspaceSelection()

    vi.spyOn(Date, "now").mockReturnValue(559)
    const selection = mod.ensureSafeRepoWorkspace()
    expect(selection.workspaceRoot).toBe("/bundle/defaults/slugger/ouroboros-scratch-559")
    mod.resetSafeWorkspaceSelection({ keepCleanupHookRegistered: true })
    mod.ensureSafeRepoWorkspace()

    const resolvedViaDefaultRepoRoot = mod.resolveSafeRepoPath({
      requestedPath: "/installed/default-runtime/src/tool.ts",
      agentName: "slugger",
    })

    expect(resolvedViaDefaultRepoRoot.resolvedPath).toBe("/bundle/defaults/slugger/ouroboros-scratch-559/src/tool.ts")
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(mkdirSync).toHaveBeenCalled()
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "--branch", "main", "https://example.com/canonical.git", expect.stringContaining("/bundle/defaults/slugger/ouroboros-scratch-")],
      expect.any(Object),
    )
  })

  it("remaps repo paths when an active selection exists but the request is not already inside the workspace", () => {
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("main\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args.join(" ") === "pull --ff-only origin main") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    ensureSafeRepoWorkspace({
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync: vi.fn() as any,
      now: () => 560,
    })

    const remapped = resolveSafeRepoPath({
      requestedPath: "/repo/src/again.ts",
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
    })

    expect(remapped.resolvedPath).toBe("/bundle/state/workspaces/ouroboros-main-560/src/again.ts")
  })

  it("covers spawn errors, repo-root path mapping, and clone cleanup skip", () => {
    emitNervesEvent({ component: "workspace", event: "workspace.test_safe_spawn_error", message: "safe workspace spawn error test", meta: {} })
    const exitHandlers: Array<() => void> = []
    vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
      if (event === "exit") exitHandlers.push(listener)
      return process
    }) as any)

    expect(() =>
      ensureSafeRepoWorkspace({
        repoRoot: "/repo",
        agentName: "slugger",
        workspaceRoot: "/bundle/state/workspaces",
        spawnSync: vi.fn((command: string, args: string[]) => {
          expect(command).toBe("git")
          if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
          if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { error: new Error("spawn failed"), stdout: undefined, stderr: undefined, status: null } as any
          }
          throw new Error(`unexpected git args: ${args.join(" ")}`)
        }) as any,
        existsSync: vi.fn(() => false) as any,
        mkdirSync: vi.fn() as any,
        rmSync: vi.fn() as any,
      }),
    ).toThrow("spawn failed")

    resetSafeWorkspaceSelection()
    const rmSync = vi.fn() as any
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return spawnResult("true\n")
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return spawnResult("main\n")
      if (args.join(" ") === "fetch origin") return spawnResult()
      if (args.join(" ") === "pull --ff-only origin main") return spawnResult()
      if (args[0] === "worktree" && args[1] === "add") return spawnResult()
      throw new Error(`unexpected git args: ${args.join(" ")}`)
    })

    const rootMapped = resolveSafeRepoPath({
      requestedPath: "/repo",
      repoRoot: "/repo",
      agentName: "slugger",
      workspaceRoot: "/bundle/state/workspaces",
      spawnSync,
      existsSync: vi.fn(() => false) as any,
      mkdirSync: vi.fn() as any,
      rmSync,
      now: () => 558,
    })

    expect(rootMapped.resolvedPath).toBe("/bundle/state/workspaces/ouroboros-main-558")
    expect(() => exitHandlers.at(-1)?.()).not.toThrow()
    expect(rmSync).not.toHaveBeenCalled()
  })
})
