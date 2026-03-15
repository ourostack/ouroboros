import type { Channel, FriendRecord, TrustLevel } from "./types"
import { emitNervesEvent } from "../../nerves/runtime"

export type TrustBasis = "direct" | "shared_group" | "unknown"

export interface TrustExplanation {
  level: TrustLevel
  basis: TrustBasis
  summary: string
  why: string
  permits: string[]
  constraints: string[]
  relatedGroupId?: string
}

function findRelatedGroupId(friend: FriendRecord): string | undefined {
  return friend.externalIds.find((externalId) => externalId.externalId.startsWith("group:"))?.externalId
}

function resolveLevel(friend: FriendRecord): TrustLevel {
  return friend.trustLevel ?? "stranger"
}

export function describeTrustContext(input: {
  friend: FriendRecord
  channel: Channel
  isGroupChat?: boolean
}): TrustExplanation {
  const level = resolveLevel(input.friend)
  const relatedGroupId = findRelatedGroupId(input.friend)

  const explanation: TrustExplanation = level === "family" || level === "friend"
    ? {
        level,
        basis: "direct",
        summary: level === "family"
          ? "direct family trust"
          : "direct trusted relationship",
        why: "this relationship is directly trusted rather than inferred through a shared group or cold first contact.",
        permits: [
          "local operations when appropriate",
          "proactive follow-through",
          "full collaborative problem solving",
        ],
        constraints: [],
      }
    : level === "acquaintance"
      ? {
          level,
          basis: "shared_group",
          summary: relatedGroupId
            ? "known through the shared project group"
            : "known through a shared group context",
          why: relatedGroupId
            ? `this trust comes from the shared group context ${relatedGroupId}, not from direct endorsement.`
            : "this trust comes from shared group context rather than direct endorsement.",
          permits: [
            "group-safe coordination",
            "normal conversation inside the shared context",
          ],
          constraints: [
            "guarded local actions",
            "do not assume broad private authority",
          ],
          relatedGroupId,
        }
      : {
          level,
          basis: "unknown",
          summary: "truly unknown first-contact context",
          why: "this person is not known through direct trust or a shared group context.",
          permits: [
            "safe first-contact orientation only",
          ],
          constraints: [
            "first contact does not reach the full model on open channels",
            "no local or privileged actions",
          ],
        }

  emitNervesEvent({
    component: "friends",
    event: "friends.trust_explained",
    message: "built explicit trust explanation",
    meta: {
      channel: input.channel,
      level: explanation.level,
      basis: explanation.basis,
      hasRelatedGroup: Boolean(explanation.relatedGroupId),
    },
  })

  return explanation
}
