import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import {
  RELAY_CONTACT_REFRESH_MS,
  markRelayContactStale,
  readRelayContact,
  relayContactNeedsRefresh,
  writeRelayContact,
} from "../../a2a/relay-contacts"

let tmp: TmpBundleHandle | null = null
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

const contact = { url: "https://relay.example", handle: "h1", sendCredential: "sc" }

describe("relay contact cache", () => {
  it("returns null for a peer with no cached entry", () => {
    tmp = createTmpBundle({ agentName: "contacts-empty" })
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toBeNull()
  })

  it("writes one private file per peer and reads it back", () => {
    tmp = createTmpBundle({ agentName: "contacts-write" })
    writeRelayContact(tmp.agentRoot, { did: "did:key:zPeer", fetchedAt: "2026-11-06T00:00:00.000Z", contact })
    writeRelayContact(tmp.agentRoot, { did: "did:key:zOther", fetchedAt: "2026-11-06T00:00:00.000Z" })
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toEqual({ did: "did:key:zPeer", fetchedAt: "2026-11-06T00:00:00.000Z", contact })
    expect(readRelayContact(tmp.agentRoot, "did:key:zOther")).toEqual({ did: "did:key:zOther", fetchedAt: "2026-11-06T00:00:00.000Z" })
    const dir = path.join(tmp.agentRoot, "state", "a2a", "relay-contacts")
    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(file).toMatch(/^[0-9a-f]{64}\.json$/)
      expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600)
    }
  })

  it("ignores an unreadable, foreign or malformed entry", () => {
    tmp = createTmpBundle({ agentName: "contacts-bad" })
    writeRelayContact(tmp.agentRoot, { did: "did:key:zPeer", fetchedAt: "2026-11-06T00:00:00.000Z", contact })
    const dir = path.join(tmp.agentRoot, "state", "a2a", "relay-contacts")
    const file = path.join(dir, fs.readdirSync(dir)[0])
    fs.writeFileSync(file, "{not json")
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ did: "did:key:zSomeoneElse", fetchedAt: "x" }))
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ did: "did:key:zPeer", fetchedAt: 5 }))
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ did: "did:key:zPeer", fetchedAt: "x", contact: { url: "u", handle: 1, sendCredential: "s" } }))
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toEqual({ did: "did:key:zPeer", fetchedAt: "x" })
    fs.writeFileSync(file, "null")
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toBeNull()
  })

  it("marks a cached contact stale and keeps the contact", () => {
    tmp = createTmpBundle({ agentName: "contacts-stale" })
    markRelayContactStale(tmp.agentRoot, "did:key:zNobody")
    expect(readRelayContact(tmp.agentRoot, "did:key:zNobody")).toBeNull()
    writeRelayContact(tmp.agentRoot, { did: "did:key:zPeer", fetchedAt: "2026-11-06T00:00:00.000Z", contact })
    markRelayContactStale(tmp.agentRoot, "did:key:zPeer")
    expect(readRelayContact(tmp.agentRoot, "did:key:zPeer")).toEqual({ did: "did:key:zPeer", fetchedAt: "2026-11-06T00:00:00.000Z", contact, stale: true })
  })

  it("needs a refresh when missing, stale, undated or older than a day", () => {
    const now = Date.parse("2026-11-06T12:00:00.000Z")
    const fresh = { did: "d", fetchedAt: new Date(now - 1000).toISOString(), contact }
    expect(relayContactNeedsRefresh(null, now)).toBe(true)
    expect(relayContactNeedsRefresh(fresh, now)).toBe(false)
    expect(relayContactNeedsRefresh({ ...fresh, stale: true }, now)).toBe(true)
    expect(relayContactNeedsRefresh({ ...fresh, fetchedAt: "garbage" }, now)).toBe(true)
    expect(relayContactNeedsRefresh({ ...fresh, fetchedAt: new Date(now - RELAY_CONTACT_REFRESH_MS - 1).toISOString() }, now)).toBe(true)
  })
})
