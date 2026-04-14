import { beforeEach, describe, expect, it, vi } from "vitest"

// ── Mock continuity store modules ────────────────────────────────

const mockReadRecentEpisodes = vi.fn()
const mockEmitEpisode = vi.fn()
const mockReadActiveCares = vi.fn()
const mockReadCares = vi.fn()
const mockCreateCare = vi.fn()
const mockUpdateCare = vi.fn()
const mockResolveCare = vi.fn()
const mockReadPresence = vi.fn()
const mockReadPeerPresence = vi.fn()
const mockCaptureIntention = vi.fn()
const mockResolveIntention = vi.fn()
const mockDismissIntention = vi.fn()

vi.mock("../../arc/episodes", () => ({
  readRecentEpisodes: (...args: any[]) => mockReadRecentEpisodes(...args),
  emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
}))

vi.mock("../../arc/cares", () => ({
  readActiveCares: (...args: any[]) => mockReadActiveCares(...args),
  readCares: (...args: any[]) => mockReadCares(...args),
  createCare: (...args: any[]) => mockCreateCare(...args),
  updateCare: (...args: any[]) => mockUpdateCare(...args),
  resolveCare: (...args: any[]) => mockResolveCare(...args),
}))

vi.mock("../../arc/presence", () => ({
  readPresence: (...args: any[]) => mockReadPresence(...args),
  readPeerPresence: (...args: any[]) => mockReadPeerPresence(...args),
}))

vi.mock("../../arc/intentions", () => ({
  captureIntention: (...args: any[]) => mockCaptureIntention(...args),
  resolveIntention: (...args: any[]) => mockResolveIntention(...args),
  dismissIntention: (...args: any[]) => mockDismissIntention(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "ouroboros"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  loadAgentConfig: vi.fn(() => ({
    name: "ouroboros",
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    context: {},
  })),
  getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/ouroboros/state/workspaces"),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
}))

// Minimal mocks for tools-base dependencies
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ mtimeMs: 0 }),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  appendFileSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
  spawnSync: vi.fn().mockReturnValue({ stdout: "", stderr: "", status: 0 }),
}))

vi.mock("fast-glob", () => ({
  default: { sync: vi.fn().mockReturnValue([]) },
  sync: vi.fn().mockReturnValue([]),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn().mockReturnValue([]),
  loadSkill: vi.fn().mockReturnValue(null),
}))

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn().mockReturnValue({ items: [] }),
  }),
}))

vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn(async () => null),
  sendDaemonCommand: vi.fn(),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

vi.mock("../../repertoire/coding", () => ({
  getCodingSessionManager: () => ({
    listSessions: vi.fn().mockReturnValue([]),
  }),
}))

import { baseToolDefinitions, type ToolDefinition } from "../../repertoire/tools-base"

// ── Test helpers ─────────────────────────────────────────────────

function findTool(name: string): ToolDefinition {
  const tool = baseToolDefinitions.find((d) => d.tool.function.name === name)
  if (!tool) throw new Error(`Tool ${name} not found in baseToolDefinitions`)
  return tool
}

// ── Tests ────────────────────────────────────────────────────────

