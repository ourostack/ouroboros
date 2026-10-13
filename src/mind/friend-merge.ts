// Merging friend records into one person, and retiring the merged-away records.
//
// Two product paths use this: redeeming an identity link code (a new channel identity
// joins its owner's record) and deduplicating records that name the same local person.
// The target record stays authoritative: a merge never raises trust, admission,
// initiative or capability, so merging cannot be used to escalate anyone.
//
// A retired record is kept as a tombstone in `friends/_retired/` (outside the store's
// listing), never deleted silently. External-identity claim journals that pointed at the
// retired record move beside it, so the store's claim ledger never names a record that
// no longer exists. The claim journal layout belongs to @ouro.bot/friends; this module
// only moves whole journal files and never rewrites them.
import * as fs from "node:fs"
import * as path from "node:path"
import type { ExternalId, FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

const RETIRED_DIR = "_retired"
const CLAIMS_DIR = "_external-id-claims"
const CLAIM_FILE = /^[a-f0-9]{64}\.json$/

export interface FriendMergeInput {
  store: FriendStore
  /** The store's directory. Tombstones and moved claim journals live beneath it. */
  friendsDir: string
  targetId: string
  sourceIds: string[]
  /** Who asked for the merge, for the audit trail (for example `cli:dedupe`). */
  actor: string
  reason: string
  dryRun?: boolean
  now?: () => Date
}

export interface FriendMergeRetirement {
  friendId: string
  name: string
  tombstonePath: string
  movedClaims: string[]
}

export type FriendMergeResult =
  | {
    ok: true
    dryRun: boolean
    target: FriendRecord
    addedExternalIds: ExternalId[]
    /** Source notes whose key collided with a different value, kept under a suffixed key. */
    preservedNoteKeys: string[]
    retired: FriendMergeRetirement[]
  }
  | { ok: false; reason: "target_not_found" | "source_not_found" | "invalid_sources" | "kind_mismatch"; message: string }

export function externalIdKey(externalId: Pick<ExternalId, "provider" | "externalId" | "tenantId">): string {
  return JSON.stringify([externalId.provider, externalId.externalId, externalId.tenantId ?? null])
}

/** Fold the sources into the target. The target's relationship fields always win. */
export function mergeFriendRecordContent(target: FriendRecord, sources: FriendRecord[], nowIso: string): {
  merged: FriendRecord
  addedExternalIds: ExternalId[]
  preservedNoteKeys: string[]
} {
  const externalIds = [...target.externalIds]
  const seenIds = new Set(externalIds.map(externalIdKey))
  const addedExternalIds: ExternalId[] = []
  const notes = { ...target.notes }
  const preservedNoteKeys: string[] = []
  const tenantMemberships = [...target.tenantMemberships]
  const toolPreferences = { ...target.toolPreferences }
  const connections = [...(target.connections ?? [])]
  const importedNotes: NonNullable<FriendRecord["importedNotes"]> = { ...(target.importedNotes ?? {}) }
  let totalTokens = target.totalTokens
  let createdAt = target.createdAt

  for (const source of sources) {
    for (const externalId of source.externalIds) {
      const key = externalIdKey(externalId)
      if (seenIds.has(key)) continue
      seenIds.add(key)
      externalIds.push(externalId)
      addedExternalIds.push(externalId)
    }
    for (const [key, note] of Object.entries(source.notes)) {
      const existing = notes[key]
      if (!existing) {
        notes[key] = note
        continue
      }
      if (existing.value === note.value) continue
      const preservedKey = `${key}~${source.id.slice(0, 8)}`
      if (notes[preservedKey]) continue
      notes[preservedKey] = note
      preservedNoteKeys.push(preservedKey)
    }
    for (const tenant of source.tenantMemberships) {
      if (!tenantMemberships.includes(tenant)) tenantMemberships.push(tenant)
    }
    for (const [tool, preference] of Object.entries(source.toolPreferences)) {
      if (!(tool in toolPreferences)) toolPreferences[tool] = preference
    }
    for (const connection of source.connections ?? []) {
      if (!connections.some((known) => known.name === connection.name && known.relationship === connection.relationship)) {
        connections.push(connection)
      }
    }
    for (const [agentKey, imported] of Object.entries(source.importedNotes ?? {})) {
      importedNotes[agentKey] = { ...imported, ...(importedNotes[agentKey] ?? {}) }
    }
    totalTokens += source.totalTokens
    if (source.createdAt < createdAt) createdAt = source.createdAt
  }

  const merged: FriendRecord = {
    ...target,
    externalIds,
    notes,
    tenantMemberships,
    toolPreferences,
    connections,
    ...(Object.keys(importedNotes).length > 0 ? { importedNotes } : {}),
    totalTokens,
    createdAt,
    updatedAt: nowIso,
  }
  return { merged, addedExternalIds, preservedNoteKeys }
}

function writePrivateJson(filePath: string, value: unknown): void {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, filePath)
}

