import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/agent/root"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: { thinking: [], tool: [], followup: [] },
  })),
}))

vi.mock("../../mind/friends/store-file", () => ({
  FileFriendStore: vi.fn(function (this: any) {
    this.get = vi.fn()
    this.put = vi.fn()
    this.delete = vi.fn()
    this.findByExternalId = vi.fn()
  }),
}))

vi.mock("../../mind/friends/resolver", () => ({
  FriendResolver: vi.fn(function (this: any) {
    this.resolve = vi.fn()
  }),
}))

import { emitNervesEvent } from "../../nerves/runtime"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tempDirs.length = 0
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teams-pending-test-"))
  tempDirs.push(dir)
  return dir
}

function makeFriend(overrides: Partial<{
  id: string
  name: string
  trustLevel: string
  externalIds: Array<{ provider: string; externalId: string; linkedAt: string; tenantId?: string }>
}> = {}): any {
  return {
    id: overrides.id ?? "friend-uuid-1",
    name: overrides.name ?? "Alice",
    trustLevel: overrides.trustLevel ?? "friend",
    externalIds: overrides.externalIds ?? [
      { provider: "aad", externalId: "aad-object-id-alice", linkedAt: "2026-01-01", tenantId: "tenant-1" },
    ],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    schemaVersion: 1,
  }
}

function writePendingFile(
  pendingRoot: string,
  friendId: string,
  key: string,
  content: Record<string, unknown>,
): string {
  const dir = path.join(pendingRoot, friendId, "teams", key)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, JSON.stringify(content))
  return filePath
}

function makeBotApi(overrides: {
  createResult?: { id: string }
  createError?: Error
  sendError?: Error
} = {}) {
  const activityCreate = vi.fn().mockResolvedValue({})
  const conversationsCreate = vi.fn().mockResolvedValue(overrides.createResult ?? { id: "conv-123" })
  if (overrides.createError) {
    conversationsCreate.mockRejectedValue(overrides.createError)
  }
  if (overrides.sendError) {
    activityCreate.mockRejectedValue(overrides.sendError)
  }
  return {
    id: "bot-id-123",
    conversations: {
      create: conversationsCreate,
      activities: vi.fn().mockReturnValue({ create: activityCreate }),
    },
    _mocks: { conversationsCreate, activityCreate },
  }
}

describe("drainAndSendPendingTeams", () => {
  let pendingRoot: string

  beforeEach(() => {
    vi.resetModules()
    pendingRoot = makeTempDir()
    vi.mocked(emitNervesEvent).mockReset()
  })

  it("sends a pending message to a friend via Bot Framework API", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      key: "session",
      content: "hey Alice, check this out!",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(
      friendStore as any,
      botApi,
      pendingRoot,
    )

    expect(result.sent).toBe(1)
    expect(botApi._mocks.conversationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        bot: { id: "bot-id-123" },
        members: [expect.objectContaining({ id: "aad-object-id-alice" })],
        isGroup: false,
      }),
    )
    expect(botApi._mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        text: "hey Alice, check this out!",
      }),
    )
  })

  it("deletes the pending file after successful send", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    const filePath = writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "hello!",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("skips friends with trust level 'acquaintance'", async () => {
    const friend = makeFriend({ trustLevel: "acquaintance" })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "should not be sent",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(result.sent).toBe(0)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("skips friends with trust level 'stranger'", async () => {
    const friend = makeFriend({ trustLevel: "stranger" })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "should not be sent",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("allows sending to friends with trust level 'family'", async () => {
    const friend = makeFriend({ trustLevel: "family" })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "hello family!",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.sent).toBe(1)
    expect(botApi._mocks.conversationsCreate).toHaveBeenCalled()
  })

  it("skips group chat external IDs (starting with 'group:')", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "aad", externalId: "group:team-channel-id", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "should not go to group",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("skips friend with no AAD object ID and logs warning", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "imessage-handle", externalId: "alice@icloud.com", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "no AAD identity",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.teams_proactive_no_aad_id",
      }),
    )
  })

  it("skips friend that cannot be found in the store", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-missing", "session", {
      from: "testagent",
      friendId: "friend-uuid-missing",
      channel: "teams",
      content: "unknown friend",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("handles conversation creation failure gracefully", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi({ createError: new Error("service unavailable") })

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "this will fail",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)
  })

  it("returns zero counts when no pending directories exist", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()
    const emptyRoot = makeTempDir()

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, emptyRoot)

    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("processes multiple pending messages across different friends", async () => {
    const alice = makeFriend({ id: "alice-uuid", name: "Alice" })
    const bob = makeFriend({
      id: "bob-uuid",
      name: "Bob",
      externalIds: [
        { provider: "aad", externalId: "aad-object-id-bob", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === "alice-uuid") return alice
        if (id === "bob-uuid") return bob
        return null
      }),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "alice-uuid", "session", {
      from: "testagent",
      friendId: "alice-uuid",
      channel: "teams",
      content: "hey Alice!",
      timestamp: Date.now(),
    })

    writePendingFile(pendingRoot, "bob-uuid", "session", {
      from: "testagent",
      friendId: "bob-uuid",
      channel: "teams",
      content: "hey Bob!",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.sent).toBe(2)
    expect(botApi._mocks.conversationsCreate).toHaveBeenCalledTimes(2)
  })

  it("handles non-existent pending root gracefully", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(
      friendStore as any,
      botApi,
      "/nonexistent/pending/root",
    )

    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("ignores non-teams channel directories", async () => {
    // Write a pending file under "bluebubbles" channel -- should be ignored by Teams drain
    const bbDir = path.join(pendingRoot, "friend-uuid-1", "bluebubbles", "session")
    fs.mkdirSync(bbDir, { recursive: true })
    fs.writeFileSync(
      path.join(bbDir, `${Date.now()}-abc.json`),
      JSON.stringify({ from: "testagent", content: "bb msg", timestamp: Date.now() }),
    )

    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    const teams = await import("../../senses/teams")
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.sent).toBe(0)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("includes tenantId from the friend's AAD external ID in the conversation", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "aad", externalId: "aad-object-id-alice", linkedAt: "2026-01-01", tenantId: "my-tenant-99" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "tenant-aware message",
      timestamp: Date.now(),
    })

    const teams = await import("../../senses/teams")
    await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(botApi._mocks.conversationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "my-tenant-99",
      }),
    )
  })
})
