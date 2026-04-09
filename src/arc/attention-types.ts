/**
 * Shared attention queue types.
 *
 * Canonical home for the AttentionItem interface — consumed by heart/, repertoire/, nerves/, and senses/.
 * Placed in heart/ because attention is a turn-coordination concern.
 */

export interface AttentionItem {
  id: string
  friendId: string
  friendName: string
  channel: string
  key: string
  bridgeId?: string
  delegatedContent: string
  obligationId?: string
  packetId?: string
  packetKind?: string
  packetObjective?: string
  packetSummary?: string
  source: "drained" | "obligation-recovery"
  timestamp: number
}
