import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { FriendStore } from "../../mind/friends/store"
import type { FriendRecord } from "../../mind/friends/types"

type TargetResolutionModule = typeof import("../../heart/target-resolution")

class InMemoryFriendStore implements FriendStore {
  private readonly records = new Map<string, FriendRecord>()

  constructor(initial: FriendRecord[]) {
    for (const friend of initial) {
      this.records.set(friend.id, friend)
    }
  }

  async get(id: string): Promise<FriendRecord | null> {
    return this.records.get(id) ?? null
  }

  async put(id: string, record: FriendRecord): Promise<void> {
    this.records.set(id, record)
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id)
  }

  async findByExternalId(provider: string, externalId: string, tenantId?: string): Promise<FriendRecord | null> {
    for (const record of this.records.values()) {
      const match = record.externalIds.find((candidate) =>
        candidate.provider === provider
        && candidate.externalId === externalId
        && candidate.tenantId === tenantId
      )
      if (match) return record
    }
    return null
  }
}

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Ari",
    role: "partner",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-14T17:42:00.000Z",
    updatedAt: "2026-03-14T17:42:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "target-resolution-"))
  tempDirs.push(dir)
  return dir
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function recentIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString()
}

async function loadTargetResolutionModule(): Promise<TargetResolutionModule> {
  const modulePath = "../../heart/target-resolution"
  return import(modulePath)
}

