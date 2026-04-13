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
const mockReaddirSync = vi.fn().mockReturnValue([])

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
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

describe("manual-clone detection (checkManualCloneBundles)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockReaddirSync.mockReturnValue([])
    emitNervesEvent({
      component: "daemon",
      event: "daemon.manual_clone_test_start",
      message: "manual clone detection test",
      meta: {},
    })
  })

  it("detects git repo bundle with remote but sync not enabled, prompts user, user says y", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn().mockResolvedValue("y")

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      if (s.includes("myagent.ouro/agent.json")) return true
      return false
    })
    mockExecFileSync.mockImplementation((cmd: string, args: string[], opts: unknown) => {
      if (cmd === "git" && args[0] === "remote" && args[1] === "-v") {
        return Buffer.from("origin\thttps://github.com/user/myagent.ouro.git (fetch)\norigin\thttps://github.com/user/myagent.ouro.git (push)\n")
      }
      return Buffer.from("")
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "myagent" })
      return ""
    })

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    // Should prompt user
    expect(mockPrompt).toHaveBeenCalled()
    expect(String(mockPrompt.mock.calls[0][0])).toContain("myagent")
    expect(String(mockPrompt.mock.calls[0][0])).toContain("Enable sync")

    // Should write agent.json with sync enabled
    const agentJsonWrites = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("agent.json"),
    )
    expect(agentJsonWrites.length).toBe(1)
    const written = JSON.parse(agentJsonWrites[0][1] as string)
    expect(written.sync.enabled).toBe(true)
    expect(written.sync.remote).toBe("origin")
  })

  it("user responds n -- no changes to agent.json", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn().mockResolvedValue("n")

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      if (s.includes("myagent.ouro/agent.json")) return true
      return false
    })
    mockExecFileSync.mockReturnValue(Buffer.from("origin\thttps://github.com/user/myagent.ouro.git (fetch)\n"))
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "myagent" })
      return ""
    })

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    // Should prompt user
    expect(mockPrompt).toHaveBeenCalled()
    // Should NOT write agent.json
    const agentJsonWrites = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("agent.json"),
    )
    expect(agentJsonWrites.length).toBe(0)
  })

  it("bundle is not a git repo -- no prompt", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn()

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return false // not a git repo
      return false
    })

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it("bundle is git repo but has no remotes -- no prompt", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn()

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      return false
    })
    mockExecFileSync.mockReturnValue(Buffer.from(""))

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it("bundle already has sync.enabled: true -- no prompt", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn()

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      if (s.includes("myagent.ouro/agent.json")) return true
      return false
    })
    mockExecFileSync.mockReturnValue(Buffer.from("origin\thttps://github.com/user/myagent.ouro.git (fetch)\n"))
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "myagent", sync: { enabled: true, remote: "origin" } })
      return ""
    })

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it("promptInput is undefined -- skips detection silently", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      return false
    })
    mockExecFileSync.mockReturnValue(Buffer.from("origin\thttps://github.com/user/myagent.ouro.git (fetch)\n"))

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: undefined,
    })

    // Should not throw or prompt
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it("git remote -v throws -- skips bundle silently", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn()

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      return false
    })
    mockExecFileSync.mockImplementation(() => {
      throw new Error("git error")
    })

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    expect(mockPrompt).not.toHaveBeenCalled()
  })

  it("multiple remotes: uses first remote name", async () => {
    const { checkManualCloneBundles } = await import("../../../heart/daemon/cli-exec")
    const mockPrompt = vi.fn().mockResolvedValue("y")

    mockReaddirSync.mockReturnValue(["myagent.ouro"])
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("myagent.ouro/.git")) return true
      if (s.includes("myagent.ouro/agent.json")) return true
      return false
    })
    mockExecFileSync.mockReturnValue(Buffer.from("upstream\thttps://github.com/other/repo.git (fetch)\nupstream\thttps://github.com/other/repo.git (push)\norigin\thttps://github.com/user/myagent.ouro.git (fetch)\n"))
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "myagent" })
      return ""
    })

    await checkManualCloneBundles({
      bundlesRoot: "/mock/bundles",
      promptInput: mockPrompt,
    })

    const agentJsonWrites = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("agent.json"),
    )
    expect(agentJsonWrites.length).toBe(1)
    const written = JSON.parse(agentJsonWrites[0][1] as string)
    // First remote name from "git remote -v" output
    expect(written.sync.remote).toBe("upstream")
  })
})
