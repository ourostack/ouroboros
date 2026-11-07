import {
  openSealedEnvelope,
  DidVerifier,
  checkEnvelopeBinding,
  type EnvelopeBindingOptions,
  type SealedEnvelope,
  type PinStore,
  type SeenLedgerLike,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import {
  findFriendByDid,
  importMissionResult,
  type FriendStore,
  type MissionStore,
  type MissionResultEnvelope,
  type TrustLevel,
} from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import type { HarnessDidResolution } from "./did-resolution"
import type { A2AIdentity } from "./identity"
import { bindingWindowsWithinRetention } from "./seen-ledger"
import type { A2AMessage } from "./types"

/**
 * THE HARNESS-OWNED RESULT WIRE.
 *
 * A mission RESULT is NOT a `FriendsKind` (`FriendsKind` = profile_share |
 * mission_share | coordination) — `prepareMissionResult`/`importMissionResult` are
 * transport-agnostic + store-only, and the result does NOT ride `sendShare`/
 * `receiveShare`. So the HARNESS owns the wire: the result envelope is sealed (reusing
 * the sign-then-seal crypto) and wrapped in a DataPart carrying a distinct `ouroKind:
 * "mission_result"` discriminator. The inbound bridge recognizes that tag and routes
 * it to `importMissionResult` — NEVER to `receiveShare`, which would mis-route a
 * non-`FriendsKind` envelope. This is "a DataPart variant + an inbound route branch"
 * (the carrier is the friends `unwrapDataPart` shape + one extra tag field — no
 * structural change beyond that).
 *
 * SECURITY — the wire AUTHENTICATES the sender exactly like the share path
 * (`receiveShare` in friends' `adapter.ts`). `openSealedEnvelope` does AEAD
 * decryption ONLY — it does NOT verify the signature (its docstring names the
 * adapter's `DidVerifier` as "the single authentication gate"). The decrypted
 * `envelope.fromAgentId` is therefore attacker-controlled plaintext: the recipient's
 * X25519 pubkey is public (derived from the published DID), so any party can SEAL a
 * forged result to us. Authentication is the ONLY barrier. Before trusting the
 * claimed sender we therefore replicate `receiveShare`'s gate:
 *   1. binding check — `opened.signerDid === opened.fromAgentId` (and non-empty),
 *   2. resolve + pin the sender DID (TOFU pin + signed-rotation evaluation),
 *   3. hand `importMissionResult` a REAL `DidVerifier` bound to the pinned key, so
 *      `verifier.verify(fromAgentId, proof)` runs the Ed25519 signature check against
 *      the pinned key — NOT the no-op `tofuVerifier` the importer defaults to.
 * Replay is deduped on a hash of the whole sealed blob (durable `SeenLedger`), matching the share path.
 */
const OURO_RESULT_KIND = "mission_result"

/** The harness result DataPart payload: the friends sealed shape + the discriminator. */
interface MissionResultDataPart {
  kind: "data"
  data: {
    v: number
    sealed: SealedEnvelope["sealed"]
    recipientDid: string
    ouroKind: typeof OURO_RESULT_KIND
  }
}

interface MissionResultMessage {
  messageId: string
  role: "agent"
  parts: [MissionResultDataPart]
}

/** Wrap a sealed result envelope into the harness-owned `mission_result` DataPart. */
export function wrapMissionResultDataPart(input: { sealedEnvelope: SealedEnvelope; recipientDid: string }): MissionResultMessage {
  return {
    messageId: `result-${Math.random().toString(36).slice(2)}`,
    role: "agent",
    parts: [{
      kind: "data",
      data: {
        v: input.sealedEnvelope.v,
        sealed: input.sealedEnvelope.sealed,
        recipientDid: input.recipientDid,
        ouroKind: OURO_RESULT_KIND,
      },
    }],
  }
}

/** Whether an inbound message carries the harness-owned `mission_result` DataPart. */
export function isMissionResultDataPart(message: A2AMessage): boolean {
  if (!Array.isArray(message.parts)) return false
  return message.parts.some((p) =>
    p && p.kind === "data" && typeof p.data === "object" && p.data !== null
    && (p.data as { ouroKind?: unknown }).ouroKind === OURO_RESULT_KIND)
}

/** Extract the sealed envelope from a `mission_result` DataPart, or null. */
function unwrapMissionResultDataPart(message: A2AMessage): { sealed: SealedEnvelope; recipientDid: string } | null {
  if (!Array.isArray(message.parts) || message.parts.length !== 1) return null
  const part = message.parts[0]
  if (!part || part.kind !== "data" || !part.data) return null
  const data = part.data as { v?: unknown; sealed?: unknown; recipientDid?: unknown; ouroKind?: unknown }
  if (data.ouroKind !== OURO_RESULT_KIND) return null
  if (typeof data.v !== "number" || typeof data.recipientDid !== "string" || !data.sealed) return null
  return { sealed: { v: data.v, sealed: data.sealed as SealedEnvelope["sealed"] }, recipientDid: data.recipientDid }
}

/**
 * The dependencies the inbound result wire needs. Carries the SAME authentication
 * seam the inbound share bridge builds (`pinStore` + `seen` + `didResolution`), so
 * the result wire verifies the sender exactly like `receiveShare` rather than
 * trusting the envelope's self-asserted `fromAgentId`.
 */
export interface InboundResultDeps {
  sodium: Sodium
  store: FriendStore
  missionStore: MissionStore
  pinStore: PinStore
  seen: SeenLedgerLike
  didResolution: HarnessDidResolution
  identity: A2AIdentity
  /** Clock and age windows for the signed binding check (tests inject a clock). Unbound envelopes are always refused. */
  bindingOptions?: Omit<EnvelopeBindingOptions, "rejectUnboundEnvelopes">
}

/** The ledger key for one sealed blob: a hash over its ephemeral key, nonce and ciphertext. Same form as friends'
 * `receiveShare` key, so a blob accepted on either path is a replay on the other. */
export function sealedBlobKey(sodium: Sodium, blob: SealedEnvelope["sealed"]): string {
  const digest = sodium.crypto_generichash(24, `${blob.ePk}|${blob.n}|${blob.ct}`, null)
  return `blob:${sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING)}`
}

/** Results being processed, per seen ledger: a parallel duplicate is refused as `in_flight` (retryable) without
 * touching the durable ledger, matching friends' `receiveShare`. */
const IN_FLIGHT = new WeakMap<SeenLedgerLike, Set<string>>()
function inFlightFor(seen: SeenLedgerLike): Set<string> {
  let set = IN_FLIGHT.get(seen)
  if (!set) {
    set = new Set()
    IN_FLIGHT.set(seen, set)
  }
  return set
}

function rejectResult(reason: string, message: string, meta: Record<string, unknown> = {}): InboundResultOutcome {
  emitNervesEvent({ component: "channels", event: "channel.a2a_result_rejected", message, meta: { reason, ...meta } })
  return { outcome: "rejected", reason }
}

/** The outcome of routing an inbound `mission_result` DataPart. */
export type InboundResultOutcome =
  | { outcome: "imported"; verifiedDid: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "not-a-result" }

/**
 * Route an inbound `mission_result` DataPart to `importMissionResult`, AUTHENTICATING
 * the sender exactly like `receiveShare` does for every other inbound kind.
 *
 * Ordering (mirrors the share bridge's trust trap + authentication gate):
 *   1. recognize + unwrap the harness `mission_result` carrier (else `not-a-result`).
 *   2. replay dedup on a hash of the whole sealed blob, then the in-flight claim on
 *      that hash. The bare seal nonce is never consulted.
 *   3. `openSealedEnvelope` → AEAD-decrypt only (unseal/recipient failures → reject).
 *   4. sender binding — reject unless `opened.signerDid === opened.fromAgentId` (and
 *      non-empty): the advisory `signerDid` (outer, unsigned) must match the claimed
 *      sender. A divergence is a forged/spoofed bundle (`sender_binding_mismatch`).
 *   5. a retired sender pin → `retired_pin`.
 *   6. the signed envelope binding (`checkEnvelopeBinding`: this recipient, this kind,
 *      a fresh issue time, an unseen `mid:` message id), then claim the blob hash and
 *      the `mid:` key in flight (released on every exit).
 *   7. `settleSender` — apply a signed rotation to the sender DID, or finish one whose
 *      record did not follow, BEFORE trust is read (refused → `resolve_failed`).
 *   8. read trust by the sender DID, then `resolveAndPin` it (TOFU pin) → the pinned
 *      key (unresolvable → `resolve_failed`).
 *   9. build a `DidVerifier` bound to THIS envelope + the pinned key and call
 *      `importMissionResult({ envelope, fromAgentId: <signed DID>, trustOfSource },
 *      { verifier })`. The verifier runs the REAL signature check against the pinned
 *      key and marks the claimed keys seen only when it passes; a result signed with
 *      any other key is rejected (`untrusted_source`). Every authorization gate
 *      (no_mission / no_delegation / assignee_mismatch, fail-closed on a legacy
 *      assignee-less delegation) is still enforced by the importer.
 */
export async function receiveInboundMissionResult(message: A2AMessage, deps: InboundResultDeps): Promise<InboundResultOutcome> {
  const payload = unwrapMissionResultDataPart(message)
  if (!payload) return { outcome: "not-a-result" }

  // Replay dedup BEFORE any state change, keyed only on a hash of the whole sealed blob. The sender picks the seal
  // nonce, and friends' share path marks a bare nonce for any share whose signature verifies, so reading the bare nonce
  // here would let a stranger's share or result burn a real result. A re-sealed copy of the same signed result is still
  // refused by its `mid:` key, and re-importing a result changes nothing (the first result per request wins).
  const blobKey = sealedBlobKey(deps.sodium, payload.sealed.sealed)
  if (deps.seen.isSeen(blobKey)) {
    return rejectResult("replayed", "rejected inbound mission_result (already received)")
  }
  const inFlight = inFlightFor(deps.seen)
  if (inFlight.has(blobKey)) return rejectResult("in_flight", "rejected inbound mission_result (the same result is being processed)")

  const recipientIdentity = { x25519Priv: deps.identity.x25519Priv, x25519Pub: deps.identity.x25519Pub }
  const opened = openSealedEnvelope({
    sodium: deps.sodium,
    sealedEnvelope: payload.sealed,
    recipientDid: deps.identity.did,
    recipientIdentity,
  })
  if (!opened.ok) {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_result_rejected",
      message: "rejected inbound mission_result (unseal/recipient)",
      meta: { reason: opened.error },
    })
    return { outcome: "rejected", reason: opened.error }
  }

  // SECURITY (binding): the trustworthy sender identity is the SIGNED `fromAgentId`.
  // `openSealedEnvelope` does NOT verify the signature, so `fromAgentId` is untrusted
  // until the DidVerifier confirms the pinned key signed THIS envelope. The advisory
  // `signerDid` (from the outer, unsigned sealed plaintext) must match the claimed
  // sender; a divergence is a forged/spoofed bundle (e.g. an attacker signing with its
  // OWN key while claiming a victim's DID). Reject before resolving or importing.
  const senderDid = opened.fromAgentId
  if (senderDid.length === 0 || opened.signerDid !== senderDid) {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_result_rejected",
      message: "rejected inbound mission_result (sender binding mismatch — forged sender)",
      meta: { reason: "sender_binding_mismatch", claimedDid: senderDid, signerDid: opened.signerDid },
    })
    return { outcome: "rejected", reason: "sender_binding_mismatch" }
  }

  // A retired pin is a tombstone: the old DID's key verifies nothing (matches receiveShare).
  if (deps.pinStore.get(senderDid)?.retiredBy !== undefined) {
    return rejectResult("retired_pin", "rejected inbound mission_result (the sender's DID was rotated away)", { verifiedDid: senderDid })
  }
  // The signed binding: this recipient, this kind, a fresh issue time and an unseen message id.
  const binding = checkEnvelopeBinding(opened, { ...bindingWindowsWithinRetention(deps.bindingOptions), rejectUnboundEnvelopes: true, recipientDid: deps.identity.did, seen: deps.seen })
  if (!binding.ok) return rejectResult(binding.reason, "rejected inbound mission_result (signed binding)", { verifiedDid: senderDid })
  /* v8 ignore next -- an unbound envelope is refused above, so a passing binding always carries its seen key @preserve */
  const claimed = binding.seenKey ? [blobKey, binding.seenKey] : [blobKey]
  /* v8 ignore next -- the same binding id under a different seal nonce needs a hand-built seal (sealEnvelope mints a fresh id) @preserve */
  if (claimed.some((key) => inFlight.has(key))) return rejectResult("in_flight", "rejected inbound mission_result (the same result is being processed)")
  for (const key of claimed) inFlight.add(key)
  try {
    return await processClaimedResult(opened, senderDid, claimed, deps)
  } finally {
    for (const key of claimed) inFlight.delete(key)
  }
}

