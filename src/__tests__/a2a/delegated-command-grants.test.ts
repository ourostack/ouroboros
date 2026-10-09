import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mockOwners } from "../test-helpers/replay-owners"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))
import type { FriendRecord } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { overrideOwnerForTests } from "../../a2a/trusted-files"
import {
  checkDelegatedCommandGrant, delegatedCommandGrantsPath, readDelegatedCommandGrants, setDelegatedCommandGrant, viewDelegatedCommandGrants,
} from "../../a2a/delegated-command-grants"
import { replayIdentitiesPath, replayWindowPath } from "../../a2a/replay-harness"

const NOW = Date.parse("2026-10-09T00:00:00.000Z")
const ISO = new Date(NOW).toISOString()
const DID = "did:key:z6MkPeerOne"
let tmp: TmpBundleHandle
beforeEach(() => { tmp = createTmpBundle({ agentName: `grants-${Date.now()}` }) })
afterEach(() => { overrideOwnerForTests(undefined); tmp.cleanup() })

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "peer", name: "Peer", role: "family", trustLevel: "family", admissionState: "active", initiativePolicy: "reactive_only", connections: [], externalIds: [],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: ISO, updatedAt: ISO, schemaVersion: 1, ...overrides,
  }
}
const entry = (overrides: Record<string, unknown> = {}) => ({ scope: "principal_commands", did: DID, grantedAt: ISO, source: "operator", ...overrides })
function writeFile(grants: unknown, mode = 0o644, schemaVersion: unknown = 1): string {
  const file = delegatedCommandGrantsPath(tmp.agentRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 })
  fs.writeFileSync(file, JSON.stringify({ schemaVersion, grants }))
  fs.chmodSync(file, mode)
  return file
}
const check = (record: FriendRecord = friend(), signer = DID, at = NOW) => checkDelegatedCommandGrant(tmp.agentRoot, record, signer, at)

describe("reading the delegated-command grants file", () => {
  it("keeps only exact-shape grants and lists the friends whose entries were dropped", () => {
    writeFile({
      ok: entry(), withExpiry: entry({ expiresAt: "2030-01-01T00:00:00.000Z" }), extraKey: entry({ extra: true }), wrongScope: entry({ scope: "escalation" }), noDid: entry({ did: undefined }),
      badDid: entry({ did: "z6Mk" }), longDid: entry({ did: `did:${"x".repeat(600)}` }), badDate: entry({ grantedAt: "nope" }), noSource: entry({ source: " " }),
      numberExpiry: entry({ expiresAt: 5 }), notAnObject: "yes", nullGrant: null, listGrant: [],
    })
    const view = viewDelegatedCommandGrants(tmp.agentRoot)
    expect(view.state).toBe("trusted")
    expect(Object.keys(view.grants).sort()).toEqual(["ok", "withExpiry"])
    expect(view.ignored.sort()).toEqual(["badDate", "badDid", "extraKey", "listGrant", "longDid", "noDid", "noSource", "notAnObject", "nullGrant", "numberExpiry", "wrongScope"])
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual(view.grants)
  })

  it.each([
    ["a wrong schema version", () => writeFile({ peer: entry() }, 0o644, 2)],
    ["a grants list", () => writeFile([entry()])],
    ["a group-writable file", () => writeFile({ peer: entry() }, 0o664)],
  ])("treats %s as untrusted", (_name, make) => {
    make()
    expect(viewDelegatedCommandGrants(tmp.agentRoot).state).toBe("untrusted")
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual({})
  })

  it("reads no file as missing", () => {
    expect(viewDelegatedCommandGrants(tmp.agentRoot).state).toBe("missing")
  })
})

