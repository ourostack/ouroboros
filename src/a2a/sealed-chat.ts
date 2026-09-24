/**
 * Sealed agent-to-agent chat over A2A (friends `message` kind).
 *
 * Both directions use the same primitive: the text is signed by the sender and
 * sealed to the recipient inside ONE friends DataPart, so a message is confidential
 * and tamper-evident over any transport (tailnet, LAN, relay). The network is a
 * pipe, not the lock.
 *
 * - `sealChatMessage` builds the single-DataPart A2A message for a recipient whose
 *   Ed25519 key the sender already trusts (a pinned DID, or a did:key card).
 * - `openChatMessage` opens one through the SAME `receiveShare` pipeline every
 *   friends kind uses (unseal, sender binding, pinned-key signature, replay guard,
 *   trust floor), pinned to the sender the opener expects. There is no second,
 *   hand-rolled verification path.
 */
import {
  keyAgreementFromDidKey,
  MemoryPinStore,
  pinOnFirstContact,
  receiveShare,
  sealEnvelope,
  wrapInDataPart,
  type A2AMessage as FriendsA2AMessage,
  type DidKeyIdentity,
  type SeenLedgerLike,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { MAX_MESSAGE_TEXT_CHARS, prepareMessage, type FriendStore, type MissionStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import type { A2AMessage, A2AMessagePart } from "./types"

/** What an agent replies when its turn produced no text; sealed like any reply. */
export const EMPTY_CHAT_REPLY = "(no reply)"

export interface SealChatMessageInput {
  sodium: Sodium
  /** The sender's own identity (signs the envelope). */
  from: DidKeyIdentity
  recipientDid: string
  /** The recipient's Ed25519 public key (from its pinned DID or did:key). */
  recipientEd25519Pub: Uint8Array
  text: string
  conversationId?: string
}

/** Seal `text` from `from` to the recipient as a single friends DataPart. Returns
 * the harness-shaped A2A message; callers add role/messageId/contextId. */
export function sealChatMessage(input: SealChatMessageInput): { parts: A2AMessagePart[] } {
  const text = input.text.trim() === "" ? EMPTY_CHAT_REPLY : input.text.slice(0, MAX_MESSAGE_TEXT_CHARS)
  const prepared = prepareMessage({
    fromAgentId: input.from.did,
    text,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
  })
  /* v8 ignore next -- the text is normalized above and the sender DID comes from a real identity @preserve */
  if (!prepared.ok) throw new Error(`cannot prepare chat message: ${prepared.status}`)
  const sealed = sealEnvelope({
    sodium: input.sodium,
    envelope: prepared.envelope as unknown as Record<string, unknown>,
    friendsKind: "message",
    fromIdentity: input.from,
    recipientDid: input.recipientDid,
    recipientX25519Pub: keyAgreementFromDidKey({ sodium: input.sodium, ed25519Pub: input.recipientEd25519Pub }),
  })
  const wrapped = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: input.recipientDid })
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_chat_sealed",
    message: "sealed an A2A chat message",
    meta: { recipientDid: input.recipientDid, chars: text.length },
  })
  return { parts: wrapped.parts as unknown as A2AMessagePart[] }
}

export interface OpenChatMessageInput {
  sodium: Sodium
  /** The opener's own identity (the seal recipient). */
  self: DidKeyIdentity
  message: A2AMessage
  /** The sender the opener expects, and its Ed25519 key, pinned before opening. */
  senderDid: string
  senderEd25519Pub: Uint8Array
}

export type OpenChatMessageResult =
  | { ok: true; text: string; conversationId?: string; issuedAt: string }
  | { ok: false; reason: string }

class MemorySeenLedger implements SeenLedgerLike {
  private readonly seen = new Set<string>()
  isSeen(nonce: string): boolean { return this.seen.has(nonce) }
  markSeen(nonce: string): void { this.seen.add(nonce) }
}

/** A `message` receipt imports nothing, so the stores must never be reached. */
function unreachableStore<T extends object>(name: string): T {
  return new Proxy({}, { get() { throw new Error(`sealed chat must not touch the ${name}`) } }) as T
}

/** Open a sealed chat message from an expected sender through `receiveShare`. */
export async function openChatMessage(input: OpenChatMessageInput): Promise<OpenChatMessageResult> {
  const pinStore = new MemoryPinStore()
  pinOnFirstContact({ pinStore, fromAgentId: input.senderDid, did: input.senderDid, ed25519Pub: input.senderEd25519Pub })
  const result = await receiveShare({
    sodium: input.sodium,
    store: unreachableStore<FriendStore>("friend store"),
    missionStore: unreachableStore<MissionStore>("mission store"),
    pinStore,
    // Only the pre-pinned sender can verify: any other signer resolves to nothing.
    didResolution: {
      async resolveAndPin({ fromAgentId }) {
        const pinned = pinStore.get(fromAgentId)
        return pinned ? { ed25519Pub: pinned.ed25519Pub } : null
      },
    },
    seen: new MemorySeenLedger(),
    a2aMessage: input.message as unknown as FriendsA2AMessage,
    recipientDid: input.self.did,
    recipientIdentity: { x25519Priv: input.self.x25519Priv, x25519Pub: input.self.x25519Pub },
    // The opener chose this sender; the signature, not this level, is the gate.
    trustOfSource: "family",
  })
  if (result.state === "rejected") {
    emitNervesEvent({
      level: "warn",
      component: "channels",
      event: "channel.a2a_chat_open_rejected",
      message: "refused a sealed A2A chat message",
      meta: { senderDid: input.senderDid, reason: result.reason },
    })
    return { ok: false, reason: result.reason }
  }
  /* v8 ignore next -- any other kind reaches a store, and these stores throw: only a message can complete here @preserve */
  if (result.friendsKind !== "message" || !result.message) return { ok: false, reason: "not_a_message" }
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_chat_opened",
    message: "opened a verified A2A chat message",
    meta: { senderDid: input.senderDid, chars: result.message.text.length },
  })
  return {
    ok: true,
    text: result.message.text,
    ...(result.message.conversationId !== undefined ? { conversationId: result.message.conversationId } : {}),
    issuedAt: result.message.issuedAt,
  }
}
