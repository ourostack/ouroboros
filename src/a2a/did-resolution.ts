import {
  applyAcceptedRotation,
  parseDidKey,
  pinOnFirstContact,
  evaluateRotation,
  type DidResolution,
  type PinStore,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { createHash } from "node:crypto"
import type { FriendRecord, FriendStore, TrustLevel } from "@ouro.bot/friends"
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

/** A pin store that can name the DID that rotated to a given DID (`FileA2APinStore`). Without it, a record left behind by
 * a rotation is not looked for. */
export interface RotationAwarePinStore extends PinStore {
  predecessorOf?(did: string): string | undefined
}

/** A notice for the agent's owner. A stable `noticeId` lets the delivery channel send it once. */
export interface OwnerNotice {
  noticeId: string
  text: string
}

export interface MakeDidResolutionInput {
  sodium: Sodium
  /** The friend store, so an accepted rotation moves the peer's record (and its trust) to the new DID. */
  store?: FriendStore
  /** Optional host successor-statement channel. Omitted ⇒ no rotation (production). */
  successorFor?: SuccessorStatementResolver
  /** The agent's name, used in the fix command an owner notice names. */
  agentName?: string
  /** Tells the owner when a verified rotation leaves the peer's friend record behind. Omitted: only nerves records it. */
  notifyOwner?: (notice: OwnerNotice) => Promise<void>
}

/** friends' `DidResolution` plus the step the receive paths run before they read the sender's trust. */
export interface HarnessDidResolution extends DidResolution {
  /**
   * Settle the sender's DID before its trust is read, so a message is judged against the record it belongs to: apply
   * an accepted rotation that arrives with the first message from a new DID, and finish a rotation whose record did not
   * follow its pins. Returns false when the message must be refused (`resolve_failed`): a presented rotation was
   * rejected, or the record still cannot follow.
   */
  settleSender(args: { did: string; pinStore: PinStore }): Promise<boolean>
}

/** At most this many earlier DIDs are followed back from a rotated pin (friends' `MAX_ROTATION_HOPS`). */
const MAX_PREDECESSOR_HOPS = 16

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
 * The receive paths call `settleSender` first, so by the time `resolveAndPin` runs a rotation is already applied.
 */
export function makeDidResolution(input: MakeDidResolutionInput): HarnessDidResolution {
  const { sodium, store, successorFor } = input
  const toldOwner = new Set<string>()

  /** Tell the owner, once per rotation, that the record could not follow and how to fix it. */
  function tellOwner(oldDid: string, newDid: string, record: FriendRecord, holder: FriendRecord | null, reason: string): void {
    const notify = input.notifyOwner
    const key = `${oldDid}>${newDid}`
    if (!notify || toldOwner.has(key)) return
    toldOwner.add(key)
    const agent = input.agentName ?? "<agent>"
    const fix = holder
      ? `Its new DID is already linked to friend ${holder.name} (${holder.id}). If that is the same peer, merge the two records: ouro friend merge --agent ${agent} --into ${record.id} ${holder.id} --apply`
      : `The move failed with ${reason}. Link the record to the new DID: ouro friend link ${agent} --friend ${record.id} --provider a2a-agent --external-id ${newDid}`
    const notice: OwnerNotice = {
      noticeId: `a2a-rotation-unmoved:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
      text: `${record.name} changed its A2A key to ${newDid}, but its friend record could not move to the new key, so this agent refuses its messages. ${fix}. Its next message then moves the record.`,
    }
    notify(notice).catch((error: unknown) => {
      emitNervesEvent({
        level: "warn",
        component: "channels",
        event: "channel.a2a_rotation_notice_failed",
        message: "could not tell the owner that a rotated peer's record did not move",
        meta: { oldDid, newDid, error: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  /** Move the peer's record along the rotation chain to `newDid`. On failure, warn and tell the owner. */
  async function moveRecord(friends: FriendStore, pinStore: PinStore, oldDid: string, newDid: string, record: FriendRecord): Promise<boolean> {
    const moved = await applyAcceptedRotation({ store: friends, pinStore, oldDid, newDid })
    if (moved.ok) return true
    // The pins moved but the friend record did not follow (another record already holds the new DID, or the chain is
    // broken). Refuse rather than run the message under a record that does not carry the old trust.
    emitNervesEvent({
      level: "warn",
      component: "channels",
      event: "channel.a2a_rotation_record_not_moved",
      message: "A2A key rotation verified but the friend record could not follow; refusing the message",
      meta: { oldDid, newDid, reason: moved.reason },
    })
    tellOwner(oldDid, newDid, record, await friends.findByExternalId("a2a-agent", newDid), moved.reason)
    return false
  }

  /** Judge a successor statement for an unpinned DID and, when accepted, move the record. */
  async function rotateIn(pinStore: PinStore, did: string, ed25519Pub: Uint8Array, statement: SuccessorStatement): Promise<boolean> {
    // A rotation is judged at the trust of the peer the OLD DID belongs to: the new DID itself is still unknown.
    const oldRecord = store ? await store.findByExternalId("a2a-agent", statement.oldDid) : null
    const oldTrust: TrustLevel = oldRecord?.trustLevel ?? "stranger"
    const decision = evaluateRotation({
      sodium,
      pinStore,
      fromAgentId: statement.oldDid,
      trustOfSource: oldTrust,
      newDid: did,
      newEd25519Pub: ed25519Pub,
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
      return false
    }
    // Accepted means the old record is family or friend, which was read from `store`, so both are present.
    if (!(await moveRecord(store!, pinStore, statement.oldDid, did, oldRecord!))) return false
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_rotation_accepted",
      message: "A2A signed key rotation accepted",
      meta: { oldDid: statement.oldDid, newDid: did, trustOfSource: oldTrust },
    })
    return true
  }

  /**
   * A pin that a rotation moved to `did`: if the peer's record still sits at an earlier DID on the chain, the move
   * failed earlier, so retry it. Returns false while the record still cannot follow.
   */
  async function finishMove(pinStore: RotationAwarePinStore, did: string): Promise<boolean> {
    if (!store || typeof pinStore.predecessorOf !== "function") return true
    const chain: string[] = []
    for (let prev = pinStore.predecessorOf(did); prev !== undefined && chain.length < MAX_PREDECESSOR_HOPS; prev = pinStore.predecessorOf(prev)) {
      chain.unshift(prev)
    }
    for (const earlier of chain) {
      const record = await store.findByExternalId("a2a-agent", earlier)
      if (!record) continue
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_rotation_record_retry",
        message: "a rotated peer's friend record is still at its old DID; retrying the move",
        meta: { oldDid: earlier, newDid: did },
      })
      if (!(await moveRecord(store, pinStore, chain[0]!, did, record))) return false
      emitNervesEvent({
        component: "channels",
        event: "channel.a2a_rotation_record_moved",
        message: "moved a rotated peer's friend record to its new DID",
        meta: { oldDid: earlier, newDid: did },
      })
      return true
    }
    return true
  }

  return {
    async settleSender({ did, pinStore }): Promise<boolean> {
      const parsed = parseDidKey(did)
      // An unusable DID is refused by `resolveAndPin` itself.
      if (!parsed) return true
      const pinned = pinStore.get(did)
      if (pinned) return pinned.rotatedAt !== undefined && pinned.retiredBy === undefined ? finishMove(pinStore, did) : true
      const statement = successorFor?.(did, parsed.ed25519Pub)
      return statement ? rotateIn(pinStore, did, parsed.ed25519Pub, statement) : true
    },

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
      return (await rotateIn(pinStore, did, parsed.ed25519Pub, statement)) ? { ed25519Pub: parsed.ed25519Pub } : null
    },
  }
}
