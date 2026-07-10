import { createHash } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"

export const RSVP_SNAPSHOT_POLICY_VERSION = "rsvp-snapshot/v1" as const

export type RsvpGuestStatus = "attending" | "declined" | "pending" | "unknown"

export interface RsvpSnapshotSource {
  kind: "aisleplanner"
  weddingId: string
  eventId: string
  adapter: "aisleplanner-api-v1"
}

export type RsvpSnapshotProvenance =
  | { kind: "live-fetch"; fetchedBy: string }
  | {
    kind: "legacy-import"
    importedAt: string
    legacySnapshotRelativePath: string
    legacySnapshotHash: string
    sentStateHash?: string
  }

export interface RsvpGuestSnapshotRow {
  id: string
  firstName: string
  lastName: string
  displayName: string
  groupId: string | number | null
  status: RsvpGuestStatus
  sourceStatus: string | null
}

export interface RsvpSnapshotSummary {
  attending: number
  declined: number
  pending: number
  unknown: number
  total: number
}

export interface RsvpSnapshot {
  schemaVersion: 1
  policyVersion: typeof RSVP_SNAPSHOT_POLICY_VERSION
  snapshotId: string
  agent: string
  fetchedAt: string
  source: RsvpSnapshotSource
  provenance: RsvpSnapshotProvenance
  guests: RsvpGuestSnapshotRow[]
  allGuestIdsHash: string
  summary: RsvpSnapshotSummary
  contentHash: string
  privacy: {
    rawCredentialsStored: false
    indexPolicy: { search: false; vector: false }
  }
}

export interface BuildRsvpSnapshotInput {
  agent: string
  fetchedAt: string
  source: RsvpSnapshotSource
  guests: Record<string, LegacyRsvpGuestRow>
  allGuests: Record<string, LegacyRsvpAllGuestRow>
  provenance: RsvpSnapshotProvenance
}

export interface LegacyRsvpGuestRow {
  first_name?: unknown
  last_name?: unknown
  group_id?: unknown
  attending_status?: unknown
}

export interface LegacyRsvpAllGuestRow {
  first_name?: unknown
  last_name?: unknown
  group_id?: unknown
}

export interface RsvpSnapshotMetadata {
  schemaVersion: 1
  policyVersion: typeof RSVP_SNAPSHOT_POLICY_VERSION
  snapshotId: string
  contentHash: string
  agent: string
  fetchedAt: string
  source: RsvpSnapshotSource
  summary: RsvpSnapshotSummary
  guestIdsHash: string
  rawGuestNamesStored: false
  indexPolicy: { search: false; vector: false }
}

