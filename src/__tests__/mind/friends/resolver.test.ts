import { describe, it, expect, vi } from "vitest"
import { FriendResolver } from "../../../mind/friends/resolver"
import type { FriendStore } from "../../../mind/friends/store"
import type { FriendRecord } from "../../../mind/friends/types"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "uuid-1",
    name: "Jordan",
    role: "partner",
    trustLevel: "friend",
    connections: [{ name: "Ari", relationship: "teammate" }],
    externalIds: [
      { provider: "aad", externalId: "aad-id-1", tenantId: "t1", linkedAt: "2026-03-02T00:00:00.000Z" },
    ],
    tenantMemberships: ["t1"],
    toolPreferences: { ado: "flat backlog view" },
    notes: { role: { value: "engineering manager", savedAt: "2026-01-01T00:00:00.000Z" } },
    totalTokens: 0,
    createdAt: "2026-03-02T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

function createMockStore(existing?: FriendRecord, hasAnyFriends = false): FriendStore & { hasAnyFriends: () => Promise<boolean> } {
  return {
    get: vi.fn(async () => existing ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    findByExternalId: vi.fn(async () => existing ?? null),
    hasAnyFriends: vi.fn(async () => hasAnyFriends),
  }
}

describe("FriendResolver", () => {
  it("returns ResolvedContext with friend and channel", async () => {
    const friend = makeFriend()
    const store = createMockStore(friend)
    const resolver = new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-id-1",
      tenantId: "t1",
      displayName: "Jordan",
      channel: "teams",
    })

    const ctx = await resolver.resolve()
    expect(ctx.friend.name).toBe("Jordan")
    expect(ctx.friend.id).toBe("uuid-1")
    expect(ctx.channel.channel).toBe("teams")
    expect(ctx.channel.availableIntegrations).toEqual(["ado", "graph", "github"])
  })

  it("resolves CLI identity with local provider", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "local", externalId: "alex@macbook", linkedAt: "2026-03-02T00:00:00.000Z" },
      ],
      tenantMemberships: [],
    })
    const store = createMockStore(friend)
    const resolver = new FriendResolver(store, {
      provider: "local",
      externalId: "alex@macbook",
      displayName: "alex",
      channel: "cli",
    })

    const ctx = await resolver.resolve()
    expect(ctx.friend.externalIds[0].provider).toBe("local")
    expect(ctx.channel.channel).toBe("cli")
    expect(ctx.channel.supportsStreaming).toBe(true)
  })

  describe("first-encounter flow", () => {
    it("creates new FriendRecord when findByExternalId returns null", async () => {
      const store = createMockStore() // no existing
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "new-aad-id",
        tenantId: "t1",
        displayName: "New Person",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      // Should have created a new friend
      expect(ctx.friend.name).toBe("New Person")
      expect(ctx.friend.externalIds[0].provider).toBe("aad")
      expect(ctx.friend.externalIds[0].externalId).toBe("new-aad-id")
      expect(ctx.friend.externalIds[0].tenantId).toBe("t1")
      expect(ctx.friend.tenantMemberships).toEqual(["t1"])
      expect(ctx.friend.toolPreferences).toEqual({})
      expect(ctx.friend.notes).toEqual({ name: { value: "New Person", savedAt: expect.any(String) } })
      expect(ctx.friend.role).toBe("primary")
      expect(ctx.friend.trustLevel).toBe("family")
      expect(ctx.friend.connections).toEqual([])
      expect(ctx.friend.id).toBeTruthy()
      // Should have saved via store.put
      expect(store.put).toHaveBeenCalledTimes(1)
    })

    it("generates a UUID for new friends", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "alex@macbook",
        displayName: "alex",
        channel: "cli",
      })

      const ctx = await resolver.resolve()
      // UUID format: 8-4-4-4-12 hex chars
      expect(ctx.friend.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it("sets createdAt and updatedAt to current time for new friends", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const before = new Date().toISOString()
      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "alex@macbook",
        displayName: "alex",
        channel: "cli",
      })
      const ctx = await resolver.resolve()
      const after = new Date().toISOString()

      expect(ctx.friend.createdAt >= before).toBe(true)
      expect(ctx.friend.createdAt <= after).toBe(true)
      expect(ctx.friend.updatedAt).toBe(ctx.friend.createdAt)
    })

    it("initializes totalTokens to 0 on newly created friend records", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "new-aad-id",
        tenantId: "t1",
        displayName: "New Person",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.totalTokens).toBe(0)
    })

    it("auto-populates name note from displayName when not 'Unknown'", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "new-aad-id",
        tenantId: "t1",
        displayName: "Jordan",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.notes).toEqual({ name: { value: "Jordan", savedAt: expect.any(String) } })
    })

    it("does NOT auto-populate name note when displayName is 'Unknown'", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "new-aad-id",
        tenantId: "t1",
        displayName: "Unknown",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.notes).toEqual({})
    })

    it("creates new friend without tenantId for local provider", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "alex@macbook",
        displayName: "alex",
        channel: "cli",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.externalIds[0].tenantId).toBeUndefined()
      expect(ctx.friend.tenantMemberships).toEqual([])
    })

    it("creates provisional stranger trust for non-first encounters", async () => {
      const store = createMockStore(undefined, true)
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "new-aad-id-2",
        tenantId: "t1",
        displayName: "Later Contact",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.trustLevel).toBe("stranger")
      expect(ctx.friend.role).toBe("stranger")
    })
  })

  describe("returning friend flow", () => {
    it("does NOT overwrite displayName on existing records", async () => {
      const existing = makeFriend({ name: "My Preferred Name" })
      const store = createMockStore(existing)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-id-1",
        tenantId: "t1",
        displayName: "SYSTEM.NAME.FROM.AAD",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      // Should keep the existing name, not overwrite with system-provided
      expect(ctx.friend.name).toBe("My Preferred Name")
    })

    it("does not call store.put for existing friends", async () => {
      const existing = makeFriend()
      const store = createMockStore(existing)

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-id-1",
        tenantId: "t1",
        displayName: "Jordan",
        channel: "teams",
      })

      await resolver.resolve()
      expect(store.put).not.toHaveBeenCalled()
    })
  })

  describe("teams-conversation fallback", () => {
    it("works with teams-conversation provider", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "teams-conversation",
        externalId: "conv-id-123",
        displayName: "Guest User",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.externalIds[0].provider).toBe("teams-conversation")
      expect(ctx.friend.externalIds[0].externalId).toBe("conv-id-123")
    })
  })

  describe("channel capabilities", () => {
    it("returns Teams capabilities for teams channel", async () => {
      const store = createMockStore(makeFriend())
      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-id-1",
        displayName: "Jordan",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.channel.supportsMarkdown).toBe(true)
      expect(ctx.channel.supportsRichCards).toBe(true)
    })

    it("returns CLI capabilities for cli channel", async () => {
      const store = createMockStore(makeFriend())
      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "alex@macbook",
        displayName: "alex",
        channel: "cli",
      })

      const ctx = await resolver.resolve()
      expect(ctx.channel.supportsStreaming).toBe(true)
      expect(ctx.channel.supportsMarkdown).toBe(false)
    })

    it("returns default capabilities for unknown channel", async () => {
      const store = createMockStore(makeFriend())
      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "user",
        displayName: "user",
        channel: "unknown",
      })

      const ctx = await resolver.resolve()
      expect(ctx.channel.availableIntegrations).toEqual([])
      expect(ctx.channel.supportsStreaming).toBe(false)
    })
  })

  describe("no authority checker", () => {
    it("result has no checker field", async () => {
      const store = createMockStore(makeFriend())
      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-id-1",
        displayName: "Jordan",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect("checker" in ctx).toBe(false)
    })
  })

  describe("error handling", () => {
    it("handles findByExternalId failure gracefully (creates new)", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk error"))

      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "user",
        displayName: "User",
        channel: "cli",
      })

      const ctx = await resolver.resolve()
      // Should still resolve (creates new friend on search failure)
      expect(ctx.friend.name).toBe("User")
    })

    it("defaults to first-imprint trust when hasAnyFriends check fails", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(store.hasAnyFriends as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("index read failed"))

      const resolver = new FriendResolver(store, {
        provider: "aad",
        externalId: "new-aad-id",
        tenantId: "t1",
        displayName: "New Person",
        channel: "teams",
      })

      const ctx = await resolver.resolve()
      expect(ctx.friend.role).toBe("primary")
      expect(ctx.friend.trustLevel).toBe("family")
    })

    it("handles store.put failure gracefully on new friend creation", async () => {
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(store.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("write error"))

      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "user",
        displayName: "User",
        channel: "cli",
      })

      // Should still resolve even if put fails
      const ctx = await resolver.resolve()
      expect(ctx.friend.name).toBe("User")
    })

    it("emits friends.persist_error nerves event when store.put throws", async () => {
      vi.mocked(emitNervesEvent).mockClear()
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(store.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"))

      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "user",
        displayName: "User",
        channel: "cli",
      })

      await resolver.resolve()

      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "friends.persist_error",
        component: "friends",
        message: "failed to persist friend record",
        meta: { reason: "disk full" },
      }))
    })

    it("emits friends.persist_error with stringified reason for non-Error throws", async () => {
      vi.mocked(emitNervesEvent).mockClear()
      const store = createMockStore()
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(store.put as ReturnType<typeof vi.fn>).mockRejectedValue("raw string error")

      const resolver = new FriendResolver(store, {
        provider: "local",
        externalId: "user",
        displayName: "User",
        channel: "cli",
      })

      await resolver.resolve()

      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "friends.persist_error",
        component: "friends",
        meta: { reason: "raw string error" },
      }))
    })
  })

  describe("auto-create marks BlueBubbles group friends so the trust gate can surface them", () => {
    it("marks an auto-created stranger group friend with notes.autoCreatedGroup", async () => {
      const store = createMockStore(undefined, true) // hasAnyFriends true → not first imprint, so trust = stranger
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "imessage-handle",
        externalId: "group:any;+;abc123",
        displayName: "Consciousness TBD",
        channel: "bluebubbles",
      })

      await resolver.resolve()

      const persisted = (store.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as FriendRecord
      expect(persisted.trustLevel).toBe("stranger")
      expect(persisted.notes?.autoCreatedGroup).toEqual(expect.objectContaining({ value: "true" }))
      expect(persisted.notes?.autoCreatedGroup).toEqual(expect.objectContaining({ savedAt: expect.any(String) }))
      expect(persisted.notes?.name).toEqual(expect.objectContaining({ value: "Consciousness TBD" }))
    })

    it("does NOT mark non-group iMessage friends with autoCreatedGroup", async () => {
      const store = createMockStore(undefined, true)
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        displayName: "Ari",
        channel: "bluebubbles",
      })

      await resolver.resolve()

      const persisted = (store.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as FriendRecord
      expect(persisted.notes?.autoCreatedGroup).toBeUndefined()
    })

    it("does NOT mark a first-imprint group friend (which becomes family-trust primary)", async () => {
      const store = createMockStore(undefined, false) // hasAnyFriends false → first imprint
      ;(store.findByExternalId as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const resolver = new FriendResolver(store, {
        provider: "imessage-handle",
        externalId: "group:any;+;first-group",
        displayName: "Some Group",
        channel: "bluebubbles",
      })

      await resolver.resolve()

      const persisted = (store.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as FriendRecord
      expect(persisted.trustLevel).toBe("family")
      expect(persisted.notes?.autoCreatedGroup).toBeUndefined()
    })
  })
})
