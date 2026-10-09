import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { overrideTrustedUidForTests } from "../../a2a/trusted-files"
import { overrideFchownForTests } from "../../a2a/operator-trust"
import { escalationGrantsPath, escalationHolders, holdsEscalation, pinnedHolderDid, readEscalationGrants, setEscalationGrant } from "../../a2a/escalation-grants"

let tmp: TmpBundleHandle | null = null
afterEach(() => { tmp?.cleanup(); tmp = null })

const NOW = "2026-10-08T00:00:00.000Z"
const DID = "did:key:z6MkHolderOne"
function friend(id: string, overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id, name: id, role: "friend", trustLevel: "family", admissionState: "active", initiativePolicy: "reactive_only", connections: [], externalIds: [],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: NOW, updatedAt: NOW, schemaVersion: 1, ...overrides,
  }
}
const root = () => { tmp = createTmpBundle({ agentName: `escalation-${Date.now()}` }); return tmp.agentRoot }

describe("escalation grants", () => {
  it("fails closed on a missing, unreadable or malformed file and keeps only well-formed grants", () => {
    const agentRoot = root()
    expect(readEscalationGrants(agentRoot)).toEqual({})
    const file = escalationGrantsPath(agentRoot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "not json")
    expect(readEscalationGrants(agentRoot)).toEqual({})
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, grants: [] }))
    expect(readEscalationGrants(agentRoot)).toEqual({})
    fs.writeFileSync(file, "null")
    expect(readEscalationGrants(agentRoot)).toEqual({})
    const good = { scope: "escalation", grantedAt: NOW, source: "owner", did: DID }
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, grants: {
      ok: good, widened: { ...good, extra: true }, wrongScope: { ...good, scope: "principal_commands" }, badDate: { ...good, grantedAt: "nope" },
      noSource: { ...good, source: " " }, noDid: { scope: "escalation", grantedAt: NOW, source: "owner" }, badDid: { ...good, did: "z6Mk" }, longDid: { ...good, did: `did:${"x".repeat(600)}` }, numberDid: { ...good, did: 5 }, notAnObject: "yes", nullGrant: null, listGrant: [],
    } }))
    expect(readEscalationGrants(agentRoot)).toEqual({ ok: good })
  })

  it("grants and revokes with a backup of the previous file, and reports no-ops without writing", () => {
    const agentRoot = root()
    expect(setEscalationGrant(agentRoot, "peer", { grant: false })).toEqual({ changed: false, backup: null })
    const first = setEscalationGrant(agentRoot, "peer", { grant: true, source: "Ari, test", did: DID }, new Date(NOW))
    expect(first).toEqual({ changed: true, backup: null })
    expect(readEscalationGrants(agentRoot)).toEqual({ peer: { scope: "escalation", grantedAt: NOW, source: "Ari, test", did: DID } })
    expect(fs.statSync(escalationGrantsPath(agentRoot)).mode & 0o777).toBe(0o644)
    expect(setEscalationGrant(agentRoot, "peer", { grant: true, source: "again", did: DID })).toEqual({ changed: false, backup: null })
    // granting the same friend a different DID re-pins it
    expect(setEscalationGrant(agentRoot, "peer", { grant: true, source: "rekeyed", did: "did:key:z6MkHolderTwo" }).changed).toBe(true)
    expect(pinnedHolderDid(agentRoot, "peer")).toBe("did:key:z6MkHolderTwo")
    expect(pinnedHolderDid(agentRoot, "nobody")).toBeNull()
    setEscalationGrant(agentRoot, "peer", { grant: true, source: "Ari, test", did: DID }, new Date(NOW))
    const revoked = setEscalationGrant(agentRoot, "peer", { grant: false }, new Date("2026-10-09T00:00:00.000Z"))
    expect(revoked.changed).toBe(true)
    expect(JSON.parse(fs.readFileSync(revoked.backup!, "utf8")).grants.peer.source).toBe("Ari, test")
    expect(readEscalationGrants(agentRoot)).toEqual({})
  })

  it("is held only by an active family friend the operator listed", async () => {
    const agentRoot = root()
    setEscalationGrant(agentRoot, "claude", { grant: true, source: "owner", did: DID })
    setEscalationGrant(agentRoot, "pending", { grant: true, source: "owner", did: DID })
    setEscalationGrant(agentRoot, "acquaintance", { grant: true, source: "owner", did: DID })
    expect(holdsEscalation(agentRoot, friend("claude"))).toBe(true)
    expect(holdsEscalation(agentRoot, friend("pending", { admissionState: "unverified" }))).toBe(false)
    expect(holdsEscalation(agentRoot, friend("acquaintance", { trustLevel: "friend" }))).toBe(false)
    expect(holdsEscalation(agentRoot, friend("unlisted"))).toBe(false)
    const store = new FileFriendStore(path.join(agentRoot, "friends"))
    for (const record of [friend("claude"), friend("pending", { admissionState: "unverified" }), friend("unlisted")]) await store.put(record.id, record)
    expect((await escalationHolders(agentRoot, store)).map((holder) => holder.id)).toEqual(["claude"])
    const listless = { listAll: undefined } as unknown as FileFriendStore
    expect(await escalationHolders(agentRoot, listless)).toEqual([])
  })
})

