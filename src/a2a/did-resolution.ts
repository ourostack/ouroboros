import {
  applyAcceptedRotation,
  parseDidKey,
  pinOnFirstContact,
  evaluateRotation,
  type DidResolution,
  type PinStore,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { findFriendByDid, type FriendStore, type TrustLevel } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * A signed successor statement: the peer's OLD key names its new DID and key (`rotationProof`, from friends'
 * `signSuccessor`), and the NEW key consents to succeed the old DID (`successorProof`, from `signSuccessorConsent`),
 * both over the same `issuedAt`. friends verifies both signatures and that `issuedAt` is newer than the old pin's last
 * rotation, so a statement cannot be replayed.
 */
export interface SuccessorStatement {
  oldDid: string
  rotationProof: string
  successorProof: string
  issuedAt: string
}

/**
 * A host-owned channel that supplies the successor statement for a DID seen for the first time, if one exists. The
 * friends wire has no carrier for a statement, so in the production inbound path none is presented (this is omitted)
 * and a new DID is a first contact. Tests, and a later carrier, inject statements here.
 */
export type SuccessorStatementResolver = (newDid: string, newEd25519Pub: Uint8Array) => SuccessorStatement | undefined

export interface MakeDidResolutionInput {
  sodium: Sodium
  /** The friend store, so an accepted rotation moves the peer's record (trust, grants) to the new DID. */
  store?: FriendStore
  /** Optional host successor-statement channel. Omitted ⇒ no rotation (production). */
  successorFor?: SuccessorStatementResolver
}

function refused(fromAgentId: string, reason: string, message: string): null {
  emitNervesEvent({ component: "channels", event: "channel.a2a_did_resolve_refused", message, meta: { fromAgentId, reason } })
  return null
}

/**
 * Build the friends `DidResolution` for did:key peers. `resolveAndPin` is the verify-and-pin core the inbound bridge
 * consumes. friends calls it with the SIGNED sender DID as both `fromAgentId` and `did`, so pins are keyed by DID:
 *   unparseable or empty DID, or a retired pin  → refused (null)
 *   pinned                                       → the pinned key (a did:key's key cannot change under the same DID)
 *   not pinned, with a successor statement       → `evaluateRotation` from the old DID (at the OLD record's trust);
 *                                                  accepted: `applyAcceptedRotation` moves the record, then the new key
 *                                                  rejected: refused, never a silent first contact
 *   not pinned, no statement                     → first contact (TOFU `pinOnFirstContact`)
 */
export function makeDidResolution(input: MakeDidResolutionInput): DidResolution {
  const { sodium, store, successorFor } = input
  return {
    async resolveAndPin(args: {
      fromAgentId: string
      did: string
      pinStore: PinStore
      trustOfSource: TrustLevel
    }): Promise<{ ed25519Pub: Uint8Array } | null> {
      const { fromAgentId, did, pinStore } = args
      if (!did) return refused(fromAgentId, "empty_did", "A2A DID resolve refused (empty DID)")
      const parsed = parseDidKey(did)
      if (!parsed) return refused(fromAgentId, "parse_failed", "A2A DID resolve refused (unparseable did:key)")

      const pinned = pinStore.get(fromAgentId)
      // A retired pin is a tombstone: the old key must never verify again (friends requires hosts to enforce this).
      if (pinned?.retiredBy !== undefined) return refused(fromAgentId, "retired_pin", "A2A DID resolve refused (the DID was rotated away)")
      if (pinned) {
        const decision = evaluateRotation({ sodium, pinStore, fromAgentId, trustOfSource: args.trustOfSource, newDid: did, newEd25519Pub: parsed.ed25519Pub })
        if (decision.decision === "unchanged") return { ed25519Pub: parsed.ed25519Pub }
        // A did:key encodes its key, so a differing pin means the pin was filed under another DID (or edited by hand).
        /* v8 ignore next -- evaluateRotation only returns "accepted" with a proof, and none is passed here @preserve */
        return refused(fromAgentId, decision.decision === "rejected" ? decision.reason : "key_changed", "A2A DID resolve refused (pinned key differs)")
      }

      const statement = successorFor?.(did, parsed.ed25519Pub)
      if (!statement) {
        // First contact (TOFU): accept + pin the (did, key) under fromAgentId.
        pinOnFirstContact({ pinStore, fromAgentId, did, ed25519Pub: parsed.ed25519Pub })
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_pin_first_contact",
          message: "A2A DID pinned on first contact",
          meta: { fromAgentId, did },
        })
        return { ed25519Pub: parsed.ed25519Pub }
      }

      // A rotation is judged at the trust of the peer the OLD DID belongs to: the new DID itself is still unknown.
      const oldTrust: TrustLevel = (store ? (await findFriendByDid(store, statement.oldDid))?.trustLevel : undefined) ?? "stranger"
      const decision = evaluateRotation({
        sodium,
        pinStore,
        fromAgentId: statement.oldDid,
        trustOfSource: oldTrust,
        newDid: did,
        newEd25519Pub: parsed.ed25519Pub,
        rotationProof: statement.rotationProof,
        successorProof: statement.successorProof,
        issuedAt: statement.issuedAt,
      })
      if (decision.decision !== "accepted") {
        emitNervesEvent({
          level: "warn",
          component: "channels",
          event: "channel.a2a_rotation_rejected",
          message: "A2A key rotation rejected",
          /* v8 ignore next -- the new DID has no pin, so evaluateRotation cannot call it unchanged @preserve */
          meta: { oldDid: statement.oldDid, newDid: did, trustOfSource: oldTrust, reason: decision.decision === "rejected" ? decision.reason : decision.decision },
        })
        return null
      }
      // Accepted means the old record is family or friend, which was read from `store`, so the store is present.
      const moved = await applyAcceptedRotation({ store: store!, pinStore, oldDid: statement.oldDid, newDid: did })
      if (!moved.ok) {
        // The pins moved but the friend record did not follow (another record already holds the new DID, or the old
        // record is gone). Refuse rather than run the message under a record that does not carry the old trust.
        emitNervesEvent({
          level: "warn",
          component: "channels",
          event: "channel.a2a_rotation_record_not_moved",
          message: "A2A key rotation verified but the friend record could not follow; refusing the message",
          meta: { oldDid: statement.oldDid, newDid: did, trustOfSource: oldTrust, reason: moved.reason },
        })
        return null
      }
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_rotation_accepted",
        message: "A2A signed key rotation accepted",
        meta: { oldDid: statement.oldDid, newDid: did, trustOfSource: oldTrust },
      })
      return { ed25519Pub: parsed.ed25519Pub }
    },
  }
}
