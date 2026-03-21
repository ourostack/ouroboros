import { describe, expect, it, vi } from "vitest"

import { spawnCodingProcess } from "../../../repertoire/coding/spawner"

class FakeProcess {
  readonly pid: number | undefined
  readonly stdin = {
    end: vi.fn(),
  }
  readonly stdout = {
    on: vi.fn(),
  }
  readonly stderr = {
    on: vi.fn(),
  }
  readonly on = vi.fn()
  readonly kill = vi.fn(() => true)

  constructor(pid?: number) {
    this.pid = pid
  }
}

describe("coding spawner", () => {
  it("builds claude command and prompt with metadata, scope content, and state content", () => {
    const spawnFn = vi.fn(() => new FakeProcess(777))
    const existsSync = vi.fn((target: string) => target.endsWith("/scope.md") || target.endsWith("/state.md"))
    const readFileSync = vi.fn((target: string) => {
      if (target.endsWith("/scope.md")) return "SCOPE PAYLOAD"
      if (target.endsWith("/state.md")) return "STATE PAYLOAD"
      return ""
    })

    const result = spawnCodingProcess(
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "execute",
        sessionId: "coding-777",
        parentAgent: "slugger",
        taskRef: "task-123",
        scopeFile: "/tmp/scope.md",
        stateFile: "/tmp/state.md",
      },
      { spawnFn, existsSync, readFileSync },
    )

    expect(result.command).toBe("claude")
    expect(result.args).toEqual([
      "-p",
      "--verbose",
      "--no-session-persistence",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/Users/test/AgentWorkspaces/ouroboros",
      "--output-format",
      "stream-json",
    ])
    expect(result.prompt).toContain("Coding session metadata")
    expect(result.prompt).toContain("sessionId: coding-777")
    expect(result.prompt).toContain("parentAgent: slugger")
    expect(result.prompt).toContain("taskRef: task-123")
    expect(result.prompt).toContain("Scope file (/tmp/scope.md):")
    expect(result.prompt).toContain("SCOPE PAYLOAD")
    expect(result.prompt).toContain("State file (/tmp/state.md):")
    expect(result.prompt).toContain("STATE PAYLOAD")
    expect(result.prompt).toContain("execute")
    expect(spawnFn).toHaveBeenCalledWith(
      "claude",
      [
        "-p",
        "--verbose",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--add-dir",
        "/Users/test/AgentWorkspaces/ouroboros",
        "--output-format",
        "stream-json",
      ],
      expect.objectContaining({
        cwd: "/Users/test/AgentWorkspaces/ouroboros",
        env: expect.objectContaining({ PATH: expect.stringContaining(".ouro-cli/bin") }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    )
    expect((result.process as any).stdin.end).toHaveBeenCalledWith(`${result.prompt}\n`)
  })

  it("builds codex command and prompt fallback when files are missing", () => {
    const spawnFn = vi.fn(() => new FakeProcess())
    const existsSync = vi.fn(() => false)
    const readFileSync = vi.fn(() => "unused")

    const result = spawnCodingProcess(
      {
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        prompt: "plan",
        taskRef: "task-456",
      },
      { spawnFn, existsSync, readFileSync },
    )

    expect(result.command).toBe("codex")
    expect(result.args).toEqual(["exec", "--skip-git-repo-check", "--cd", "/Users/test/AgentWorkspaces/slugger"])
    expect(result.prompt).toContain("taskRef: task-456")
    expect(result.prompt).toContain("plan")
    expect(readFileSync).not.toHaveBeenCalled()
  })

  it("drops empty state content from prompt sections", () => {
    const spawnFn = vi.fn(() => new FakeProcess(99))
    const existsSync = vi.fn(() => true)
    const readFileSync = vi.fn(() => "   ")

    const result = spawnCodingProcess(
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "merge now",
        taskRef: "task-merge",
        stateFile: "/tmp/blank.md",
      },
      { spawnFn, existsSync, readFileSync },
    )

    expect(result.prompt).not.toContain("Scope file")
    expect(result.prompt).not.toContain("State file")
    expect(result.prompt).toContain("taskRef: task-merge")
    expect(result.prompt).toContain("merge now")
  })

  it("uses metadata fallbacks when task/session fields are missing", () => {
    const spawnFn = vi.fn(() => new FakeProcess(303))
    const existsSync = vi.fn(() => false)
    const readFileSync = vi.fn(() => "")

    const result = spawnCodingProcess(
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/slugger",
        prompt: "fallback metadata",
      },
      { spawnFn, existsSync, readFileSync },
    )

    expect(result.prompt).toContain("sessionId: pending")
    expect(result.prompt).toContain("parentAgent: unknown")
    expect(result.prompt).toContain("taskRef: unassigned")
  })

  it("prepends ~/.ouro-cli/bin to PATH when missing", () => {
    const spawnFn = vi.fn(() => new FakeProcess(404))

    spawnCodingProcess(
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "check runtime",
        taskRef: "task-path",
      },
      {
        spawnFn,
        homeDir: "/Users/test",
        baseEnv: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
      },
    )

    const options = spawnFn.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
    expect(options.env.PATH).toBe("/Users/test/.ouro-cli/bin:/usr/bin:/bin")
  })

  it("handles missing PATH env var gracefully", () => {
    const spawnFn = vi.fn(() => new FakeProcess(406))

    spawnCodingProcess(
      {
        runner: "claude",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "check runtime",
        taskRef: "task-path",
      },
      {
        spawnFn,
        homeDir: "/Users/test",
        baseEnv: { HOME: "/Users/test" },
      },
    )

    const options = spawnFn.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
    expect(options.env.PATH).toBe("/Users/test/.ouro-cli/bin")
  })

  it("does not duplicate ~/.ouro-cli/bin when already present", () => {
    const spawnFn = vi.fn(() => new FakeProcess(405))

    spawnCodingProcess(
      {
        runner: "codex",
        workdir: "/Users/test/AgentWorkspaces/ouroboros",
        prompt: "check runtime",
        taskRef: "task-path",
      },
      {
        spawnFn,
        homeDir: "/Users/test",
        baseEnv: { PATH: "/Users/test/.ouro-cli/bin:/usr/bin:/bin", HOME: "/Users/test" },
      },
    )

    const options = spawnFn.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
    expect(options.env.PATH).toBe("/Users/test/.ouro-cli/bin:/usr/bin:/bin")
  })
})
