import { describe, expect, it } from "vitest"
import { buildRsvpSnapshot, type RsvpSnapshot } from "../../rsvp/snapshot"
import { queryRsvpSnapshot, summarizeRsvpSnapshot } from "../../rsvp/query"

function sampleSnapshot(): RsvpSnapshot {
  return buildRsvpSnapshot({
    agent: "slugger",
    fetchedAt: "2026-07-09T12:00:00.000Z",
    source: {
      kind: "aisleplanner",
      weddingId: "484532",
      eventId: "2081539",
      adapter: "aisleplanner-api-v1",
    },
    guests: {
      "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "attending" },
      "2": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: null },
      "3": { first_name: "Debra", last_name: "Edelson", group_id: 8, attending_status: "declined" },
      "4": { first_name: "", last_name: "", group_id: 7, attending_status: null },
      "5": { first_name: "Mystery", last_name: "Guest", group_id: 9, attending_status: "maybe" },
    },
    allGuests: {},
    provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
  })
}

function declinedOnlySnapshot(): RsvpSnapshot {
  return buildRsvpSnapshot({
    agent: "slugger",
    fetchedAt: "2026-07-09T12:30:00.000Z",
    source: {
      kind: "aisleplanner",
      weddingId: "484532",
      eventId: "2081539",
      adapter: "aisleplanner-api-v1",
    },
    guests: {
      "1": { first_name: "Debra", last_name: "Edelson", group_id: 8, attending_status: "declined" },
    },
    allGuests: {},
    provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
  })
}

describe("RSVP snapshot query", () => {
  it("answers pending queries directly from native snapshot state", () => {
    const result = queryRsvpSnapshot(sampleSnapshot(), { query: "who is pending?" })

    expect(result).toEqual({
      ok: true,
      status: "pending",
      count: 2,
      total: 5,
      names: ["Rachel Example", "Unnamed guest (via Ari Mendelow)"],
      text: "Pending (2/5): Rachel Example; Unnamed guest (via Ari Mendelow)",
    })
  })

  it("supports status filters, name filters, and unknown statuses deterministically", () => {
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "declined" })).toMatchObject({
      ok: true,
      status: "declined",
      names: ["Debra Edelson"],
      text: "Declined (1/5): Debra Edelson",
    })

    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "unknown" })).toMatchObject({
      ok: true,
      status: "unknown",
      names: ["Mystery Guest"],
      text: "Unknown (1/5): Mystery Guest",
    })

    expect(queryRsvpSnapshot(sampleSnapshot(), { query: "rachel" })).toMatchObject({
      ok: true,
      status: "all",
      names: ["Rachel Example"],
      text: "Matching guests (1/5): Rachel Example [pending]",
    })
  })

  it("handles explicit status aliases, invalid status input, and empty result sets", () => {
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "attending" })).toMatchObject({
      status: "attending",
      text: "Attending (1/5): Ari Mendelow",
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "all" })).toMatchObject({
      status: "all",
      count: 5,
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "bogus" as never, query: "who is attending?" })).toMatchObject({
      status: "attending",
      names: ["Ari Mendelow"],
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "pending", query: "ignored name" })).toMatchObject({
      status: "pending",
      names: ["Rachel Example", "Unnamed guest (via Ari Mendelow)"],
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { query: "not-a-real-guest" })).toMatchObject({
      status: "all",
      names: [],
      text: "Matching guests (0/5): none",
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "all", query: undefined })).toMatchObject({
      status: "all",
      count: 5,
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "attending", query: "not-a-real-guest" })).toMatchObject({
      status: "attending",
      text: "Attending (1/5): Ari Mendelow",
    })
    expect(queryRsvpSnapshot(sampleSnapshot(), { status: "attending", query: "who is pending?" })).toMatchObject({
      status: "attending",
      names: ["Ari Mendelow"],
    })
    expect(queryRsvpSnapshot(declinedOnlySnapshot(), { status: "attending" })).toMatchObject({
      status: "attending",
      names: [],
      text: "Attending (0/1): none",
    })
  })

  it("summarizes snapshots without exposing raw credentials or provider context", () => {
    const snapshot = sampleSnapshot()
    expect(summarizeRsvpSnapshot(snapshot)).toEqual(
      `RSVP snapshot ${snapshot.snapshotId}: 1 attending / 1 declined / 2 pending / 1 unknown (5 total), fetched 2026-07-09T12:00:00.000Z`,
    )
  })
})
