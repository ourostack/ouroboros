import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

const mockGetBoard = vi.fn()
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: mockGetBoard,
  }),
}))

vi.mock("../../heart/identity", () => ({
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    context: { maxTokens: 80000, contextMargin: 20 },
    humanFacing: { provider: "minimax", model: "test-model" },
    agentFacing: { provider: "minimax", model: "test-model" },
  })),
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

vi.mock("../../heart/core", async () => {
  const actual = await vi.importActual<typeof import("../../heart/core")>("../../heart/core")
  return {
    ...actual,
    getProviderDisplayLabel: vi.fn(() => "minimax (test-model)"),
  }
})

import * as fs from "fs"
import { bodyMapSection } from "../../mind/prompt"

describe("MCP system prompt — first-class tools (no mcpToolsSection)", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (typeof path === "string" && path.includes("package.json")) {
        return JSON.stringify({ version: "0.0.0-test" })
      }
      return ""
    })
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    mockGetBoard.mockReturnValue([])
  })

  describe("mcpToolsSection removed", () => {
    it("mcpToolsSection is not exported from prompt.ts", async () => {
      const prompt = await import("../../mind/prompt")
      expect("mcpToolsSection" in prompt).toBe(false)
    })

    it("buildSystem output does not contain '## mcp tools' section", async () => {
      const { buildSystem } = await import("../../mind/prompt")
      const mockManager = {
        listAllTools: vi.fn().mockReturnValue([
          {
            server: "browser",
            tools: [
              { name: "navigate", description: "Nav", inputSchema: {} },
            ],
          },
        ]),
      }
      const result = buildSystem({
        agentName: "testagent",
        mcpManager: mockManager as never,
      })
      expect(result).not.toContain("## mcp tools")
    })

    it("buildSystem without mcpManager also has no mcp tools section", async () => {
      const { buildSystem } = await import("../../mind/prompt")
      const result = buildSystem({ agentName: "testagent" })
      expect(result).not.toContain("## mcp tools")
    })
  })

  describe("bodyMapSection MCP entries", () => {
    it("includes ouro mcp list and ouro mcp call in body map", () => {
      const result = bodyMapSection("testagent")
      expect(result).toContain("ouro mcp list")
      expect(result).toContain("ouro mcp call")
    })
  })

  describe("bodyMapSection auth entries", () => {
    it("includes ouro auth, ouro auth verify, and ouro auth switch in body map", () => {
      const result = bodyMapSection("testagent")
      expect(result).toContain("ouro auth --agent testagent --provider")
      expect(result).toContain("ouro auth verify --agent testagent")
      expect(result).toContain("ouro auth switch --agent testagent --provider")
    })
  })

  describe("bodyMapSection config models entry", () => {
    it("includes ouro config models in body map", () => {
      const result = bodyMapSection("testagent")
      expect(result).toContain("ouro config models --agent testagent")
    })
  })

  describe("bodyMapSection auto-refresh note", () => {
    it("includes note that model/provider changes take effect automatically", () => {
      const result = bodyMapSection("testagent")
      expect(result).toContain("take effect on the next turn automatically")
      expect(result).toContain("no restart needed")
    })
  })
})
