import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
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
  })),
  getAgentName: vi.fn(() => "testagent"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

import * as fs from "fs"
import { bodyMapSection, mcpToolsSection } from "../../mind/prompt"

describe("MCP system prompt injection", () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue("")
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    mockGetBoard.mockReturnValue([])
  })

  describe("mcpToolsSection", () => {
    it("returns empty string when no mcpManager provided", () => {
      const result = mcpToolsSection(undefined)
      expect(result).toBe("")
    })

    it("returns empty string when mcpManager has no tools", () => {
      const mockManager = {
        listAllTools: vi.fn().mockReturnValue([]),
      }
      const result = mcpToolsSection(mockManager as never)
      expect(result).toBe("")
    })

    it("formats tools section with server names and tool descriptions", () => {
      const mockManager = {
        listAllTools: vi.fn().mockReturnValue([
          {
            server: "ado",
            tools: [
              { name: "get_work_items", description: "Query work items from ADO", inputSchema: {} },
              { name: "create_work_item", description: "Create a new work item", inputSchema: {} },
            ],
          },
          {
            server: "mail",
            tools: [
              { name: "send_mail", description: "Send an email", inputSchema: {} },
            ],
          },
        ]),
      }
      const result = mcpToolsSection(mockManager as never)

      expect(result).toContain("mcp tools")
      expect(result).toContain("ouro mcp call")
      expect(result).toContain("### ado")
      expect(result).toContain("- get_work_items: Query work items from ADO")
      expect(result).toContain("- create_work_item: Create a new work item")
      expect(result).toContain("### mail")
      expect(result).toContain("- send_mail: Send an email")
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
})
