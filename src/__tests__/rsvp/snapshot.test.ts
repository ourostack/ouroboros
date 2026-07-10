import { describe, expect, it } from "vitest"

describe("RSVP snapshot v1", () => {
  it("normalizes AislePlanner guest rows into a deterministic private snapshot with counts and hash", async () => {
    const {
      RSVP_SNAPSHOT_POLICY_VERSION,
      buildRsvpSnapshot,
      rsvpSnapshotContentHash,
      serializeRsvpSnapshotMetadata,
    } = await import("../../rsvp/snapshot")

    const snapshot = buildRsvpSnapshot({
      agent: "slugger",
      fetchedAt: "2026-07-09T17:00:00.000Z",
      source: {
        kind: "aisleplanner",
        weddingId: "wedding-1",
        eventId: "event-1",
        adapter: "aisleplanner-api-v1",
      },
      guests: {
        "g-2": { first_name: "Bina", last_name: "Example", group_id: 20, attending_status: "declined" },
        "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
        "g-3": { first_name: "", last_name: "", group_id: 10, attending_status: null },
      },
      allGuests: {
        "g-1": { first_name: "Ari", last_name: "Example", group_id: 10 },
        "g-2": { first_name: "Bina", last_name: "Example", group_id: 20 },
        "g-3": { first_name: "", last_name: "", group_id: 10 },
      },
      provenance: {
        kind: "live-fetch",
        fetchedBy: "unit-test",
      },
    })

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      policyVersion: RSVP_SNAPSHOT_POLICY_VERSION,
      agent: "slugger",
      privacy: {
        rawCredentialsStored: false,
        indexPolicy: { search: false, vector: false },
      },
      summary: { attending: 1, declined: 1, pending: 1, unknown: 0, total: 3 },
    })
    expect(snapshot.guests.map((guest) => guest.id)).toEqual(["g-1", "g-2", "g-3"])
    expect(snapshot.guests[2]).toMatchObject({
      displayName: "Unnamed guest",
      status: "pending",
      sourceStatus: null,
    })
    expect(snapshot.contentHash).toBe(rsvpSnapshotContentHash(snapshot))

    const metadata = serializeRsvpSnapshotMetadata(snapshot)
    expect(metadata).toEqual({
      schemaVersion: 1,
      policyVersion: RSVP_SNAPSHOT_POLICY_VERSION,
      snapshotId: snapshot.snapshotId,
      contentHash: snapshot.contentHash,
      agent: "slugger",
      fetchedAt: "2026-07-09T17:00:00.000Z",
      source: snapshot.source,
      summary: snapshot.summary,
      guestIdsHash: expect.stringMatching(/^sha256:/),
      rawGuestNamesStored: false,
      indexPolicy: { search: false, vector: false },
    })
    expect(JSON.stringify(metadata)).not.toContain("Ari")
    expect(JSON.stringify(metadata)).not.toContain("Bina")
  })

  it("rejects malformed snapshots, duplicate guests, bad timestamps, and hash drift", async () => {
    const {
      buildRsvpSnapshot,
      parseRsvpSnapshot,
      rsvpSnapshotContentHash,
    } = await import("../../rsvp/snapshot")

    expect(() => buildRsvpSnapshot({
      agent: "slugger",
      fetchedAt: "not-a-date",
      source: { kind: "aisleplanner", weddingId: "wedding-1", eventId: "event-1", adapter: "aisleplanner-api-v1" },
      guests: {},
      allGuests: {},
      provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
    })).toThrow(/fetchedAt/)

    const valid = buildRsvpSnapshot({
      agent: "slugger",
      fetchedAt: "2026-07-09T17:00:00.000Z",
      source: { kind: "aisleplanner", weddingId: "wedding-1", eventId: "event-1", adapter: "aisleplanner-api-v1" },
      guests: {
        "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
      },
      allGuests: {},
      provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
    })
    expect(parseRsvpSnapshot(valid).ok).toBe(true)
    expect(parseRsvpSnapshot({ ...valid, guests: [...valid.guests, valid.guests[0]] }).ok).toBe(false)
    expect(parseRsvpSnapshot({ ...valid, contentHash: "sha256:bad" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("contentHash"),
    })
    expect(rsvpSnapshotContentHash(valid)).toBe(valid.contentHash)
  })

  it("covers unknown statuses, non-numeric groups, and malformed parser branches", async () => {
    const {
      RSVP_SNAPSHOT_POLICY_VERSION,
      buildRsvpSnapshot,
      parseRsvpSnapshot,
    } = await import("../../rsvp/snapshot")
    const valid = buildRsvpSnapshot({
      agent: "slugger",
      fetchedAt: "2026-07-09T17:00:00.000Z",
      source: { kind: "aisleplanner", weddingId: "wedding-1", eventId: "event-1", adapter: "aisleplanner-api-v1" },
      guests: {
        "g-1": { first_name: 123, last_name: "Example", group_id: "10", attending_status: "maybe" },
        "g-2": { first_name: "No", last_name: "Group", group_id: { bad: true }, attending_status: "declined" },
      },
      allGuests: {},
      provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
    })
    expect(valid.guests[0]).toMatchObject({ firstName: "", groupId: "10", status: "unknown", sourceStatus: "maybe" })
    expect(valid.guests[1]).toMatchObject({ groupId: null, status: "declined" })

    const invalids: unknown[] = [
      null,
      { ...valid, schemaVersion: 2 },
      { ...valid, policyVersion: "old" },
      { ...valid, snapshotId: 1 },
      { ...valid, agent: 1 },
      { ...valid, fetchedAt: "bad-date" },
      { ...valid, source: null },
      { ...valid, provenance: null },
      { ...valid, guests: "nope" },
      { ...valid, guests: [null] },
      { ...valid, guests: [{ ...valid.guests[0], id: 1 }] },
      { ...valid, guests: [{ ...valid.guests[0], firstName: 1 }] },
      { ...valid, guests: [{ ...valid.guests[0], lastName: 1 }] },
      { ...valid, guests: [{ ...valid.guests[0], displayName: 1 }] },
      { ...valid, guests: [{ ...valid.guests[0], groupId: true }] },
      { ...valid, guests: [{ ...valid.guests[0], status: "wat" }] },
      { ...valid, guests: [{ ...valid.guests[0], sourceStatus: 1 }] },
      { ...valid, allGuestIdsHash: 1 },
      { ...valid, summary: null },
      { ...valid, summary: { ...valid.summary, attending: "1" } },
      { ...valid, summary: { ...valid.summary, declined: "1" } },
      { ...valid, summary: { ...valid.summary, pending: "1" } },
      { ...valid, summary: { ...valid.summary, unknown: "1" } },
      { ...valid, summary: { ...valid.summary, total: "1" } },
      { ...valid, privacy: null },
      { ...valid, privacy: { rawCredentialsStored: true } },
      { ...valid, contentHash: undefined },
      { ...valid, snapshotId: "rsvp_wrong" },
    ]

    for (const candidate of invalids) {
      expect(parseRsvpSnapshot(candidate).ok).toBe(false)
    }
    expect(RSVP_SNAPSHOT_POLICY_VERSION).toBe("rsvp-snapshot/v1")
  })
})