function uniqueTombstonePath(retiredDir: string, friendId: string, nowIso: string): string {
  const plain = path.join(retiredDir, `${friendId}.json`)
  if (!fs.existsSync(plain)) return plain
  return path.join(retiredDir, `${friendId}.${nowIso.replace(/[:.]/g, "-")}.json`)
}

/** Move every claim journal that names `friendId` out of the live claim ledger. */
function moveClaimJournals(friendsDir: string, friendId: string): string[] {
  const claimsDir = path.join(friendsDir, CLAIMS_DIR)
  if (!fs.existsSync(claimsDir)) return []
  const retiredClaimsDir = path.join(friendsDir, RETIRED_DIR, "external-id-claims")
  const moved: string[] = []
  for (const entry of fs.readdirSync(claimsDir)) {
    if (!CLAIM_FILE.test(entry)) continue
    let claim: { friendId?: unknown }
    try {
      claim = JSON.parse(fs.readFileSync(path.join(claimsDir, entry), "utf-8")) as { friendId?: unknown }
    } catch {
      continue
    }
    if (claim.friendId !== friendId) continue
    fs.mkdirSync(retiredClaimsDir, { recursive: true, mode: 0o700 })
    fs.renameSync(path.join(claimsDir, entry), path.join(retiredClaimsDir, entry))
    moved.push(entry)
  }
  return moved
}

export async function mergeFriends(input: FriendMergeInput): Promise<FriendMergeResult> {
  const nowIso = (input.now ?? (() => new Date()))().toISOString()
  const dryRun = input.dryRun === true
  const sourceIds = [...new Set(input.sourceIds)]
  if (sourceIds.length === 0 || sourceIds.includes(input.targetId)) {
    return { ok: false, reason: "invalid_sources", message: "name at least one record to merge, other than the target" }
  }
  const target = await input.store.get(input.targetId)
  if (!target || target.id !== input.targetId) {
    return { ok: false, reason: "target_not_found", message: `friend not found: ${input.targetId}` }
  }
  const sources: FriendRecord[] = []
  for (const sourceId of sourceIds) {
    const source = await input.store.get(sourceId)
    if (!source || source.id !== sourceId) {
      return { ok: false, reason: "source_not_found", message: `friend not found: ${sourceId}` }
    }
    if ((source.kind ?? "human") !== (target.kind ?? "human")) {
      return { ok: false, reason: "kind_mismatch", message: `cannot merge ${sourceId} into ${target.id}: an agent and a human are different friends` }
    }
    sources.push(source)
  }

  const { merged, addedExternalIds, preservedNoteKeys } = mergeFriendRecordContent(target, sources, nowIso)
  const retiredDir = path.join(input.friendsDir, RETIRED_DIR)

  if (dryRun) {
    return {
      ok: true,
      dryRun,
      target: merged,
      addedExternalIds,
      preservedNoteKeys,
      retired: sources.map((source) => ({ friendId: source.id, name: source.name, tombstonePath: path.join(retiredDir, `${source.id}.json`), movedClaims: [] })),
    }
  }

  // Order: tombstones first (nothing is lost if we stop), then the target gains the
  // identities, then the sources leave the store and their claim journals follow them.
  fs.mkdirSync(retiredDir, { recursive: true, mode: 0o700 })
  const tombstones = sources.map((source) => {
    const tombstonePath = uniqueTombstonePath(retiredDir, source.id, nowIso)
    writePrivateJson(tombstonePath, {
      schemaVersion: 1,
      retiredAt: nowIso,
      retiredInto: target.id,
      actor: input.actor,
      reason: input.reason,
      record: source,
    })
    return { source, tombstonePath }
  })
  await input.store.put(target.id, merged)
  const retired: FriendMergeRetirement[] = []
  for (const { source, tombstonePath } of tombstones) {
    await input.store.delete(source.id)
    const movedClaims = moveClaimJournals(input.friendsDir, source.id)
    retired.push({ friendId: source.id, name: source.name, tombstonePath, movedClaims })
    emitNervesEvent({
      component: "friends",
      event: "friends.record_retired",
      message: "retired a friend record into another record",
      meta: { friendId: source.id, retiredInto: target.id, actor: input.actor, movedClaims: movedClaims.length },
    })
  }
  const stored = (await input.store.get(target.id)) ?? merged

  emitNervesEvent({
    component: "friends",
    event: "friends.records_merged",
    message: "merged friend records",
    meta: {
      targetId: target.id,
      sourceIds,
      actor: input.actor,
      reason: input.reason,
      addedExternalIds: addedExternalIds.map((externalId) => externalId.provider),
      preservedNoteKeys: preservedNoteKeys.length,
    },
  })
  return { ok: true, dryRun, target: stored, addedExternalIds, preservedNoteKeys, retired }
}

