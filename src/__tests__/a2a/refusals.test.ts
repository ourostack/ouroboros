import { describe, expect, it } from "vitest"
import { receiveRefusal, receiveRefusalError, type RefusalReason } from "../../a2a/refusals"
import { commandIdFor } from "../../a2a/server"

/** Every rejection reason friends 0.1.0-alpha.17 `receiveShare` and `checkEnvelopeBinding` can return. The table in
 * refusals.ts is checked against the friends types at compile time; this list checks the wording at run time. */
const FRIENDS_REASONS: RefusalReason[] = [
  "malformed_message", "malformed_plaintext", "unseal_failed", "recipient_mismatch", "signed_recipient_mismatch",
  "signed_kind_mismatch", "sender_binding_mismatch", "malformed_binding", "unbound_envelope", "unbound_delegation",
  "stale_envelope", "stale_delegation", "replayed", "in_flight", "resolve_failed", "retired_pin", "bad_signature",
  "untrusted_source", "import_failed",
  // The harness mission-result wire.
  "no_mission", "no_delegation", "assignee_mismatch",
]

describe("receive refusals", () => {
  it("has specific wording for every friends rejection reason", () => {
    const generic = receiveRefusal("something_new")
    for (const reason of FRIENDS_REASONS) {
      const refusal = receiveRefusal(reason)
      expect(refusal, reason).not.toBe(generic)
      expect(refusal.message.length, reason).toBeGreaterThan(0)
      expect(refusal.next.length, reason).toBeGreaterThan(0)
    }
  })

  it("marks only the refusals that can succeed unchanged later as retryable", () => {
    const retryable = FRIENDS_REASONS.filter((reason) => receiveRefusal(reason).retry)
    // Anything that consumed the message or cannot change by itself is final; only a concurrent duplicate is retryable.
    expect(retryable).toEqual(["in_flight"])
  })

  it("keeps the `A2A <what> rejected: <reason>` prefix and adds what happened and the next step", () => {
    const error = receiveRefusalError("share", "unbound_envelope")
    expect(error.message).toBe("A2A share rejected: unbound_envelope. the envelope has no signed binding (the sender runs an older harness). Next: Upgrade the sending agent's harness (ouro) and send again.")
    expect(error.data).toEqual({ reason: "unbound_envelope", retry: false, next: "Upgrade the sending agent's harness (ouro) and send again." })
  })

  it("falls back to a generic line for an unknown reason", () => {
    expect(receiveRefusalError("result", "something_new")).toEqual({
      message: "A2A result rejected: something_new. the message was refused. Next: Check the agent's logs.",
      data: { reason: "something_new", retry: false, next: "Check the agent's logs." },
    })
  })
})

describe("delegated command id", () => {
  it("is stable for one signed message and changes when a sender reuses a message id at another time or from another DID", () => {
    const base = { did: "did:key:zA", bindingId: "b1", issuedAt: "2026-11-06T00:00:00.000Z" }
    expect(commandIdFor(base)).toMatch(/^[0-9a-f]{32}$/)
    expect(commandIdFor({ ...base })).toBe(commandIdFor(base))
    expect(commandIdFor({ ...base, issuedAt: "2026-11-14T00:00:00.000Z" })).not.toBe(commandIdFor(base))
    expect(commandIdFor({ ...base, did: "did:key:zB" })).not.toBe(commandIdFor(base))
    expect(commandIdFor({ did: "did:key:zA", bindingId: "b1" })).not.toBe(commandIdFor(base))
  })
})
