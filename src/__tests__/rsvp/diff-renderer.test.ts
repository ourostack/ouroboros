import { describe, expect, it } from "vitest"
import { buildRsvpSnapshot, type RsvpSnapshot } from "../../rsvp/snapshot"
import { computeRsvpDelta, renderRsvpReport } from "../../rsvp/diff-renderer"

function snapshot(label: string, guests: Record<string, { first_name?: string; last_name?: string; group_id?: string | number | null; attending_status?: string | null }>): RsvpSnapshot {
  return buildRsvpSnapshot({
    agent: "slugger",
    fetchedAt: `2026-07-09T${label}:00.000Z`,
    source: {
      kind: "aisleplanner",
      weddingId: "484532",
      eventId: "2081539",
      adapter: "aisleplanner-api-v1",
    },
    guests,
    allGuests: guests,
    provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
  })
}

describe("RSVP diff renderer", () => {
  it("computes deterministic deltas and renders intentional native copy", () => {
    const previous = snapshot("10:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: null },
      "2": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: "attending" },
      "3": { first_name: "Debra", last_name: "Edelson", group_id: 8, attending_status: null },
      "4": { first_name: "Old", last_name: "Guest", group_id: 9, attending_status: "declined" },
    })
    const current = snapshot("11:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "attending" },
      "2": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: "declined" },
      "3": { first_name: "Debra", last_name: "Edelson", group_id: 8, attending_status: null },
      "5": { first_name: "", last_name: "", group_id: 7, attending_status: "declined" },
    })

    const delta = computeRsvpDelta(previous, current)

    expect(delta).toMatchObject({
      isFirstRun: false,
      newRsvps: [expect.objectContaining({ id: "1", displayName: "Ari Mendelow", oldStatus: "pending", newStatus: "attending" })],
      statusChanges: [expect.objectContaining({ id: "2", displayName: "Rachel Example", oldStatus: "attending", newStatus: "declined" })],
      newGuests: [expect.objectContaining({ id: "5", displayName: "Unnamed guest", status: "declined" })],
      removedGuests: [expect.objectContaining({ id: "4", displayName: "Old Guest", status: "declined" })],
      summary: { attending: 1, declined: 2, pending: 1, unknown: 0, total: 4 },
    })

    const report = renderRsvpReport(delta)

    expect(report).toContain("RSVP Update — Ari & Rachel")
    expect(report).toContain("New RSVPs:")
    expect(report).toContain("  • Ari Mendelow — attending")
    expect(report).toContain("Status changes:")
    expect(report).toContain("  • Rachel Example: attending → declined")
    expect(report).toContain("New guests added:")
    expect(report).toContain("  • Unnamed guest (via Ari Mendelow) (declined)")
    expect(report).toContain("Guests removed:")
    expect(report).toContain("1 attending / 2 declined / 1 pending")
    expect(report).not.toContain("Beep boop")
    expect(report).not.toContain("script")
  })

  it("renders first-run and no-change summaries without model calls", () => {
    const current = snapshot("12:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", attending_status: "attending" },
      "2": { first_name: "Rachel", last_name: "Example", attending_status: null },
      "3": { first_name: "Mystery", last_name: "Guest", attending_status: "maybe" },
    })

    const firstRun = renderRsvpReport(computeRsvpDelta(null, current))
    expect(firstRun).toContain("First native RSVP check — current summary:")
    expect(firstRun).toContain("1 attending / 0 declined / 1 pending / 1 unknown")

    const noChange = renderRsvpReport(computeRsvpDelta(current, current))
    expect(noChange).toContain("No changes since last check.")
    expect(noChange).toContain("1 attending / 0 declined / 1 pending / 1 unknown")
  })

  it("renders sparse change sections and unnamed guests without a group peer", () => {
    const previous = snapshot("13:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "attending" },
      "2": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: null },
    })
    const current = snapshot("14:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "declined" },
      "2": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: "declined" },
      "3": { first_name: "", last_name: "", group_id: null, attending_status: null },
    })

    const report = renderRsvpReport(computeRsvpDelta(previous, current))

    expect(report).toContain("New RSVPs:")
    expect(report).toContain("  • Rachel Example — declined")
    expect(report).toContain("Status changes:")
    expect(report).toContain("  • Ari Mendelow: attending → declined")
    expect(report).toContain("New guests added:")
    expect(report).toContain("  • Unnamed guest (pending)")
    expect(report).not.toContain("Guests removed:")
  })

  it("omits empty change sections when only status changes are present", () => {
    const previous = snapshot("15:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "attending" },
    })
    const current = snapshot("16:00", {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "declined" },
    })

    const report = renderRsvpReport(computeRsvpDelta(previous, current))

    expect(report).not.toContain("New RSVPs:")
    expect(report).toContain("Status changes:")
    expect(report).not.toContain("New guests added:")
    expect(report).not.toContain("Guests removed:")
  })

  it("omits status-change sections when only new RSVPs are present", () => {
    const previous = snapshot("17:00", {
      "1": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: null },
    })
    const current = snapshot("18:00", {
      "1": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: "declined" },
    })

    const report = renderRsvpReport(computeRsvpDelta(previous, current))

    expect(report).toContain("New RSVPs:")
    expect(report).not.toContain("Status changes:")
    expect(report).not.toContain("New guests added:")
    expect(report).not.toContain("Guests removed:")
  })
})
