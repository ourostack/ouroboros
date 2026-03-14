import { describe, expect, it } from "vitest"

import type { FriendStore } from "../../../mind/friends/store"
import type { FriendRecord, IdentityProvider } from "../../../mind/friends/types"

type GroupContextModule = typeof import("../../../mind/friends/group-context")

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "stranger",
    trustLevel: "stranger",
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

class InMemoryFriendStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()

  constructor(initial: FriendRecord[] = []) {
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
        && candidate.tenantId === tenantId,
      )
      if (match) return record
    }
    return null
  }

  async hasAnyFriends(): Promise<boolean> {
    return this.records.size > 0
  }

  async listAll(): Promise<FriendRecord[]> {
    return Array.from(this.records.values())
  }
}

async function loadGroupContextModule(): Promise<GroupContextModule> {
  const modulePath = "../../../mind/friends/group-context"
  return import(modulePath)
}

function participant(
  externalId: string,
  displayName = externalId,
  provider: IdentityProvider = "imessage-handle",
) {
  return { provider, externalId, displayName }
}

describe("upsertGroupContextParticipants", () => {
  it("creates unknown relevant group participants as acquaintances with the specific group external id", async () => {
    const { upsertGroupContextParticipants } = await loadGroupContextModule()
    const store = new InMemoryFriendStore()

    const results = await upsertGroupContextParticipants({
      store,
      participants: [
        participant("new-one@example.com", "New One"),
        participant("new-two@example.com", "New Two"),
      ],
      groupExternalId: "group:any;+;groupchat123",
      now: () => "2026-03-14T18:00:00.000Z",
    })

    expect(results).toHaveLength(2)
    expect(results.every((result) => result.created)).toBe(true)
    expect(Array.from(store.records.values()).map((friend) => ({
      name: friend.name,
      trustLevel: friend.trustLevel,
      externalIds: friend.externalIds.map((externalId) => externalId.externalId).sort(),
    }))).toEqual([
      {
        name: "New One",
        trustLevel: "acquaintance",
        externalIds: ["group:any;+;groupchat123", "new-one@example.com"],
      },
      {
        name: "New Two",
        trustLevel: "acquaintance",
        externalIds: ["group:any;+;groupchat123", "new-two@example.com"],
      },
    ])
  })

  it("keeps cold non-group first encounters on the generic resolver path as strangers", async () => {
    const store = new InMemoryFriendStore([
      makeFriend({
        id: "existing-friend",
        name: "Existing Friend",
        role: "partner",
        trustLevel: "friend",
        externalIds: [{ provider: "imessage-handle", externalId: "existing@example.com", linkedAt: "2026-03-14T17:42:00.000Z" }],
      }),
    ])

    const genericResolverModulePath = "../../../mind/friends/resolver"
    const { FriendResolver } = await import(genericResolverModulePath)
    const resolver = new FriendResolver(store, {
      provider: "imessage-handle",
      externalId: "cold-contact@example.com",
      displayName: "Cold Contact",
      channel: "bluebubbles",
    })

    const context = await resolver.resolve()

    expect(context.friend.trustLevel).toBe("stranger")
    expect(context.friend.externalIds.map((externalId) => externalId.externalId)).toEqual(["cold-contact@example.com"])
  })

  it("promotes existing strangers to acquaintance when the harness learns a relevant shared group", async () => {
    const { upsertGroupContextParticipants } = await loadGroupContextModule()
    const stranger = makeFriend({
      id: "stranger-1",
      name: "Shared Context Person",
      trustLevel: "stranger",
      role: "stranger",
      externalIds: [
        { provider: "imessage-handle", externalId: "shared@example.com", linkedAt: "2026-03-14T17:42:00.000Z" },
      ],
    })
    const store = new InMemoryFriendStore([stranger])

    const [result] = await upsertGroupContextParticipants({
      store,
      participants: [participant("shared@example.com", "Shared Context Person")],
      groupExternalId: "group:any;+;groupchat123",
      now: () => "2026-03-14T18:00:00.000Z",
    })

    const updated = await store.get("stranger-1")
    expect(result.updated).toBe(true)
    expect(updated?.trustLevel).toBe("acquaintance")
    expect(updated?.externalIds.map((externalId) => externalId.externalId).sort()).toEqual([
      "group:any;+;groupchat123",
      "shared@example.com",
    ])
  })

  it("preserves higher trust levels and just adds the relevant group association", async () => {
    const { upsertGroupContextParticipants } = await loadGroupContextModule()
    const family = makeFriend({
      id: "family-1",
      name: "Family Friend",
      role: "partner",
      trustLevel: "family",
      externalIds: [
        { provider: "imessage-handle", externalId: "family@example.com", linkedAt: "2026-03-14T17:42:00.000Z" },
      ],
    })
    const store = new InMemoryFriendStore([family])

    const [result] = await upsertGroupContextParticipants({
      store,
      participants: [participant("family@example.com", "Family Friend")],
      groupExternalId: "group:any;+;groupchat123",
      now: () => "2026-03-14T18:00:00.000Z",
    })

    const updated = await store.get("family-1")
    expect(result.updated).toBe(true)
    expect(updated?.trustLevel).toBe("family")
    expect(updated?.externalIds.map((externalId) => externalId.externalId).sort()).toEqual([
      "family@example.com",
      "group:any;+;groupchat123",
    ])
  })

  it("scopes bootstrap to the specific live group and avoids duplicate records for repeated handles", async () => {
    const { upsertGroupContextParticipants } = await loadGroupContextModule()
    const store = new InMemoryFriendStore()

    const results = await upsertGroupContextParticipants({
      store,
      participants: [
        participant("repeat@example.com", "Repeat"),
        participant("repeat@example.com", "Repeat"),
      ],
      groupExternalId: "group:any;+;groupchat123",
      now: () => "2026-03-14T18:00:00.000Z",
    })

    expect(results).toHaveLength(1)
    expect(Array.from(store.records.values())).toHaveLength(1)
    expect(Array.from(store.records.values())[0]?.externalIds.map((externalId) => externalId.externalId)).toEqual([
      "repeat@example.com",
      "group:any;+;groupchat123",
    ])
  })
})