describe("checkDelegatedCommandGrant", () => {
  it("honours an active family peer whose signer matches the pinned DID", () => {
    writeFile({ peer: entry() })
    expect(check()).toEqual({ ok: true })
  })

  it("never consults the friend record's own delegationGrant", () => {
    writeFile({})
    expect(check(friend({ delegationGrant: { scope: "principal_commands", grantedAt: ISO, source: "agent-written" } }))).toEqual({ ok: false, reason: "no_grant" })
    expect(check(friend())).toEqual({ ok: false, reason: "no_grant" })
  })

  it("answers in order: untrusted file, no grant, DID mismatch, expired, not family", () => {
    expect(check().ok).toBe(false)
    expect(check()).toMatchObject({ reason: "no_grant" })
    writeFile({ peer: entry() }, 0o666)
    fs.chmodSync(delegatedCommandGrantsPath(tmp.agentRoot), 0o666)
    expect(check(friend({ trustLevel: "friend" }), "did:key:other", NOW + 1e12)).toEqual({ ok: false, reason: "grants_untrusted" })
    writeFile({ peer: entry({ expiresAt: new Date(NOW - 1).toISOString() }) })
    expect(check(friend({ trustLevel: "friend" }), "did:key:other")).toEqual({ ok: false, reason: "grant_did_mismatch" })
    expect(check(friend({ trustLevel: "friend" }))).toEqual({ ok: false, reason: "grant_expired" })
    writeFile({ peer: entry() })
    expect(check(friend({ trustLevel: "friend" }))).toEqual({ ok: false, reason: "not_family" })
    expect(check(friend({ admissionState: "unverified" }))).toEqual({ ok: false, reason: "not_family" })
    expect(check(friend({ admissionState: "revoked" }))).toEqual({ ok: false, reason: "not_family" })
  })

  it("treats an expiry that is not a finite time as expired, and honours one still in the future", () => {
    writeFile({ peer: entry({ expiresAt: "never" }) })
    expect(check()).toEqual({ ok: false, reason: "grant_expired" })
    writeFile({ peer: entry({ expiresAt: new Date(NOW + 1000).toISOString() }) })
    expect(check()).toEqual({ ok: true })
    expect(check(friend(), DID, NOW + 1000)).toEqual({ ok: false, reason: "grant_expired" })
  })

  it("uses the current time when none is given", () => {
    writeFile({ peer: entry({ expiresAt: new Date(Date.now() + 60_000).toISOString() }) })
    expect(checkDelegatedCommandGrant(tmp.agentRoot, friend(), DID)).toEqual({ ok: true })
  })

  it("is refused when any ancestor of the file belongs to the agent", () => {
    writeFile({ peer: entry() })
    overrideOwnerForTests((target) => (target === path.dirname(path.dirname(delegatedCommandGrantsPath(tmp.agentRoot))) ? process.getuid!() + 1 : undefined))
    expect(check()).toEqual({ ok: false, reason: "grants_untrusted" })
  })

  describe("replay identities", () => {
    function replayState(options: { window?: unknown; identity?: boolean }) {
      const dir = path.dirname(replayWindowPath(tmp.agentRoot))
      fs.mkdirSync(dir, { recursive: true })
      if (options.identity !== false) fs.writeFileSync(replayIdentitiesPath(tmp.agentRoot), JSON.stringify({ friends: { peer: {} } }))
      if (options.window !== undefined) fs.writeFileSync(replayWindowPath(tmp.agentRoot), JSON.stringify(options.window))
      mockOwners(fs, (file) => (file.startsWith(dir) ? 0 : process.getuid!()))
    }
    afterEach(() => { vi.restoreAllMocks() })

    it("honours a replay identity's grant only while the root-owned window is open", () => {
      writeFile({ peer: entry({ expiresAt: new Date(NOW + 600_000).toISOString() }) })
      replayState({ window: { friends: { peer: { expiresAt: new Date(NOW + 600_000).toISOString() } } } })
      expect(check()).toEqual({ ok: true })
      expect(check(friend(), DID, NOW + 700_000)).toEqual({ ok: false, reason: "grant_expired" })
    })

    it("ignores malformed entries in the replay list, so only a well-formed holder forces an expiry", () => {
      writeFile({ peer: entry({ source: "Replay gate provisioning" }) })
      const listFile = path.join(path.dirname(delegatedCommandGrantsPath(tmp.agentRoot)), "replay-identities.json")
      for (const bad of [null, "peer", [], { who: 1, name: "p", did: DID }]) {
        fs.writeFileSync(listFile, JSON.stringify({ schemaVersion: 1, grants: { peer: bad } }), { mode: 0o644 })
        expect(check()).toEqual({ ok: true })
      }
      fs.rmSync(listFile)
    })

    it("refuses a replay grant with no trusted expiry when the root-owned replay list names the friend", () => {
      writeFile({ peer: entry({ source: "Replay gate provisioning" }) })
      expect(check()).toEqual({ ok: true })
      fs.writeFileSync(path.join(path.dirname(delegatedCommandGrantsPath(tmp.agentRoot)), "replay-identities.json"), JSON.stringify({ schemaVersion: 1, grants: { peer: { who: "principal", name: "p", did: DID } } }), { mode: 0o644 })
      expect(check()).toEqual({ ok: false, reason: "grant_expired" })
      fs.rmSync(path.join(path.dirname(delegatedCommandGrantsPath(tmp.agentRoot)), "replay-identities.json"))
      writeFile({ peer: entry() })
      replayState({ window: { friends: { peer: { expiresAt: new Date(NOW + 600_000).toISOString() } } } })
      // only the root-owned list decides that a grant must expire; the bundle registry adds just the window check
      expect(check()).toEqual({ ok: true })
    })

    it("does not honour it with no window at all, and leaves ordinary friends alone", () => {
      writeFile({ peer: entry() })
      replayState({})
      expect(check()).toEqual({ ok: false, reason: "grant_expired" })
      vi.restoreAllMocks()
      fs.rmSync(replayIdentitiesPath(tmp.agentRoot))
      expect(check()).toEqual({ ok: true })
    })
  })
})

