import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import * as os from "os"
import { FileFriendStore } from "../../../mind/friends/store-file"
import type { FriendRecord } from "../../../mind/friends/types"
import { expectCappedAgentContent, makeOversizedAgentContent } from "../../helpers/content-cap"

let tmpDir: string
let friendsPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friend-store-test-"))
  friendsPath = path.join(tmpDir, "friends")
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

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
    kind: "human",
    ...overrides,
  }
}

describe("FileFriendStore", () => {
  describe("constructor", () => {
    it("auto-creates friends directory on construction", () => {
      new FileFriendStore(friendsPath)
      expect(fsSync.existsSync(friendsPath)).toBe(true)
    })

    it("auto-creates deeply nested directories", () => {
      const deep = path.join(tmpDir, "a", "b", "c", "friends")
      new FileFriendStore(deep)
      expect(fsSync.existsSync(deep)).toBe(true)
    })
  })

  describe("get()", () => {
    it("returns null for non-existent ID", async () => {
      const store = new FileFriendStore(friendsPath)
      expect(await store.get("nonexistent")).toBeNull()
    })

    it("round-trips unified record after put", async () => {
      const store = new FileFriendStore(friendsPath)
      const friend = makeFriend()
      await store.put("uuid-1", friend)

      const result = await store.get("uuid-1")
      expect(result).not.toBeNull()
      expect(result).toEqual(friend)
    })

    it("returns normalized defaults for legacy records missing new fields", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "legacy-uuid.json"),
        JSON.stringify({
          id: "legacy-uuid",
          name: "Legacy Friend",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("legacy-uuid")
      expect(result).not.toBeNull()
      expect(result!.totalTokens).toBe(0)
      expect(result!.trustLevel).toBe("friend")
      expect(result!.role).toBe("friend")
      expect(result!.connections).toEqual([])
    })

    it("normalizes malformed optional fields", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "malformed-uuid.json"),
        JSON.stringify({
          id: "malformed-uuid",
          name: "Malformed Friend",
          role: "",
          trustLevel: "invalid",
          connections: [{ name: "Ari", relationship: "teammate" }, { name: 42 }, "bad"],
          externalIds: "bad",
          tenantMemberships: null,
          toolPreferences: null,
          notes: null,
          totalTokens: "bad",
          createdAt: 123,
          updatedAt: {},
          schemaVersion: "v1",
        }),
      )

      const result = await store.get("malformed-uuid")
      expect(result).not.toBeNull()
      expect(result!.role).toBe("friend")
      expect(result!.trustLevel).toBe("friend")
      expect(result!.connections).toEqual([{ name: "Ari", relationship: "teammate" }])
      expect(result!.externalIds).toEqual([])
      expect(result!.tenantMemberships).toEqual([])
      expect(result!.toolPreferences).toEqual({})
      expect(result!.notes).toEqual({})
      expect(result!.totalTokens).toBe(0)
      expect(typeof result!.createdAt).toBe("string")
      expect(typeof result!.updatedAt).toBe("string")
      expect(result!.schemaVersion).toBe(1)
    })

    it("returns null on corrupted JSON", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(path.join(friendsPath, "uuid-1.json"), "not json{{{", "utf-8")

      const result = await store.get("uuid-1")
      expect(result).toBeNull()
    })

    it("returns null when parsed JSON is an array", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(path.join(friendsPath, "uuid-1.json"), JSON.stringify(["not", "an", "object"]), "utf-8")

      const result = await store.get("uuid-1")
      expect(result).toBeNull()
    })
  })

  describe("put()", () => {
    it("writes one unified friend file", async () => {
      const store = new FileFriendStore(friendsPath)
      const friend = makeFriend()
      await store.put("uuid-1", friend)

      const saved = JSON.parse(await fs.readFile(path.join(friendsPath, "uuid-1.json"), "utf-8")) as FriendRecord
      expect(saved.id).toBe("uuid-1")
      expect(saved.name).toBe("Jordan")
      expect(saved.externalIds[0].provider).toBe("aad")
      expect(saved.tenantMemberships).toEqual(["t1"])
      expect(saved.toolPreferences).toEqual({ ado: "flat backlog view" })
      expect(saved.notes).toEqual({ role: { value: "engineering manager", savedAt: "2026-01-01T00:00:00.000Z" } })
      expect(saved.role).toBe("partner")
      expect(saved.trustLevel).toBe("friend")
      expect(saved.connections).toEqual([{ name: "Ari", relationship: "teammate" }])
    })

    it("caps oversized agent-authored friend note values before writing JSON", async () => {
      const store = new FileFriendStore(friendsPath)
      const oversized = makeOversizedAgentContent("friend note ")
      const friend = makeFriend({
        notes: {
          context: { value: oversized, savedAt: "2026-05-13T00:00:00.000Z" },
        },
      })

      await store.put("uuid-1", friend)

      const saved = JSON.parse(await fs.readFile(path.join(friendsPath, "uuid-1.json"), "utf-8")) as FriendRecord
      expectCappedAgentContent(saved.notes.context.value, oversized)
    })
  })

  describe("delete()", () => {
    it("removes friend file", async () => {
      const store = new FileFriendStore(friendsPath)
      await store.put("uuid-1", makeFriend())
      await store.delete("uuid-1")
      expect(await store.get("uuid-1")).toBeNull()
    })

    it("does not throw on non-existent ID", async () => {
      const store = new FileFriendStore(friendsPath)
      await expect(store.delete("nonexistent")).resolves.not.toThrow()
    })

    it("throws on non-ENOENT delete error", async () => {
      const store = new FileFriendStore(friendsPath)
      await store.put("uuid-1", makeFriend())
      await fs.chmod(friendsPath, 0o444)
      try {
        await expect(store.delete("uuid-1")).rejects.toThrow()
      } finally {
        await fs.chmod(friendsPath, 0o755)
      }
    })
  })

  describe("findByExternalId()", () => {
    it("finds by provider/external ID", async () => {
      const store = new FileFriendStore(friendsPath)
      await store.put("uuid-1", makeFriend())

      const found = await store.findByExternalId("aad", "aad-id-1")
      expect(found).not.toBeNull()
      expect(found!.id).toBe("uuid-1")
    })

    it("matches tenantId when provided", async () => {
      const store = new FileFriendStore(friendsPath)
      await store.put("uuid-1", makeFriend())

      const found = await store.findByExternalId("aad", "aad-id-1", "t1")
      const notFound = await store.findByExternalId("aad", "aad-id-1", "wrong")
      expect(found).not.toBeNull()
      expect(notFound).toBeNull()
    })

    it("returns null when no match found", async () => {
      const store = new FileFriendStore(friendsPath)
      await store.put("uuid-1", makeFriend())

      const found = await store.findByExternalId("aad", "missing")
      expect(found).toBeNull()
    })

    it("skips corrupted files and non-json files", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(path.join(friendsPath, ".DS_Store"), "junk", "utf-8")
      await fs.writeFile(path.join(friendsPath, "bad.json"), "not-json", "utf-8")
      await store.put("uuid-1", makeFriend())

      const found = await store.findByExternalId("aad", "aad-id-1")
      expect(found).not.toBeNull()
      expect(found!.id).toBe("uuid-1")
    })

    it("returns null when directory is missing", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.rm(friendsPath, { recursive: true, force: true })

      const found = await store.findByExternalId("aad", "aad-id-1")
      expect(found).toBeNull()
    })
  })

  describe("hasAnyFriends()", () => {
    it("returns false when no friend json files exist", async () => {
      const store = new FileFriendStore(friendsPath)
      expect(await store.hasAnyFriends()).toBe(false)
    })

    it("returns true when at least one friend json file exists", async () => {
      const store = new FileFriendStore(friendsPath)
      await store.put("uuid-1", makeFriend())
      expect(await store.hasAnyFriends()).toBe(true)
    })

    it("returns false when friends directory is missing", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.rm(friendsPath, { recursive: true, force: true })
      expect(await store.hasAnyFriends()).toBe(false)
    })
  })

  describe("concurrent operations", () => {
    it("concurrent puts to different IDs do not corrupt each other", async () => {
      const store = new FileFriendStore(friendsPath)
      const f1 = makeFriend({ id: "uuid-1", name: "Friend1" })
      const f2 = makeFriend({ id: "uuid-2", name: "Friend2" })

      await Promise.all([
        store.put("uuid-1", f1),
        store.put("uuid-2", f2),
      ])

      const r1 = await store.get("uuid-1")
      const r2 = await store.get("uuid-2")
      expect(r1!.name).toBe("Friend1")
      expect(r2!.name).toBe("Friend2")
    })
  })

  describe("normalize kind and agentMeta", () => {
    it("defaults missing kind to 'human'", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "no-kind.json"),
        JSON.stringify({
          id: "no-kind",
          name: "Legacy",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("no-kind")
      expect(result).not.toBeNull()
      expect(result!.kind).toBe("human")
    })

    it("passes through valid kind 'human'", async () => {
      const store = new FileFriendStore(friendsPath)
      const friend = makeFriend({ kind: "human" })
      await store.put("uuid-h", friend)
      const result = await store.get("uuid-h")
      expect(result!.kind).toBe("human")
    })

    it("passes through valid kind 'agent'", async () => {
      const store = new FileFriendStore(friendsPath)
      const friend = makeFriend({
        kind: "agent",
        agentMeta: {
          bundleName: "slugger.ouro",
          familiarity: 5,
          sharedMissions: ["m1"],
          outcomes: [],
        },
      })
      await store.put("uuid-a", friend)
      const result = await store.get("uuid-a")
      expect(result!.kind).toBe("agent")
    })

    it("defaults invalid kind to 'human'", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "bad-kind.json"),
        JSON.stringify({
          id: "bad-kind",
          name: "Bad Kind",
          kind: "robot",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("bad-kind")
      expect(result!.kind).toBe("human")
    })

    it("missing agentMeta stays undefined", async () => {
      const store = new FileFriendStore(friendsPath)
      const friend = makeFriend({ kind: "human" })
      await store.put("uuid-no-meta", friend)
      const result = await store.get("uuid-no-meta")
      expect(result!.agentMeta).toBeUndefined()
    })

    it("passes through valid agentMeta when kind is agent", async () => {
      const store = new FileFriendStore(friendsPath)
      const friend = makeFriend({
        kind: "agent",
        agentMeta: {
          bundleName: "slugger.ouro",
          familiarity: 10,
          sharedMissions: ["m1", "m2"],
          outcomes: [{ missionId: "m1", result: "success", timestamp: "2026-04-01T00:00:00.000Z" }],
        },
      })
      await store.put("uuid-agent-meta", friend)
      const result = await store.get("uuid-agent-meta")
      expect(result!.agentMeta).toBeDefined()
      expect(result!.agentMeta!.bundleName).toBe("slugger.ouro")
      expect(result!.agentMeta!.familiarity).toBe(10)
      expect(result!.agentMeta!.sharedMissions).toEqual(["m1", "m2"])
      expect(result!.agentMeta!.outcomes).toHaveLength(1)
    })

    it("strips agentMeta when kind is human", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "human-with-meta.json"),
        JSON.stringify({
          id: "human-with-meta",
          name: "Human With Meta",
          kind: "human",
          agentMeta: { bundleName: "rogue.ouro", familiarity: 1, sharedMissions: [], outcomes: [] },
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("human-with-meta")
      expect(result!.kind).toBe("human")
      expect(result!.agentMeta).toBeUndefined()
    })

    it("defaults agentMeta to undefined when shape is invalid (non-object)", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "bad-meta-type.json"),
        JSON.stringify({
          id: "bad-meta-type",
          name: "Bad Meta",
          kind: "agent",
          agentMeta: "not-an-object",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("bad-meta-type")
      expect(result!.kind).toBe("agent")
      expect(result!.agentMeta).toBeUndefined()
    })

    it("defaults agentMeta to undefined when bundleName is missing", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "no-bundle.json"),
        JSON.stringify({
          id: "no-bundle",
          name: "No Bundle",
          kind: "agent",
          agentMeta: { familiarity: 1, sharedMissions: [], outcomes: [] },
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("no-bundle")
      expect(result!.agentMeta).toBeUndefined()
    })

    it("defaults agentMeta subfields: familiarity to 0, sharedMissions to [], outcomes to []", async () => {
      const store = new FileFriendStore(friendsPath)
      await fs.mkdir(friendsPath, { recursive: true })
      await fs.writeFile(
        path.join(friendsPath, "partial-meta.json"),
        JSON.stringify({
          id: "partial-meta",
          name: "Partial Meta",
          kind: "agent",
          agentMeta: { bundleName: "peer.ouro", familiarity: "bad", sharedMissions: "bad", outcomes: "bad" },
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
      )

      const result = await store.get("partial-meta")
      expect(result!.agentMeta).toBeDefined()
      expect(result!.agentMeta!.bundleName).toBe("peer.ouro")
      expect(result!.agentMeta!.familiarity).toBe(0)
      expect(result!.agentMeta!.sharedMissions).toEqual([])
      expect(result!.agentMeta!.outcomes).toEqual([])
    })
  })

  describe("listAll", () => {
    it("returns all friend records from disk", async () => {
      const store = new FileFriendStore(friendsPath)
      const f1 = makeFriend({ id: "uuid-1", name: "Alice" })
      const f2 = makeFriend({ id: "uuid-2", name: "Bob" })

      await store.put("uuid-1", f1)
      await store.put("uuid-2", f2)

      const all = await store.listAll()
      expect(all).toHaveLength(2)
      const names = all.map((r) => r.name).sort()
      expect(names).toEqual(["Alice", "Bob"])
    })

    it("returns empty array when no friends exist", async () => {
      const store = new FileFriendStore(friendsPath)

      const all = await store.listAll()
      expect(all).toEqual([])
    })

    it("returns empty array when friends directory does not exist", async () => {
      const nonExistent = path.join(tmpDir, "nonexistent-dir", "friends")
      // Use a path that won't be auto-created (we need readdir to fail)
      const store = new FileFriendStore(friendsPath)
      // Remove the auto-created directory
      await fs.rm(friendsPath, { recursive: true, force: true })

      const all = await store.listAll()
      expect(all).toEqual([])
    })

    it("skips non-JSON files and malformed JSON", async () => {
      const store = new FileFriendStore(friendsPath)
      const f1 = makeFriend({ id: "uuid-1", name: "Alice" })
      await store.put("uuid-1", f1)

      // Write non-JSON file
      await fs.writeFile(path.join(friendsPath, "readme.txt"), "not a friend record")

      // Write malformed JSON
      await fs.writeFile(path.join(friendsPath, "bad.json"), "not valid json{{{")

      const all = await store.listAll()
      expect(all).toHaveLength(1)
      expect(all[0].name).toBe("Alice")
    })
  })
})
