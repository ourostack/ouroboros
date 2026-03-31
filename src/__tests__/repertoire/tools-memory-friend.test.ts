import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { FriendRecord } from "../../mind/friends/types"

const mockTaskModule = {
  getBoard: vi.fn(),
  createTask: vi.fn(),
  updateStatus: vi.fn(),
  boardStatus: vi.fn(),
  boardAction: vi.fn(),
  boardDeps: vi.fn(),
  boardSessions: vi.fn(),
}

let agentRoot = ""

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => mockTaskModule,
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
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
    getAgentRoot: vi.fn(() => agentRoot),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentBundlesRoot: vi.fn(() => "/mock/AgentBundles"),
    resetIdentity: vi.fn(),
  }
})

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {
      role: { value: "engineer", savedAt: "2026-03-06T00:00:00.000Z" },
    },
    totalTokens: 0,
    createdAt: "2026-03-06T00:00:00.000Z",
    updatedAt: "2026-03-06T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

describe("memory/friend tools", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-memory-friend-"))
    fs.mkdirSync(path.join(agentRoot, "diary"), { recursive: true })
    fs.mkdirSync(path.join(agentRoot, "friends"), { recursive: true })

    mockTaskModule.getBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        validating: [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
    mockTaskModule.createTask.mockReset()
    mockTaskModule.updateStatus.mockReset().mockReturnValue({ ok: true, from: "drafting", to: "processing", archived: [] })
    mockTaskModule.boardStatus.mockReset().mockReturnValue([])
    mockTaskModule.boardAction.mockReset().mockReturnValue([])
    mockTaskModule.boardDeps.mockReset().mockReturnValue([])
    mockTaskModule.boardSessions.mockReset().mockReturnValue([])
  })

  it("diary_write writes a diary entry through execTool", async () => {
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("diary_write", { entry: "Ari prefers terse progress updates", about: "ari" })

    expect(result.toLowerCase()).toContain("saved")

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const raw = fs.readFileSync(factsPath, "utf8").trim()
    expect(raw.length).toBeGreaterThan(0)
    const saved = JSON.parse(raw.split("\n")[0]) as {
      text: string
      source: string
      about?: string
      embedding: number[]
    }

    expect(saved.text).toBe("Ari prefers terse progress updates")
    expect(saved.source).toBe("tool:diary_write")
    expect(saved.about).toBe("ari")
    expect(Array.isArray(saved.embedding)).toBe(true)
  })

  it("diary_write validates entry argument", async () => {
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("diary_write", { entry: "   " })
    expect(result.toLowerCase()).toContain("entry")
    expect(result.toLowerCase()).toContain("required")
  })

  it("diary_write validates missing entry argument", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool("diary_write", {})
    expect(result.toLowerCase()).toContain("entry")
    expect(result.toLowerCase()).toContain("required")
  })

  it("diary_write ignores non-string about values", async () => {
    const { execTool } = await import("../../repertoire/tools")

    await execTool("diary_write", { entry: "Persist without about", about: { bad: "value" } as unknown as string })
    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const saved = JSON.parse(fs.readFileSync(factsPath, "utf8").trim().split("\n")[0]) as {
      about?: string
    }
    expect(saved.about).toBeUndefined()
  })

  it("get_friend_note returns a specific friend record via friendStore", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const friend = makeFriend({ id: "friend-lookup", name: "Jordan Lee" })

    const friendStore = {
      get: vi.fn(async (id: string) => (id === "friend-lookup" ? friend : null)),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }

    const result = await execTool("get_friend_note", { friendId: "friend-lookup" }, {
      signin: async () => undefined,
      friendStore,
    })

    expect(result).toContain("Jordan Lee")
    expect(result).toContain("friend-lookup")
    expect(result).toContain("engineer")
  })

  it("get_friend_note requires friend store and friendId", async () => {
    const { execTool } = await import("../../repertoire/tools")

    const missingId = await execTool("get_friend_note", {}, {
      signin: async () => undefined,
      friendStore: {
        get: vi.fn(async () => null),
        put: vi.fn(),
        delete: vi.fn(),
        findByExternalId: vi.fn(),
      },
    })
    expect(missingId.toLowerCase()).toContain("friendid")

    const missingStore = await execTool("get_friend_note", { friendId: "x" }, {
      signin: async () => undefined,
    })
    expect(missingStore.toLowerCase()).toContain("friend store")
  })

  it("get_friend_note returns explicit not-found message", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool("get_friend_note", { friendId: "missing-friend" }, {
      signin: async () => undefined,
      friendStore: {
        get: vi.fn(async () => null),
        put: vi.fn(),
        delete: vi.fn(),
        findByExternalId: vi.fn(),
      },
    })
    expect(result).toBe("friend not found: missing-friend")
  })
})
