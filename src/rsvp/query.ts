import { emitNervesEvent } from "../nerves/runtime"
import { guestDisplayName } from "./diff-renderer"
import type { RsvpGuestSnapshotRow, RsvpGuestStatus, RsvpSnapshot } from "./snapshot"

export type RsvpQueryStatus = RsvpGuestStatus | "all"

export interface RsvpSnapshotQuery {
  query?: string
  status?: RsvpQueryStatus
}

export interface RsvpQueryResult {
  ok: true
  status: RsvpQueryStatus
  count: number
  total: number
  names: string[]
  text: string
}

const STATUS_LABELS: Record<RsvpGuestStatus, string> = {
  attending: "Attending",
  declined: "Declined",
  pending: "Pending",
  unknown: "Unknown",
}

const STATUS_ALIASES: ReadonlyArray<[RsvpGuestStatus, RegExp]> = [
  ["pending", /\b(pending|not\s+responded|not\s+replied|no\s+response|waiting)\b/i],
  ["declined", /\b(declined|declines|not\s+coming|can't\s+come|cannot\s+come|no\b)\b/i],
  ["attending", /\b(attending|coming|yes|accepted|rsvp'?d\s+yes)\b/i],
  ["unknown", /\b(unknown|weird|invalid|unclear)\b/i],
]

function normalizeStatus(value: string | undefined): RsvpQueryStatus | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "attending" || normalized === "declined" || normalized === "pending" || normalized === "unknown" || normalized === "all") {
    return normalized
  }
  return null
}

function statusFromQuery(query: string | undefined): RsvpGuestStatus | null {
  if (!query) return null
  for (const [status, pattern] of STATUS_ALIASES) {
    if (pattern.test(query)) return status
  }
  return null
}

function searchableName(guest: RsvpGuestSnapshotRow, displayName: string): string {
  return `${displayName} ${guest.firstName} ${guest.lastName}`.toLowerCase()
}

function formatStatusResult(status: RsvpGuestStatus, names: string[], total: number): string {
  return `${STATUS_LABELS[status]} (${names.length}/${total}): ${names.length > 0 ? names.join("; ") : "none"}`
}

function formatNameResult(matches: Array<{ guest: RsvpGuestSnapshotRow; displayName: string }>, total: number): string {
  const names = matches.map(({ guest, displayName }) => `${displayName} [${guest.status}]`)
  return `Matching guests (${matches.length}/${total}): ${names.length > 0 ? names.join("; ") : "none"}`
}

function sortedGuests(snapshot: RsvpSnapshot): RsvpGuestSnapshotRow[] {
  return [...snapshot.guests].sort((left, right) => left.id.localeCompare(right.id))
}

export function queryRsvpSnapshot(snapshot: RsvpSnapshot, query: RsvpSnapshotQuery): RsvpQueryResult {
  const guests = sortedGuests(snapshot)
  const requestedStatus = normalizeStatus(query.status)
  const inferredStatus = statusFromQuery(query.query)
  const status = requestedStatus ?? inferredStatus ?? "all"

  if (status !== "all") {
    const matches = guests
      .filter((guest) => guest.status === status)
      .map((guest) => guestDisplayName(guest, guests))
    emitNervesEvent({
      component: "rsvp",
      event: "rsvp.query_answered",
      message: "answered RSVP status query",
      meta: {
        snapshotId: snapshot.snapshotId,
        status,
        count: matches.length,
        total: snapshot.summary.total,
      },
    })
    return {
      ok: true,
      status,
      count: matches.length,
      total: snapshot.summary.total,
      names: matches,
      text: formatStatusResult(status, matches, snapshot.summary.total),
    }
  }

  const needle = query.query?.trim().toLowerCase() ?? ""
  const matches = guests
    .map((guest) => ({ guest, displayName: guestDisplayName(guest, guests) }))
    .filter(({ guest, displayName }) => needle.length === 0 || searchableName(guest, displayName).includes(needle))
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.query_answered",
    message: "answered RSVP name query",
    meta: {
      snapshotId: snapshot.snapshotId,
      status: "all",
      count: matches.length,
      total: snapshot.summary.total,
    },
  })
  return {
    ok: true,
    status: "all",
    count: matches.length,
    total: snapshot.summary.total,
    names: matches.map(({ displayName }) => displayName),
    text: formatNameResult(matches, snapshot.summary.total),
  }
}

function summaryLine(snapshot: RsvpSnapshot): string {
  const { attending, declined, pending, unknown, total } = snapshot.summary
  return `${attending} attending / ${declined} declined / ${pending} pending / ${unknown} unknown (${total} total)`
}

export function summarizeRsvpSnapshot(snapshot: RsvpSnapshot): string {
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.snapshot_summarized",
    message: "summarized RSVP snapshot",
    meta: {
      snapshotId: snapshot.snapshotId,
      total: snapshot.summary.total,
    },
  })
  return `RSVP snapshot ${snapshot.snapshotId}: ${summaryLine(snapshot)}, fetched ${snapshot.fetchedAt}`
}
