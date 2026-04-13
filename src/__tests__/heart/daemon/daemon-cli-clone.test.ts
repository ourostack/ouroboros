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

describe("ouro clone execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    emitNervesEvent({
      component: "daemon",
      event: "daemon.clone_test_start",
      message: "clone execution test",
      meta: {},
    })
  })

  it("successful clone: calls git clone, creates identity, enables sync", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"

    // git --version succeeds
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "--version") return Buffer.from("git version 2.40.0")
      if (cmd === "git" && args[0] === "ls-remote") return Buffer.from("")
      if (cmd === "git" && args[0] === "clone") return Buffer.from("")
      return Buffer.from("")
    })

    // agent.json exists after clone
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.ouro/agent.json")) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "agent" })
      if (s.includes("package.json")) return JSON.stringify({ version: "0.1.0" })
      return ""
    })

    await runOuroCli(["clone", "https://github.com/user/agent.ouro.git"], deps)

    // Verify git clone was called
    const cloneCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])[0] === "clone",
    )
    expect(cloneCalls.length).toBe(1)
    expect(cloneCalls[0][1]).toContain("https://github.com/user/agent.ouro.git")

    // Verify agent.json was written with sync enabled
    const agentJsonWrites = mockWriteFileSync.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("agent.json"),
    )
    expect(agentJsonWrites.length).toBe(1)
    const written = JSON.parse(agentJsonWrites[0][1] as string)
    expect(written.sync.enabled).toBe(true)
    expect(written.sync.remote).toBe("origin")

    // Verify success message was output
    const output = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n")
    expect(output).toContain("cloned agent to")
    expect(output).toContain("sync enabled")
    expect(output).toContain("ouro auth run")
  })

  it("git not installed: outputs human-readable install guide", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"

    // git --version throws ENOENT
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("ENOENT") as Error & { code: string }
      err.code = "ENOENT"
      throw err
    })

    await runOuroCli(["clone", "https://github.com/user/agent.ouro.git"], deps)

    const output = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n")
    expect(output).toContain("git is not installed")
    expect(output).toContain("https://git-scm.com")
  })

  it("remote not accessible: outputs 'could not reach remote' message", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "--version") return Buffer.from("git version 2.40.0")
      if (cmd === "git" && args[0] === "ls-remote") {
        throw new Error("fatal: repository not found")
      }
      return Buffer.from("")
    })

    await runOuroCli(["clone", "https://github.com/user/agent.ouro.git"], deps)

    const output = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n")
    expect(output).toContain("could not reach remote")
  })

  it("target path already exists: outputs error message", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"

    // git --version succeeds
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "--version") return Buffer.from("git version 2.40.0")
      return Buffer.from("")
    })

    // Target directory already exists
    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s === "/mock/bundles/agent.ouro") return true
      return false
    })

    await runOuroCli(["clone", "https://github.com/user/agent.ouro.git"], deps)

    const output = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c[0])
      .join("\n")
    expect(output).toContain("already exists")
  })

  it("agent name inferred from remote URL", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "--version") return Buffer.from("git version 2.40.0")
      if (cmd === "git" && args[0] === "ls-remote") return Buffer.from("")
      if (cmd === "git" && args[0] === "clone") return Buffer.from("")
      return Buffer.from("")
    })

    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("mybot.ouro/agent.json")) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "mybot" })
      if (s.includes("package.json")) return JSON.stringify({ version: "0.1.0" })
      return ""
    })

    await runOuroCli(["clone", "https://github.com/user/mybot.git"], deps)

    // Clone target should be mybot.ouro
    const cloneCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])[0] === "clone",
    )
    expect(cloneCalls.length).toBe(1)
    expect(cloneCalls[0][1]).toContain("/mock/bundles/mybot.ouro")
  })

  it("agent name provided via --agent flag", async () => {
    const { runOuroCli, createDefaultOuroCliDeps } = await import("../../../heart/daemon/daemon-cli")
    const deps = createDefaultOuroCliDeps()
    deps.writeStdout = vi.fn()
    deps.bundlesRoot = "/mock/bundles"

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "--version") return Buffer.from("git version 2.40.0")
      if (cmd === "git" && args[0] === "ls-remote") return Buffer.from("")
      if (cmd === "git" && args[0] === "clone") return Buffer.from("")
      return Buffer.from("")
    })

    mockExistsSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("custom.ouro/agent.json")) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes("agent.json")) return JSON.stringify({ name: "custom" })
      if (s.includes("package.json")) return JSON.stringify({ version: "0.1.0" })
      return ""
    })

    await runOuroCli(["clone", "https://github.com/user/agent.ouro.git", "--agent", "custom"], deps)

    // Clone target should use custom name
    const cloneCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === "git" && (c[1] as string[])[0] === "clone",
    )
    expect(cloneCalls.length).toBe(1)
    expect(cloneCalls[0][1]).toContain("/mock/bundles/custom.ouro")
  })
})
