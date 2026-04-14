import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
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

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/agent/root"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
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
import { FileFriendStore } from "../../mind/friends/store-file"

const tempDirs: string[] = []
const teamsPromise = import("../../senses/teams")

async function loadTeams(): Promise<typeof import("../../senses/teams")> {
  return teamsPromise
}

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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
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

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.sent).toBe(0)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("uses default pending root from getAgentRoot when not provided", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    const teams = await loadTeams()
    // Call without pendingRoot -- should use default from getAgentRoot
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi)

    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("skips unreadable key directories gracefully", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    // Create a file where a directory is expected (key path)
    const teamsDir = path.join(pendingRoot, "friend-uuid-1", "teams")
    fs.mkdirSync(teamsDir, { recursive: true })
    fs.writeFileSync(path.join(teamsDir, "not-a-directory"), "oops")

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("handles invalid JSON in pending file gracefully", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi()

    const dir = path.join(pendingRoot, "friend-uuid-1", "teams", "session")
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${Date.now()}-bad.json`)
    fs.writeFileSync(filePath, "not valid json {{{")

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.failed).toBe(1)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("skips pending messages with empty content", async () => {
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
      content: "   ",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("skips pending messages with non-string content field", async () => {
    const friendStore = {
      get: vi.fn(),
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
      content: 12345,
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
  })

  it("handles friend store get() throwing an error", async () => {
    const friendStore = {
      get: vi.fn().mockRejectedValue(new Error("disk read error")),
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
      content: "store will throw",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("treats undefined trustLevel as disallowed", async () => {
    const friend = makeFriend({ trustLevel: undefined as any })
    delete (friend as any).trustLevel
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
      content: "trust undefined",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("handles non-Error thrown from Bot Framework API", async () => {
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
    botApi._mocks.conversationsCreate.mockRejectedValueOnce("string error thrown")

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "this will fail with string throw",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.failed).toBe(1)
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.teams_proactive_send_error",
        meta: expect.objectContaining({
          reason: "string error thrown",
        }),
      }),
    )
  })

  it("falls back to aadObjectId when friend has no name", async () => {
    const friend = makeFriend({ name: "" })
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
      content: "nameless friend",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(botApi._mocks.conversationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [expect.objectContaining({
          name: "aad-object-id-alice",
        })],
      }),
    )
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

    const teams = await loadTeams()
    await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(botApi._mocks.conversationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "my-tenant-99",
      }),
    )
  })

  it("skips pending messages that contain internal content", async () => {
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
      content: "heartbeat check-in: same state, nothing new",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(result.sent).toBe(0)
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
    expect(fs.existsSync(filePath)).toBe(false)
  })
})

describe("sendProactiveTeamsMessageToSession", () => {
  it("allows explicit cross-chat delivery from a trusted asking session even when the target record is only acquaintance", async () => {
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

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "carry this into the other chat now",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "trusted-friend-1",
        channel: "teams",
        key: "ari-thread",
        trustLevel: "friend",
      },
    }, {
      botApi,
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(botApi._mocks.conversationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [expect.objectContaining({ id: "aad-object-id-alice" })],
      }),
    )
    expect(botApi._mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        text: "carry this into the other chat now",
      }),
    )
  })

  it("prefers an explicitly provided friend store over createFriendStore", async () => {
    const friend = makeFriend()
    const providedStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const createFriendStore = vi.fn(() => ({
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }))
    const botApi = makeBotApi()

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "use the provided store",
    }, {
      botApi,
      store: providedStore as any,
      createFriendStore,
    })

    expect(result).toEqual({ delivered: true })
    expect(providedStore.get).toHaveBeenCalledWith("friend-uuid-1")
    expect(createFriendStore).not.toHaveBeenCalled()
  })

  it("uses createFriendStore when no explicit store is provided", async () => {
    const friend = makeFriend()
    const createdStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const createFriendStore = vi.fn(() => createdStore as any)
    const botApi = makeBotApi()

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "use the created store",
    }, {
      botApi,
      createFriendStore,
    })

    expect(result).toEqual({ delivered: true })
    expect(createFriendStore).toHaveBeenCalledOnce()
    expect(createdStore.get).toHaveBeenCalledWith("friend-uuid-1")
  })

  it("falls back to FileFriendStore when no store helpers are provided", async () => {
    const friend = makeFriend()
    vi.mocked(FileFriendStore).mockImplementationOnce(function (this: any) {
      this.get = vi.fn().mockResolvedValue(friend)
      this.put = vi.fn()
      this.delete = vi.fn()
      this.findByExternalId = vi.fn()
    } as any)
    const botApi = makeBotApi()

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "use the file store fallback",
    }, {
      botApi,
    })

    expect(result).toEqual({ delivered: true })
    expect(FileFriendStore).toHaveBeenCalledWith("/mock/agent/root/friends")
  })

  it("requires a trusted authorizing session for explicit cross-chat delivery into acquaintance chats", async () => {
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

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "this should not send",
      intent: "explicit_cross_chat",
    }, {
      botApi,
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "trust_skip" })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.teams_proactive_trust_skip",
      meta: expect.objectContaining({
        intent: "explicit_cross_chat",
        authorizingTrustLevel: null,
      }),
    }))
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
  })

  it("reports generic_outreach truthfully when a low-trust Teams target is skipped without explicit cross-chat intent", async () => {
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

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "this should stay queued",
    }, {
      botApi,
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "trust_skip" })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.teams_proactive_trust_skip",
      meta: expect.objectContaining({
        intent: "generic_outreach",
        authorizingTrustLevel: null,
      }),
    }))
  })

  it("blocks proactive send when text contains internal content", async () => {
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

    const teams = await loadTeams() as any
    const result = await teams.sendProactiveTeamsMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "heartbeat check-in: same state, nothing new",
    }, {
      botApi,
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "internal_content_blocked" })
    expect(botApi._mocks.conversationsCreate).not.toHaveBeenCalled()
    expect(botApi._mocks.activityCreate).not.toHaveBeenCalled()
  })
})

describe("drainAndSendPendingTeams send_error accounting", () => {
  it("counts Teams send_error results as failed when the activity send explodes", async () => {
    const pendingRoot = makeTempDir()
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    const botApi = makeBotApi({ sendError: new Error("activity exploded") })

    writePendingFile(pendingRoot, "friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "teams",
      content: "this activity send should fail",
      timestamp: Date.now(),
    })

    const teams = await loadTeams()
    const result = await teams.drainAndSendPendingTeams(friendStore as any, botApi, pendingRoot)

    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.teams_proactive_send_error",
      meta: expect.objectContaining({
        reason: "activity exploded",
      }),
    }))
  })
})
