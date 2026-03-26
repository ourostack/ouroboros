import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

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

describe("codex spawner MCP injection", () => {
  it("includes --ephemeral flag for codex runner", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing codex ephemeral flag",
      meta: {},
    })

    const spawnFn = vi.fn(() => new FakeProcess(100))
    const result = spawnCodingProcess(
      {
        runner: "codex",
        workdir: "/test/workspace",
        prompt: "test",
        parentAgent: "test-agent",
      },
      { spawnFn, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "") },
    )

    expect(result.args).toContain("--ephemeral")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "codex ephemeral flag test complete",
      meta: {},
    })
  })

  it("includes --json flag for codex runner", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing codex json flag",
      meta: {},
    })

    const spawnFn = vi.fn(() => new FakeProcess(101))
    const result = spawnCodingProcess(
      {
        runner: "codex",
        workdir: "/test/workspace",
        prompt: "test",
        parentAgent: "test-agent",
      },
      { spawnFn, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "") },
    )

    expect(result.args).toContain("--json")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "codex json flag test complete",
      meta: {},
    })
  })

  it("includes -c flag with MCP server config for codex runner", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing codex MCP injection",
      meta: {},
    })

    const spawnFn = vi.fn(() => new FakeProcess(102))
    const result = spawnCodingProcess(
      {
        runner: "codex",
        workdir: "/test/workspace",
        prompt: "test",
        parentAgent: "test-agent",
      },
      { spawnFn, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "") },
    )

    const cIndex = result.args.indexOf("-c")
    expect(cIndex).toBeGreaterThan(-1)
    const configArg = result.args[cIndex + 1]
    expect(configArg).toBeDefined()
    const config = JSON.parse(configArg)
    expect(config.mcp_servers).toBeDefined()
    expect(config.mcp_servers.ouro).toBeDefined()
    expect(config.mcp_servers.ouro.command).toBe("ouro")
    expect(config.mcp_servers.ouro.args).toContain("mcp-serve")
    expect(config.mcp_servers.ouro.args).toContain("--agent")
    expect(config.mcp_servers.ouro.args).toContain("test-agent")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "codex MCP injection test complete",
      meta: {},
    })
  })

  it("does not include codex-specific flags for claude runner", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing claude runner unchanged",
      meta: {},
    })

    const spawnFn = vi.fn(() => new FakeProcess(103))
    const result = spawnCodingProcess(
      {
        runner: "claude",
        workdir: "/test/workspace",
        prompt: "test",
        parentAgent: "test-agent",
      },
      { spawnFn, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "") },
    )

    expect(result.args).not.toContain("--ephemeral")
    expect(result.args).not.toContain("--json")
    expect(result.args).not.toContain("-c")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "claude runner unchanged test complete",
      meta: {},
    })
  })
})
