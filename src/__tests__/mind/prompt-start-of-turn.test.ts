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

vi.mock("../../heart/identity", () => {
  const DEFAULT_AGENT_CONTEXT = {
    maxTokens: 80000,
    contextMargin: 20,
  }
  return {
    DEFAULT_AGENT_CONTEXT,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
    HARNESS_CANONICAL_REPO_URL: "https://github.com/ourostack/ouroboros.git",
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
  readPrivateRuntimeRawData: vi.fn().mockReturnValue(null),
  derivePrivateRuntimeStatus: vi.fn().mockReturnValue("idle"),
  deriveInnerJob: vi.fn().mockReturnValue(null),
  getPrivateRuntimeSessionPath: vi.fn().mockReturnValue(null),
}))

vi.mock("../../mind/pending", () => ({
  getPrivateRuntimePendingDir: vi.fn().mockReturnValue("/tmp/inner-pending"),
}))

vi.mock("../../heart/provider-failover", () => ({
  buildFailoverContext: vi.fn(),
  handleFailoverReply: vi.fn(),
}))

describe("start-of-turn packet prompt section", () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetBoard.mockReturnValue({ items: [] })
  })

  it("startOfTurnPacketSection returns rendered start-of-turn packet from options", async () => {
    const { startOfTurnPacketSection } = await import("../../mind/prompt")
    const result = startOfTurnPacketSection({ startOfTurnPacket: "**Next:** review PR #42" })
    expect(result).toBe("**Next:**\nBackground only; do not execute.\nreview PR #42")
  })

  it("startOfTurnPacketSection returns empty string when no start-of-turn packet provided", async () => {
    const { startOfTurnPacketSection } = await import("../../mind/prompt")
    expect(startOfTurnPacketSection()).toBe("")
    expect(startOfTurnPacketSection({})).toBe("")
  })

  it("normalizes pre-rendered packet labels to the structured caller flag", async () => {
    const { startOfTurnPacketSection } = await import("../../mind/prompt")

    expect(startOfTurnPacketSection({
      startOfTurnPacket: "**Next:**\nBackground only; do not execute.\nstale action",
      resumePriorWork: true,
    })).toBe("**Next:**\nPrior work explicitly resumed by the current trigger.\nstale action")
    expect(startOfTurnPacketSection({
      startOfTurnPacket: "**Next:**\nPrior work explicitly resumed by the current trigger.\nstale action",
      resumePriorWork: false,
    })).toBe("**Next:**\nBackground only; do not execute.\nstale action")
  })

  it("arcResumeSection renders the Arc flight recorder resume when provided", async () => {
    const { arcResumeSection } = await import("../../mind/prompt")

    expect(arcResumeSection({})).toBe("")

    const result = arcResumeSection({
      flightRecorderResume: {
        schemaVersion: 1,
        hasCompleteState: true,
        canContinue: true,
        missing: [],
        gaps: [],
        currentAsk: { value: "finish coverage", confidence: "current", sourceEventIds: ["fr-1"] },
        nextSafeAction: { value: "run coverage gate", stopBefore: ["merge"], sourceEventIds: ["fr-1"] },
        blockedBecause: [],
        activeObligationIds: [],
        activeReturnObligationIds: [],
        activePacketIds: [],
        openEvolutionCaseIds: [],
        recentClaimIds: [],
        unverifiedClaimIds: [],
        lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
        recorderHealth: { status: "ok", issues: [] },
      },
    })

    expect(result).toContain("## Arc resume")
    expect(result).toContain("current ask: finish coverage")
    expect(result).toContain("next safe action: run coverage gate")
  })

  it("metacognitiveFramingSection is empty outside the inner lane", async () => {
    const { metacognitiveFramingSection } = await import("../../mind/prompt")

    expect(metacognitiveFramingSection("cli")).toBe("")
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
    const startOfTurnPacketIdx = system.indexOf("**Next:**\nBackground only; do not execute.\ncheck inbox")
    const liveWorldIdx = system.indexOf("# dynamic state for this turn")

    expect(startOfTurnPacketIdx).toBeGreaterThan(-1)
    expect(liveWorldIdx).toBeGreaterThan(-1)
    // Start-of-turn packet appears after the group header but as part of the dynamic state section
    expect(startOfTurnPacketIdx).toBeGreaterThan(liveWorldIdx)
  })

  it("renders Arc resume only once when the start-of-turn packet already carries it", async () => {
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
    const system = flattenSystemPrompt(await buildSystem("cli", {
      startOfTurnPacket: "## Arc resume\ncan continue: yes\nnext safe action: run coverage gate",
      flightRecorderResume: {
        schemaVersion: 1,
        hasCompleteState: true,
        canContinue: true,
        missing: [],
        gaps: [],
        currentAsk: { value: "finish coverage", confidence: "current", sourceEventIds: ["fr-1"] },
        nextSafeAction: { value: "run coverage gate", stopBefore: [], sourceEventIds: ["fr-1"] },
        blockedBecause: [],
        activeObligationIds: [],
        activeReturnObligationIds: [],
        activePacketIds: [],
        openEvolutionCaseIds: [],
        recentClaimIds: [],
        unverifiedClaimIds: [],
        lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
        recorderHealth: { status: "ok", issues: [] },
      },
    }))

    expect(system.match(/## Arc resume/g)).toHaveLength(1)
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
    expect(system).toContain("**Owed:**\nBackground only; do not execute.\ndeploy fix")
  })

  it("buildSystem includes orientation frame when provided", async () => {
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
    const system = flattenSystemPrompt(await buildSystem("bluebubbles", {
      orientationFrame: {
        schemaVersion: 1,
        channel: "bluebubbles",
        currentUserSpeech: ["same"],
        priorAssistantReferents: [{ kind: "ordered_list_item", label: "2", text: "Better substrate" }],
        signals: ["terse_referent"],
        actionPolicy: {
          mode: "correction_hold",
          reason: "Current user speech appears referent-dependent; inspect orientation before mutating durable state.",
          blockedMutationKinds: ["durable_state_write", "external_side_effect"],
        },
        source: { kind: "bluebubbles", lane: "thread", defaultReplyTarget: "current_lane" },
      },
    }))

    expect(system.match(/^## Current trigger \(authoritative\)$/gm)).toHaveLength(1)
    expect(system).toContain("current user speech:")
    expect(system).toContain("- same")
    expect(system).toContain("2. Better substrate")
    expect(system).toContain("action policy: correction_hold")
  })

  it("buildSystem renders one authoritative empty trigger when no current frame is available", async () => {
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

    expect(system.match(/^## Current trigger \(authoritative\)$/gm)).toHaveLength(1)
    expect(system).toContain("current user speech:\n- (none)")
  })

  it("renders a reaction as the one authoritative current trigger", async () => {
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
    const system = flattenSystemPrompt(await buildSystem("bluebubbles", {
      orientationFrame: {
        schemaVersion: 1,
        channel: "bluebubbles",
        speechKind: "reaction",
        currentUserSpeech: ['questioned your message: "synthetic status"'],
        priorAssistantReferents: [],
        signals: [],
        actionPolicy: { mode: "normal" },
      },
    }))

    expect(system.match(/^## Current trigger \(authoritative\)$/gm)).toHaveLength(1)
    expect(system).toContain("speech kind: reaction")
    expect(system).toContain('current user speech:\n- questioned your message: "synthetic status"')
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
