import * as path from "path"
import { FileFriendStore, getChannelCapabilities } from "@ouro.bot/friends"
import type { FriendRecord, ResolvedContext, TrustLevel } from "@ouro.bot/friends"
import { emitNervesEvent } from "../../nerves/runtime"

const SAFE_FRIEND_ID = /^[A-Za-z0-9._-]{1,128}$/
const LOCAL_ROOM_FRIEND_ID = "local-audio-room"
const TRUST_RANK: Record<TrustLevel, number> = { stranger: 0, acquaintance: 1, friend: 2, family: 3 }

/**
 * A local session runs at acquaintance unless the join says the room is the owner alone. The cap
 * only lowers: a record already below acquaintance stays where it is, and an unrecorded trust is
 * treated as acquaintance.
 */
export function capLocalTrust(recorded: TrustLevel | undefined, ownerAlone: boolean): TrustLevel {
  const effective: TrustLevel = recorded ?? "acquaintance"
  if (ownerAlone) return effective
  return TRUST_RANK[effective] > TRUST_RANK.acquaintance ? "acquaintance" : effective
}

function roomRecord(): FriendRecord {
  const now = new Date().toISOString()
  return {
    id: LOCAL_ROOM_FRIEND_ID,
    name: "Local audio room",
    trustLevel: "acquaintance",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  } as FriendRecord
}

export interface ResolvedLocalAudioFriend {
  friendId: string
  friendStore: FileFriendStore
  resolved: ResolvedContext
}

/**
 * Resolves who a local audio session is with. `friendId` comes from the join request (a local
 * pidfile/socket command or the family text tool), is validated as a safe id, and must match a
 * record id exactly (never a display name). Anything else maps to one stable room record. The
 * returned friend carries the capped effective trust for the whole session.
 */
export async function resolveLocalAudioFriend(options: {
  agentRoot: string
  friendId?: string
  ownerAlone: boolean
}): Promise<ResolvedLocalAudioFriend> {
  const friendStore = new FileFriendStore(path.join(options.agentRoot, "friends"))
  const requested = options.friendId?.trim()
  let friend: FriendRecord | null = null
  if (requested && SAFE_FRIEND_ID.test(requested) && requested !== "." && requested !== "..") {
    const existing = await friendStore.get(requested)
    if (existing && existing.id === requested) friend = existing
  }
  // No identified friend: the room is a stable, unprivileged record. It is built in memory rather
  // than resolved through FriendResolver, which would persist it (and treat the first friend ever
  // seen in an empty store as family).
  const identified = friend !== null
  friend ??= (await friendStore.get(LOCAL_ROOM_FRIEND_ID)) ?? roomRecord()
  const trustLevel = capLocalTrust(friend.trustLevel, identified && options.ownerAlone)
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_local_identity_resolved",
    message: "local audio session identity resolved",
    meta: { friendId: friend.id, recordedTrust: String(friend.trustLevel), effectiveTrust: trustLevel, ownerAlone: options.ownerAlone },
  })
  return {
    friendId: friend.id,
    friendStore,
    resolved: { friend: { ...friend, trustLevel }, channel: getChannelCapabilities("voice") },
  }
}
