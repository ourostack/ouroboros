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
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
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

describe("notes/friend tools", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-notes-friend-"))
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

  it("friend_list lists all friends sorted by name with default limit", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const friends: FriendRecord[] = [
      makeFriend({ id: "f-a", name: "Bea", trustLevel: "family" }),
      makeFriend({ id: "f-b", name: "Aria", trustLevel: "friend" }),
      makeFriend({ id: "f-c", name: "Cleo", trustLevel: "stranger" }),
    ]
    const result = await execTool("friend_list", {}, {
      signin: async () => undefined,
      friendStore: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        findByExternalId: vi.fn(),
        listAll: vi.fn(async () => friends),
      } as any,
    })
    expect(result).toContain("3 friends")
    expect(result.indexOf("Aria")).toBeLessThan(result.indexOf("Bea"))
    expect(result.indexOf("Bea")).toBeLessThan(result.indexOf("Cleo"))
  })

  it("friend_list filters by trust level", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const friends: FriendRecord[] = [
      makeFriend({ id: "f-a", name: "FamilyMember", trustLevel: "family" }),
      makeFriend({ id: "f-b", name: "AcquaintanceX", trustLevel: "stranger" }),
    ]
    const result = await execTool("friend_list", { trust: "family" }, {
      signin: async () => undefined,
      friendStore: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        findByExternalId: vi.fn(),
        listAll: vi.fn(async () => friends),
      } as any,
    })
    expect(result).toContain("trust=family")
    expect(result).toContain("FamilyMember")
    expect(result).not.toContain("AcquaintanceX")
  })

  it("friend_list reports 'not available' when friendStore lacks listAll", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool("friend_list", {}, {
      signin: async () => undefined,
      friendStore: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        findByExternalId: vi.fn(),
      },
    })
    expect(result).toContain("does not support listing")
  })

  it("friend_list reports empty state with trust filter", async () => {
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool("friend_list", { trust: "family" }, {
      signin: async () => undefined,
      friendStore: {
        get: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        findByExternalId: vi.fn(),
        listAll: vi.fn(async () => []),
      } as any,
    })
    expect(result).toContain("no friends with trust level 'family'")
  })
})
