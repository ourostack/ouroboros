import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FileFriendStore, upsertAgentPeer, type FriendRecord } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { overrideOwnerForTests } from "../../a2a/trusted-files"
import { operatorTrustDir } from "../../a2a/operator-trust"
import { delegatedCommandGrantsPath, readDelegatedCommandGrants, setDelegatedCommandGrant } from "../../a2a/delegated-command-grants"
import { escalationGrantsPath, readEscalationGrants } from "../../a2a/escalation-grants"
import { executeDelegatedCommandsCommand, executeEscalationCommand, type TrustCommandContext } from "../../a2a/trust-commands"

const DID = "did:key:z6MkPeerOne"
const NOW = new Date("2026-10-09T12:00:00.000Z")
let tmp: TmpBundleHandle
let store: FileFriendStore
beforeEach(() => { tmp = createTmpBundle({ agentName: `trustcmd-${Date.now()}` }); store = new FileFriendStore(path.join(tmp.agentRoot, "friends")) })
afterEach(() => { overrideOwnerForTests(undefined); tmp.cleanup() })

async function peer(options: { name?: string; did?: string | null; trust?: "family" | "friend"; admission?: "active" | "unverified"; legacy?: boolean } = {}): Promise<FriendRecord> {
  const did = options.did === undefined ? DID : options.did
  const created = await upsertAgentPeer(store, { name: options.name ?? "Claude Code", agentId: did ?? "no-did", trustLevel: options.trust ?? "family", ...(did ? { a2a: { did, agentId: did, endpointUrl: "https://x.example/a2a" } } : {}) })
  const record: FriendRecord = { ...created, admissionState: options.admission ?? "active", ...(options.legacy ? { delegationGrant: { scope: "principal_commands", grantedAt: "2026-10-01T00:00:00.000Z", source: "agent-written" } } : {}) }
  if (did === null) delete (record as { agentMeta?: unknown }).agentMeta
  await store.put(record.id, record)
  return record
}
const ctx = (overrides: Partial<TrustCommandContext> = {}): TrustCommandContext => ({
  agentName: "sanctuary", agentRoot: tmp.agentRoot, store, now: NOW, isRoot: true, ownDid: async () => "did:key:z6MkSanctuarySelf", ...overrides,
})
const grant = (friend: string, extra: Partial<Parameters<typeof executeDelegatedCommandsCommand>[0]> = {}, c: Partial<TrustCommandContext> = {}) =>
  executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "grant", friendId: friend, did: DID, ...extra } as never, ctx(c))

describe("delegated-commands grant, edge cases", () => {
  it("refuses a missing --did by name", async () => {
    const friend = await peer()
    await expect(grant(friend.id, { did: undefined })).rejects.toThrow("(missing) is not a DID")
  })

  it("warns when the written grant would not be honoured", async () => {
    const friend = await peer()
    overrideOwnerForTests((target) => (target.endsWith("delegated-command-grants.json") ? process.getuid!() + 1 : undefined))
    expect(await grant(friend.id)).toContain("WARNING: the grant is written but will not be honoured")
  })

  it("works against a store that cannot list, treating it as empty", async () => {
    const friend = await peer()
    const noList = { get: store.get.bind(store) } as never
    expect(await grant(friend.id, {}, { store: noList, ownDid: async () => null })).toContain("could not read this agent's own DID")
    expect(await executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "list" } as never, ctx({ store: noList }))).toContain(friend.id)
  })

  it("says a granted friend record without a DID names no DID", async () => {
    const friend = await peer()
    setDelegatedCommandGrant(tmp.agentRoot, friend.id, { grant: true, did: DID, source: "Ari" })
    const bare = { ...friend } as { a2a?: unknown; agentMeta?: unknown }
    delete bare.a2a
    delete bare.agentMeta
    await store.put(friend.id, bare as FriendRecord)
    expect(await executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "list" } as never, ctx())).toContain(`names no DID, but the grant pins ${DID}`)
  })
})

