import { beforeEach, describe, expect, it, vi } from "vitest"
import * as path from "path"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import * as fs from "fs"

describe("session activity", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.statSync).mockReset()
  })

  it("prefers explicit friend-facing activity over newer file mtimes", async () => {
    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1", "friend-2"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-2")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      if (p === path.join(sessionsDir, "friend-2", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockImplementation(((p: string) => {
      if (String(p).includes("friend-1")) return { mtimeMs: now - 1000 * 60 * 60 } as any
      return { mtimeMs: now - 1000 * 10 } as any
    }) as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
      if (p === path.join(friendsDir, "friend-2.json")) return JSON.stringify({ name: "Sam" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 1,
          messages: [],
          state: { lastFriendActivityAt: new Date(now - 1000 * 60).toISOString() },
        })
      }
      if (p === path.join(sessionsDir, "friend-2", "cli", "session.json")) {
        return JSON.stringify({ version: 1, messages: [] })
      }
      throw new Error("ENOENT")
    }) as any)

    const { listSessionActivity } = await import("../../heart/session-activity")
    const result = listSessionActivity({ sessionsDir, friendsDir, agentName: "slugger" })

    expect(result.map((entry) => entry.friendId)).toEqual(["friend-1", "friend-2"])
    expect(result[0]).toMatchObject({
      friendId: "friend-1",
      friendName: "Ari",
      activitySource: "friend-facing",
    })
    expect(result[1]).toMatchObject({
      friendId: "friend-2",
      friendName: "Sam",
      activitySource: "mtime-fallback",
    })
  })

  it("finds the freshest active session for one friend and falls back when none are active", async () => {
    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli", "bluebubbles"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      if (p === path.join(sessionsDir, "friend-1", "bluebubbles")) return ["chat.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockImplementation(((p: string) => {
      if (String(p).includes("bluebubbles")) return { mtimeMs: now - 1000 * 30 } as any
      return { mtimeMs: now - 1000 * 60 * 60 * 48 } as any
    }) as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 1,
          messages: [],
          state: { lastFriendActivityAt: new Date(now - 1000 * 60 * 60 * 72).toISOString() },
        })
      }
      if (p === path.join(sessionsDir, "friend-1", "bluebubbles", "chat.json")) {
        return JSON.stringify({ version: 1, messages: [] })
      }
      throw new Error("ENOENT")
    }) as any)

    const { findFreshestFriendSession } = await import("../../heart/session-activity")

    const active = findFreshestFriendSession({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendId: "friend-1",
      activeOnly: true,
      activeThresholdMs: 1000 * 60 * 60,
    })
    expect(active).toMatchObject({
      friendId: "friend-1",
      channel: "bluebubbles",
      activitySource: "mtime-fallback",
    })

    const any = findFreshestFriendSession({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      friendId: "friend-1",
      activeOnly: false,
      activeThresholdMs: 1000 * 60 * 60,
    })
    expect(any?.friendId).toBe("friend-1")
  })

  it("falls back cleanly when sessions are missing or explicit friend activity is malformed", async () => {
    const missingSessionsDir = "/missing/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { listSessionActivity, findFreshestFriendSession } = await import("../../heart/session-activity")

    expect(listSessionActivity({
      sessionsDir: missingSessionsDir,
      friendsDir,
      agentName: "slugger",
    })).toEqual([])
    expect(findFreshestFriendSession({
      sessionsDir: missingSessionsDir,
      friendsDir,
      agentName: "slugger",
      friendId: "friend-1",
    })).toBeNull()

    const sessionsDir = "/mock/sessions"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: now - 1000 * 15 } as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 1,
          messages: [],
          state: { lastFriendActivityAt: { not: "a string" } },
        })
      }
      throw new Error("ENOENT")
    }) as any)

    expect(listSessionActivity({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
    })).toMatchObject([
      {
        friendId: "friend-1",
        activitySource: "mtime-fallback",
      },
    ])
  })

  it("falls back to mtime when lastFriendActivityAt is an invalid date string", async () => {
    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: now - 1000 * 20 } as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 1,
          messages: [],
          state: { lastFriendActivityAt: "not-a-real-date" },
        })
      }
      throw new Error("ENOENT")
    }) as any)

    const { listSessionActivity } = await import("../../heart/session-activity")
    expect(listSessionActivity({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
    })[0]).toMatchObject({
      friendId: "friend-1",
      activitySource: "mtime-fallback",
      lastActivityAt: new Date(now - 1000 * 20).toISOString(),
    })
  })

  it("derives inbound/outbound temporal context from canonical session events", async () => {
    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: now - 1000 * 20 } as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 2,
          events: [
            {
              id: "evt-000001",
              sequence: 1,
              role: "user",
              content: "first",
              name: null,
              toolCallId: null,
              toolCalls: [],
              attachments: [],
              time: {
                authoredAt: null,
                authoredAtSource: "unknown",
                observedAt: new Date(now - 1000 * 60 * 10).toISOString(),
                observedAtSource: "ingest",
                recordedAt: new Date(now - 1000 * 60 * 10).toISOString(),
                recordedAtSource: "save",
              },
              relations: {
                replyToEventId: null,
                threadRootEventId: null,
                references: [],
                toolCallId: null,
                supersedesEventId: null,
                redactsEventId: null,
              },
              provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
            },
            {
              id: "evt-000002",
              sequence: 2,
              role: "assistant",
              content: "reply",
              name: null,
              toolCallId: null,
              toolCalls: [],
              attachments: [],
              time: {
                authoredAt: new Date(now - 1000 * 60 * 5).toISOString(),
                authoredAtSource: "local",
                observedAt: new Date(now - 1000 * 60 * 5).toISOString(),
                observedAtSource: "local",
                recordedAt: new Date(now - 1000 * 60 * 5).toISOString(),
                recordedAtSource: "save",
              },
              relations: {
                replyToEventId: "evt-000001",
                threadRootEventId: "evt-000001",
                references: ["evt-000001"],
                toolCallId: null,
                supersedesEventId: null,
                redactsEventId: null,
              },
              provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
            },
            {
              id: "evt-000003",
              sequence: 3,
              role: "user",
              content: "follow-up",
              name: null,
              toolCallId: null,
              toolCalls: [],
              attachments: [],
              time: {
                authoredAt: null,
                authoredAtSource: "unknown",
                observedAt: new Date(now - 1000 * 60).toISOString(),
                observedAtSource: "ingest",
                recordedAt: new Date(now - 1000 * 60).toISOString(),
                recordedAtSource: "save",
              },
              relations: {
                replyToEventId: "evt-000002",
                threadRootEventId: "evt-000001",
                references: ["evt-000001", "evt-000002"],
                toolCallId: null,
                supersedesEventId: null,
                redactsEventId: null,
              },
              provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
            },
          ],
          projection: {
            eventIds: ["evt-000001", "evt-000002", "evt-000003"],
            trimmed: false,
            maxTokens: 80000,
            contextMargin: 20,
            inputTokens: null,
            projectedAt: new Date(now - 1000 * 60).toISOString(),
          },
          lastUsage: null,
          state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
        })
      }
      throw new Error("ENOENT")
    }) as any)

    const { listSessionActivity } = await import("../../heart/session-activity")
    const [entry] = listSessionActivity({ sessionsDir, friendsDir, agentName: "slugger" })

    expect(entry).toMatchObject({
      friendId: "friend-1",
      lastInboundAt: new Date(now - 1000 * 60).toISOString(),
      lastOutboundAt: new Date(now - 1000 * 60 * 5).toISOString(),
      unansweredInboundCount: 1,
    })
  })

  it("keeps explicit friend-facing activity while still surfacing unanswered inbound context", async () => {
    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()
    const explicitActivityAt = new Date(now - 1000 * 60 * 2).toISOString()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: now - 1000 * 20 } as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 2,
          events: [
            {
              id: "evt-000001",
              sequence: 1,
              role: "user",
              content: "hello",
              name: null,
              toolCallId: null,
              toolCalls: [],
              attachments: [],
              time: {
                authoredAt: null,
                authoredAtSource: "unknown",
                observedAt: new Date(now - 1000 * 60 * 10).toISOString(),
                observedAtSource: "ingest",
                recordedAt: new Date(now - 1000 * 60 * 10).toISOString(),
                recordedAtSource: "save",
              },
              relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
              provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
            },
          ],
          projection: {
            eventIds: ["evt-000001"],
            trimmed: false,
            maxTokens: 80000,
            contextMargin: 20,
            inputTokens: null,
            projectedAt: explicitActivityAt,
          },
          lastUsage: null,
          state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: explicitActivityAt },
        })
      }
      throw new Error("ENOENT")
    }) as any)

    const { listSessionActivity } = await import("../../heart/session-activity")
    const [entry] = listSessionActivity({ sessionsDir, friendsDir, agentName: "slugger" })

    expect(entry).toMatchObject({
      friendId: "friend-1",
      activitySource: "friend-facing",
      lastActivityAt: explicitActivityAt,
      unansweredInboundCount: 1,
    })
  })

  it("defaults unanswered inbound count to zero when explicit friend-facing activity exists without chronology", async () => {
    vi.resetModules()
    vi.doMock("../../heart/session-events", () => ({
      loadSessionEnvelopeFile: vi.fn(() => ({
        version: 2,
        events: [],
        projection: {
          eventIds: [],
          trimmed: false,
          maxTokens: null,
          contextMargin: null,
          inputTokens: null,
          projectedAt: null,
        },
        lastUsage: null,
        state: {
          mustResolveBeforeHandoff: false,
          lastFriendActivityAt: "2026-04-09T18:00:00.000Z",
        },
      })),
      deriveSessionChronology: vi.fn(() => null),
    }))

    try {
      const sessionsDir = "/mock/sessions"
      const friendsDir = "/mock/friends"

      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
        if (p === sessionsDir) return ["friend-1"] as any
        if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
        if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
        return [] as any
      }) as any)
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.parse("2026-04-09T18:05:00.000Z") } as any)
      vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
        if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
        throw new Error("ENOENT")
      }) as any)

      const { listSessionActivity } = await import("../../heart/session-activity")
      const [entry] = listSessionActivity({ sessionsDir, friendsDir, agentName: "slugger" })

      expect(entry).toMatchObject({
        friendId: "friend-1",
        activitySource: "friend-facing",
        unansweredInboundCount: 0,
      })
    } finally {
      vi.doUnmock("../../heart/session-events")
      vi.resetModules()
    }
  })

  it("falls back to mtime when derived chronology has a malformed inbound timestamp", async () => {
    vi.resetModules()
    vi.doMock("../../heart/session-events", () => ({
      loadSessionEnvelopeFile: vi.fn(() => ({
        version: 2,
        events: [],
        projection: {
          eventIds: [],
          trimmed: false,
          maxTokens: null,
          contextMargin: null,
          inputTokens: null,
          projectedAt: null,
        },
        lastUsage: null,
        state: {
          mustResolveBeforeHandoff: false,
          lastFriendActivityAt: null,
        },
      })),
      deriveSessionChronology: vi.fn(() => ({
        lastInboundAt: "not-a-real-date",
        lastOutboundAt: null,
        lastActivityAt: "not-a-real-date",
        unansweredInboundCount: 2,
      })),
    }))

    try {
      const sessionsDir = "/mock/sessions"
      const friendsDir = "/mock/friends"
      const mtimeMs = Date.parse("2026-04-09T18:15:00.000Z")

      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
        if (p === sessionsDir) return ["friend-1"] as any
        if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
        if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
        return [] as any
      }) as any)
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs } as any)
      vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
        if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ name: "Ari" })
        throw new Error("ENOENT")
      }) as any)

      const { listSessionActivity } = await import("../../heart/session-activity")
      const [entry] = listSessionActivity({ sessionsDir, friendsDir, agentName: "slugger" })

      expect(entry).toMatchObject({
        friendId: "friend-1",
        activitySource: "mtime-fallback",
        lastActivityAt: new Date(mtimeMs).toISOString(),
        lastInboundAt: "not-a-real-date",
        unansweredInboundCount: 2,
      })
    } finally {
      vi.doUnmock("../../heart/session-events")
      vi.resetModules()
    }
  })
})
