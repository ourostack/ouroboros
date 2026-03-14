import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "../../nerves/runtime"
import type { FriendStore } from "./store"
import type { FriendRecord, IdentityProvider, TrustLevel } from "./types"

const CURRENT_SCHEMA_VERSION = 1

export interface GroupContextParticipant {
  provider: "imessage-handle" | "aad" | "teams-conversation"
  externalId: string
  displayName?: string
}

export interface GroupContextUpsertResult {
  friendId: string
  name: string
  trustLevel: TrustLevel
  created: boolean
  updated: boolean
  addedGroupExternalId: boolean
}

function normalizeDisplayName(externalId: string, displayName?: string): string {
  const trimmed = displayName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : externalId
}

function buildNameNotes(name: string, now: string): FriendRecord["notes"] {
  return name !== "Unknown"
    ? { name: { value: name, savedAt: now } }
    : {}
}

function dedupeParticipants(participants: GroupContextParticipant[]): GroupContextParticipant[] {
  const deduped = new Map<string, GroupContextParticipant>()
  for (const participant of participants) {
    const externalId = participant.externalId.trim()
    if (!externalId) continue
    const key = `${participant.provider}:${externalId}`
    if (!deduped.has(key)) {
      deduped.set(key, {
        ...participant,
        externalId,
        displayName: participant.displayName?.trim() || undefined,
      })
    }
  }
  return Array.from(deduped.values())
}

function createGroupExternalId(provider: IdentityProvider, groupExternalId: string, linkedAt: string) {
  return {
    provider,
    externalId: groupExternalId,
    linkedAt,
  }
}

function shouldPromoteToAcquaintance(friend: FriendRecord): boolean {
  return (friend.trustLevel ?? "stranger") === "stranger"
}

function createAcquaintanceRecord(
  participant: GroupContextParticipant,
  groupExternalId: string,
  linkedAt: string,
): FriendRecord {
  const name = normalizeDisplayName(participant.externalId, participant.displayName)
  return {
    id: randomUUID(),
    name,
    role: "acquaintance",
    trustLevel: "acquaintance",
    connections: [],
    externalIds: [
      {
        provider: participant.provider,
        externalId: participant.externalId,
        linkedAt,
      },
      createGroupExternalId(participant.provider, groupExternalId, linkedAt),
    ],
    tenantMemberships: [],
    toolPreferences: {},
    notes: buildNameNotes(name, linkedAt),
    totalTokens: 0,
    createdAt: linkedAt,
    updatedAt: linkedAt,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  }
}

export async function upsertGroupContextParticipants(input: {
  store: FriendStore
  participants: GroupContextParticipant[]
  groupExternalId: string
  now?: () => string
}): Promise<GroupContextUpsertResult[]> {
  emitNervesEvent({
    component: "friends",
    event: "friends.group_context_upsert_start",
    message: "upserting shared-group participant context",
    meta: {
      participantCount: input.participants.length,
      hasGroupExternalId: input.groupExternalId.trim().length > 0,
    },
  })

  const groupExternalId = input.groupExternalId.trim()
  if (!groupExternalId) {
    return []
  }

  const now = input.now ?? (() => new Date().toISOString())
  const participants = dedupeParticipants(input.participants)
  const results: GroupContextUpsertResult[] = []

  for (const participant of participants) {
    const linkedAt = now()
    const existing = await input.store.findByExternalId(participant.provider, participant.externalId)

    if (!existing) {
      const created = createAcquaintanceRecord(participant, groupExternalId, linkedAt)
      await input.store.put(created.id, created)
      results.push({
        friendId: created.id,
        name: created.name,
        trustLevel: "acquaintance",
        created: true,
        updated: false,
        addedGroupExternalId: true,
      })
      continue
    }

    const hasGroupExternalId = existing.externalIds.some((externalId) => externalId.externalId === groupExternalId)
    const promoteToAcquaintance = shouldPromoteToAcquaintance(existing)
    const trustLevel: TrustLevel = promoteToAcquaintance
      ? "acquaintance"
      : existing.trustLevel!
    const role = promoteToAcquaintance
      ? "acquaintance"
      : existing.role

    const updatedExternalIds = hasGroupExternalId
      ? existing.externalIds
      : [...existing.externalIds, createGroupExternalId(participant.provider, groupExternalId, linkedAt)]

    const updated = promoteToAcquaintance || !hasGroupExternalId
    const record: FriendRecord = updated
      ? {
          ...existing,
          role,
          trustLevel,
          externalIds: updatedExternalIds,
          updatedAt: linkedAt,
        }
      : existing

    if (updated) {
      await input.store.put(record.id, record)
    }

    results.push({
      friendId: record.id,
      name: record.name,
      trustLevel,
      created: false,
      updated,
      addedGroupExternalId: !hasGroupExternalId,
    })
  }

  emitNervesEvent({
    component: "friends",
    event: "friends.group_context_upsert_end",
    message: "upserted shared-group participant context",
    meta: {
      participantCount: participants.length,
      updatedCount: results.filter((result) => result.created || result.updated).length,
    },
  })

  return results
}