describe("delegated-commands grant", () => {
  it("writes a trusted grant pinned to the DID, and says what it did", async () => {
    const friend = await peer()
    const out = await grant(friend.id, { expires: "2030-01-01T00:00:00Z", source: "Ari, in person" })
    expect(out).toContain(`granted delegated commands: Claude Code (${friend.id})`)
    expect(out).toContain(`pinned DID: ${DID}`)
    expect(out).toContain("expires: 2030-01-01T00:00:00.000Z")
    expect(readDelegatedCommandGrants(tmp.agentRoot)[friend.id]).toEqual({ scope: "principal_commands", did: DID, grantedAt: NOW.toISOString(), source: "Ari, in person", expiresAt: "2030-01-01T00:00:00.000Z" })
    expect(await grant(friend.id, { expires: "2030-01-01T00:00:00Z", source: "Ari, in person" })).toContain("(no change)")
  })

  it("defaults the source and says there is no expiry", async () => {
    const friend = await peer()
    const out = await grant(friend.id)
    expect(out).toContain("expires: never")
    expect(readDelegatedCommandGrants(tmp.agentRoot)[friend.id]!.source).toBe("ouro a2a delegated-commands grant, 2026-10-09T12:00:00.000Z")
  })

  it("keeps a backup when it replaces a file", async () => {
    const friend = await peer()
    await grant(friend.id)
    const out = await grant(friend.id, { expires: "2030-01-01T00:00:00Z" })
    expect(out).toContain(`backup: ${delegatedCommandGrantsPath(tmp.agentRoot)}.bak-`)
  })

  it("grants anyway, with a note, when the friend is not active family", async () => {
    const friend = await peer({ trust: "friend", admission: "unverified" })
    const out = await grant(friend.id)
    expect(out).toContain("note: Claude Code is friend, unverified, so the grant stays suspended until it is active family")
    expect(readDelegatedCommandGrants(tmp.agentRoot)[friend.id]).toBeDefined()
  })

  describe("refuses, and writes nothing, when", () => {
    const untouched = () => expect(fs.existsSync(operatorTrustDir(tmp.agentRoot))).toBe(false)

    it("it is not run as root", async () => {
      const friend = await peer()
      await expect(grant(friend.id, {}, { isRoot: false })).rejects.toThrow("must run as root")
      untouched()
    })

    it("the DID is not a did", async () => {
      const friend = await peer()
      await expect(grant(friend.id, { did: "z6MkNotADid" })).rejects.toThrow("not a DID")
      untouched()
    })

    it("the friend is unknown", async () => {
      await expect(grant("nobody")).rejects.toThrow("friend not found: nobody")
      untouched()
    })

    it("the record has no DID", async () => {
      const friend = await peer({ did: null })
      await expect(grant(friend.id)).rejects.toThrow("has no DID on record")
      untouched()
    })

    it("--did differs from the record's DID", async () => {
      const friend = await peer()
      await expect(grant(friend.id, { did: "did:key:z6MkOther" })).rejects.toThrow(`does not match the DID on Claude Code's record (${DID})`)
      untouched()
    })

    it("--did is this agent's own DID", async () => {
      const friend = await peer()
      await expect(grant(friend.id, {}, { ownDid: async () => DID })).rejects.toThrow("this agent's own DID")
      untouched()
    })

    it("another friend's grant already pins the DID", async () => {
      const first = await peer({ name: "First" })
      await grant(first.id)
      const twin: FriendRecord = { ...first, id: "twin-record", name: "Twin" }
      await store.put(twin.id, twin)
      await expect(grant(twin.id)).rejects.toThrow(`already pinned by ${first.id}`)
      expect(Object.keys(readDelegatedCommandGrants(tmp.agentRoot))).toEqual([first.id])
    })

    it("--expires is not a time in the future", async () => {
      const friend = await peer()
      await expect(grant(friend.id, { expires: "tomorrow-ish" })).rejects.toThrow("--expires")
      await expect(grant(friend.id, { expires: "2020-01-01T00:00:00Z" })).rejects.toThrow("--expires")
      untouched()
    })

    it("the trust directory exists but is not trusted, and does not change it", async () => {
      const friend = await peer()
      const dir = operatorTrustDir(tmp.agentRoot)
      fs.mkdirSync(dir, { recursive: true })
      fs.chmodSync(dir, 0o777)
      await expect(grant(friend.id)).rejects.toThrow("not trusted")
      expect(fs.statSync(dir).mode & 0o777).toBe(0o777)
      expect(fs.readdirSync(dir)).toEqual([])
    })
  })

  it("proceeds when the agent's own DID cannot be determined", async () => {
    const friend = await peer()
    expect(await grant(friend.id, {}, { ownDid: async () => null })).toContain("granted delegated commands")
  })
})

