import {
  parseDidKey,
  pinOnFirstContact,
  evaluateRotation,
  type DidResolution,
  type PinStore,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import type { TrustLevel } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * A host-owned channel that supplies a rotation proof for a presented successor
 * key, if one is available. The friends `DidResolution.resolveAndPin` interface
 * carries NO rotation-proof field, and friends alpha.7's over-the-wire surface
 * (sealed envelope / DataPart / `receiveShare`) has no carrier for one either — so
 * the HOST owns where a proof comes from. In the production inbound path no proof
 * is presented (this returns `undefined`), so a key change for a pinned peer is
 * refused (`bad_rotation_proof`). A signed over-the-wire rotation-accept is a
 * documented follow-up (needs a proof carrier added to the friends wire / a
 * `did:web` slice). Tests inject a `signSuccessor`-minted proof here to exercise
 * the accept branch of the matrix.
 */
export type RotationProofResolver = (
  fromAgentId: string,
  newDid: string,
  newEd25519Pub: Uint8Array,
) => string | undefined

export interface MakeDidResolutionInput {
  sodium: Sodium
  /** Optional host rotation-proof channel. Omitted ⇒ no proof (production). */
  rotationProofFor?: RotationProofResolver
}

/**
 * Build the friends `DidResolution` for did:key peers. `resolveAndPin` is the
 * verify-and-pin core the inbound bridge consumes:
 *   parse the did:key → derive the presented Ed25519 key →
 *     first contact (no pin under `fromAgentId`) → TOFU `pinOnFirstContact`
 *     already pinned → `evaluateRotation` against the pin:
 *       unchanged  → pin-hit, return the pinned key
 *       accepted   → (re-pinned by evaluateRotation) return the NEW key
 *       rejected   → loud security event, return null
 *
 * The pin is keyed by the STABLE `fromAgentId` (NOT the did:key string), so a
 * rotation is "same `fromAgentId`, new (did, key)". An unparseable or empty DID is
 * refused (null) and never matchable. The crypto is the friends primitives' — this
 * only sequences them.
 */
export function makeDidResolution(input: MakeDidResolutionInput): DidResolution {
  const { sodium, rotationProofFor } = input
  return {
    async resolveAndPin(args: {
      fromAgentId: string
      did: string
      pinStore: PinStore
      trustOfSource: TrustLevel
    }): Promise<{ ed25519Pub: Uint8Array } | null> {
      const { fromAgentId, did, pinStore, trustOfSource } = args

      // Empty DID is never a matchable key.
      if (!did) {
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_did_resolve_refused",
          message: "A2A DID resolve refused (empty DID)",
          meta: { fromAgentId, reason: "empty_did" },
        })
        return null
      }

      const parsed = parseDidKey(did)
      if (!parsed) {
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_did_resolve_refused",
          message: "A2A DID resolve refused (unparseable did:key)",
          meta: { fromAgentId, reason: "parse_failed" },
        })
        return null
      }

      const pinned = pinStore.get(fromAgentId)
      if (!pinned) {
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

      // Already pinned: evaluate the presented key against the pin.
      const rotationProof = rotationProofFor?.(fromAgentId, did, parsed.ed25519Pub)
      const decision = evaluateRotation({
        sodium,
        pinStore,
        fromAgentId,
        trustOfSource,
        newDid: did,
        newEd25519Pub: parsed.ed25519Pub,
        rotationProof,
      })

      if (decision.decision === "unchanged") {
        // Same key — pin-hit. (FileA2APinStore.get already emitted a2a_pin_hit.)
        return { ed25519Pub: parsed.ed25519Pub }
      }
      if (decision.decision === "accepted") {
        // evaluateRotation already re-pinned to the new key under fromAgentId.
        emitNervesEvent({
          component: "channels",
          event: "channel.a2a_rotation_accepted",
          message: "A2A signed key rotation accepted",
          meta: { fromAgentId, newDid: did, trustOfSource },
        })
        return { ed25519Pub: parsed.ed25519Pub }
      }

      // Rejected — loud security signal (carries the reason).
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_rotation_rejected",
        message: "A2A key rotation rejected",
        meta: { fromAgentId, newDid: did, trustOfSource, reason: decision.reason },
      })
      return null
    },
  }
}