describe("escalation grants trust", () => {
  const grant = { scope: "escalation", grantedAt: NOW, source: "owner", did: DID }
  const write = (agentRoot: string, mode: number) => {
    const file = escalationGrantsPath(agentRoot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, grants: { peer: grant } }))
    fs.chmodSync(file, mode)
    return file
  }

  it("reads a file its trusted owner alone can write", () => {
    const agentRoot = root()
    write(agentRoot, 0o644)
    expect(readEscalationGrants(agentRoot)).toEqual({ peer: grant })
  })

  it("ignores a file that group or other can write", () => {
    const agentRoot = root()
    write(agentRoot, 0o664)
    expect(readEscalationGrants(agentRoot)).toEqual({})
    write(agentRoot, 0o646)
    expect(readEscalationGrants(agentRoot)).toEqual({})
  })

  it("ignores a directory that other users can write", () => {
    const agentRoot = root()
    const file = write(agentRoot, 0o644)
    fs.chmodSync(path.dirname(file), 0o777)
    expect(readEscalationGrants(agentRoot)).toEqual({})
  })

  it("ignores a symlinked file", () => {
    const agentRoot = root()
    const file = write(agentRoot, 0o644)
    fs.renameSync(file, `${file}.real`)
    fs.symlinkSync(`${file}.real`, file)
    expect(readEscalationGrants(agentRoot)).toEqual({})
  })

  it("ignores a file owned by anyone but the trusted uid (the Butler's own uid is not trusted)", () => {
    const agentRoot = root()
    write(agentRoot, 0o644)
    overrideTrustedUidForTests(process.getuid!() + 1)
    try {
      expect(readEscalationGrants(agentRoot)).toEqual({})
    } finally {
      overrideTrustedUidForTests(process.getuid!())
    }
  })
})

describe("escalation grants written as root", () => {
  it("creates a missing trust directory and the file root-owned and closed to everyone else, through descriptors", () => {
    const agentRoot = root()
    const dir = path.dirname(escalationGrantsPath(agentRoot))
    const calls: unknown[][] = []
    overrideFchownForTests((_fd, uid, gid) => { calls.push([uid, gid]) })
    const geteuid = vi.spyOn(process, "geteuid").mockReturnValue(0)
    try {
      setEscalationGrant(agentRoot, "claude", { grant: true, source: "test", did: DID })
      // the directory, then the temporary file that becomes the grants file
      expect(calls).toEqual([[0, 0], [0, 0]])
      expect(fs.statSync(dir).mode & 0o777).toBe(0o755)
      expect(fs.statSync(escalationGrantsPath(agentRoot)).mode & 0o777).toBe(0o644)
      expect(fs.readdirSync(dir)).toEqual(["escalation-grants.json"])
    } finally {
      geteuid.mockRestore()
      overrideFchownForTests(undefined)
    }
  })

  it("does not touch ownership when not root", () => {
    const agentRoot = root()
    const calls: unknown[][] = []
    overrideFchownForTests((...args) => { calls.push(args) })
    try {
      setEscalationGrant(agentRoot, "claude", { grant: true, source: "test", did: DID })
      expect(calls).toEqual([])
    } finally { overrideFchownForTests(undefined) }
  })

  it("refuses an existing trust directory the agent could have made, and never takes it over", () => {
    const agentRoot = root()
    const dir = path.dirname(escalationGrantsPath(agentRoot))
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 })
    fs.chmodSync(dir, 0o777)
    expect(() => setEscalationGrant(agentRoot, "claude", { grant: true, source: "test", did: DID })).toThrow("not trusted")
    expect(fs.statSync(dir).mode & 0o777).toBe(0o777)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
