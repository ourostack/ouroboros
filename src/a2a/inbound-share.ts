import {
  unwrapDataPart,
  openSealedEnvelope,
  receiveShare,
  type DidResolution,
  type PinStore,
  type SeenLedgerLike,
  type Sodium,
  type A2AMessage as FriendsA2AMessage,
} from "@ouro.bot/friends/a2a-client"
import {
  findFriendByDid,
  type FriendStore,
  type MissionStore,
  type TrustLevel,
} from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import type { A2AIdentity } from "./identity"
import type { A2AMessage } from "./types"

/**
 * The dependencies the inbound bridge needs. The stores are the agent's own
 * file-backed friend/mission/pin/seen stores (the durable Slice-1 homes). The
 * `identity` is the agent's self A2A identity (its did:key + derived X25519 keys),
 * used as the unseal recipient.
 */
export interface InboundShareDeps {
  sodium: Sodium
  store: FriendStore
  missionStore: MissionStore
  pinStore: PinStore
  didResolution: DidResolution
  seen: SeenLedgerLike
  identity: A2AIdentity
}

/** The outcome of bridging an inbound A2A message through `receiveShare`. */
export type InboundShareResult =
  | {
      /** The friends import completed. Run the turn keyed on `verifiedDid`. */
      outcome: "completed"
      /** The signed, verified sender DID — the turn's `externalId`. */
      verifiedDid: string
      /** The trust read from the friend store BY `verifiedDid` (never defaulted). */
      trust: TrustLevel
      friendsKind: string
      status: string
    }
  | {
      /** The message was rejected; do NOT run a turn. */
      outcome: "rejected"
      reason: string
    }
  | {
      /** The message carries no friends DataPart — the caller falls back to the
       * legacy text path (status-quo `stranger` behavior). */
      outcome: "not-a-share"
    }

/** Whether the inbound message carries a friends data part (kind:"data"). */
function hasDataPart(message: A2AMessage): boolean {
  return Array.isArray(message.parts) && message.parts.some((p) => p && p.kind === "data")
}

/**
 * Bridge an inbound A2A message through friends' `receiveShare`, keying the result
 * on the VERIFIED sender DID.
 *
 * Ordering (the security-critical trap — `trustOfSource` is read from the store BY
 * the just-verified DID, never defaulted, never from the envelope):
 *   1. `unwrapDataPart` — no friends part ⇒ `not-a-share` (caller does text path).
 *   2. `openSealedEnvelope` (pre-unseal) — extract the SIGNED sender DID. Unseal /
 *      recipient-mismatch failures ⇒ `rejected` (no turn). (This open does NOT
 *      verify the signature; the real auth gate is the `DidVerifier` inside
 *      `receiveShare`, so a forged-high-trust claim here is harmless — the forge is
 *      rejected by the verifier regardless of the trust we read.)
 *   3. `findFriendByDid(store, verifiedDid)` — read trust off that record; an
 *      unknown DID ⇒ `stranger` (never a default-up).
 *   4. `receiveShare({ ..., trustOfSource })` — re-unseal (deterministic) + resolve
 *      & pin + run `DidVerifier` (forge fails HERE) + replay-dedup + import.
 *   5. Map the result. `completed` ⇒ run the turn at `verifiedDid`/`trust`.
 */
export async function receiveInboundShare(
  message: A2AMessage,
  deps: InboundShareDeps,
): Promise<InboundShareResult> {
  const friendsMessage = message as unknown as FriendsA2AMessage
  const payload = unwrapDataPart(friendsMessage)
  if (!payload) {
    // No (valid) friends part. If there was a data part at all, it was a malformed
    // friends attempt → reject; otherwise it's a legacy text message → not-a-share.
    if (hasDataPart(message)) {
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_inbound_rejected",
        message: "rejected malformed inbound A2A data part",
        meta: { reason: "malformed_message" },
      })
      return { outcome: "rejected", reason: "malformed_message" }
    }
    return { outcome: "not-a-share" }
  }

  const recipientIdentity = {
    x25519Priv: deps.identity.x25519Priv,
    x25519Pub: deps.identity.x25519Pub,
  }

  // Pre-unseal to learn the SIGNED sender DID before we can read its trust.
  const opened = openSealedEnvelope({
    sodium: deps.sodium,
    sealedEnvelope: { v: payload.v, sealed: payload.sealed },
    recipientDid: deps.identity.did,
    recipientIdentity,
  })
  if (!opened.ok) {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_inbound_rejected",
      message: "rejected inbound A2A envelope (unseal/recipient)",
      meta: { reason: opened.error },
    })
    return { outcome: "rejected", reason: opened.error }
  }

  const verifiedDid = opened.fromAgentId
  // Read trust from the friend store BY the verified DID — never defaulted, never
  // from the envelope. Unknown DID ⇒ stranger.
  const record = verifiedDid ? await findFriendByDid(deps.store, verifiedDid) : null
  const trust: TrustLevel = record?.trustLevel ?? "stranger"

  const result = await receiveShare({
    sodium: deps.sodium,
    store: deps.store,
    missionStore: deps.missionStore,
    pinStore: deps.pinStore,
    didResolution: deps.didResolution,
    seen: deps.seen,
    a2aMessage: friendsMessage,
    recipientDid: deps.identity.did,
    recipientIdentity,
    trustOfSource: trust,
  })

  if (result.state === "completed") {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_inbound_verified",
      message: "verified inbound A2A share; keying turn on sender DID",
      meta: { verifiedDid, trust, friendsKind: result.friendsKind, status: result.status },
    })
    return {
      outcome: "completed",
      verifiedDid,
      trust,
      friendsKind: result.friendsKind,
      status: result.status,
    }
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_inbound_rejected",
    message: "rejected inbound A2A share",
    meta: { reason: result.reason, verifiedDid, trust },
  })
  return { outcome: "rejected", reason: result.reason }
}
