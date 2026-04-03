import { describe, expect, it, vi } from "vitest"

import { prepareCodingContextPack } from "../../../repertoire/coding/context-pack"
import type { CodingIdentityPacket } from "../../../repertoire/coding/context-pack"
import type { CodingSession } from "../../../repertoire/coding/types"

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "coding-001",
    runner: "codex",
    workdir: "/Users/test/Projects/ouro",
    taskRef: "task-123",
    checkpoint: "working through the coding lane",
    artifactPath: "/path/to/artifact",
    status: "running",
    stdoutTail: "",
    stderrTail: "",
    pid: 1234,
    startedAt: "2026-03-21T00:00:00.000Z",
    lastActivityAt: "2026-03-21T00:05:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
    ...overrides,
  }
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentRoot: "/Users/test/AgentBundles/slugger.ouro",
    agentName: "slugger",
    nowIso: () => "2026-04-03T12:00:00.000Z",
    existsSync: () => false,
    readFileSync: () => { throw new Error("should not read") },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    listSkills: () => [],
    runCommand: (_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/Projects/ouro\n", stderr: "" }
      if (args.includes("--abbrev-ref")) return { status: 0, stdout: "feat/my-feature\n", stderr: "" }
      if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "abc1234\n", stderr: "" }
      if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: " M src/file.ts\n", stderr: "" }
      if (args.includes("rev-parse") && args.includes("--show-prefix")) return { status: 0, stdout: "\n", stderr: "" }
      return { status: 1, stdout: "", stderr: "" }
    },
    ...overrides,
  }
}

describe("CodingIdentityPacket", () => {
  it("is exported as a type from context-pack", () => {
    // Type-level assertion: CodingIdentityPacket has the required fields
    const packet: CodingIdentityPacket = {
      repoPath: "/Users/test/Projects/ouro",
      worktreePath: "/Users/test/Projects/ouro",
      branch: "feat/my-feature",
      commit: "abc1234",
      dirty: true,
      dirtyFiles: [" M src/file.ts"],
      taskRef: "task-123",
      verificationCommands: ["npm test", "npx tsc --noEmit"],
      verificationStatus: "not-verified",
    }
    expect(packet.repoPath).toBe("/Users/test/Projects/ouro")
    expect(packet.branch).toBe("feat/my-feature")
    expect(packet.commit).toBe("abc1234")
    expect(packet.dirty).toBe(true)
    expect(packet.dirtyFiles).toEqual([" M src/file.ts"])
    expect(packet.taskRef).toBe("task-123")
    expect(packet.verificationCommands).toEqual(["npm test", "npx tsc --noEmit"])
    expect(packet.verificationStatus).toBe("not-verified")
  })

  it("prepareCodingContextPack returns an identityPacket in the result", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "fix the bug",
          taskRef: "task-123",
        },
      },
      baseDeps(),
    )

    expect(pack.identityPacket).toBeDefined()
    expect(pack.identityPacket.repoPath).toBe("/Users/test/Projects/ouro")
    expect(pack.identityPacket.branch).toBe("feat/my-feature")
    expect(pack.identityPacket.commit).toBe("abc1234")
    expect(pack.identityPacket.dirty).toBe(true)
    expect(pack.identityPacket.dirtyFiles).toEqual([" M src/file.ts"])
    expect(pack.identityPacket.taskRef).toBe("task-123")
    expect(pack.identityPacket.verificationStatus).toBe("not-verified")
  })

  it("identity packet has dirty=false and empty dirtyFiles when repo is clean", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "review",
        },
      },
      baseDeps({
        runCommand: (_cmd: string, args: string[]) => {
          if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/Projects/ouro\n", stderr: "" }
          if (args.includes("--abbrev-ref")) return { status: 0, stdout: "main\n", stderr: "" }
          if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "def5678\n", stderr: "" }
          if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: "", stderr: "" }
          return { status: 1, stdout: "", stderr: "" }
        },
      }),
    )

    expect(pack.identityPacket.dirty).toBe(false)
    expect(pack.identityPacket.dirtyFiles).toEqual([])
  })

  it("identity packet handles missing git (no repo)", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "claude",
          workdir: "/tmp/no-repo",
          prompt: "do stuff",
        },
      },
      baseDeps({
        runCommand: () => ({ status: 1, stdout: "", stderr: "not a repo" }),
      }),
    )

    expect(pack.identityPacket.repoPath).toBeNull()
    expect(pack.identityPacket.worktreePath).toBeNull()
    expect(pack.identityPacket.branch).toBeNull()
    expect(pack.identityPacket.commit).toBeNull()
    expect(pack.identityPacket.dirty).toBe(false)
    expect(pack.identityPacket.dirtyFiles).toEqual([])
  })

  it("identity packet state content includes an identity section", () => {
    const writes = new Map<string, string>()
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "fix the bug",
          taskRef: "task-123",
        },
      },
      baseDeps({
        writeFileSync: (target: string, content: string) => { writes.set(target, content) },
      }),
    )

    const state = writes.get(pack.stateFile) ?? ""
    expect(state).toContain("## Coding Identity")
    expect(state).toContain("repoPath: /Users/test/Projects/ouro")
    expect(state).toContain("branch: feat/my-feature")
    expect(state).toContain("commit: abc1234")
    expect(state).toContain("dirty: true")
    expect(state).toContain("taskRef: task-123")
    expect(state).toContain("verificationStatus: not-verified")
  })

  it("identity packet picks up worktree path distinct from repo root", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/worktrees/my-task",
          prompt: "fix it",
        },
      },
      baseDeps({
        runCommand: (_cmd: string, args: string[]) => {
          if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/worktrees/my-task\n", stderr: "" }
          if (args.includes("--abbrev-ref")) return { status: 0, stdout: "feat/task-branch\n", stderr: "" }
          if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "aaa1111\n", stderr: "" }
          if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: "", stderr: "" }
          if (args.includes("rev-parse") && args.includes("--git-common-dir")) return { status: 0, stdout: "/Users/test/Projects/ouro/.git\n", stderr: "" }
          return { status: 1, stdout: "", stderr: "" }
        },
      }),
    )

    expect(pack.identityPacket.worktreePath).toBe("/Users/test/worktrees/my-task")
    expect(pack.identityPacket.branch).toBe("feat/task-branch")
  })

  it("identity packet includes verification commands from project context", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "fix the bug",
          taskRef: "task-123",
          verificationCommands: ["npm test", "npx tsc --noEmit"],
        },
      },
      baseDeps(),
    )

    expect(pack.identityPacket.verificationCommands).toEqual(["npm test", "npx tsc --noEmit"])
  })

  it("defaults verificationCommands to empty array when not provided", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "fix the bug",
        },
      },
      baseDeps(),
    )

    expect(pack.identityPacket.verificationCommands).toEqual([])
  })

  it("verificationStatus is 'not-verified' by default", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "fix",
        },
      },
      baseDeps(),
    )

    expect(pack.identityPacket.verificationStatus).toBe("not-verified")
  })
})