afterEach(() => {
  vi.doUnmock("../../heart/session-recall")
  vi.resetModules()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("listTargetSessionCandidates", () => {
  it("returns live candidate sessions with trust explanation, snapshots, and delivery truth while excluding current and inner sessions", async () => {
    const { listTargetSessionCandidates } = await loadTargetResolutionModule()
    const root = makeTempDir()
    const sessionsDir = path.join(root, "state", "sessions")
    const friendsDir = path.join(root, "friends")

    writeJson(path.join(friendsDir, "friend-1.json"), { name: "Ari" })
    writeJson(path.join(friendsDir, "friend-2.json"), { name: "Project Group" })
    writeJson(path.join(sessionsDir, "friend-1", "cli", "current.json"), {
      state: { lastFriendActivityAt: recentIso(6) },
      messages: [{ role: "user", content: "current chat" }],
    })
    writeJson(path.join(sessionsDir, "friend-1", "bluebubbles", "chat-any.json"), {
      state: { lastFriendActivityAt: recentIso(5) },
      messages: [
        { role: "user", content: "tell the group the plan changed" },
        { role: "assistant", content: "i can carry that over" },
      ],
    })
    writeJson(path.join(sessionsDir, "friend-2", "teams", "group-thread.json"), {
      state: { lastFriendActivityAt: recentIso(4) },
      messages: [
        { role: "user", content: "we need the latest update" },
        { role: "assistant", content: "waiting for the relay" },
      ],
    })
    writeJson(path.join(sessionsDir, "self", "inner", "dialog.json"), {
      state: { lastFriendActivityAt: recentIso(3) },
      messages: [{ role: "assistant", content: "private thought" }],
    })

    const store = new InMemoryFriendStore([
      makeFriend({
        id: "friend-1",
        name: "Ari",
        trustLevel: "friend",
      }),
      makeFriend({
        id: "friend-2",
        name: "Project Group",
        role: "acquaintance",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-03-14T17:42:00.000Z" },
        ],
      }),
    ])

    const candidates = await listTargetSessionCandidates({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendStore: store,
      currentSession: {
        friendId: "friend-1",
        channel: "cli",
        key: "current",
      },
      summarize: async (_transcript, instruction) => `summary via ${instruction.slice(0, 24)}`,
    })

    expect(candidates).toHaveLength(2)
    expect(candidates.map((candidate) => `${candidate.friendId}/${candidate.channel}/${candidate.key}`)).toEqual([
      "friend-1/bluebubbles/chat-any",
      "friend-2/teams/group-thread",
    ])
    expect(candidates[0]).toEqual(expect.objectContaining({
      trust: expect.objectContaining({ level: "friend", basis: "direct" }),
      delivery: expect.objectContaining({ mode: "deliver_now" }),
    }))
    expect(candidates[1]).toEqual(expect.objectContaining({
      trust: expect.objectContaining({ level: "acquaintance", basis: "shared_group" }),
      delivery: expect.objectContaining({ mode: "queue_only" }),
    }))
    expect(candidates[0]?.snapshot.toLowerCase()).toContain("recent focus")
  })

  it("keeps multiple plausible live sessions visible and formats enough detail to disambiguate them", async () => {
    const { listTargetSessionCandidates, formatTargetSessionCandidates } = await loadTargetResolutionModule()
    const root = makeTempDir()
    const sessionsDir = path.join(root, "state", "sessions")
    const friendsDir = path.join(root, "friends")

    writeJson(path.join(friendsDir, "friend-1.json"), { name: "Ari" })
    writeJson(path.join(friendsDir, "friend-3.json"), { name: "Project Crew" })
    writeJson(path.join(sessionsDir, "friend-1", "bluebubbles", "chat-any.json"), {
      state: { lastFriendActivityAt: recentIso(5) },
      messages: [{ role: "user", content: "bluebubbles target" }],
    })
    writeJson(path.join(sessionsDir, "friend-3", "teams", "group-thread.json"), {
      messages: [{ role: "user", content: "teams target" }],
    })

    const store = new InMemoryFriendStore([
      makeFriend({
        id: "friend-1",
        name: "Ari",
        trustLevel: "friend",
      }),
      makeFriend({
        id: "friend-3",
        name: "Project Crew",
        trustLevel: "friend",
      }),
    ])

    const candidates = await listTargetSessionCandidates({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendStore: store,
      summarize: async () => "recent work snapshot",
    })

    const formatted = formatTargetSessionCandidates(candidates)
    expect(candidates).toHaveLength(2)
    expect(formatted).toContain("friend-1")
    expect(formatted).toContain("friend-3")
    expect(formatted).toContain("bluebubbles/chat-any")
    expect(formatted).toContain("teams/group-thread")
    expect(formatted.toLowerCase()).toContain("delivery")
    expect(formatted.toLowerCase()).toContain("trust")
  })

  it("falls back to synthesized stranger context for unknown sessions, blocks unsupported channels, and keeps same-priority candidates newest-first", async () => {
    const { listTargetSessionCandidates } = await loadTargetResolutionModule()
    const root = makeTempDir()
    const sessionsDir = path.join(root, "state", "sessions")
    const friendsDir = path.join(root, "friends")

    writeJson(path.join(friendsDir, "friend-cli-newer.json"), { name: "CLI Newer" })
    writeJson(path.join(friendsDir, "friend-cli-older.json"), { name: "CLI Older" })
    writeJson(path.join(sessionsDir, "friend-cli-newer", "cli", "alpha.json"), {
      state: { lastFriendActivityAt: recentIso(3) },
      messages: [{ role: "user", content: "newer cli target" }],
    })
    writeJson(path.join(sessionsDir, "friend-cli-older", "cli", "beta.json"), {
      state: { lastFriendActivityAt: recentIso(7) },
      messages: [{ role: "user", content: "older cli target" }],
    })
    writeJson(path.join(sessionsDir, "missing-friend", "cli", "mystery.json"), {
      state: { lastFriendActivityAt: recentIso(5) },
      messages: [{ role: "user", content: "unknown cli target" }],
    })

    const store = new InMemoryFriendStore([
      makeFriend({
        id: "friend-cli-newer",
        name: "CLI Newer",
        trustLevel: "friend",
      }),
      makeFriend({
        id: "friend-cli-older",
        name: "CLI Older",
        trustLevel: "friend",
      }),
    ])

    const candidates = await listTargetSessionCandidates({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendStore: store,
    })

    expect(candidates.map((candidate) => candidate.friendId)).toEqual([
      "friend-cli-newer",
      "missing-friend",
      "friend-cli-older",
    ])
    expect(candidates.every((candidate) => candidate.delivery.mode === "blocked")).toBe(true)
    expect(candidates[1]).toEqual(expect.objectContaining({
      friendId: "missing-friend",
      trust: expect.objectContaining({
        level: "stranger",
        basis: "unknown",
      }),
      delivery: expect.objectContaining({
        mode: "blocked",
        reason: "this channel does not support proactive outward delivery yet",
      }),
    }))
  })

  it("MCP sessions get queue_only delivery mode", async () => {
    const { listTargetSessionCandidates } = await loadTargetResolutionModule()
    const root = makeTempDir()
    const sessionsDir = path.join(root, "state", "sessions")
    const friendsDir = path.join(root, "friends")

    writeJson(path.join(friendsDir, "friend-mcp.json"), { name: "Dev Tool User" })
    writeJson(path.join(sessionsDir, "friend-mcp", "mcp", "session-1.json"), {
      state: { lastFriendActivityAt: recentIso(2) },
      messages: [{ role: "user", content: "mcp session target" }],
    })

    const store = new InMemoryFriendStore([
      makeFriend({
        id: "friend-mcp",
        name: "Dev Tool User",
        trustLevel: "friend",
      }),
    ])

    const candidates = await listTargetSessionCandidates({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendStore: store,
      summarize: async () => "mcp snapshot",
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toEqual(expect.objectContaining({
      friendId: "friend-mcp",
      channel: "mcp",
      delivery: expect.objectContaining({
        mode: "queue_only",
        reason: expect.stringContaining("MCP session"),
      }),
    }))
  })

  it("surfaces empty and unavailable recall states explicitly and formats no candidates as empty output", async () => {
    vi.resetModules()
    vi.doMock("../../heart/session-recall", async () => {
      const actual = await vi.importActual<typeof import("../../heart/session-recall")>("../../heart/session-recall")
      return {
        ...actual,
        recallSession: vi.fn()
          .mockResolvedValueOnce({ kind: "empty" })
          .mockResolvedValueOnce({ kind: "missing" }),
      }
    })

    const { listTargetSessionCandidates, formatTargetSessionCandidates } = await loadTargetResolutionModule()
    const root = makeTempDir()
    const sessionsDir = path.join(root, "state", "sessions")
    const friendsDir = path.join(root, "friends")

    writeJson(path.join(friendsDir, "friend-1.json"), { name: "Ari" })
    writeJson(path.join(friendsDir, "friend-2.json"), { name: "Ops Room" })
    writeJson(path.join(sessionsDir, "friend-1", "teams", "chat-a.json"), {
      state: { lastFriendActivityAt: recentIso(4) },
      messages: [{ role: "user", content: "anything here is ignored by the mock" }],
    })
    writeJson(path.join(sessionsDir, "friend-2", "teams", "chat-b.json"), {
      state: { lastFriendActivityAt: recentIso(5) },
      messages: [{ role: "user", content: "still ignored by the mock" }],
    })

    const store = new InMemoryFriendStore([
      makeFriend({
        id: "friend-1",
        name: "Ari",
        trustLevel: "friend",
      }),
      makeFriend({
        id: "friend-2",
        name: "Ops Room",
        trustLevel: "friend",
      }),
    ])

    const candidates = await listTargetSessionCandidates({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendStore: store,
    })

    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.snapshot).toBe("recent focus: no recent visible messages")
    expect(candidates[1]?.snapshot).toBe("recent focus: session transcript unavailable")
    expect(formatTargetSessionCandidates([])).toBe("")
  })
})
