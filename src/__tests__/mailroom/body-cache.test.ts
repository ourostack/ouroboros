import { beforeEach, describe, expect, it } from "vitest"
import {
  MAIL_BODY_CACHE_MAX_ENTRIES,
  cacheMailBody,
  clearMailBodyCache,
  getCachedMailBody,
  getMailBodyCacheSize,
} from "../../mailroom/body-cache"
import type { DecryptedMailMessage } from "../../mailroom/core"

function fakeDecrypted(id: string, snippet = "x"): DecryptedMailMessage {
  return {
    schemaVersion: 1,
    id,
    agentId: "slugger",
    mailboxId: "mb",
    compartmentKind: "native",
    compartmentId: "native",
    recipient: "slugger@ouro.bot",
    envelope: { mailFrom: "f@e.com", rcptTo: ["slugger@ouro.bot"] },
    placement: "imbox",
    trustReason: "test",
    rawObject: `raw/${id}.json`,
    rawSha256: "0".repeat(64),
    rawSize: 0,
    privateEnvelope: { algorithm: "RSA-OAEP-SHA256+A256GCM", keyId: "k", wrappedKey: "", iv: "", authTag: "", ciphertext: "" },
    ingest: { schemaVersion: 1, kind: "smtp" },
    receivedAt: "2026-04-21T08:00:00Z",
    private: { from: [], to: [], cc: [], subject: id, text: "body", snippet, attachments: [], untrustedContentWarning: "" },
  }
}

describe("body-cache", () => {
  beforeEach(() => clearMailBodyCache())

  it("returns undefined for a miss and the cached message after insertion", () => {
    expect(getCachedMailBody("nope")).toBeUndefined()
    cacheMailBody(fakeDecrypted("m1"))
    expect(getCachedMailBody("m1")?.id).toBe("m1")
  })

  it("rejects an empty messageId on read", () => {
    expect(getCachedMailBody("")).toBeUndefined()
  })

  it("ignores a message with no id (defensive)", () => {
    cacheMailBody({ ...fakeDecrypted("x"), id: "" } as unknown as DecryptedMailMessage)
    expect(getMailBodyCacheSize()).toBe(0)
  })

  it("re-inserting the same id refreshes the entry without growing the cache", () => {
    const first = fakeDecrypted("m1", "first")
    const second = fakeDecrypted("m1", "second")
    cacheMailBody(first)
    cacheMailBody(second)
    expect(getMailBodyCacheSize()).toBe(1)
    expect(getCachedMailBody("m1")?.private.snippet).toBe("second")
  })

  it("evicts oldest entries when capacity is exceeded", () => {
    for (let i = 0; i < MAIL_BODY_CACHE_MAX_ENTRIES + 5; i++) {
      cacheMailBody(fakeDecrypted(`m${i}`))
    }
    expect(getMailBodyCacheSize()).toBe(MAIL_BODY_CACHE_MAX_ENTRIES)
    expect(getCachedMailBody("m0")).toBeUndefined()
    expect(getCachedMailBody("m4")).toBeUndefined()
    expect(getCachedMailBody("m5")?.id).toBe("m5")
    expect(getCachedMailBody(`m${MAIL_BODY_CACHE_MAX_ENTRIES + 4}`)?.id).toBe(`m${MAIL_BODY_CACHE_MAX_ENTRIES + 4}`)
  })

  it("a get on an existing entry refreshes its LRU position", () => {
    for (let i = 0; i < MAIL_BODY_CACHE_MAX_ENTRIES; i++) {
      cacheMailBody(fakeDecrypted(`m${i}`))
    }
    // Touch m0 to move it to the end.
    expect(getCachedMailBody("m0")?.id).toBe("m0")
    // Now insert one more. m1 should be evicted, not m0.
    cacheMailBody(fakeDecrypted("new"))
    expect(getCachedMailBody("m0")?.id).toBe("m0")
    expect(getCachedMailBody("m1")).toBeUndefined()
  })

  it("clearMailBodyCache empties the cache", () => {
    cacheMailBody(fakeDecrypted("m1"))
    expect(getMailBodyCacheSize()).toBe(1)
    clearMailBodyCache()
    expect(getMailBodyCacheSize()).toBe(0)
  })
})