describe("delegated-commands revoke", () => {
  it("removes the trusted grant but never writes the friend record as root, and always prints the follow-up that clears the legacy field as the resident user", async () => {
    const friend = await peer({ legacy: true })
    await grant(friend.id)
    const puts: string[] = []
    const spy = Object.create(store) as FileFriendStore
    spy.put = async (id: string, record: FriendRecord) => { puts.push(id); await store.put(id, record) }
    const out = await executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "revoke", friendId: friend.id }, ctx({ store: spy }))
    expect(puts).toEqual([])
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual({})
    expect(out).toContain(`revoked delegated commands: Claude Code (${friend.id})`)
    expect(out).toContain("REQUIRED FOLLOW-UP")
    expect(out).toContain("docker exec -u 10001 ouro-butler node -e")
    expect(out).toContain(`${tmp.agentRoot}/friends/${friend.id}.json`)
    expect(out).toContain("backup: ")
    expect(out).not.toContain("cleared the legacy delegationGrant")
    expect((await store.get(friend.id))!.delegationGrant).toBeDefined()
  })

  it("prints the follow-up for a legacy record grant even when there is no trusted grant, and reports no change otherwise", async () => {
    const legacy = await peer({ legacy: true })
    const out = await executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "revoke", friendId: legacy.id }, ctx())
    expect(out).toContain("REQUIRED FOLLOW-UP")
    expect(out).not.toContain("(no change)")
    const plain = await peer({ name: "Plain", did: "did:key:z6MkPlain" })
    expect(await executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "revoke", friendId: plain.id }, ctx())).toContain("(no change)")
  })

  it("revokes a grant whose friend record is gone, by id", async () => {
    setDelegatedCommandGrant(tmp.agentRoot, "ghost", { grant: true, did: DID, source: "x" })
    const out = await executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "revoke", friendId: "ghost" }, ctx())
    expect(out).toContain("revoked delegated commands: ghost (no friend record)")
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual({})
  })

  it("refuses when not root", async () => {
    await expect(executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "revoke", friendId: "x" }, ctx({ isRoot: false }))).rejects.toThrow("must run as root")
  })
})

