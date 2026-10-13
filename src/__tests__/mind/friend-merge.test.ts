import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FileFriendStore, FriendResolver, type FriendRecord, type FriendStore } from "@ouro.bot/friends"
import { dedupeFriends, externalIdKey, mergeFriendRecordContent, mergeFriends, planFriendDedupe } from "../../mind/friend-merge"

const AAD = { provider: "aad" as const, externalId: "aad-object-1", tenantId: "tenant-1" }

function record(overrides: Partial<FriendRecord> & { id: string }): FriendRecord {
  return {
    name: "Ari",
    role: "family",
    trustLevel: "family",
    connections: [],
    externalIds: [{ provider: "local", externalId: "ari@host.local", linkedAt: "2026-01-01T00:00:00.000Z" }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    kind: "human",
    ...overrides,
  }
}

class MemoryStore implements FriendStore {
  records = new Map<string, FriendRecord>()
  constructor(records: FriendRecord[] = []) {
    for (const item of records) this.records.set(item.id, structuredClone(item))
  }
  async get(id: string) { return structuredClone(this.records.get(id) ?? null) }
  async put(id: string, value: FriendRecord) { this.records.set(id, structuredClone(value)) }
  async delete(id: string) { this.records.delete(id) }
  async findByExternalId() { return null }
  async listAll() { return [...this.records.values()].map((item) => structuredClone(item)) }
}

let friendsDir: string

beforeEach(() => {
  friendsDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "friend-merge-")), "friends")
  fs.mkdirSync(friendsDir)
})

