import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──

const mockExecSync = vi.fn()
const mockExecFileSync = vi.fn()
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawn: vi.fn().mockReturnValue({
    unref: vi.fn(),
    pid: 1234,
    on: vi.fn(),
    stdout: null,
    stderr: null,
  }),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "" }),
}))

const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn().mockReturnValue(false)
const mockMkdirSync = vi.fn()

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  readdirSync: vi.fn().mockReturnValue([]),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  unlinkSync: vi.fn(),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: vi.fn((agent: string) => `/mock/bundles/${agent}`),
  getAgentName: vi.fn(() => "test-agent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  getAgentBundlesRoot: vi.fn(() => "/mock/bundles"),
  getAgentDaemonLogsDir: vi.fn(() => "/mock/logs"),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
  loadAgentConfig: vi.fn(() => ({
    name: "test-agent",
    configPath: "~/.agentsecrets/test-agent/secrets.json",
    provider: "anthropic",
  })),
}))

vi.mock("../../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn().mockReturnValue("dev"),
}))

const mockDetectPlatform = vi.fn()
vi.mock("../../../heart/platform", () => ({
  detectPlatform: (...args: unknown[]) => mockDetectPlatform(...args),
}))

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn().mockResolvedValue({ ok: true }),
}))

// ── Tests ──

describe("ouro setup WSL-aware", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecSync.mockReturnValue("")
    mockExecFileSync.mockReturnValue(Buffer.from(""))
    emitNervesEvent({
      component: "daemon",
      event: "daemon.setup_wsl_test_start",
      message: "WSL setup test",
      meta: {},
    })
  })

  describe("WSL platform", () => {
    beforeEach(() => {
      mockDetectPlatform.mockReturnValue("wsl")
      // Mock Windows home resolution
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "cmd.exe") return Buffer.from("C:\\Users\\testuser\r\n")
        if (cmd === "wslpath") return Buffer.from("/mnt/c/Users/testuser\n")
        return Buffer.from("")
      })
    })

    it("calls claude.exe instead of claude for MCP add", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0])
      expect(calls.some((c: unknown) => String(c).includes("claude.exe") && String(c).includes("mcp") && String(c).includes("add"))).toBe(true)
    })

    it("MCP serve command is prefixed with wsl", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const mcpAddCall = mockExecSync.mock.calls.find(
        (c: unknown[]) => String(c[0]).includes("mcp") && String(c[0]).includes("add"),
      )
      expect(mcpAddCall).toBeDefined()
      expect(String(mcpAddCall![0])).toContain("wsl ")
    })

    it("hook commands in settings.json are prefixed with wsl", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const settingsWrites = mockWriteFileSync.mock.calls.filter(
        (c: unknown[]) => String(c[0]).includes("settings.json"),
      )
      expect(settingsWrites.length).toBeGreaterThan(0)
      const written = JSON.parse(settingsWrites[0][1] as string)
      expect(written.hooks).toBeDefined()
      // Check that hook commands are prefixed with "wsl "
      const sessionStartCmd = written.hooks.SessionStart[0].hooks[0].command as string
      expect(sessionStartCmd).toMatch(/^wsl /)
    })

    it("settings.json is written to Windows-side path", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const settingsWrites = mockWriteFileSync.mock.calls.filter(
        (c: unknown[]) => String(c[0]).includes("settings.json"),
      )
      expect(settingsWrites.length).toBeGreaterThan(0)
      expect(String(settingsWrites[0][0])).toContain("/mnt/c/Users/testuser/.claude/settings.json")
    })

    it("CLAUDE.md is written to Windows-side path", async () => {
      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const claudeWrites = mockWriteFileSync.mock.calls.filter(
        (c: unknown[]) => String(c[0]).includes("CLAUDE.md"),
      )
      expect(claudeWrites.length).toBeGreaterThan(0)
      expect(String(claudeWrites[0][0])).toContain("/mnt/c/Users/testuser/.claude/CLAUDE.md")
    })
  })

  describe("windows-native platform", () => {
    it("outputs 'not yet supported' message and returns early", async () => {
      mockDetectPlatform.mockReturnValue("windows-native")

      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const output = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls
        .map((c: unknown[]) => c[0])
        .join("\n")
      expect(output).toContain("Windows native is not yet supported")
      expect(output).toContain("WSL2")
      // Should NOT have called execSync (no claude mcp add)
      expect(mockExecSync).not.toHaveBeenCalled()
    })
  })

  describe("non-WSL platforms", () => {
    it("macos uses claude (not claude.exe) and os.homedir() paths", async () => {
      mockDetectPlatform.mockReturnValue("macos")

      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      // Should call `claude` not `claude.exe`
      const calls = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]))
      const mcpCall = calls.find((c) => c.includes("mcp") && c.includes("add"))
      expect(mcpCall).toBeDefined()
      expect(mcpCall).toContain("claude mcp add")
      expect(mcpCall).not.toContain("claude.exe")
    })

    it("linux uses claude (not claude.exe) and os.homedir() paths", async () => {
      mockDetectPlatform.mockReturnValue("linux")

      const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
      const deps = createDefaultOuroCliDeps()
      deps.writeStdout = vi.fn()

      await runOuroCli(["setup", "--tool", "claude-code", "--agent", "test-agent"], deps)

      const calls = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]))
      const mcpCall = calls.find((c) => c.includes("mcp") && c.includes("add"))
      expect(mcpCall).toBeDefined()
      expect(mcpCall).not.toContain("claude.exe")
    })
  })
})