describe("delegated-commands list", () => {
  const list = (json = false, c: Partial<TrustCommandContext> = {}) => executeDelegatedCommandsCommand({ kind: "a2a.delegatedCommands", action: "list", ...(json ? { json: true } : {}) }, ctx({ isRoot: false, ...c }))

  it("says there are no grants, without root", async () => {
    expect(await list()).toContain(`not present: ${delegatedCommandGrantsPath(tmp.agentRoot)}`)
    expect(await list()).toContain("no delegated-command grants")
  })

  it("shows each grant as HONOURED, SUSPENDED or NOT HONOURED from the shared check, and lists legacy record grants", async () => {
    const good = await peer({ name: "Good" })
    const suspended = await peer({ name: "Suspended", did: "did:key:z6MkSusp", trust: "friend" })
    const rotated = await peer({ name: "Rotated", did: "did:key:z6MkRotatedNew" })
    const legacy = await peer({ name: "Legacy", did: "did:key:z6MkLegacy", legacy: true })
    setDelegatedCommandGrant(tmp.agentRoot, good.id, { grant: true, did: DID, source: "Ari" })
    setDelegatedCommandGrant(tmp.agentRoot, suspended.id, { grant: true, did: "did:key:z6MkSusp", source: "Ari", expiresAt: "2030-01-01T00:00:00.000Z" })
    setDelegatedCommandGrant(tmp.agentRoot, rotated.id, { grant: true, did: "did:key:z6MkRotatedOld", source: "Ari" })
    setDelegatedCommandGrant(tmp.agentRoot, "ghost", { grant: true, did: "did:key:z6MkGhost", source: "Ari", expiresAt: "2020-01-01T00:00:00.000Z" })
    const text = await list()
    expect(text).toContain(`trusted: ${delegatedCommandGrantsPath(tmp.agentRoot)}`)
    expect(text).toMatch(new RegExp(`${good.id}  Good[^]*?HONOURED`, "u"))
    expect(text).toContain("SUSPENDED: Suspended is trust friend, admission active; the grant is kept and applies again once it is family and active")
    expect(text).toContain("NOT HONOURED: the friend record names did:key:z6MkRotatedNew, but the grant pins did:key:z6MkRotatedOld")
    expect(text).toContain("NOT HONOURED: no friend record for ghost")
    expect(text).toContain(`legacy friend-record grants (not honoured): Legacy (${legacy.id})`)

    const json = JSON.parse(await list(true))
    expect(json.file).toEqual({ path: delegatedCommandGrantsPath(tmp.agentRoot), state: "trusted" })
    const byId = Object.fromEntries(json.grants.map((entry: { friendId: string }) => [entry.friendId, entry]))
    expect(byId[good.id]).toMatchObject({ name: "Good", did: DID, status: "honoured" })
    expect(byId[suspended.id]).toMatchObject({ status: "suspended" })
    expect(byId[rotated.id]).toMatchObject({ status: "not_honoured", reason: "grant_did_mismatch" })
    expect(byId.ghost).toMatchObject({ status: "not_honoured", reason: "no_friend_record" })
    expect(json.legacyRecordGrants).toEqual([{ friendId: legacy.id, name: "Legacy" }])
  })

  it("reports an expired grant as not honoured", async () => {
    const friend = await peer()
    setDelegatedCommandGrant(tmp.agentRoot, friend.id, { grant: true, did: DID, source: "Ari", expiresAt: "2026-10-09T11:00:00.000Z" })
    expect(await list()).toContain("NOT HONOURED: the grant is not in force: it expired")
  })

  it("flags an untrusted file and honours nothing in it", async () => {
    const friend = await peer()
    setDelegatedCommandGrant(tmp.agentRoot, friend.id, { grant: true, did: DID, source: "Ari" })
    fs.chmodSync(delegatedCommandGrantsPath(tmp.agentRoot), 0o666)
    const text = await list()
    expect(text).toContain("NOT TRUSTED")
    expect(text).toContain("no grant in it is honoured")
    expect(JSON.parse(await list(true)).file).toMatchObject({ state: "untrusted", reason: expect.any(String) })
  })

  it("lists entries the file holds but the harness ignores", async () => {
    const dir = operatorTrustDir(tmp.agentRoot)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(delegatedCommandGrantsPath(tmp.agentRoot), JSON.stringify({ schemaVersion: 1, grants: { broken: { scope: "nope" } } }), { mode: 0o644 })
    expect(await list()).toContain("ignored (malformed) entries: broken")
    expect(JSON.parse(await list(true)).ignoredEntries).toEqual(["broken"])
  })
})

describe("when the agent's own DID cannot be read", () => {
  const unknownSelf = { ownDid: async () => null }
  it("still grants, says the own-DID check was skipped, and compares --did with every DID on file", async () => {
    const friend = await peer()
    const out = await grant(friend.id, {}, unknownSelf)
    expect(out).toContain("could not read this agent's own DID")
    expect(out).toContain("compared --did with every DID in the friend records")
    expect(readDelegatedCommandGrants(tmp.agentRoot)[friend.id]?.did).toBe(DID)
  })

  it("refuses a DID that another friend record also carries, since it may be this agent's own key", async () => {
    const friend = await peer()
    await store.put("twin", { ...friend, id: "twin", name: "Other record" })
    await expect(grant(friend.id, {}, unknownSelf)).rejects.toThrow(/another friend record.*Other record/s)
    await expect(executeEscalationCommand({ kind: "a2a.escalation", action: "grant", friendId: friend.id, did: DID } as never, ctx(unknownSelf))).rejects.toThrow("another friend record")
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual({})
  })
})

