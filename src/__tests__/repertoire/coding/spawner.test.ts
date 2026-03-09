import { describe, expect, it, vi } from "vitest"

import { spawnCodingProcess } from "../../../repertoire/coding/spawner"

class FakeProcess {
  readonly pid: number | undefined
  readonly stdin = {
    write: vi.fn(),
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
  it("builds claude command and prompt with metadata + state content", () => {
    const spawnFn = vi.fn(() => new FakeProcess(777))
    const existsSync = vi.fn((target: string) => target.endsWith("/state.md"))
    const readFileSync = vi.fn((target: string) => {
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
      { cwd: "/Users/test/AgentWorkspaces/ouroboros", stdio: ["pipe", "pipe", "pipe"] },
    )
    expect((result.process as any).stdin.write).toHaveBeenCalledWith(`${result.prompt}\n`)
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
})
