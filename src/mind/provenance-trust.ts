import type { DiaryEntryProvenance } from "./diary"
import { isTrustedLevel, type TrustLevel } from "./friends/types"

export type ProvenanceTrust = "self" | "trusted" | "external"

/**
 * Classify a diary entry's provenance into a trust category.
 *
 * - No provenance, or inner channel with no friend -> "self"
 * - Family or friend trust (via isTrustedLevel) -> "trusted"
 * - Everything else (external channels, untrusted contacts) -> "external"
 */
export function classifyProvenanceTrust(provenance?: DiaryEntryProvenance): ProvenanceTrust {
  if (!provenance) return "self"

  // Inner channel with no friend context is self-authored
  if (provenance.channel === "inner" && !provenance.friendId) return "self"

  // No channel and no friend means self-authored (e.g. CLI diary_write with no context)
  if (!provenance.channel && !provenance.friendId) return "self"

  // If there's a trust level from a friend, classify by trust
  if (provenance.trust && isTrustedLevel(provenance.trust as TrustLevel)) return "trusted"

  // Everything else is external (non-inner channels without trusted friend)
  return "external"
}
