import * as crypto from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  PendingVoiceCalls,
  RecentIds,
  mintVoiceCallToken,
  newVoiceCallNonce,
  verifyVoiceCallToken,
  type VoiceCallIdentity,
} from "../../../senses/voice/call-auth"

const SECRET = "fixture-twilio-auth-token"
const NOW = 1_000_000

function mint(overrides: Partial<Parameters<typeof mintVoiceCallToken>[0]> = {}): string {
  return mintVoiceCallToken({
    secret: SECRET,
    purpose: "stream",
    agentName: "slugger",
    callSid: "CA123",
    direction: "inbound",
    nowMs: NOW,
    nonce: "nonce-1",
    ...overrides,
  })
}

function verify(token: string, overrides: Partial<Parameters<typeof verifyVoiceCallToken>[0]> = {}) {
  return verifyVoiceCallToken({
    secret: SECRET,
    purpose: "stream",
    token,
    agentName: "slugger",
    callSid: "CA123",
    nowMs: NOW + 1_000,
    ...overrides,
  })
}

function identity(callSid: string, overrides: Partial<VoiceCallIdentity> = {}): VoiceCallIdentity {
  return { callSid, agentName: "slugger", direction: "inbound", from: "+15551234567", to: "+15557654321", ...overrides }
}

describe("voice call tokens", () => {
  it("round trips and reports the signed fields", () => {
    const token = mint({ direction: "outbound", outboundId: "out-1" })
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(verify(token)).toEqual({ ok: true, nonce: "nonce-1", direction: "outbound", outboundId: "out-1" })
  })

  it("generates a random nonce when none is given and the token stays small", () => {
    const first = mint({ nonce: undefined })
    const second = mint({ nonce: undefined })
    expect(first).not.toBe(second)
    expect(first.length).toBeLessThan(400)
    expect(newVoiceCallNonce()).toMatch(/^[0-9a-f]{32}$/)
  })

  it("signs from and to for SIP tokens and reports them", () => {
    const token = mint({ purpose: "sip", from: "+15551234567", to: "+15557654321" })
    expect(verify(token, { purpose: "sip" })).toEqual({
      ok: true, nonce: "nonce-1", direction: "inbound", from: "+15551234567", to: "+15557654321",
    })
  })

  it("rejects a token after its ttl, with the default and a custom ttl", () => {
    expect(verify(mint(), { nowMs: NOW + 60_001 })).toEqual({ ok: false, reason: "expired" })
    expect(verify(mint(), { nowMs: NOW + 60_000 }).ok).toBe(true)
    expect(verify(mint({ ttlMs: 5_000 }), { nowMs: NOW + 5_001 })).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects a different call, agent, or purpose", () => {
    const token = mint()
    expect(verify(token, { callSid: "CA999" })).toEqual({ ok: false, reason: "wrong_call" })
    expect(verify(token, { agentName: "other" })).toEqual({ ok: false, reason: "wrong_agent" })
    expect(verify(token, { purpose: "sip" })).toEqual({ ok: false, reason: "wrong_purpose" })
  })

  it("rejects tampered, truncated and foreign-secret signatures", () => {
    const token = mint()
    const [payload, signature] = token.split(".") as [string, string]
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`
    expect(verify(`${payload}.${flipped}`)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verify(`${payload}.${signature.slice(0, 10)}`)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verify(token, { secret: "another-secret" })).toEqual({ ok: false, reason: "bad_signature" })
    expect(verify(mint({ secret: "another-secret" }))).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("rejects an altered payload even with the original signature", () => {
    const [payload, signature] = mint().split(".") as [string, string]
    const altered = Buffer.from(Buffer.from(payload, "base64url").toString("utf8").replace("CA123", "CA124")).toString("base64url")
    expect(verify(`${altered}.${signature}`, { callSid: "CA124" })).toEqual({ ok: false, reason: "bad_signature" })
  })

  it("reports missing and malformed tokens", () => {
    expect(verify("")).toEqual({ ok: false, reason: "missing" })
    expect(verify("   ")).toEqual({ ok: false, reason: "missing" })
    expect(verify("abc")).toEqual({ ok: false, reason: "malformed" })
    expect(verify("a.b.c")).toEqual({ ok: false, reason: "malformed" })
    expect(verify(".")).toEqual({ ok: false, reason: "malformed" })
  })

  it("reports a correctly signed but unparseable or incomplete payload as malformed", () => {
    // Reproduce the signing path with a fixture payload that is not a valid claim set.
    const sign = (payload: string): string => {
      const key = crypto.createHmac("sha256", SECRET).update("ouro-voice-stream-v1").digest()
      return crypto.createHmac("sha256", key).update(payload).digest("base64url")
    }
    for (const raw of ["not json", "[]", "null", JSON.stringify({ v: 1 }), JSON.stringify({ a: "slugger", c: "CA123", d: "inbound", e: "soon", n: "x", p: "stream" })]) {
      const payload = Buffer.from(raw).toString("base64url")
      expect(verify(`${payload}.${sign(payload)}`)).toEqual({ ok: false, reason: "malformed" })
    }
  })
})

describe("PendingVoiceCalls", () => {
  it("consumes a recorded identity once and only with the matching nonce", () => {
    const pending = new PendingVoiceCalls()
    pending.record(identity("CA1"), "n1")
    expect(pending.size()).toBe(1)
    expect(pending.consume("CA1", "wrong")).toBeNull()
    expect(pending.size()).toBe(1)
    expect(pending.consume("CA1", "n1")).toEqual(identity("CA1"))
    expect(pending.consume("CA1", "n1")).toBeNull()
    expect(pending.size()).toBe(0)
  })

  it("accepts any of several overlapping nonces for one call, then drops them all", () => {
    const pending = new PendingVoiceCalls()
    pending.record(identity("CA1"), "n1")
    pending.record(identity("CA1", { reason: "retry" }), "n2")
    expect(pending.size()).toBe(1)
    expect(pending.consume("CA1", "n2")).toEqual(identity("CA1", { reason: "retry" }))
    expect(pending.consume("CA1", "n1")).toBeNull()
  })

  it("reports whether a call is still waiting", () => {
    const pending = new PendingVoiceCalls()
    pending.record(identity("CA1"), "n1")
    expect(pending.has("CA1")).toBe(true)
    expect(pending.has("CA2")).toBe(false)
    expect(pending.discard("CA1")).toBe(true)
    expect(pending.discard("CA1")).toBe(false)
    expect(pending.has("CA1")).toBe(false)
  })

  it("expires entries after the ttl", () => {
    let now = 0
    const pending = new PendingVoiceCalls({ ttlMs: 1_000, now: () => now })
    pending.record(identity("CA1"), "n1")
    now = 999
    expect(pending.has("CA1")).toBe(true)
    now = 1_001
    expect(pending.has("CA1")).toBe(false)
    expect(pending.consume("CA1", "n1")).toBeNull()
    expect(pending.size()).toBe(0)
  })

  it("uses a default ttl of two minutes and a default clock", () => {
    const pending = new PendingVoiceCalls()
    pending.record(identity("CA1"), "n1")
    expect(pending.consume("CA1", "n1")).not.toBeNull()
  })

  it("evicts the oldest entry once the cap is exceeded", () => {
    const pending = new PendingVoiceCalls()
    for (let index = 0; index < 257; index += 1) pending.record(identity(`CA${index}`), `n${index}`)
    expect(pending.size()).toBe(256)
    expect(pending.consume("CA0", "n0")).toBeNull()
    expect(pending.consume("CA256", "n256")).not.toBeNull()
    const small = new PendingVoiceCalls({ maxEntries: 2 })
    small.record(identity("A"), "a")
    small.record(identity("B"), "b")
    small.record(identity("C"), "c")
    expect(small.consume("A", "a")).toBeNull()
    expect(small.consume("B", "b")).not.toBeNull()
  })

  it("refreshes ordering when a call is recorded again", () => {
    const small = new PendingVoiceCalls({ maxEntries: 2 })
    small.record(identity("A"), "a1")
    small.record(identity("B"), "b")
    small.record(identity("A"), "a2")
    small.record(identity("C"), "c")
    expect(small.consume("B", "b")).toBeNull()
    expect(small.consume("A", "a1")).not.toBeNull()
  })
})

describe("PendingVoiceCalls call outcome", () => {
  it("settles a connected call as ok even if a replayed token was refused", () => {
    const pending = new PendingVoiceCalls()
    pending.record(identity("CA1"), "n1")
    expect(pending.consume("CA1", "n1")).not.toBeNull()
    pending.markRejected("CA1")
    expect(pending.settle("CA1")).toBe(false)
  })

  it("settles a refused stream or a never-connected call as failed, once", () => {
    const pending = new PendingVoiceCalls()
    pending.markRejected("CA1")
    expect(pending.settle("CA1")).toBe(true)
    expect(pending.settle("CA1")).toBe(false)
    pending.record(identity("CA2"), "n2")
    expect(pending.settle("CA2")).toBe(true)
    expect(pending.has("CA2")).toBe(false)
    expect(pending.settle("CA3")).toBe(false)
  })

  it("forgets marks after the ttl and bounds how many it keeps", () => {
    let now = 0
    const pending = new PendingVoiceCalls({ ttlMs: 1_000, maxEntries: 2, now: () => now })
    pending.markRejected("A")
    now = 1_001
    expect(pending.settle("A")).toBe(false)
    now = 0
    pending.markRejected("A")
    pending.markRejected("B")
    pending.markRejected("C")
    expect(pending.settle("A")).toBe(false)
    expect(pending.settle("C")).toBe(true)
  })
})

describe("RecentIds", () => {
  it("accepts an id once, then reports it as seen until it expires", () => {
    let now = 0
    const ids = new RecentIds({ ttlMs: 1_000, maxEntries: 2, now: () => now })
    expect(ids.add("a")).toBe(true)
    expect(ids.add("a")).toBe(false)
    now = 1_001
    expect(ids.add("a")).toBe(true)
  })

  it("forgets the oldest id past the cap and works with defaults", () => {
    const ids = new RecentIds({ maxEntries: 2 })
    ids.add("a")
    ids.add("b")
    ids.add("c")
    expect(ids.add("a")).toBe(true)
    expect(new RecentIds().add("x")).toBe(true)
  })
})
