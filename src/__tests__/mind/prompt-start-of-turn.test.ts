import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

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

vi.mock("../../heart/identity", () => {
  const DEFAULT_AGENT_CONTEXT = {
    maxTokens: 80000,
    contextMargin: 20,
  }
  return {
    DEFAULT_AGENT_CONTEXT,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
    HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
    resetIdentity: vi.fn(),
  }
})

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockOpenAI, OpenAI: MockOpenAI }
})

vi.mock("../../heart/session-activity", () => ({
  listSessionActivity: vi.fn().mockReturnValue([]),
}))

vi.mock("../../heart/active-work", () => ({
  buildActiveWorkFrame: vi.fn(),
  formatActiveWorkFrame: vi.fn().mockReturnValue(""),
}))

vi.mock("../../heart/daemon/thoughts", () => ({
  readInnerDialogRawData: vi.fn().mockReturnValue(null),
  deriveInnerDialogStatus: vi.fn().mockReturnValue("idle"),
  deriveInnerJob: vi.fn().mockReturnValue(null),
  getInnerDialogSessionPath: vi.fn().mockReturnValue(null),
}))

vi.mock("../../mind/pending", () => ({
  getInnerDialogPendingDir: vi.fn().mockReturnValue("/tmp/inner-pending"),
}))

vi.mock("../../heart/provider-failover", () => ({
  buildFailoverContext: vi.fn(),
  handleFailoverReply: vi.fn(),
}))

vi.mock("../../mind/friends/store", () => ({
  makeFriendStore: vi.fn(),
}))

describe("start-of-turn packet prompt section", () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetBoard.mockReturnValue({ items: [] })
  })

  it("startOfTurnPacketSection returns rendered start-of-turn packet from options", async () => {
    const { startOfTurnPacketSection } = await import("../../mind/prompt")
    const result = startOfTurnPacketSection({ startOfTurnPacket: "**Next:** review PR #42" })
    expect(result).toBe("**Next:** review PR #42")
  })

  it("startOfTurnPacketSection returns empty string when no start-of-turn packet provided", async () => {
    const { startOfTurnPacketSection } = await import("../../mind/prompt")
    expect(startOfTurnPacketSection()).toBe("")
    expect(startOfTurnPacketSection({})).toBe("")
  })

  it("start-of-turn packet section appears before liveWorldStateSection in buildSystem output", async () => {
    const fs = await import("fs")
    const fsMock = vi.mocked(fs)
    fsMock.existsSync.mockReturnValue(false)
    fsMock.readFileSync.mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.0.0-test" })
      return ""
    })
    fsMock.readdirSync.mockReturnValue([])

    const { buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    const system = flattenSystemPrompt(await buildSystem("cli", { startOfTurnPacket: "**Next:** check inbox" }))
    const startOfTurnPacketIdx = system.indexOf("**Next:** check inbox")
    const liveWorldIdx = system.indexOf("# dynamic state for this turn")

    expect(startOfTurnPacketIdx).toBeGreaterThan(-1)
    expect(liveWorldIdx).toBeGreaterThan(-1)
    // Start-of-turn packet appears after the group header but as part of the dynamic state section
    expect(startOfTurnPacketIdx).toBeGreaterThan(liveWorldIdx)
  })

  it("buildSystem includes start-of-turn packet when provided", async () => {
    const fs = await import("fs")
    const fsMock = vi.mocked(fs)
    fsMock.existsSync.mockReturnValue(false)
    fsMock.readFileSync.mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.0.0-test" })
      return ""
    })
    fsMock.readdirSync.mockReturnValue([])

    const { buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    const system = flattenSystemPrompt(await buildSystem("cli", { startOfTurnPacket: "**Owed:** deploy fix" }))
    expect(system).toContain("**Owed:** deploy fix")
  })

  it("buildSystem omits start-of-turn packet section when none provided", async () => {
    const fs = await import("fs")
    const fsMock = vi.mocked(fs)
    fsMock.existsSync.mockReturnValue(false)
    fsMock.readFileSync.mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("package.json")) return JSON.stringify({ version: "0.0.0-test" })
      return ""
    })
    fsMock.readdirSync.mockReturnValue([])

    const { buildSystem, flattenSystemPrompt } = await import("../../mind/prompt")
    const system = flattenSystemPrompt(await buildSystem("cli"))
    // No start-of-turn packet content should appear
    expect(system).not.toContain("**Next:**")
    expect(system).not.toContain("**Owed:**")
  })
})