export type ParseRsvpSnapshotResult =
  | { ok: true; snapshot: RsvpSnapshot }
  | { ok: false; reason: string }

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export function rsvpHash(input: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(input))}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`)
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function groupIdValue(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value
  return null
}

function normalizeStatus(value: unknown): { status: RsvpGuestStatus; sourceStatus: string | null } {
  if (value === null || value === undefined) return { status: "pending", sourceStatus: null }
  const raw = String(value)
  if (raw === "attending") return { status: "attending", sourceStatus: raw }
  if (raw === "declined") return { status: "declined", sourceStatus: raw }
  return { status: "unknown", sourceStatus: raw }
}

function displayName(firstName: string, lastName: string): string {
  const name = `${firstName} ${lastName}`.trim()
  return name || "Unnamed guest"
}

function normalizeGuest(id: string, row: LegacyRsvpGuestRow): RsvpGuestSnapshotRow {
  const firstName = stringValue(row.first_name).trim()
  const lastName = stringValue(row.last_name).trim()
  const normalizedStatus = normalizeStatus(row.attending_status)
  return {
    id,
    firstName,
    lastName,
    displayName: displayName(firstName, lastName),
    groupId: groupIdValue(row.group_id),
    status: normalizedStatus.status,
    sourceStatus: normalizedStatus.sourceStatus,
  }
}

function summaryFor(guests: RsvpGuestSnapshotRow[]): RsvpSnapshotSummary {
  const summary: RsvpSnapshotSummary = {
    attending: 0,
    declined: 0,
    pending: 0,
    unknown: 0,
    total: guests.length,
  }
  for (const guest of guests) {
    summary[guest.status] += 1
  }
  return summary
}

function hashBasis(snapshot: Omit<RsvpSnapshot, "contentHash" | "snapshotId">): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    policyVersion: snapshot.policyVersion,
    agent: snapshot.agent,
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
    provenance: snapshot.provenance,
    guests: snapshot.guests,
    allGuestIdsHash: snapshot.allGuestIdsHash,
    summary: snapshot.summary,
    privacy: snapshot.privacy,
  }
}

export function rsvpSnapshotContentHash(snapshot: RsvpSnapshot): string {
  return rsvpHash(hashBasis(snapshot))
}

function snapshotIdFor(contentHash: string): string {
  return `rsvp_${contentHash.slice("sha256:".length, "sha256:".length + 32)}`
}

function allGuestIdsHash(allGuests: Record<string, LegacyRsvpAllGuestRow>): string {
  return rsvpHash(Object.keys(allGuests).sort())
}

export function buildRsvpSnapshot(input: BuildRsvpSnapshotInput): RsvpSnapshot {
  assertIsoTimestamp(input.fetchedAt, "fetchedAt")
  if (input.provenance.kind === "legacy-import") assertIsoTimestamp(input.provenance.importedAt, "importedAt")
  const guests = Object.entries(input.guests)
    .map(([id, row]) => normalizeGuest(id, row))
    .sort((left, right) => left.id.localeCompare(right.id))
  const base: Omit<RsvpSnapshot, "contentHash" | "snapshotId"> = {
    schemaVersion: 1,
    policyVersion: RSVP_SNAPSHOT_POLICY_VERSION,
    agent: input.agent,
    fetchedAt: input.fetchedAt,
    source: input.source,
    provenance: input.provenance,
    guests,
    allGuestIdsHash: allGuestIdsHash(input.allGuests),
    summary: summaryFor(guests),
    privacy: {
      rawCredentialsStored: false,
      indexPolicy: { search: false, vector: false },
    },
  }
  const contentHash = rsvpHash(hashBasis(base))
  const snapshot: RsvpSnapshot = {
    ...base,
    snapshotId: snapshotIdFor(contentHash),
    contentHash,
  }
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.snapshot_built",
    message: "built RSVP snapshot",
    meta: {
      agent: snapshot.agent,
      snapshotId: snapshot.snapshotId,
      total: snapshot.summary.total,
    },
  })
  return snapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseGuest(value: unknown): RsvpGuestSnapshotRow | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string") return null
  if (typeof value.firstName !== "string") return null
  if (typeof value.lastName !== "string") return null
  if (typeof value.displayName !== "string") return null
  if (!(typeof value.groupId === "string" || typeof value.groupId === "number" || value.groupId === null)) return null
  if (value.status !== "attending" && value.status !== "declined" && value.status !== "pending" && value.status !== "unknown") return null
  if (!(typeof value.sourceStatus === "string" || value.sourceStatus === null)) return null
  return value as unknown as RsvpGuestSnapshotRow
}

function parseSummary(value: unknown): RsvpSnapshotSummary | null {
  if (!isRecord(value)) return null
  const summary = value as Partial<RsvpSnapshotSummary>
  return typeof summary.attending === "number"
    && typeof summary.declined === "number"
    && typeof summary.pending === "number"
    && typeof summary.unknown === "number"
    && typeof summary.total === "number"
    ? summary as RsvpSnapshotSummary
    : null
}

export function parseRsvpSnapshot(value: unknown): ParseRsvpSnapshotResult {
  if (!isRecord(value)) return { ok: false, reason: "snapshot must be an object" }
  if (value.schemaVersion !== 1) return { ok: false, reason: "unsupported schemaVersion" }
  if (value.policyVersion !== RSVP_SNAPSHOT_POLICY_VERSION) return { ok: false, reason: "unsupported policyVersion" }
  if (typeof value.snapshotId !== "string") return { ok: false, reason: "missing snapshotId" }
  if (typeof value.agent !== "string") return { ok: false, reason: "missing agent" }
  if (typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt))) return { ok: false, reason: "invalid fetchedAt" }
  if (!isRecord(value.source)) return { ok: false, reason: "invalid source" }
  if (!isRecord(value.provenance)) return { ok: false, reason: "invalid provenance" }
  if (!Array.isArray(value.guests)) return { ok: false, reason: "guests must be an array" }
  const guests = value.guests.map(parseGuest)
  if (guests.some((guest) => guest === null)) return { ok: false, reason: "invalid guest row" }
  const ids = guests.map((guest) => guest!.id)
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "duplicate guest id" }
  if (typeof value.allGuestIdsHash !== "string") return { ok: false, reason: "missing allGuestIdsHash" }
  const summary = parseSummary(value.summary)
  if (!summary) return { ok: false, reason: "invalid summary" }
  if (!isRecord(value.privacy) || value.privacy.rawCredentialsStored !== false) return { ok: false, reason: "invalid privacy" }
  const snapshot = value as unknown as RsvpSnapshot
  if (typeof value.contentHash !== "string" || rsvpSnapshotContentHash(snapshot) !== value.contentHash) {
    return { ok: false, reason: "contentHash mismatch" }
  }
  if (snapshotIdFor(value.contentHash) !== value.snapshotId) return { ok: false, reason: "snapshotId mismatch" }
  return { ok: true, snapshot }
}

export function serializeRsvpSnapshotMetadata(snapshot: RsvpSnapshot): RsvpSnapshotMetadata {
  return {
    schemaVersion: 1,
    policyVersion: RSVP_SNAPSHOT_POLICY_VERSION,
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    agent: snapshot.agent,
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
    summary: snapshot.summary,
    guestIdsHash: rsvpHash(snapshot.guests.map((guest) => guest.id).sort()),
    rawGuestNamesStored: false,
    indexPolicy: { search: false, vector: false },
  }
}