describe("setDelegatedCommandGrant", () => {
  it("grants and revokes with a backup of the previous file, and reports no-ops without writing", () => {
    expect(setDelegatedCommandGrant(tmp.agentRoot, "peer", { grant: false })).toEqual({ changed: false, backup: null })
    const first = setDelegatedCommandGrant(tmp.agentRoot, "peer", { grant: true, did: DID, source: "Ari", expiresAt: "2030-01-01T00:00:00.000Z" }, new Date(NOW))
    expect(first).toEqual({ changed: true, backup: null })
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual({ peer: { scope: "principal_commands", did: DID, grantedAt: ISO, source: "Ari", expiresAt: "2030-01-01T00:00:00.000Z" } })
    expect(fs.statSync(delegatedCommandGrantsPath(tmp.agentRoot)).mode & 0o777).toBe(0o644)
    expect(setDelegatedCommandGrant(tmp.agentRoot, "peer", { grant: true, did: DID, source: "Ari", expiresAt: "2030-01-01T00:00:00.000Z" })).toEqual({ changed: false, backup: null })
    const reGranted = setDelegatedCommandGrant(tmp.agentRoot, "peer", { grant: true, did: DID, source: "Ari" }, new Date(NOW + 5))
    expect(reGranted.changed).toBe(true)
    expect(reGranted.backup).not.toBeNull()
    expect(readDelegatedCommandGrants(tmp.agentRoot).peer).not.toHaveProperty("expiresAt")
    const revoked = setDelegatedCommandGrant(tmp.agentRoot, "peer", { grant: false }, new Date(NOW + 10))
    expect(revoked.changed).toBe(true)
    expect(JSON.parse(fs.readFileSync(revoked.backup!, "utf8")).grants.peer.source).toBe("Ari")
    expect(readDelegatedCommandGrants(tmp.agentRoot)).toEqual({})
  })
})
