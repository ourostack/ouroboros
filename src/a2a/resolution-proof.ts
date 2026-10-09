import { parseDidKey, signEnvelope, verifyEnvelopeSignature, type DidKeyIdentity, type Sodium, type StructuredProof } from "@ouro.bot/friends/a2a-client"
import { resolveAgentIdentity, type FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The proof that an escalation holder, and nobody who can write the Butler's files, said a failure report is fixed.
 * The holder signs `{reportId, version, note, resolvedAt}` with its DID key (canonical JSON, detached Ed25519), and
 * the Butler keeps the signature next to the resolution. The holder's private key never leaves the holder's machine,
 * so a forged report file cannot carry a valid one.
 */
export interface ResolutionClaim {
  reportId: string
  version: string
  note: string
  resolvedAt: string
}

export type ResolutionProof = StructuredProof

export function signResolution(input: { sodium: Sodium; identity: DidKeyIdentity; claim: ResolutionClaim }): ResolutionProof {
  const { claim } = input
  return signEnvelope({
    sodium: input.sodium,
    envelope: { reportId: claim.reportId, version: claim.version, note: claim.note, resolvedAt: claim.resolvedAt },
    signerEd25519Priv: input.identity.ed25519Priv,
    signerDid: input.identity.did,
    signerKeyId: input.identity.keyId,
  })
}

/** The DID a holder's friend record names; the signer must be exactly this one. */
export function friendDid(friend: FriendRecord): string | null {
  return resolveAgentIdentity(friend.agentMeta).did ?? null
}

export type ResolutionCheck = { ok: true } | { ok: false; reason: "no_proof" | "no_holder_did" | "wrong_signer" | "bad_signature" }

export function verifyResolution(input: { sodium: Sodium; claim: ResolutionClaim; proof: unknown; holderDid: string | null }): ResolutionCheck {
  const fail = (reason: Exclude<ResolutionCheck, { ok: true }>["reason"]): ResolutionCheck => {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.a2a_resolution_proof_rejected", message: "rejected a report resolution without a valid holder signature", meta: { reportId: input.claim.reportId, reason } })
    return { ok: false, reason }
  }
  const proof = input.proof
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return fail("no_proof")
  if (!input.holderDid) return fail("no_holder_did")
  const parsed = parseDidKey(input.holderDid)
  if (!parsed || (proof as { signerDid?: unknown }).signerDid !== input.holderDid) return fail("wrong_signer")
  const valid = verifyEnvelopeSignature({
    sodium: input.sodium,
    envelope: { reportId: input.claim.reportId, version: input.claim.version, note: input.claim.note, resolvedAt: input.claim.resolvedAt },
    proof: proof as StructuredProof,
    signerEd25519Pub: parsed.ed25519Pub,
  })
  return valid ? { ok: true } : fail("bad_signature")
}