// ── Duplicate consolidation ──

export interface FriendDedupeGroup {
  canonical: FriendRecord
  duplicates: FriendRecord[]
}

function isLocalOnly(record: FriendRecord): boolean {
  return record.externalIds.length > 0 && record.externalIds.every((externalId) => externalId.provider === "local")
}

function canonicalOrder(a: FriendRecord, b: FriendRecord): number {
  const notes = Object.keys(b.notes).length - Object.keys(a.notes).length
  if (notes !== 0) return notes
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : 1
}

/**
 * Records are duplicates when they are human, carry only local identities, share the
 * same name and trust level, and are joined through at least one shared local identity.
 * The canonical record is the one with the most notes, then the oldest.
 */
export function planFriendDedupe(records: FriendRecord[]): FriendDedupeGroup[] {
  const buckets = new Map<string, FriendRecord[]>()
  for (const record of records) {
    if ((record.kind ?? "human") !== "human" || !isLocalOnly(record)) continue
    const key = JSON.stringify([record.name.trim().toLowerCase(), record.trustLevel ?? "friend"])
    buckets.set(key, [...(buckets.get(key) ?? []), record])
  }

  const groups: FriendDedupeGroup[] = []
  for (const bucket of buckets.values()) {
    // Union records that share any local identity.
    const parent = bucket.map((_, index) => index)
    const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)))
    const owner = new Map<string, number>()
    bucket.forEach((record, index) => {
      for (const externalId of record.externalIds) {
        const key = externalIdKey(externalId)
        const seen = owner.get(key)
        if (seen === undefined) owner.set(key, index)
        else parent[find(index)] = find(seen)
      }
    })
    const components = new Map<number, FriendRecord[]>()
    bucket.forEach((record, index) => {
      const root = find(index)
      components.set(root, [...(components.get(root) ?? []), record])
    })
    for (const members of components.values()) {
      if (members.length < 2) continue
      const [canonical, ...duplicates] = [...members].sort(canonicalOrder)
      groups.push({ canonical: canonical!, duplicates })
    }
  }
  return groups.sort((a, b) => canonicalOrder(a.canonical, b.canonical))
}

export interface FriendDedupeResult {
  dryRun: boolean
  groups: Array<{ canonical: FriendRecord; duplicateIds: string[]; preservedNoteKeys: string[]; addedExternalIds: ExternalId[] }>
}

export async function dedupeFriends(input: { store: FriendStore; friendsDir: string; actor: string; dryRun?: boolean; now?: () => Date }): Promise<FriendDedupeResult> {
  const listAll = input.store.listAll
  const records = listAll ? await listAll.call(input.store) : []
  const plan = planFriendDedupe(records)
  const dryRun = input.dryRun !== false
  const groups: FriendDedupeResult["groups"] = []
  for (const group of plan) {
    const duplicateIds = group.duplicates.map((record) => record.id)
    const result = await mergeFriends({
      store: input.store,
      friendsDir: input.friendsDir,
      targetId: group.canonical.id,
      sourceIds: duplicateIds,
      actor: input.actor,
      reason: "duplicate local records of the same person",
      dryRun,
      ...(input.now ? { now: input.now } : {}),
    })
    /* v8 ignore next -- the plan only names records it just listed; a concurrent removal is the only way here @preserve */
    if (!result.ok) throw new Error(result.message)
    groups.push({ canonical: result.target, duplicateIds, preservedNoteKeys: result.preservedNoteKeys, addedExternalIds: result.addedExternalIds })
  }
  emitNervesEvent({
    component: "friends",
    event: "friends.dedupe_completed",
    message: dryRun ? "planned friend record dedupe" : "applied friend record dedupe",
    meta: { dryRun, groups: groups.length, duplicates: groups.reduce((sum, group) => sum + group.duplicateIds.length, 0), actor: input.actor },
  })
  return { dryRun, groups }
}
