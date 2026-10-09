import { didKeyIdentityFromEd25519, ready, type DidKeyIdentity } from "@ouro.bot/friends/a2a-client"
import { signResolution, type ResolutionClaim } from "../../a2a/resolution-proof"

/** A throwaway did:key identity standing in for an escalation holder's machine key. */
export async function makeTestIdentity(): Promise<DidKeyIdentity> {
  const sodium = await ready()
  const pair = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: pair.publicKey, ed25519Priv: pair.privateKey })
}

/** The signed fields a holder sends with report/resolve. */
export async function signedResolution(identity: DidKeyIdentity, claim: Omit<ResolutionClaim, "resolvedAt"> & { resolvedAt?: string }): Promise<{ resolvedAt: string; proof: ReturnType<typeof signResolution> }> {
  const resolvedAt = claim.resolvedAt ?? "2026-10-08T12:00:00.000Z"
  return { resolvedAt, proof: signResolution({ sodium: await ready(), identity, claim: { ...claim, resolvedAt } }) }
}

/** The part of a friend record that names the holder's DID. */
export function agentMetaFor(identity: DidKeyIdentity): { bundleName: string; familiarity: number; sharedMissions: string[]; outcomes: never[]; a2a: { did: string } } {
  return { bundleName: "holder", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { did: identity.did } }
}
