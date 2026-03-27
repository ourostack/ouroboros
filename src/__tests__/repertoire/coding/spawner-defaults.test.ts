import { beforeEach, describe, expect, it, vi } from "vitest"

const spawnMock = vi.fn()

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

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

describe("coding spawner defaults", () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it("uses default spawn dependency when no overrides are provided", async () => {
    const proc = new FakeProcess(55)
    spawnMock.mockReturnValue(proc)

    const { spawnCodingProcess } = await import("../../../repertoire/coding/spawner")
    const result = spawnCodingProcess({
      runner: "codex",
      workdir: "/Users/test/AgentWorkspaces/ouroboros",
      prompt: "default deps",
      taskRef: "task-default",
    })

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--cd",
        "/Users/test/AgentWorkspaces/ouroboros",
        "--ephemeral",
        "--json",
        "-c",
        "mcp_servers.ouro.command=node",
        "-c",
        expect.stringContaining("mcp_servers.ouro.args="),
      ],
      expect.objectContaining({
        cwd: "/Users/test/AgentWorkspaces/ouroboros",
        env: expect.objectContaining({ PATH: expect.any(String) }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    )
    expect(result.process).toBe(proc)
    expect(proc.stdin.end).toHaveBeenCalledWith(expect.stringContaining("taskRef: task-default"))
  })
})
