import { emitNervesEvent } from "../nerves/runtime"

/**
 * What a sender can do about each refusal of an inbound sealed message (friends `receiveShare` reasons and the
 * harness result wire). The error text keeps its `A2A <what> rejected: <reason>` prefix, which older senders and the
 * replay gate match, and adds what happened and what to do next. `retry` is true when the same message can succeed
 * later unchanged.
 */
export interface ReceiveRefusal {
  message: string
  next: string
  retry: boolean
}

const UPGRADE = "Upgrade the sending agent's harness (ouro) and send again."
const RESEND = "Send it again as a new message."

const REFUSALS: Record<string, ReceiveRefusal> = {
  malformed_message: { message: "the message is not a sealed A2A data part", next: UPGRADE, retry: false },
  malformed_plaintext: { message: "the sealed message did not open to a valid envelope", next: UPGRADE, retry: false },
  unseal_failed: { message: "the message could not be opened with this agent's key", next: "Fetch this agent's card again (its key may have changed) and resend.", retry: false },
  recipient_mismatch: { message: "the message was sealed to a different agent", next: "Check the recipient's DID and resend.", retry: false },
  signed_recipient_mismatch: { message: "the signed envelope names a different recipient", next: "Check the recipient's DID and resend.", retry: false },
  signed_kind_mismatch: { message: "the signed envelope's kind does not match how it was sealed", next: UPGRADE, retry: false },
  sender_binding_mismatch: { message: "the claimed sender does not match the signer", next: "Send from the identity the message claims.", retry: false },
  malformed_binding: { message: "the envelope's signed binding is malformed", next: UPGRADE, retry: false },
  unbound_envelope: { message: "the envelope has no signed binding (the sender runs an older harness)", next: UPGRADE, retry: false },
  unbound_delegation: { message: "the delegated command has no signed binding (the sender runs an older harness)", next: UPGRADE, retry: false },
  stale_envelope: { message: "the envelope is more than 7 days old or dated in the future", next: `Check the sender's clock. ${RESEND}`, retry: false },
  stale_delegation: { message: "the delegated command is more than 10 minutes old", next: `Check the sender's clock. ${RESEND}`, retry: false },
  replayed: { message: "this message was already received", next: `Nothing to do if it was delivered; otherwise ${RESEND.toLowerCase()}`, retry: false },
  in_flight: { message: "the same message is being handled right now", next: "Retry in a moment.", retry: true },
  resolve_failed: { message: "the sender's DID could not be resolved or pinned", next: "Retry later; if it persists, the sender's key changed and the operator must re-link it.", retry: true },
  retired_pin: { message: "the sender's DID was rotated to a successor and no longer verifies", next: "Send from the successor identity.", retry: false },
  bad_signature: { message: "the signature does not verify against the sender's pinned key", next: "Send from the key this agent pinned for you, or ask the operator to re-link you.", retry: false },
  untrusted_source: { message: "this agent does not trust the sender enough for this kind of message", next: "Ask the operator to connect you as a friend.", retry: false },
  import_failed: { message: "the message verified but could not be stored", next: "Retry later.", retry: true },
}

const UNKNOWN: ReceiveRefusal = { message: "the message was refused", next: "Check the agent's logs.", retry: false }

/** The wording for one refusal reason (an unknown reason gets a generic line). */
export function receiveRefusal(reason: string): ReceiveRefusal {
  return REFUSALS[reason] ?? UNKNOWN
}

/** The JSON-RPC error text and data for a refused inbound message: `A2A <what> rejected: <reason>. <message>. Next: <next>`. */
export function receiveRefusalError(what: string, reason: string): { message: string; data: { reason: string; retry: boolean; next: string } } {
  const refusal = receiveRefusal(reason)
  emitNervesEvent({ component: "channels", event: "channel.a2a_receive_refused", message: "refused an inbound A2A message", meta: { what, reason, retry: refusal.retry } })
  return { message: `A2A ${what} rejected: ${reason}. ${refusal.message}. Next: ${refusal.next}`, data: { reason, retry: refusal.retry, next: refusal.next } }
}