describe("escalation grant and revoke", () => {
  const esc = (action: "grant" | "revoke" | "list", friendId: string | undefined, extra: Record<string, unknown> = {}, c: Partial<TrustCommandContext> = {}) =>
    executeEscalationCommand({ kind: "a2a.escalation", action, ...(friendId ? { friendId } : {}), ...extra } as never, ctx(c))

  it("requires root and a --did that matches the record, then writes into the trust directory", async () => {
    const friend = await peer()
    await expect(esc("grant", friend.id, { did: DID }, { isRoot: false })).rejects.toThrow("must run as root")
    await expect(esc("grant", friend.id, { did: "z6Mk" })).rejects.toThrow("not a DID")
    await expect(esc("grant", friend.id, { did: "did:key:z6MkOther" })).rejects.toThrow("does not match")
    expect(fs.existsSync(operatorTrustDir(tmp.agentRoot))).toBe(false)
    const out = await esc("grant", friend.id, { did: DID, source: "Ari, test" })
    expect(out).toContain(`granted escalation: Claude Code (${friend.id})`)
    expect(out).toContain(`pinned DID: ${DID}`)
    expect(readEscalationGrants(tmp.agentRoot)[friend.id]).toMatchObject({ did: DID, source: "Ari, test" })
    expect(escalationGrantsPath(tmp.agentRoot).startsWith(operatorTrustDir(tmp.agentRoot))).toBe(true)
  })

  it("refuses a record with no DID, an unknown friend and a missing --did, and notes a friend that is not active family", async () => {
    const noDid = await peer({ did: null })
    await expect(esc("grant", noDid.id, { did: DID })).rejects.toThrow("has no DID on record")
    await expect(esc("grant", "nobody", { did: DID })).rejects.toThrow("friend not found: nobody")
    const unverified = await peer({ name: "Pending", did: "did:key:z6MkPending", trust: "friend", admission: "unverified" })
    expect(await esc("grant", unverified.id, { did: "did:key:z6MkPending" })).toContain("only holds the grant while it is active family (now friend, unverified)")
  })

  it("revokes with a backup and lists", async () => {
    const friend = await peer()
    expect(await esc("list", undefined, {}, { isRoot: false })).toContain("no escalation grants")
    await esc("grant", friend.id, { did: DID })
    expect(await esc("list", undefined, {}, { isRoot: false })).toContain(`${friend.id}  granted 2026-10-09T12:00:00.000Z  ${DID}`)
    const revoked = await esc("revoke", friend.id)
    expect(revoked).toContain(`revoked escalation: Claude Code (${friend.id})`)
    expect(revoked).toContain("backup: ")
    await expect(esc("revoke", friend.id, {}, { isRoot: false })).rejects.toThrow("must run as root")
  })

  it("refuses this agent's own DID and a DID another holder already has", async () => {
    const friend = await peer()
    await expect(esc("grant", friend.id, { did: DID }, { ownDid: async () => DID })).rejects.toThrow("this agent's own DID")
    await esc("grant", friend.id, { did: DID })
    await store.put("clash", { ...friend, id: "clash", name: "Clash" })
    await expect(esc("grant", "clash", { did: DID })).rejects.toThrow(`already pinned by ${friend.id}'s grant`)
    expect(Object.keys(readEscalationGrants(tmp.agentRoot))).toEqual([friend.id])
  })

  it("revokes a grant whose friend record is gone, by id", async () => {
    const friend = await peer()
    await esc("grant", friend.id, { did: DID })
    fs.rmSync(path.join(tmp.agentRoot, "friends", `${friend.id}.json`))
    const out = await esc("revoke", friend.id)
    expect(out).toContain(`revoked escalation: ${friend.id} (no friend record)`)
    expect(readEscalationGrants(tmp.agentRoot)).toEqual({})
    expect(await esc("revoke", friend.id)).toContain("(no change)")
  })

  it("keeps a backup when an escalation grant is replaced, and flags an untrusted file in the list", async () => {
    const friend = await peer()
    await esc("grant", friend.id, { did: DID })
    const other = await peer({ name: "Other", did: "did:key:z6MkOther" })
    expect(await esc("grant", other.id, { did: "did:key:z6MkOther" })).toContain(`backup: ${escalationGrantsPath(tmp.agentRoot)}.bak-`)
    fs.chmodSync(escalationGrantsPath(tmp.agentRoot), 0o666)
    expect(await esc("list", undefined, {}, { isRoot: false })).toContain("NOT TRUSTED")
  })

  it("warns when the written grant would not be honoured", async () => {
    const friend = await peer()
    overrideOwnerForTests((target) => (target.endsWith("escalation-grants.json") ? process.getuid!() + 1 : undefined))
    const out = await esc("grant", friend.id, { did: DID })
    expect(out).toContain("WARNING: the grant is written but will not be honoured")
  })
})
