import type { ReceiveShareResult } from "@ouro.bot/friends/a2a-client"
import type { ImportMissionResultStatus } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * What a sender can do about each refusal of an inbound sealed message (friends `receiveShare` reasons and the
 * harness result wire). The error text keeps its `A2A <what> rejected: <reason>` prefix, which older senders and the
 * replay gate match, and adds what happened and what to do next. `retry` is true when the same message (the same
 * sealed envelope) can succeed later unchanged. A delegated-command refusal uses `retry` differently; see
 * `DelegationRefusalGuidance`.
 */
export interface ReceiveRefusal {
  message: string
  next: string
  retry: boolean
}

const UPGRADE = "Upgrade the sending agent's harness (ouro) and send again."
const RESEND = "Send it again as a new message."

/** Every reason a receive path can refuse with: friends' `receiveShare` (which includes `checkEnvelopeBinding`) and the
 * harness result wire. A reason a later friends adds fails the type check on `REFUSALS` until it has wording. */
export type RefusalReason =
  | Extract<ReceiveShareResult, { state: "rejected" }>["reason"]
  | Exclude<ImportMissionResultStatus, "imported">

const REFUSALS = {
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
  resolve_failed: { message: "the sender's DID could not be resolved or pinned (it is not a did:key, its pinned key differs, or a key rotation was refused)", next: "Send from the identity this agent knows you by, or ask the operator to re-link you.", retry: false },
  retired_pin: { message: "the sender's DID was rotated to a successor and no longer verifies", next: "Send from the successor identity.", retry: false },
  bad_signature: { message: "the signature does not verify against the sender's pinned key", next: "Send from the key this agent pinned for you, or ask the operator to re-link you.", retry: false },
  untrusted_source: { message: "this agent does not trust the sender enough for this kind of message", next: "Ask the operator to connect you as a friend.", retry: false },
  import_failed: { message: "the message verified but could not be stored", next: RESEND, retry: false },
  // Mission results (the harness result wire).
  no_mission: { message: "this agent has no mission with that key", next: "Check the mission key; the delegator may have dropped the mission.", retry: false },
  no_delegation: { message: "this agent delegated no task with that request id", next: "Check the request id the delegation gave you.", retry: false },
  assignee_mismatch: { message: "the task was delegated to a different agent", next: "Only the assignee can send this result.", retry: false },
} satisfies Record<RefusalReason, ReceiveRefusal>

const UNKNOWN: ReceiveRefusal = { message: "the message was refused", next: "Check the agent's logs.", retry: false }

/** The wording for one refusal reason (an unknown reason gets a generic line). */
export function receiveRefusal(reason: string): ReceiveRefusal {
  return Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason as RefusalReason] : UNKNOWN
}

/** Every `data` object `receiveRefusalError` made in this process, so a caller can tell a real receive refusal from an
 * error that only looks like one (a delegated-command refusal also carries `retry`). */
const ISSUED = new WeakSet<object>()

/** The JSON-RPC error text and data for a refused inbound message: `A2A <what> rejected: <reason>. <message>. Next: <next>`. */
export function receiveRefusalError(what: string, reason: string): { message: string; data: { reason: string; retry: boolean; next: string } } {
  const refusal = receiveRefusal(reason)
  emitNervesEvent({ component: "channels", event: "channel.a2a_receive_refused", message: "refused an inbound A2A message", meta: { what, reason, retry: refusal.retry } })
  const data = { reason, retry: refusal.retry, next: refusal.next }
  ISSUED.add(data)
  return { message: `A2A ${what} rejected: ${reason}. ${refusal.message}. Next: ${refusal.next}`, data }
}

/** True only for the `data` of a refusal made here that says the same message can succeed later (such as `in_flight`). */
export function isRetryableReceiveRefusal(data: unknown): boolean {
  return typeof data === "object" && data !== null && ISSUED.has(data) && (data as { retry?: unknown }).retry === true
}