async function processClaimedResult(
  opened: Extract<ReturnType<typeof openSealedEnvelope>, { ok: true }>,
  senderDid: string,
  claimed: string[],
  deps: InboundResultDeps,
): Promise<InboundResultOutcome> {
  // Settle a rotation to this DID first, so the first result after it is judged against the moved record.
  if (!(await deps.didResolution.settleSender({ did: senderDid, pinStore: deps.pinStore }))) {
    return rejectResult("resolve_failed", "rejected inbound mission_result (the sender's key rotation could not be applied)", { verifiedDid: senderDid })
  }

  // Read trust from the friend store BY the verified DID — never defaulted, never from
  // the envelope. Unknown (or empty) DID ⇒ stranger.
  const record = await findFriendByDid(deps.store, senderDid)
  const trust: TrustLevel = record?.trustLevel ?? "stranger"

  // Resolve + pin the SENDER's DID (async — BEFORE the sync verifier/importer).
  const resolved = await deps.didResolution.resolveAndPin({
    fromAgentId: senderDid,
    did: senderDid,
    pinStore: deps.pinStore,
    trustOfSource: trust,
  })
  if (!resolved) {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_result_rejected",
      message: "rejected inbound mission_result (sender DID resolve/pin failed)",
      meta: { reason: "resolve_failed", verifiedDid: senderDid, trust },
    })
    return { outcome: "rejected", reason: "resolve_failed" }
  }

  // Build the sync verifier bound to THIS envelope + the pinned sender key. This is the
  // single authentication gate (the importer would otherwise default to the no-op TOFU
  // verifier). `verify` confirms the agentId===did binding AND the Ed25519 signature
  // over the envelope against the pinned key.
  const didVerifier = new DidVerifier({
    sodium: deps.sodium,
    pinnedEd25519Pub: resolved.ed25519Pub,
    pinnedDid: senderDid,
    envelope: opened.envelope,
  })
  // The result is consumed the moment its signature verifies (and not before), so a failure before that leaves it
  // redeliverable. The keys are the whole-blob hash and the sender-scoped `mid:` id, so no other sender's message,
  // share or result, can burn this one by reusing its seal nonce.
  const verifier = {
    verify(fromAgentId: string, proof: unknown): boolean {
      const ok = didVerifier.verify(fromAgentId, proof as Parameters<DidVerifier["verify"]>[1])
      if (ok) for (const key of claimed) deps.seen.markSeen(key)
      return ok
    },
  }

  const result = await importMissionResult(
    deps.missionStore,
    {
      envelope: opened.envelope as unknown as MissionResultEnvelope,
      fromAgentId: senderDid,
      trustOfSource: trust,
    },
    { verifier },
  )

  if (result.ok) {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_result_imported",
      message: "imported inbound mission_result (authenticated, quarantined, attributed)",
      meta: { verifiedDid: senderDid, trust, status: result.status },
    })
    return { outcome: "imported", verifiedDid: senderDid }
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_result_rejected",
    message: "rejected inbound mission_result (import gate)",
    meta: { reason: result.status, verifiedDid: senderDid, trust },
  })
  return { outcome: "rejected", reason: result.status }
}
