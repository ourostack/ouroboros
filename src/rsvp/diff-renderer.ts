import { emitNervesEvent } from "../nerves/runtime"
import type { RsvpGuestSnapshotRow, RsvpGuestStatus, RsvpSnapshot, RsvpSnapshotSummary } from "./snapshot"

const RSVP_REPORT_FOOTER = "🤖 Beep boop! Automated RSVP update from Slugger — no need to reply here!"

export interface RsvpDeltaGuest {
  id: string
  displayName: string
  contextualDisplayName: string
  groupId: string | number | null
}

export interface RsvpNewRsvp extends RsvpDeltaGuest {
  oldStatus: RsvpGuestStatus
  newStatus: RsvpGuestStatus
}

export interface RsvpStatusChange extends RsvpDeltaGuest {
  oldStatus: RsvpGuestStatus
  newStatus: RsvpGuestStatus
}

export interface RsvpAddedGuest extends RsvpDeltaGuest {
  status: RsvpGuestStatus
}

export interface RsvpRemovedGuest extends RsvpDeltaGuest {
  status: RsvpGuestStatus
}

export interface RsvpDelta {
  previousSnapshotId: string | null
  currentSnapshotId: string
  isFirstRun: boolean
  newRsvps: RsvpNewRsvp[]
  statusChanges: RsvpStatusChange[]
  newGuests: RsvpAddedGuest[]
  removedGuests: RsvpRemovedGuest[]
  summary: RsvpSnapshotSummary
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id)
}

function sameGroup(left: string | number | null, right: string | number | null): boolean {
  return left !== null && right !== null && String(left) === String(right)
}

export function guestDisplayName(guest: RsvpGuestSnapshotRow, peers: RsvpGuestSnapshotRow[]): string {
  if (guest.displayName !== "Unnamed guest") return guest.displayName
  const primary = peers
    .filter((candidate) => candidate.id !== guest.id && candidate.displayName !== "Unnamed guest" && sameGroup(candidate.groupId, guest.groupId))
    .sort(byId)[0]
  return primary ? `Unnamed guest (via ${primary.displayName})` : "Unnamed guest"
}

function guestBase(guest: RsvpGuestSnapshotRow, peers: RsvpGuestSnapshotRow[]): RsvpDeltaGuest {
  return {
    id: guest.id,
    displayName: guest.displayName,
    contextualDisplayName: guestDisplayName(guest, peers),
    groupId: guest.groupId,
  }
}

function mapById(snapshot: RsvpSnapshot): Map<string, RsvpGuestSnapshotRow> {
  return new Map(snapshot.guests.map((guest) => [guest.id, guest]))
}

function statusLabel(status: RsvpGuestStatus): string {
  return status
}

function reportName(guest: RsvpDeltaGuest): string {
  return guest.contextualDisplayName
}

function summaryLine(summary: RsvpSnapshotSummary): string {
  const base = `${summary.attending} attending / ${summary.declined} declined / ${summary.pending} pending`
  return summary.unknown > 0 ? `${base} / ${summary.unknown} unknown` : base
}

export function computeRsvpDelta(previous: RsvpSnapshot | null, current: RsvpSnapshot): RsvpDelta {
  const previousGuests = previous ? mapById(previous) : new Map<string, RsvpGuestSnapshotRow>()
  const currentGuests = mapById(current)
  const newRsvps: RsvpNewRsvp[] = []
  const statusChanges: RsvpStatusChange[] = []
  const newGuests: RsvpAddedGuest[] = []
  const removedGuests: RsvpRemovedGuest[] = []

  for (const currentGuest of current.guests) {
    const previousGuest = previousGuests.get(currentGuest.id)
    if (!previousGuest) {
      newGuests.push({ ...guestBase(currentGuest, current.guests), status: currentGuest.status })
      continue
    }
    if (previousGuest.status === currentGuest.status) continue
    const changed = {
      ...guestBase(currentGuest, current.guests),
      oldStatus: previousGuest.status,
      newStatus: currentGuest.status,
    }
    if (previousGuest.status === "pending" && (currentGuest.status === "attending" || currentGuest.status === "declined")) {
      newRsvps.push(changed)
    } else {
      statusChanges.push(changed)
    }
  }

  if (previous) {
    for (const previousGuest of previous.guests) {
      if (currentGuests.has(previousGuest.id)) continue
      removedGuests.push({ ...guestBase(previousGuest, previous.guests), status: previousGuest.status })
    }
  }

  const delta = {
    previousSnapshotId: previous?.snapshotId ?? null,
    currentSnapshotId: current.snapshotId,
    isFirstRun: previous === null,
    newRsvps: newRsvps.sort(byId),
    statusChanges: statusChanges.sort(byId),
    newGuests: newGuests.sort(byId),
    removedGuests: removedGuests.sort(byId),
    summary: current.summary,
  }
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.delta_computed",
    message: "computed RSVP snapshot delta",
    meta: {
      currentSnapshotId: current.snapshotId,
      previousSnapshotId: previous?.snapshotId ?? null,
      isFirstRun: previous === null,
      newRsvps: delta.newRsvps.length,
      statusChanges: delta.statusChanges.length,
      newGuests: delta.newGuests.length,
      removedGuests: delta.removedGuests.length,
    },
  })
  return delta
}

function hasChanges(delta: RsvpDelta): boolean {
  return delta.newRsvps.length > 0
    || delta.statusChanges.length > 0
    || delta.newGuests.length > 0
    || delta.removedGuests.length > 0
}

export function renderRsvpReport(delta: RsvpDelta): string {
  const lines: string[] = ["RSVP Update — Ari & Rachel", ""]

  if (delta.isFirstRun) {
    lines.push("First check — here's the current summary:", "")
  } else if (!hasChanges(delta)) {
    lines.push("No changes since last check.", "")
  } else {
    if (delta.newRsvps.length > 0) {
      lines.push("New RSVPs:")
      for (const guest of delta.newRsvps) {
        lines.push(`  • ${reportName(guest)} — ${statusLabel(guest.newStatus)}`)
      }
      lines.push("")
    }
    if (delta.statusChanges.length > 0) {
      lines.push("Status changes:")
      for (const guest of delta.statusChanges) {
        lines.push(`  • ${reportName(guest)}: ${statusLabel(guest.oldStatus)} → ${statusLabel(guest.newStatus)}`)
      }
      lines.push("")
    }
    if (delta.newGuests.length > 0) {
      lines.push("New guests added:")
      for (const guest of delta.newGuests) {
        lines.push(`  • ${reportName(guest)} (${statusLabel(guest.status)})`)
      }
      lines.push("")
    }
    if (delta.removedGuests.length > 0) {
      lines.push("Guests removed:")
      for (const guest of delta.removedGuests) {
        lines.push(`  • ${reportName(guest)}`)
      }
      lines.push("")
    }
  }

  lines.push(summaryLine(delta.summary))
  lines.push("", RSVP_REPORT_FOOTER)
  const report = lines.join("\n")
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.report_rendered",
    message: "rendered RSVP report",
    meta: {
      currentSnapshotId: delta.currentSnapshotId,
      isFirstRun: delta.isFirstRun,
      characters: report.length,
    },
  })
  return report
}
