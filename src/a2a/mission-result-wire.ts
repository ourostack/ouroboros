import {
  openSealedEnvelope,
  type SealedEnvelope,
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
import type { A2AIdentity } from "./identity"
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

/** The dependencies the inbound result wire needs. */
export interface InboundResultDeps {
  sodium: Sodium
  store: FriendStore
  missionStore: MissionStore
  identity: A2AIdentity
}

/** The outcome of routing an inbound `mission_result` DataPart. */
export type InboundResultOutcome =
  | { outcome: "imported"; verifiedDid: string }
  | { outcome: "rejected"; reason: string }
  | { outcome: "not-a-result" }

/**
 * Route an inbound `mission_result` DataPart to `importMissionResult`.
 *
 * Ordering (mirrors the coordination inbound bridge's trust trap):
 *   1. recognize + unwrap the harness `mission_result` carrier (else `not-a-result`).
 *   2. `openSealedEnvelope` → the SIGNED sender DID (unseal/recipient failures → reject).
 *   3. `findFriendByDid` → read trust BY the verified DID (unknown → stranger, never up).
 *   4. `importMissionResult({ envelope, fromAgentId: <signed DID>, trustOfSource })` —
 *      the TRANSPORT-supplied `fromAgentId` is the authenticated identity (the result
 *      envelope's self-asserted `fromAgentId` is vestigial). Every gate
 *      (untrusted_source / no_mission / no_delegation / assignee_mismatch, fail-closed
 *      on a legacy assignee-less delegation) is enforced by the importer.
 */
export async function receiveInboundMissionResult(message: A2AMessage, deps: InboundResultDeps): Promise<InboundResultOutcome> {
  const payload = unwrapMissionResultDataPart(message)
  if (!payload) return { outcome: "not-a-result" }

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

  const verifiedDid = opened.fromAgentId
  const record = await findFriendByDid(deps.store, verifiedDid)
  const trust: TrustLevel = record?.trustLevel ?? "stranger"

  const result = await importMissionResult(deps.missionStore, {
    envelope: opened.envelope as unknown as MissionResultEnvelope,
    fromAgentId: verifiedDid,
    trustOfSource: trust,
  })

  if (result.ok) {
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_result_imported",
      message: "imported inbound mission_result (quarantined, attributed)",
      meta: { verifiedDid, trust, status: result.status },
    })
    return { outcome: "imported", verifiedDid }
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_result_rejected",
    message: "rejected inbound mission_result (import gate)",
    meta: { reason: result.status, verifiedDid, trust },
  })
  return { outcome: "rejected", reason: result.status }
}
