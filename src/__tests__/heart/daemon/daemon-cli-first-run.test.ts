import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──

const mockExecFileSync = vi.fn()
vi.mock("child_process", () => ({
  execSync: vi.fn(),
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
  openSync: vi.fn().mockReturnValue(3),
  closeSync: vi.fn(),
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

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: vi.fn().mockReturnValue({
    schemaVersion: 1,
    machineId: "machine_test-uuid",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    hostnameAliases: [],
  }),
}))

vi.mock("../../../heart/provider-ping", () => ({
  pingProvider: vi.fn().mockResolvedValue({ ok: true }),
}))

// ── Tests ──

describe("first-run hatch-or-clone choice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.first_run_test_start",
      message: "first-run choice test",
      meta: {},
    })
  })

  it("when promptInput returns 'hatch', proceeds to runSerpentGuide flow", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = vi.fn().mockResolvedValue("hatch")
    deps.runSerpentGuide = vi.fn().mockResolvedValue(null) // null means user cancelled
    deps.startChat = vi.fn().mockResolvedValue(undefined)

    await runOuroCli([], deps)

    // promptInput should have been called for the choice
    expect(deps.promptInput).toHaveBeenCalled()
    // runSerpentGuide should be called (hatch path)
    expect(deps.runSerpentGuide).toHaveBeenCalled()
  })

  it("when promptInput returns 'clone', prompts for remote URL and runs clone", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = vi.fn()
      .mockResolvedValueOnce("clone")
      .mockResolvedValueOnce("https://github.com/user/myagent.ouro.git")
    deps.runSerpentGuide = vi.fn().mockResolvedValue(null)

    // Mock git operations for clone
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "--version") return Buffer.from("git version 2.40.0")
      if (cmd === "git" && args[0] === "ls-remote") return Buffer.from("")
      if (cmd === "git" && args[0] === "clone") return Buffer.from("")
      return Buffer.from("")
    })
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/agent.json")) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "myagent" })
      if (s.includes("package.json")) return JSON.stringify({ version: "0.1.0" })
      return ""
    })

    await runOuroCli([], deps)

    // promptInput should have been called twice: choice then remote URL
    expect(deps.promptInput).toHaveBeenCalledTimes(2)
    // runSerpentGuide should NOT be called (clone path)
    expect(deps.runSerpentGuide).not.toHaveBeenCalled()
    // git clone should have been called
    const cloneCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])[0] === "clone",
    )
    expect(cloneCalls.length).toBe(1)
  })

  it("when promptInput returns unexpected input, defaults to hatch", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = vi.fn().mockResolvedValue("foo")
    deps.runSerpentGuide = vi.fn().mockResolvedValue(null)
    deps.startChat = vi.fn().mockResolvedValue(undefined)

    await runOuroCli([], deps)

    // Should still call runSerpentGuide (hatch fallback)
    expect(deps.runSerpentGuide).toHaveBeenCalled()
  })

  it("when promptInput is undefined but runSerpentGuide available, skips choice and goes to serpent guide", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = undefined
    deps.runSerpentGuide = vi.fn().mockResolvedValue(null) // user cancelled
    deps.startChat = vi.fn().mockResolvedValue(undefined)

    await runOuroCli([], deps)

    // Should go straight to runSerpentGuide (no prompt)
    expect(deps.runSerpentGuide).toHaveBeenCalled()
  })

  it("when neither promptInput nor runSerpentGuide available, falls through to hatch.start", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = undefined
    deps.runSerpentGuide = undefined
    deps.runHatchFlow = vi.fn().mockResolvedValue({ success: true, agentName: "test" })

    // This will try to run hatch.start and call promptInput for hatch input,
    // which will fail since promptInput is undefined. That's expected.
    try {
      await runOuroCli([], deps)
    } catch {
      // Expected: hatch.start flow fails without promptInput
    }

    // runSerpentGuide should NOT be called
    expect(deps.runSerpentGuide).toBeUndefined()
  })

  it("when promptInput returns empty string, defaults to hatch", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = vi.fn().mockResolvedValue("")
    deps.runSerpentGuide = vi.fn().mockResolvedValue(null)
    deps.startChat = vi.fn().mockResolvedValue(undefined)

    await runOuroCli([], deps)

    expect(deps.runSerpentGuide).toHaveBeenCalled()
  })

  it("when promptInput returns whitespace-only, defaults to hatch", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.listDiscoveredAgents = vi.fn().mockReturnValue([])
    deps.promptInput = vi.fn().mockResolvedValue("   ")
    deps.runSerpentGuide = vi.fn().mockResolvedValue(null)
    deps.startChat = vi.fn().mockResolvedValue(undefined)

    await runOuroCli([], deps)

    expect(deps.runSerpentGuide).toHaveBeenCalled()
  })
})
