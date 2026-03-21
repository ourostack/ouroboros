import { describe, expect, it, vi } from "vitest"

import type { CodingSession } from "../../../repertoire/coding/types"
import { prepareCodingContextPack } from "../../../repertoire/coding/context-pack"

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "coding-001",
    runner: "codex",
    workdir: "/Users/test/Projects/ouro",
    taskRef: "task-123",
    checkpoint: "working through the coding lane",
    artifactPath: "/Users/test/AgentBundles/slugger.ouro/state/coding/sessions/coding-001.md",
    status: "running",
    stdoutTail: "working",
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

describe("coding context pack", () => {
  it("writes deterministic scope/state files with repo instructions, skills, and workspace state", () => {
    const writes = new Map<string, string>()
    const mkdirSync = vi.fn()
    const writeFileSync = vi.fn((target: string, content: string) => {
      writes.set(target, content)
    })
    const existsSync = vi.fn((target: string) =>
      target === "/Users/test/Projects/ouro/AGENTS.md"
      || target === "/Users/test/Projects/ouro"
      || target === "/Users/test/Projects"
      || target === "/Users/test"
      || target === "/"
    )
    const readFileSync = vi.fn((target: string) => {
      if (target === "/Users/test/Projects/ouro/AGENTS.md") {
        return "## Repo Rules\n- do the work"
      }
      throw new Error(`unexpected read: ${target}`)
    })
    const runCommand = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.includes("--show-toplevel")) {
        return { status: 0, stdout: "/Users/test/Projects/ouro\n", stderr: "" }
      }
      if (args.includes("--abbrev-ref")) {
        return { status: 0, stdout: "slugger/pi-mono-capability-adoption\n", stderr: "" }
      }
      if (args.includes("--short") && args.includes("HEAD")) {
        return { status: 0, stdout: "42ee0bf\n", stderr: "" }
      }
      if (args.includes("status") && args.includes("--short")) {
        return { status: 0, stdout: " M src/repertoire/coding/tools.ts\n?? src/repertoire/coding/context-pack.ts\n", stderr: "" }
      }
      throw new Error(`unexpected command: ${args.join(" ")}`)
    })

    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "make the coding agent better",
          taskRef: "task-123",
          parentAgent: "slugger",
          obligationId: "ob-1",
          originSession: {
            friendId: "friend-1",
            channel: "teams",
            key: "thread-9",
          },
        },
        existingSessions: [
          makeSession(),
          makeSession({
            id: "coding-002",
            checkpoint: "waiting on a review decision",
            artifactPath: "/Users/test/AgentBundles/slugger.ouro/state/coding/sessions/coding-002.md",
            status: "waiting_input",
            lastActivityAt: "2026-03-21T00:06:00.000Z",
          }),
        ],
      },
      {
        agentRoot: "/Users/test/AgentBundles/slugger.ouro",
        agentName: "slugger",
        nowIso: () => "2026-03-21T00:51:00.000Z",
        existsSync,
        readFileSync,
        writeFileSync,
        mkdirSync,
        listSkills: () => ["frontend-design", "work-planner"],
        runCommand,
      },
    )

    expect(pack.contextKey).toMatch(/^[a-f0-9]{12}$/)
    expect(pack.scopeFile).toBe(`/Users/test/AgentBundles/slugger.ouro/state/coding/context/${pack.contextKey}-scope.md`)
    expect(pack.stateFile).toBe(`/Users/test/AgentBundles/slugger.ouro/state/coding/context/${pack.contextKey}-state.md`)
    expect(mkdirSync).toHaveBeenCalledWith("/Users/test/AgentBundles/slugger.ouro/state/coding/context", { recursive: true })

    const scope = writes.get(pack.scopeFile) ?? ""
    expect(scope).toContain("# Coding Session Scope")
    expect(scope).toContain("runner: codex")
    expect(scope).toContain("taskRef: task-123")
    expect(scope).toContain("make the coding agent better")
    expect(scope).toContain("## Project Context Files")
    expect(scope).toContain("/Users/test/Projects/ouro/AGENTS.md")
    expect(scope).toContain("## Repo Rules")
    expect(scope).toContain("## Available Bundle Skills")
    expect(scope).toContain("frontend-design")
    expect(scope).toContain("work-planner")

    const state = writes.get(pack.stateFile) ?? ""
    expect(state).toContain("# Coding Session State")
    expect(state).toContain("generatedAt: 2026-03-21T00:51:00.000Z")
    expect(state).toContain("obligationId: ob-1")
    expect(state).toContain("teams/thread-9")
    expect(state).toContain("branch: slugger/pi-mono-capability-adoption")
    expect(state).toContain("head: 42ee0bf")
    expect(state).toContain(" M src/repertoire/coding/tools.ts")
    expect(state).toContain("coding-001")
    expect(state).toContain("coding-002")
    expect(state).toContain("checkpoint=working through the coding lane")
    expect(state).toContain("artifact=/Users/test/AgentBundles/slugger.ouro/state/coding/sessions/coding-002.md")
  })

  it("still writes useful files when no repo context or git metadata is available", () => {
    const writes = new Map<string, string>()

    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "claude",
          workdir: "/tmp/plain-dir",
          prompt: "do the task",
          taskRef: "task-plain",
        },
        existingSessions: [],
      },
      {
        agentRoot: "/Users/test/AgentBundles/slugger.ouro",
        agentName: "slugger",
        nowIso: () => "2026-03-21T01:00:00.000Z",
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("should not read")
        },
        writeFileSync: (target, content) => {
          writes.set(target, content)
        },
        mkdirSync: () => {},
        listSkills: () => [],
        runCommand: () => ({ status: 1, stdout: "", stderr: "not a repo" }),
      },
    )

    expect(writes.get(pack.scopeFile)).toContain("## Project Context Files")
    expect(writes.get(pack.scopeFile)).toContain("(none found)")
    expect(writes.get(pack.stateFile)).toContain("git: unavailable")
    expect(writes.get(pack.stateFile)).toContain("activeSessions: none")
  })

  it("lists related sessions even when optional session metadata is absent", () => {
    const writes = new Map<string, string>()

    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "claude",
          workdir: "/tmp/plain-dir",
          prompt: "do the task",
        },
        existingSessions: [
          makeSession({
            id: "coding-plain",
            runner: "claude",
            workdir: "/tmp/plain-dir",
            taskRef: undefined,
            checkpoint: null,
            artifactPath: undefined,
            lastActivityAt: "2026-03-21T01:10:00.000Z",
          }),
        ],
      },
      {
        agentRoot: "/Users/test/AgentBundles/slugger.ouro",
        agentName: "slugger",
        nowIso: () => "2026-03-21T01:11:00.000Z",
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("should not read")
        },
        writeFileSync: (target, content) => {
          writes.set(target, content)
        },
        mkdirSync: () => {},
        listSkills: () => [],
        runCommand: () => ({ status: 1, stdout: "", stderr: "not a repo" }),
      },
    )

    const state = writes.get(pack.stateFile) ?? ""
    expect(state).toContain("- coding-plain status=running lastActivityAt=2026-03-21T01:10:00.000Z")
    expect(state).not.toContain("taskRef=")
    expect(state).not.toContain("checkpoint=")
    expect(state).not.toContain("artifact=")
  })

  it("falls back to default dependencies and tolerates partial git/context metadata", async () => {
    const writes = new Map<string, string>()
    const existsSync = vi.fn((target: string) =>
      target === "/tmp/project/AGENTS.md"
      || target === "/tmp/project/CLAUDE.md"
      || target === "/tmp/AGENTS.md"
    )
    const readFileSync = vi.fn((target: string) => {
      if (target === "/tmp/project/AGENTS.md") return "   \n"
      if (target === "/tmp/project/CLAUDE.md") return "## Local Instructions\nBe precise."
      if (target === "/tmp/AGENTS.md") throw new Error("read denied")
      throw new Error(`unexpected read: ${target}`)
    })
    const writeFileSync = vi.fn((target: string, content: string) => {
      writes.set(target, content)
    })
    const mkdirSync = vi.fn()
    const spawnSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe("git")
      if (args.includes("--show-toplevel")) {
        return { status: 0, stdout: "/tmp/project\n", stderr: "" }
      }
      if (args.includes("--abbrev-ref")) {
        return { status: 1, stdout: "", stderr: "detached" }
      }
      if (args.includes("--short") && args.includes("HEAD")) {
        return { status: 0, stdout: "\n", stderr: "" }
      }
      if (args.includes("status") && args.includes("--short")) {
        return { status: 1, stdout: "ignored\n", stderr: "status denied" }
      }
      throw new Error(`unexpected command: ${args.join(" ")}`)
    })

    vi.resetModules()
    vi.doMock("fs", () => ({
      existsSync,
      readFileSync,
      writeFileSync,
      mkdirSync,
    }))
    vi.doMock("child_process", () => ({
      spawnSync,
    }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/Users/test/AgentBundles/default.ouro",
      getAgentName: () => "default-agent",
    }))
    vi.doMock("../../../repertoire/skills", () => ({
      listSkills: () => ["work-doer"],
    }))

    try {
      const { prepareCodingContextPack: prepareWithDefaults } = await import("../../../repertoire/coding/context-pack")

      const pack = prepareWithDefaults({
        request: {
          runner: "codex",
          workdir: "/tmp/project",
          prompt: "ship it",
        },
      })

      expect(mkdirSync).toHaveBeenCalledWith("/Users/test/AgentBundles/default.ouro/state/coding/context", { recursive: true })

      const scope = writes.get(pack.scopeFile) ?? ""
      expect(scope).toContain("taskRef: unassigned")
      expect(scope).toContain("parentAgent: default-agent")
      expect(scope).toContain("obligationId: none")
      expect(scope).toContain("/tmp/project/CLAUDE.md")
      expect(scope).not.toContain("/tmp/project/AGENTS.md")
      expect(scope).toContain("work-doer")

      const state = writes.get(pack.stateFile) ?? ""
      expect(state).toContain("agent: default-agent")
      expect(state).toContain("originSession: none")
      expect(state).toContain("obligationId: none")
      expect(state).toContain("repoRoot: /tmp/project")
      expect(state).toContain("branch: unknown")
      expect(state).toContain("head: unknown")
      expect(state).toContain("status:\n(clean)")
      expect(state).toContain("activeSessions: none")
      expect(state).toMatch(/generatedAt: \d{4}-\d{2}-\d{2}T/)
    } finally {
      vi.doUnmock("fs")
      vi.doUnmock("child_process")
      vi.doUnmock("../../../heart/identity")
      vi.doUnmock("../../../repertoire/skills")
      vi.resetModules()
    }
  })

  it("records unknown git metadata when git commands return blank or failed values", () => {
    const writes = new Map<string, string>()
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/tmp/repo-blank-git",
          prompt: "investigate",
          taskRef: "task-blank-git",
        },
      },
      {
        agentRoot: "/Users/test/AgentBundles/slugger.ouro",
        agentName: "slugger",
        nowIso: () => "2026-03-21T01:12:00.000Z",
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("should not read")
        },
        writeFileSync: (target, content) => {
          writes.set(target, content)
        },
        mkdirSync: () => {},
        listSkills: () => [],
        runCommand: (_command, args) => {
          if (args.includes("--show-toplevel")) {
            return { status: 0, stdout: "\n", stderr: "" }
          }
          if (args.includes("--abbrev-ref")) {
            return { status: 0, stdout: "\n", stderr: "" }
          }
          if (args.includes("--short") && args.includes("HEAD")) {
            return { status: 1, stdout: "", stderr: "detached" }
          }
          if (args.includes("status") && args.includes("--short")) {
            return { status: 0, stdout: "", stderr: "" }
          }
          throw new Error(`unexpected command: ${args.join(" ")}`)
        },
      },
    )

    const state = writes.get(pack.stateFile) ?? ""
    expect(state).toContain("repoRoot: unknown")
    expect(state).toContain("branch: unknown")
    expect(state).toContain("head: unknown")
    expect(state).toContain("status:\n(clean)")
  })

  it("uses the default command runner when no override is provided", async () => {
    const writes = new Map<string, string>()
    const spawnSync = vi.fn(() => ({
      status: null,
      stdout: Buffer.from("ignored"),
      stderr: Buffer.from("ignored"),
    }))

    vi.resetModules()
    vi.doMock("child_process", () => ({
      spawnSync,
    }))

    const { prepareCodingContextPack: prepareWithDefaultRunner } = await import("../../../repertoire/coding/context-pack")

    const pack = prepareWithDefaultRunner(
      {
        request: {
          runner: "claude",
          workdir: "/tmp/plain-dir",
          prompt: "do the task",
          taskRef: "task-default-runner",
        },
        existingSessions: [],
      },
      {
        agentRoot: "/Users/test/AgentBundles/slugger.ouro",
        agentName: "slugger",
        nowIso: () => "2026-03-21T01:05:00.000Z",
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("should not read")
        },
        writeFileSync: (target, content) => {
          writes.set(target, content)
        },
        mkdirSync: () => {},
        listSkills: () => [],
      },
    )

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: "/tmp/plain-dir",
        encoding: "utf-8",
      },
    )
    expect(writes.get(pack.stateFile)).toContain("git: unavailable")
    vi.doUnmock("child_process")
  })
})