describe("mergeFriendRecordContent", () => {
  it("keeps the target's relationship and folds in the sources' identities and history", () => {
    const target = record({
      id: "target",
      trustLevel: "acquaintance",
      notes: { name: { value: "Ari", savedAt: "t" }, tone: { value: "brief", savedAt: "t" } },
      tenantMemberships: ["t1"],
      toolPreferences: { ado: "target" },
      connections: [{ name: "Sam", relationship: "friend" }],
      importedNotes: { agentA: { k: { value: "target", importedAt: "t" } } },
      totalTokens: 10,
      createdAt: "2026-02-01T00:00:00.000Z",
    })
    const source = record({
      id: "source-1234567890",
      trustLevel: "family",
      externalIds: [...target.externalIds, { ...AAD, linkedAt: "2026-03-01T00:00:00.000Z" }],
      notes: { name: { value: "Ari", savedAt: "s" }, tone: { value: "chatty", savedAt: "s" }, work: { value: "Ouro", savedAt: "s" } },
      tenantMemberships: ["t1", "t2"],
      toolPreferences: { ado: "source", github: "source" },
      connections: [{ name: "Sam", relationship: "friend" }, { name: "Lee", relationship: "sibling" }],
      importedNotes: { agentA: { k: { value: "source", importedAt: "s" }, j: { value: "only-source", importedAt: "s" } }, agentB: { x: { value: "b", importedAt: "s" } } },
      totalTokens: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const second = record({ id: "second-abcdefgh", notes: { tone: { value: "dry", savedAt: "x" } }, createdAt: "2026-05-01T00:00:00.000Z" })
    const third = record({ id: "second-abcdefgh-dup", notes: { tone: { value: "other", savedAt: "x" } } })
    const { merged, addedExternalIds, preservedNoteKeys } = mergeFriendRecordContent(target, [source, second, third], "2026-06-01T00:00:00.000Z")

    expect(merged.trustLevel).toBe("acquaintance")
    expect(merged.externalIds.map(externalIdKey)).toEqual([target.externalIds[0], { ...AAD, linkedAt: "x" }].map(externalIdKey))
    expect(addedExternalIds).toHaveLength(1)
    expect(merged.notes.tone!.value).toBe("brief")
    expect(merged.notes["tone~source-1"]!.value).toBe("chatty")
    expect(merged.notes["tone~second-a"]!.value).toBe("dry")
    expect(merged.notes.work!.value).toBe("Ouro")
    // A second collision on the same preserved key keeps the first preserved value.
    expect(preservedNoteKeys).toEqual(["tone~source-1", "tone~second-a"])
    expect(merged.tenantMemberships).toEqual(["t1", "t2"])
    expect(merged.toolPreferences).toEqual({ ado: "target", github: "source" })
    expect(merged.connections).toEqual([{ name: "Sam", relationship: "friend" }, { name: "Lee", relationship: "sibling" }])
    expect(merged.importedNotes!.agentA!.k!.value).toBe("target")
    expect(merged.importedNotes!.agentA!.j!.value).toBe("only-source")
    expect(merged.importedNotes!.agentB!.x!.value).toBe("b")
    expect(merged.totalTokens).toBe(15)
    expect(merged.createdAt).toBe("2026-01-01T00:00:00.000Z")
    expect(merged.updatedAt).toBe("2026-06-01T00:00:00.000Z")
  })

  it("handles records without connections or imported notes", () => {
    const target = record({ id: "target", connections: undefined })
    const source = record({ id: "source", connections: undefined })
    const { merged } = mergeFriendRecordContent(target, [source], "2026-06-01T00:00:00.000Z")
    expect(merged.connections).toEqual([])
    expect(merged.importedNotes).toBeUndefined()
  })
})

describe("mergeFriends", () => {
  it("refuses empty, self-referencing, missing and mismatched merges", async () => {
    const store = new MemoryStore([record({ id: "a" }), record({ id: "agent", kind: "agent" }), record({ id: "unkinded", kind: undefined })])
    const base = { store, friendsDir, actor: "test", reason: "test" }
    expect(await mergeFriends({ ...base, targetId: "a", sourceIds: [] })).toMatchObject({ ok: false, reason: "invalid_sources" })
    expect(await mergeFriends({ ...base, targetId: "a", sourceIds: ["a"] })).toMatchObject({ ok: false, reason: "invalid_sources" })
    expect(await mergeFriends({ ...base, targetId: "missing", sourceIds: ["a"] })).toMatchObject({ ok: false, reason: "target_not_found" })
    expect(await mergeFriends({ ...base, targetId: "a", sourceIds: ["missing"] })).toMatchObject({ ok: false, reason: "source_not_found" })
    expect(await mergeFriends({ ...base, targetId: "a", sourceIds: ["agent"] })).toMatchObject({ ok: false, reason: "kind_mismatch" })
    expect(await mergeFriends({ ...base, targetId: "unkinded", sourceIds: ["agent"] })).toMatchObject({ ok: false, reason: "kind_mismatch" })
    // A record without a kind is human.
    expect(await mergeFriends({ ...base, targetId: "a", sourceIds: ["unkinded"], dryRun: true })).toMatchObject({ ok: true })
  })

  it("previews without writing anything", async () => {
    const store = new MemoryStore([record({ id: "a" }), record({ id: "b", notes: { x: { value: "1", savedAt: "t" } } })])
    const result = await mergeFriends({ store, friendsDir, targetId: "a", sourceIds: ["b", "b"], actor: "test", reason: "test", dryRun: true })
    expect(result).toMatchObject({ ok: true, dryRun: true })
    if (!result.ok) throw new Error("expected ok")
    expect(result.target.notes.x!.value).toBe("1")
    expect(result.retired).toEqual([{ friendId: "b", name: "Ari", tombstonePath: path.join(friendsDir, "_retired", "b.json"), movedClaims: [] }])
    expect(store.records.has("b")).toBe(true)
    expect(fs.existsSync(path.join(friendsDir, "_retired"))).toBe(false)
  })

  it("retires sources as tombstones, moves only their claim journals and skips unreadable ones", async () => {
    const store = new MemoryStore([record({ id: "a" }), record({ id: "b" })])
    const claimsDir = path.join(friendsDir, "_external-id-claims")
    fs.mkdirSync(claimsDir)
    const own = `${"a".repeat(64)}.json`
    const other = `${"b".repeat(64)}.json`
    const broken = `${"c".repeat(64)}.json`
    fs.writeFileSync(path.join(claimsDir, own), JSON.stringify({ friendId: "b" }))
    fs.writeFileSync(path.join(claimsDir, other), JSON.stringify({ friendId: "someone-else" }))
    fs.writeFileSync(path.join(claimsDir, broken), "{")
    fs.writeFileSync(path.join(claimsDir, "notes.txt"), "ignored")
    // An earlier tombstone for the same id is kept; the new one gets a timestamped name.
    fs.mkdirSync(path.join(friendsDir, "_retired"))
    fs.writeFileSync(path.join(friendsDir, "_retired", "b.json"), "{}")

    const result = await mergeFriends({ store, friendsDir, targetId: "a", sourceIds: ["b"], actor: "test", reason: "dupes", now: () => new Date("2026-06-01T00:00:00.000Z") })
    if (!result.ok) throw new Error("expected ok")
    expect(store.records.has("b")).toBe(false)
    expect(result.retired[0]!.movedClaims).toEqual([own])
    expect(fs.existsSync(path.join(friendsDir, "_retired", "external-id-claims", own))).toBe(true)
    expect(fs.existsSync(path.join(claimsDir, other))).toBe(true)
    expect(fs.existsSync(path.join(claimsDir, broken))).toBe(true)
    const tombstone = JSON.parse(fs.readFileSync(result.retired[0]!.tombstonePath, "utf-8"))
    expect(result.retired[0]!.tombstonePath).toBe(path.join(friendsDir, "_retired", "b.2026-06-01T00-00-00-000Z.json"))
    expect(tombstone).toMatchObject({ retiredInto: "a", actor: "test", reason: "dupes", record: { id: "b" } })
  })

  it("returns the merged record when the store cannot read it back", async () => {
    const store = new MemoryStore([record({ id: "a" }), record({ id: "b" })])
    const realGet = store.get.bind(store)
    let reads = 0
    store.get = async (id: string) => (id === "a" && ++reads > 1 ? null : realGet(id))
    const result = await mergeFriends({ store, friendsDir, targetId: "a", sourceIds: ["b"], actor: "test", reason: "test" })
    expect(result).toMatchObject({ ok: true, target: { id: "a" } })
  })

  it("moves a claimed Teams identity onto the family record so the resolver finds family", async () => {
    const store = new FileFriendStore(friendsDir)
    const family = record({ id: "family-ari", notes: { name: { value: "Ari", savedAt: "t" } } })
    await store.put(family.id, family)
    // How a Teams message from an unknown AAD user creates its stranger record.
    const teamsResolver = () => new FriendResolver(store, { provider: "aad", externalId: AAD.externalId, tenantId: AAD.tenantId, displayName: "Ari Mendelow", channel: "teams" })
    const stranger = (await teamsResolver().resolve()).friend
    expect(stranger.trustLevel).toBe("stranger")
    expect(fs.readdirSync(path.join(friendsDir, "_external-id-claims"))).toHaveLength(1)

    const result = await mergeFriends({ store, friendsDir, targetId: family.id, sourceIds: [stranger.id], actor: "test", reason: "link" })
    if (!result.ok) throw new Error("expected ok")
    expect(fs.readdirSync(path.join(friendsDir, "_external-id-claims"))).toHaveLength(0)
    expect(await store.get(stranger.id)).toBeNull()

    const resolved = (await teamsResolver().resolve()).friend
    expect(resolved.id).toBe(family.id)
    expect(resolved.trustLevel).toBe("family")
    expect(resolved.externalIds.some((externalId) => externalId.provider === "aad" && externalId.tenantId === AAD.tenantId)).toBe(true)
    expect((await store.listAll()).map((item) => item.id)).toEqual([family.id])
  })
})

describe("friend dedupe", () => {
  it("groups same-name, same-trust, local-only records joined by a shared identity", () => {
    const local = (id: string) => [{ provider: "local" as const, externalId: id, linkedAt: "t" }]
    const records = [
      record({ id: "dup-new", createdAt: "2026-09-01T00:00:00.000Z", notes: { name: { value: "Ari", savedAt: "t" } } }),
      record({ id: "canonical", createdAt: "2026-03-01T00:00:00.000Z", notes: { a: { value: "1", savedAt: "t" }, b: { value: "2", savedAt: "t" } } }),
      record({ id: "dup-b", createdAt: "2026-09-01T00:00:00.000Z", name: " ari " }),
      record({ id: "dup-a", createdAt: "2026-09-01T00:00:00.000Z" }),
      record({ id: "chain", externalIds: [...local("ari@host.local"), ...local("ari@other")] }),
      record({ id: "chain-tail", externalIds: local("ari@other") }),
      record({ id: "other-person", externalIds: local("someone@host") }),
      record({ id: "stranger-ari", trustLevel: "stranger" }),
      record({ id: "teams-ari", externalIds: [{ ...AAD, linkedAt: "t" }] }),
      record({ id: "no-ids", externalIds: [] }),
      record({ id: "agent-ari", kind: "agent" }),
      record({ id: "kindless", kind: undefined, trustLevel: undefined, name: "Sam", externalIds: local("sam@host") }),
      record({ id: "kindless-2", kind: undefined, trustLevel: "friend", name: "Sam", externalIds: local("sam@host") }),
    ]
    const groups = planFriendDedupe(records)
    expect(groups.map((group) => [group.canonical.id, group.duplicates.map((item) => item.id)])).toEqual([
      ["canonical", ["dup-new", "chain", "chain-tail", "dup-a", "dup-b"]],
      ["kindless", ["kindless-2"]],
    ])
  })

  it("prefers the oldest record when note counts tie", () => {
    const groups = planFriendDedupe([
      record({ id: "z-old", createdAt: "2026-01-01T00:00:00.000Z" }),
      record({ id: "a-new", createdAt: "2026-02-01T00:00:00.000Z" }),
      record({ id: "m-mid", createdAt: "2026-01-15T00:00:00.000Z" }),
    ])
    expect(groups[0]!.canonical.id).toBe("z-old")
    expect(groups[0]!.duplicates.map((item) => item.id)).toEqual(["m-mid", "a-new"])
  })

  it("previews by default, applies on request and is idempotent", async () => {
    const store = new MemoryStore([
      record({ id: "canonical", notes: { a: { value: "1", savedAt: "t" } } }),
      record({ id: "dup-1", notes: { a: { value: "2", savedAt: "t" } } }),
      record({ id: "dup-2" }),
    ])
    const preview = await dedupeFriends({ store, friendsDir, actor: "test" })
    expect(preview).toMatchObject({ dryRun: true, groups: [{ duplicateIds: ["dup-1", "dup-2"], preservedNoteKeys: ["a~dup-1"] }] })
    expect(store.records.size).toBe(3)

    const applied = await dedupeFriends({ store, friendsDir, actor: "test", dryRun: false, now: () => new Date("2026-06-01T00:00:00.000Z") })
    expect(applied.dryRun).toBe(false)
    expect([...store.records.keys()]).toEqual(["canonical"])
    expect(store.records.get("canonical")!.notes["a~dup-1"]!.value).toBe("2")

    expect((await dedupeFriends({ store, friendsDir, actor: "test", dryRun: false })).groups).toEqual([])
  })

  it("finds nothing in a store that cannot list", async () => {
    const store = new MemoryStore([record({ id: "a" }), record({ id: "b" })])
    const unlistable: FriendStore = { get: store.get.bind(store), put: store.put.bind(store), delete: store.delete.bind(store), findByExternalId: store.findByExternalId.bind(store) }
    expect((await dedupeFriends({ store: unlistable, friendsDir, actor: "test" })).groups).toEqual([])
  })
})
