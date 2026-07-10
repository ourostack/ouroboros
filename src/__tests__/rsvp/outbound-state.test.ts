import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildRsvpSnapshot, type RsvpSnapshot } from "../../rsvp/snapshot"

const emitNervesEvent = vi.fn()

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => emitNervesEvent(...args),
}))

function snapshot(label: string, guests: Record<string, { first_name?: string; last_name?: string; group_id?: string | number | null; attending_status?: string | null }>): RsvpSnapshot {
  return buildRsvpSnapshot({
    agent: "slugger",
    fetchedAt: `2026-07-09T${label}:00.000Z`,
    source: { kind: "aisleplanner", weddingId: "wedding-1", eventId: "event-1", adapter: "aisleplanner-api-v1" },
    guests,
    allGuests: guests,
    provenance: { kind: "live-fetch", fetchedBy: "slugger" },
  })
}

describe("RSVP outbound baseline state", () => {
  let agentRoot: string
  let previous: RsvpSnapshot
  let current: RsvpSnapshot

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-outbound-state-"))
    emitNervesEvent.mockReset()
    previous = snapshot("16:00", {
      "guest-1": { first_name: "Ari", last_name: "Mendelow", attending_status: "attending" },
      "guest-2": { first_name: "Debra", last_name: "Edelson", attending_status: null },
    })
    current = snapshot("17:00", {
      "guest-1": { first_name: "Ari", last_name: "Mendelow", attending_status: "attending" },
      "guest-2": { first_name: "Debra", last_name: "Edelson", attending_status: "declined" },
    })
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("does not advance the RSVP baseline when the BlueBubbles outbound attempt fails", async () => {
    const {
      decideRsvpOutboundReport,
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    const decision = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel\n\nNew RSVPs:\n- Debra Edelson -- declined",
      now: "2026-07-09T17:00:00.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      bluebubblesRecord: {
        recordId: "bb-out-1",
        status: "failed",
        tempGuid: "temp-1",
        messageGuid: undefined,
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state.baseline?.snapshotId).toBe(previous.snapshotId)
    expect(state.pendingReports).toHaveLength(1)
    expect(state.pendingReports[0]).toMatchObject({
      snapshotId: current.snapshotId,
      bluebubblesRecordId: "bb-out-1",
      status: "failed",
    })
    expect(decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      now: "2026-07-09T17:01:00.000Z",
    })).toMatchObject({ action: "send", currentSnapshotId: current.snapshotId })
  })

  it("recovers from malformed persisted RSVP outbound state as an empty state", async () => {
    const {
      decideRsvpOutboundReport,
      readRsvpOutboundState,
    } = await import("../../rsvp/outbound-state")

    const statePath = path.join(agentRoot, "state", "rsvp", "outbound-state.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{not-json", "utf-8")

    expect(readRsvpOutboundState(agentRoot)).toMatchObject({ pendingReports: [] })
    expect(decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel",
    })).toMatchObject({ action: "send", currentSnapshotId: current.snapshotId })

    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      policyVersion: "wrong-policy",
      updatedAt: "2026-07-09T17:00:00.000Z",
      pendingReports: [],
    }), "utf-8")
    expect(readRsvpOutboundState(agentRoot)).toMatchObject({ pendingReports: [] })
  })

  it("advances the baseline only after an accepted-or-better outbound proof", async () => {
    const {
      decideRsvpOutboundReport,
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    const decision = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel\n\nNew RSVPs:\n- Debra Edelson -- declined",
      now: "2026-07-09T17:00:00.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      bluebubblesRecord: {
        recordId: "bb-out-2",
        status: "accepted",
        tempGuid: "temp-2",
        messageGuid: "sent-guid-2",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state.baseline).toMatchObject({
      snapshotId: current.snapshotId,
      contentHash: current.contentHash,
      bluebubblesRecordId: "bb-out-2",
      advancedBy: "accepted",
    })
    expect(state.pendingReports).toEqual([])
    expect(decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: decision.reportText,
      now: "2026-07-09T17:01:00.000Z",
    })).toMatchObject({ action: "skip", reason: "baseline-current" })
  })

  it("advances the baseline for a local-visible-only outbound proof", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel\n\nNew RSVPs:\n- Debra Edelson -- declined",
      bluebubblesRecord: {
        recordId: "bb-out-local-visible",
        status: "local-visible",
        tempGuid: "temp-local-visible",
        messageGuid: "local-guid-visible",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    expect(readRsvpOutboundState(agentRoot).baseline).toMatchObject({
      snapshotId: current.snapshotId,
      bluebubblesRecordId: "bb-out-local-visible",
      advancedBy: "local-visible",
    })
  })

  it("clears an older pending report once a later local-visible proof arrives", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
    } = await import("../../rsvp/outbound-state")
    const reportText = "RSVP Update -- Ari & Rachel\n\nNew RSVPs:\n- Debra Edelson -- declined"

    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText,
      bluebubblesRecord: {
        recordId: "bb-out-failed-first",
        status: "failed",
        tempGuid: "temp-failed-first",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText,
      bluebubblesRecord: {
        recordId: "bb-out-visible-after-failure",
        status: "local-visible",
        tempGuid: "temp-visible-after-failure",
        messageGuid: "local-guid-after-failure",
      },
      recordedAt: "2026-07-09T17:01:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state.pendingReports).toEqual([])
    expect(state.baseline).toMatchObject({
      snapshotId: current.snapshotId,
      bluebubblesRecordId: "bb-out-visible-after-failure",
      advancedBy: "local-visible",
    })
  })

  it("records a pending report without a baseline when no prior baseline is available", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
    } = await import("../../rsvp/outbound-state")

    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel",
      bluebubblesRecord: {
        recordId: "bb-out-no-baseline",
        status: "reserved",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })

    const state = readRsvpOutboundState(agentRoot)
    expect(state).not.toHaveProperty("baseline")
    expect(state.pendingReports).toEqual([
      expect.objectContaining({ bluebubblesRecordId: "bb-out-no-baseline" }),
    ])
  })

  it("removes a pending report for the snapshot that becomes the written baseline", async () => {
    const {
      readRsvpOutboundState,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel",
      bluebubblesRecord: {
        recordId: "bb-out-pending-before-baseline",
        status: "failed",
        tempGuid: "temp-pending-before-baseline",
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })
    writeRsvpBaseline({
      agentRoot,
      snapshot: current,
      recordedAt: "2026-07-09T17:01:00.000Z",
      reason: "manual-baseline-repair",
    })

    expect(readRsvpOutboundState(agentRoot).pendingReports).toEqual([])
  })

  it("keeps an existing pending report idempotent across habit crash recovery", async () => {
    const {
      decideRsvpOutboundReport,
      recordRsvpOutboundAttempt,
      writeRsvpBaseline,
    } = await import("../../rsvp/outbound-state")

    writeRsvpBaseline({
      agentRoot,
      snapshot: previous,
      recordedAt: "2026-07-09T16:00:00.000Z",
      reason: "legacy-import",
    })
    const first = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: "RSVP Update -- Ari & Rachel\n\nNew RSVPs:\n- Debra Edelson -- declined",
      now: "2026-07-09T17:00:00.000Z",
    })
    recordRsvpOutboundAttempt({
      agentRoot,
      currentSnapshot: current,
      reportText: first.reportText,
      bluebubblesRecord: {
        recordId: "bb-out-3",
        status: "reserved",
        tempGuid: "temp-3",
        messageGuid: undefined,
      },
      recordedAt: "2026-07-09T17:00:02.000Z",
    })
    const recovered = decideRsvpOutboundReport({
      agentRoot,
      currentSnapshot: current,
      reportText: first.reportText,
      now: "2026-07-09T17:05:00.000Z",
    })

    expect(first).toMatchObject({ action: "send", idempotencyKey: recovered.idempotencyKey })
    expect(recovered).toMatchObject({
      action: "send",
      existingPending: expect.objectContaining({
        snapshotId: current.snapshotId,
        bluebubblesRecordId: "bb-out-3",
        status: "reserved",
      }),
    })
  })
})
