import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DidKeyIdentity } from "@ouro.bot/friends/a2a-client"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"

const { callOutboxMethod } = vi.hoisted(() => ({ callOutboxMethod: vi.fn() }))
vi.mock("../../a2a/outbox-client", () => ({ callOutboxMethod }))

const { readRelayContact, refreshRelayContact, writeRelayContact } = await import("../../a2a/relay-contacts")

let tmp: TmpBundleHandle | null = null
beforeEach(() => {
  callOutboxMethod.mockReset()
})
afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

const identity = { did: "did:key:zSelf" } as DidKeyIdentity
const peerDid = "did:key:zPeer"
const contact = { url: "https://relay.example", handle: "h1", sendCredential: "sc" }
const NOW = Date.parse("2026-11-06T12:00:00.000Z")

describe("refreshRelayContact", () => {
  it("asks the peer over the sealed relay/contact method with a timeout and caches its contact", async () => {
    tmp = createTmpBundle({ agentName: "refresh-ok" })
    const fetchImpl = vi.fn(async () => new Response("{}"))
    callOutboxMethod.mockImplementation(async (input: { fetchImpl: typeof fetch }) => {
      await input.fetchImpl("https://peer.example/a2a", { method: "POST" })
      return { contact: { ...contact, extra: "dropped" } }
    })
    await refreshRelayContact({ agentRoot: tmp.agentRoot, peerDid, cardUrl: "https://peer.example/card", identity, fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW })
    expect(callOutboxMethod).toHaveBeenCalledWith(expect.objectContaining({ cardUrl: "https://peer.example/card", method: "relay/contact", params: {}, identity, expectedDid: expect.any(String) }))
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.method).toBe("POST")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(readRelayContact(tmp.agentRoot, peerDid)).toEqual({ did: peerDid, fetchedAt: "2026-11-06T12:00:00.000Z", contact })
  })

  it("records 'no relay' when the peer shares none", async () => {
    tmp = createTmpBundle({ agentName: "refresh-none" })
    callOutboxMethod.mockResolvedValue({ contact: null })
    await refreshRelayContact({ agentRoot: tmp.agentRoot, peerDid, cardUrl: "https://peer.example/card", identity, now: NOW })
    expect(readRelayContact(tmp.agentRoot, peerDid)).toEqual({ did: peerDid, fetchedAt: "2026-11-06T12:00:00.000Z" })
  })

  it("on failure keeps a cached contact, and otherwise records 'no relay' so the peer is not asked again today", async () => {
    tmp = createTmpBundle({ agentName: "refresh-fail" })
    callOutboxMethod.mockRejectedValue(new Error("unknown method relay/contact"))
    await refreshRelayContact({ agentRoot: tmp.agentRoot, peerDid, cardUrl: "https://peer.example/card", identity, now: NOW })
    expect(readRelayContact(tmp.agentRoot, peerDid)).toEqual({ did: peerDid, fetchedAt: "2026-11-06T12:00:00.000Z" })

    writeRelayContact(tmp.agentRoot, { did: peerDid, fetchedAt: "2026-11-01T00:00:00.000Z", contact, stale: true })
    await refreshRelayContact({ agentRoot: tmp.agentRoot, peerDid, cardUrl: "https://peer.example/card", identity })
    expect(readRelayContact(tmp.agentRoot, peerDid)).toEqual({ did: peerDid, fetchedAt: "2026-11-01T00:00:00.000Z", contact, stale: true })
  })
})
