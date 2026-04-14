import { describe, it, expect, vi, beforeEach } from "vitest"
import * as os from "os"
import { emitNervesEvent } from "../../../nerves/runtime"

// Mock child_process to capture execSync/spawnSync calls
const mockExecSync = vi.fn()
vi.mock("child_process", () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  spawn: vi.fn().mockReturnValue({
    unref: vi.fn(),
    pid: 1234,
    on: vi.fn(),
    stdout: null,
    stderr: null,
  }),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
}))

// Mock fs for settings file operations
const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn().mockReturnValue(false)
const mockMkdirSync = vi.fn()

vi.mock("fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
}))

// Mock identity
vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn((agent: string) => `/mock/bundles/${agent}`),
  getAgentName: vi.fn(() => "test-agent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  getAgentBundlesRoot: vi.fn(() => "/mock/bundles"),
  getAgentDaemonLogsDir: vi.fn(() => "/mock/logs"),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
  loadAgentConfig: vi.fn(() => ({
    name: "test-agent",
    provider: "anthropic",
  })),
}))

// Mock runtime-mode
vi.mock("../../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn().mockReturnValue("dev"),
}))

// Mock provider-ping
vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn().mockResolvedValue({ ok: true }),
}))

// ── Tests ──────────────────────────────────────────────────────

describe("ouro setup command", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecSync.mockReturnValue("")
    emitNervesEvent({
      component: "daemon",
      event: "daemon.setup_test_start",
      message: "setup command test",
      meta: {},
    })
  })

  describe("parseOuroCommand", () => {
    it("parses setup --tool claude-code --agent slugger", async () => {
      const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
      const cmd = parseOuroCommand(["setup", "--tool", "claude-code", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "setup", tool: "claude-code", agent: "slugger" })
    })

    it("parses setup --tool codex --agent slugger", async () => {
      const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
      const cmd = parseOuroCommand(["setup", "--tool", "codex", "--agent", "slugger"])
      expect(cmd).toEqual({ kind: "setup", tool: "codex", agent: "slugger" })
    })

    it("throws when --tool is missing", async () => {
      const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
      expect(() => parseOuroCommand(["setup", "--agent", "slugger"])).toThrow()
    })

    it("throws when --agent is missing", async () => {
      const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
      expect(() => parseOuroCommand(["setup", "--tool", "claude-code"])).toThrow()
    })

    it("throws when --agent is provided without a value", async () => {
      const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
      expect(() => parseOuroCommand(["setup", "--tool", "claude-code", "--agent"])).toThrow()
    })

    it("throws for unknown tool", async () => {
      const { parseOuroCommand } = await import("../../../heart/daemon/daemon-cli")
      expect(() => parseOuroCommand(["setup", "--tool", "vscode", "--agent", "slugger"])).toThrow()
    })
  })

  describe("runOuroCli setup execution", () => {
    it("claude-code setup runs claude mcp add", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // Should have called execSync with claude mcp add
      expect(mockExecSync).toHaveBeenCalled()
      const calls = mockExecSync.mock.calls.map((c: any[]) => c[0])
      expect(calls.some((c: string) => c.includes("claude") && c.includes("mcp") && c.includes("add"))).toBe(true)
    })

    it("claude-code setup writes hooks config", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      // Mock existing settings.json
      mockExistsSync.mockImplementation((p: any) => {
        return String(p).includes("settings.json")
      })
      mockReadFileSync.mockImplementation((p: any) => {
        if (String(p).includes("settings.json")) return JSON.stringify({})
        if (String(p).includes("package.json")) return JSON.stringify({ version: "0.1.0" })
        return ""
      })

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // Should write settings.json with hooks
      const settingsWrites = mockWriteFileSync.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("settings.json"),
      )
      expect(settingsWrites.length).toBeGreaterThan(0)
      const written = JSON.parse(settingsWrites[0][1])
      expect(written.hooks).toBeDefined()
    })

    it("codex setup runs codex mcp add", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "codex", "--agent", "test-agent"], deps)

      expect(mockExecSync).toHaveBeenCalled()
      const calls = mockExecSync.mock.calls.map((c: any[]) => c[0])
      expect(calls.some((c: string) => c.includes("codex") && c.includes("mcp") && c.includes("add"))).toBe(true)
    })

    it("claude-code setup reads existing CLAUDE.md and skips write when instructions present", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      // Mock CLAUDE.md already exists with the agent instructions
      mockExistsSync.mockImplementation((p: any) => {
        const s = String(p)
        return s.includes("CLAUDE.md") || s.includes("settings.json")
      })
      mockReadFileSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes("CLAUDE.md")) return "# My Claude\n## Agent conversations (ouro)\nExisting instructions\n"
        if (s.includes("settings.json")) return JSON.stringify({})
        return ""
      })

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // CLAUDE.md should NOT be written since instructions are already present
      const claudeWrites = mockWriteFileSync.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("CLAUDE.md"),
      )
      expect(claudeWrites).toHaveLength(0)
    })

    it("claude-code setup appends instructions to existing CLAUDE.md without agent section", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      // Mock CLAUDE.md exists but without agent instructions
      mockExistsSync.mockImplementation((p: any) => {
        const s = String(p)
        return s.includes("CLAUDE.md") || s.includes("settings.json")
      })
      mockReadFileSync.mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes("CLAUDE.md")) return "# My Claude\nSome existing content\n"
        if (s.includes("settings.json")) return JSON.stringify({})
        return ""
      })

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // CLAUDE.md SHOULD be written with appended instructions
      const claudeWrites = mockWriteFileSync.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("CLAUDE.md"),
      )
      expect(claudeWrites).toHaveLength(1)
      expect(claudeWrites[0][1]).toContain("Agent conversations (ouro)")
      expect(claudeWrites[0][1]).toContain("Some existing content")
    })

    it("uses bare ouro command in installed mode", async () => {
      const { detectRuntimeMode } = await import("../../../heart/daemon/runtime-mode")
      vi.mocked(detectRuntimeMode).mockReturnValue("installed")

      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // In installed mode, should use bare `ouro` command
      const calls = mockExecSync.mock.calls.map((c: any[]) => c[0])
      const mcpAddCall = calls.find((c: string) => c.includes("mcp") && c.includes("add"))
      expect(mcpAddCall).toBeDefined()
      expect(mcpAddCall).toContain("ouro mcp-serve")
      expect(mcpAddCall).not.toContain("node")
    })

    it("detects dev mode and uses node + absolute path", async () => {
      const { detectRuntimeMode } = await import("../../../heart/daemon/runtime-mode")
      vi.mocked(detectRuntimeMode).mockReturnValue("dev")

      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // In dev mode, mcp add command should use node + path to entry
      const calls = mockExecSync.mock.calls.map((c: any[]) => c[0])
      const mcpAddCall = calls.find((c: string) => c.includes("mcp") && c.includes("add"))
      expect(mcpAddCall).toBeDefined()
      // Should reference node or the repo path (dev mode)
      expect(mcpAddCall).toMatch(/node|dist/)
    })
  })
})