describe("continuity tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("query_episodes", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_episodes")
      expect(tool).toBeDefined()
      expect(tool.tool.function.name).toBe("query_episodes")
    })

    it("returns recent episodes", async () => {
      const episodes = [
        { id: "ep-1", kind: "coding_milestone", summary: "deployed v2", timestamp: "2026-04-01T10:00:00Z", salience: "medium", relatedEntities: [], whyItMattered: "milestone" },
      ]
      mockReadRecentEpisodes.mockReturnValue(episodes)

      const tool = findTool("query_episodes")
      const result = await tool.handler({})
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith("/mock/agent-root", expect.any(Object))
      expect(result).toContain("deployed v2")
    })

    it("supports limit filter", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ limit: "5" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ limit: 5 }))
    })

    it("supports kind filter", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ kind: "coding_milestone" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ kinds: ["coding_milestone"] }))
    })
  })

  describe("capture_episode", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("capture_episode")
      expect(tool).toBeDefined()
    })

    it("creates agent-authored episode with minimal fields", async () => {
      const mockEpisode = { id: "ep-new", summary: "breakthrough moment", timestamp: "2026-04-02T10:00:00Z" }
      mockEmitEpisode.mockReturnValue(mockEpisode)

      const tool = findTool("capture_episode")
      const result = await tool.handler({ summary: "breakthrough moment", whyItMattered: "changed approach" })
      expect(mockEmitEpisode).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({
          summary: "breakthrough moment",
          whyItMattered: "changed approach",
          kind: "turning_point",
          salience: "medium",
        }),
      )
      expect(result).toContain("ep-new")
    })
  })

  describe("query_presence", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_presence")
      expect(tool).toBeDefined()
    })

    it("returns self and peer presence", async () => {
      const selfPresence = { agentName: "ouroboros", availability: "active", lane: "conversation", tempo: "brief", updatedAt: "2026-04-02T10:00:00Z" }
      const peers = [{ agentName: "slugger", availability: "idle", lane: "coding", tempo: "standard", updatedAt: "2026-04-02T10:00:00Z" }]
      mockReadPresence.mockReturnValue(selfPresence)
      mockReadPeerPresence.mockReturnValue(peers)

      const tool = findTool("query_presence")
      const result = await tool.handler({})
      expect(result).toContain("ouroboros")
      expect(result).toContain("slugger")
    })
  })

  describe("query_cares", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_cares")
      expect(tool).toBeDefined()
    })

    it("returns active cares by default", async () => {
      const cares = [{ id: "c-1", label: "deploy health", status: "active", salience: "high" }]
      mockReadActiveCares.mockReturnValue(cares)

      const tool = findTool("query_cares")
      const result = await tool.handler({})
      expect(result).toContain("deploy health")
    })

    it("returns all cares when status=all", async () => {
      const cares = [{ id: "c-1", label: "old care", status: "resolved" }]
      mockReadCares.mockReturnValue(cares)

      const tool = findTool("query_cares")
      const result = await tool.handler({ status: "all" })
      expect(mockReadCares).toHaveBeenCalled()
    })
  })

  describe("care_manage", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("care_manage")
      expect(tool).toBeDefined()
    })

    it("creates a care when action=create", async () => {
      const mockCare = { id: "c-new", label: "new care", status: "active" }
      mockCreateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "create", label: "new care", why: "matters to me", salience: "high", kind: "project", stewardship: "mine" })
      expect(mockCreateCare).toHaveBeenCalled()
      expect(result).toContain("c-new")
    })

    it("updates a care when action=update", async () => {
      const mockCare = { id: "c-1", label: "updated", status: "active" }
      mockUpdateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "update", id: "c-1", label: "updated" })
      expect(mockUpdateCare).toHaveBeenCalledWith("/mock/agent-root", "c-1", expect.objectContaining({ label: "updated" }))
    })

    it("resolves a care when action=resolve", async () => {
      const mockCare = { id: "c-1", label: "resolved care", status: "resolved" }
      mockResolveCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "resolve", id: "c-1" })
      expect(mockResolveCare).toHaveBeenCalledWith("/mock/agent-root", "c-1")
    })
  })

  describe("query_relationships", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_relationships")
      expect(tool).toBeDefined()
    })

    it("returns all agent friends when no agentName", async () => {
      const mockListAll = vi.fn().mockResolvedValue([
        { id: "uuid-1", name: "Slugger", kind: "agent", agentMeta: { bundleName: "slugger.ouro", familiarity: 3, sharedMissions: [], outcomes: [] } },
        { id: "uuid-2", name: "Jordan", kind: "human" },
      ])
      const ctx = { friendStore: { listAll: mockListAll } } as any

      const tool = findTool("query_relationships")
      const result = await tool.handler({}, ctx)
      expect(mockListAll).toHaveBeenCalled()
      expect(result).toContain("Slugger")
      expect(result).not.toContain("Jordan")
    })

    it("filters by agentName (case-insensitive)", async () => {
      const mockListAll = vi.fn().mockResolvedValue([
        { id: "uuid-1", name: "Slugger", kind: "agent", agentMeta: { bundleName: "slugger.ouro", familiarity: 3, sharedMissions: [], outcomes: [] } },
        { id: "uuid-2", name: "Copilot", kind: "agent", agentMeta: { bundleName: "copilot.ouro", familiarity: 1, sharedMissions: [], outcomes: [] } },
      ])
      const ctx = { friendStore: { listAll: mockListAll } } as any

      const tool = findTool("query_relationships")
      const result = await tool.handler({ agentName: "SLUGGER" }, ctx)
      expect(result).toContain("Slugger")
      expect(result).not.toContain("Copilot")
    })

    it("returns empty when no agent friends exist", async () => {
      const mockListAll = vi.fn().mockResolvedValue([
        { id: "uuid-1", name: "Jordan", kind: "human" },
      ])
      const ctx = { friendStore: { listAll: mockListAll } } as any

      const tool = findTool("query_relationships")
      const result = await tool.handler({}, ctx)
      expect(result).toBe("[]")
    })

    it("returns empty array when friendStore is not available", async () => {
      const tool = findTool("query_relationships")
      const result = await tool.handler({})
      expect(result).toBe("[]")
    })
  })

  describe("intention_capture", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("intention_capture")
      expect(tool).toBeDefined()
    })

    it("captures a lightweight intention", async () => {
      const mockIntention = { id: "int-1", content: "check on deploy", status: "open" }
      mockCaptureIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_capture")
      const result = await tool.handler({ content: "check on deploy" })
      expect(mockCaptureIntention).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ content: "check on deploy", source: "tool" }),
      )
      expect(result).toContain("int-1")
    })
  })

  describe("query_episodes edge cases", () => {
    it("returns empty array when no episodes exist", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      const result = await tool.handler({})
      expect(result).toBe("[]")
    })

    it("passes kind filter when provided", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ kind: "turning_point" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ kinds: ["turning_point"] }),
      )
    })

    it("passes limit when provided", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ limit: "5" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ limit: 5 }),
      )
    })
  })

  describe("query_presence edge cases", () => {
    it("handles null self presence", async () => {
      mockReadPresence.mockReturnValue(null)
      mockReadPeerPresence.mockReturnValue([])
      const tool = findTool("query_presence")
      const result = await tool.handler({})
      expect(result).toContain("null")
    })
  })

  describe("care_manage edge cases", () => {
    it("uses defaults when optional fields omitted on create", async () => {
      const mockCare = { id: "c-default", label: "untitled", status: "active" }
      mockCreateCare.mockReturnValue(mockCare)
      const tool = findTool("care_manage")
      await tool.handler({ action: "create" })
      expect(mockCreateCare).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ label: "untitled", kind: "project", salience: "medium" }),
      )
    })

    it("passes why and salience fields when updating a care", async () => {
      const mockCare = { id: "c-1", label: "updated", status: "active" }
      mockUpdateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      await tool.handler({ action: "update", id: "c-1", label: "renamed", why: "reprioritized", salience: "high" })
      expect(mockUpdateCare).toHaveBeenCalledWith(
        "/mock/agent-root",
        "c-1",
        expect.objectContaining({ label: "renamed", why: "reprioritized", salience: "high" }),
      )
    })

    it("handles unknown action gracefully (no create/update/resolve match)", async () => {
      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "unknown-action" })
      // JSON.stringify(undefined) returns undefined (not a string)
      expect(result).toBeUndefined()
    })

    it("updates a care with only why (no label or salience)", async () => {
      const mockCare = { id: "c-2", label: "unchanged", status: "active" }
      mockUpdateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      await tool.handler({ action: "update", id: "c-2", why: "new reason" })
      const updates = mockUpdateCare.mock.calls[mockUpdateCare.mock.calls.length - 1][2]
      expect(updates).toEqual({ why: "new reason" })
      expect(updates).not.toHaveProperty("label")
      expect(updates).not.toHaveProperty("salience")
    })
  })

  describe("query_episodes edge cases", () => {
    it("passes since filter when provided", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ since: "2026-04-01T00:00:00Z" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ since: "2026-04-01T00:00:00Z" }),
      )
    })
  })

  describe("intention_capture edge cases", () => {
    it("passes nudgeAfter when provided", async () => {
      const mockIntention = { id: "int-2", content: "follow up", status: "open" }
      mockCaptureIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_capture")
      await tool.handler({ content: "follow up", nudgeAfter: "2026-04-10T00:00:00Z" })
      expect(mockCaptureIntention).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ content: "follow up", nudgeAfter: "2026-04-10T00:00:00Z" }),
      )
    })
  })

  describe("intention_manage", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("intention_manage")
      expect(tool).toBeDefined()
    })

    it("resolves an intention when action=resolve", async () => {
      const mockIntention = { id: "int-1", content: "done", status: "done" }
      mockResolveIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_manage")
      const result = await tool.handler({ action: "resolve", id: "int-1" })
      expect(mockResolveIntention).toHaveBeenCalledWith("/mock/agent-root", "int-1")
    })

    it("dismisses an intention when action=dismiss", async () => {
      const mockIntention = { id: "int-1", content: "nevermind", status: "dismissed" }
      mockDismissIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_manage")
      const result = await tool.handler({ action: "dismiss", id: "int-1" })
      expect(mockDismissIntention).toHaveBeenCalledWith("/mock/agent-root", "int-1")
    })
  })
})
