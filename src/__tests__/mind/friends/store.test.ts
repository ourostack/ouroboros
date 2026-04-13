import { describe, it, expect, vi } from "vitest"
import type { FriendStore } from "../../../mind/friends/store"
import type { FriendRecord } from "../../../mind/friends/types"

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "uuid-1",
    name: "Jordan",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-02T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

// Mock process-local implementation for interface contract tests
function createMockFriendStore(): FriendStore {
  const items = new Map<string, FriendRecord>()
  return {
    get: vi.fn(async (id: string) => items.get(id) ?? null),
    put: vi.fn(async (id: string, value: FriendRecord) => { items.set(id, value) }),
    delete: vi.fn(async (id: string) => { items.delete(id) }),
    findByExternalId: vi.fn(async (provider: string, externalId: string, _tenantId?: string) => {
      for (const record of items.values()) {
        if (record.externalIds.some(e => e.provider === provider && e.externalId === externalId)) {
          return record
        }
      }
      return null
    }),
  }
}

describe("FriendStore interface contract", () => {
  it("get returns null for missing id", async () => {
    const store = createMockFriendStore()
    expect(await store.get("nonexistent")).toBeNull()
  })

  it("put then get returns the stored value", async () => {
    const store = createMockFriendStore()
    const friend = makeFriend()
    await store.put("uuid-1", friend)
    expect(await store.get("uuid-1")).toEqual(friend)
  })

  it("delete then get returns null", async () => {
    const store = createMockFriendStore()
    const friend = makeFriend()
    await store.put("uuid-1", friend)
    await store.delete("uuid-1")
    expect(await store.get("uuid-1")).toBeNull()
  })

  it("findByExternalId with matching external ID returns the record", async () => {
    const store = createMockFriendStore()
    const friend = makeFriend({
      externalIds: [
        { provider: "aad", externalId: "aad-id-123", tenantId: "t1", linkedAt: "2026-03-02T00:00:00.000Z" },
      ],
    })
    await store.put("uuid-1", friend)
    const found = await store.findByExternalId("aad", "aad-id-123")
    expect(found).toEqual(friend)
  })

  it("findByExternalId with no match returns null", async () => {
    const store = createMockFriendStore()
    await store.put("uuid-1", makeFriend())
    const found = await store.findByExternalId("aad", "nonexistent")
    expect(found).toBeNull()
  })

  it("findByExternalId with teams-conversation provider works", async () => {
    const store = createMockFriendStore()
    const friend = makeFriend({
      externalIds: [
        { provider: "teams-conversation", externalId: "conv-123", linkedAt: "2026-03-02T00:00:00.000Z" },
      ],
    })
    await store.put("uuid-1", friend)
    const found = await store.findByExternalId("teams-conversation", "conv-123")
    expect(found).toEqual(friend)
  })

  it("has no CollectionStore or ContextStore exports", async () => {
    // Ensure the old interfaces are removed
    const storeModule = await import("../../../mind/friends/store")
    expect("CollectionStore" in storeModule).toBe(false)
    expect("ContextStore" in storeModule).toBe(false)
  })
})
