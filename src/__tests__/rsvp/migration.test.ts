import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function writeLegacySnapshot(legacyRoot: string, name: string, guests: Record<string, unknown>): string {
  const snapshotPath = path.join(legacyRoot, "data", name)
  writeJson(snapshotPath, {
    guests,
    all_guests: Object.fromEntries(Object.entries(guests).map(([id, guest]) => {
      const row = guest as Record<string, unknown>
      return [id, {
        first_name: row.first_name,
        last_name: row.last_name,
        group_id: row.group_id,
      }]
    })),
  })
  return snapshotPath
}

describe("RSVP legacy migration", () => {
  it("imports the pinned sent baseline and latest legacy snapshot into native private state without absolute legacy paths", async () => {
    const { importLegacyRsvpState, readRsvpBaselineState } = await import("../../rsvp/migration")
    const agentRoot = tempDir("ouro-rsvp-agent-")
    const legacyRoot = tempDir("ouro-rsvp-legacy-")
    const baselinePath = writeLegacySnapshot(legacyRoot, "snapshot_2026-07-08_100007.json", {
      "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
    })
    const latestPath = writeLegacySnapshot(legacyRoot, "snapshot_2026-07-09_100007.json", {
      "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
      "g-2": { first_name: "Bina", last_name: "Example", group_id: 20, attending_status: "declined" },
    })
    writeJson(path.join(legacyRoot, "data", "sent_state.json"), {
      snapshot_path: baselinePath,
      source: "sent",
      updated_at: "2026-07-09T10:00:07.493920",
    })

    const result = importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })

    expect(result).toMatchObject({
      ok: true,
      latestSnapshotPath: expect.stringContaining("state/rsvp/snapshots/"),
      baselineSnapshotPath: expect.stringContaining("state/rsvp/snapshots/"),
      baselineSource: "sent",
    })
    const baseline = readRsvpBaselineState(agentRoot)
    expect(baseline).toMatchObject({
      schemaVersion: 1,
      policyVersion: "rsvp-migration/v1",
      baselineSource: "sent",
      legacySnapshotRelativePath: "data/snapshot_2026-07-08_100007.json",
      nativeSnapshotId: result.baselineSnapshotId,
      legacySnapshotHash: expect.stringMatching(/^sha256:/),
      sentStateHash: expect.stringMatching(/^sha256:/),
    })
    const latestRaw = fs.readFileSync(result.latestSnapshotPath, "utf-8")
    const baselineRaw = fs.readFileSync(result.baselineSnapshotPath, "utf-8")
    expect(latestRaw).toContain("Bina")
    expect(latestRaw).not.toContain(legacyRoot)
    expect(baselineRaw).not.toContain(legacyRoot)
    expect(path.resolve(latestPath)).toContain(legacyRoot)
  })

  it("hard-blocks missing, malformed, or unreadable sent baselines instead of silently bootstrapping", async () => {
    const { importLegacyRsvpState } = await import("../../rsvp/migration")
    const agentRoot = tempDir("ouro-rsvp-agent-")
    const legacyRoot = tempDir("ouro-rsvp-legacy-")
    writeLegacySnapshot(legacyRoot, "snapshot_2026-07-09_100007.json", {
      "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
    })

    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({
      ok: false,
      reason: "missing_sent_state",
      actor: "agent-runnable",
    })

    writeJson(path.join(legacyRoot, "data", "sent_state.json"), { snapshot_path: path.join(legacyRoot, "data", "missing.json") })
    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({
      ok: false,
      reason: "missing_baseline_snapshot",
      actor: "agent-runnable",
    })

    fs.writeFileSync(path.join(legacyRoot, "data", "sent_state.json"), "{bad json", "utf-8")
    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({
      ok: false,
      reason: "malformed_sent_state",
      actor: "agent-runnable",
    })
  })

  it("reports other legacy import hard failures without writing native state", async () => {
    const { importLegacyRsvpState } = await import("../../rsvp/migration")
    const agentRoot = tempDir("ouro-rsvp-agent-")
    const missingRoot = tempDir("ouro-rsvp-missing-")
    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot: path.join(missingRoot, "does-not-exist"),
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({ ok: false, reason: "missing_legacy_data" })

    const outsideRoot = tempDir("ouro-rsvp-outside-")
    const legacyRoot = tempDir("ouro-rsvp-legacy-")
    const outsideSnapshot = writeLegacySnapshot(outsideRoot, "snapshot_2026-07-09_100007.json", {
      "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
    })
    writeJson(path.join(legacyRoot, "data", "sent_state.json"), { snapshot_path: outsideSnapshot })
    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({ ok: false, reason: "baseline_outside_legacy_root" })

    const noSnapshotRoot = tempDir("ouro-rsvp-legacy-")
    const baselinePath = path.join(noSnapshotRoot, "data", "baseline.json")
    writeJson(baselinePath, { guests: {}, all_guests: [] })
    writeJson(path.join(noSnapshotRoot, "data", "sent_state.json"), { snapshot_path: baselinePath, source: 123 })
    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot: noSnapshotRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({ ok: false, reason: "missing_legacy_snapshot" })

    const malformedRoot = tempDir("ouro-rsvp-legacy-")
    const malformedBaseline = path.join(malformedRoot, "data", "baseline.json")
    writeJson(malformedBaseline, { no_guests: true })
    writeLegacySnapshot(malformedRoot, "snapshot_2026-07-09_100007.json", {
      "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
    })
    writeJson(path.join(malformedRoot, "data", "sent_state.json"), { snapshot_path: malformedBaseline })
    expect(importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot: malformedRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })).toMatchObject({ ok: false, reason: "malformed_legacy_snapshot" })

    const invalidAllGuestsRoot = tempDir("ouro-rsvp-legacy-")
    const customBaseline = path.join(invalidAllGuestsRoot, "data", "baseline.json")
    writeJson(customBaseline, {
      guests: { "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" } },
      all_guests: [],
    })
    writeLegacySnapshot(invalidAllGuestsRoot, "snapshot_2026-07-09_100007.json", {
      "g-1": { first_name: "Ari", last_name: "Example", group_id: 10, attending_status: "attending" },
    })
    writeJson(path.join(invalidAllGuestsRoot, "data", "sent_state.json"), { snapshot_path: customBaseline, source: 123 })
    const imported = importLegacyRsvpState({
      agent: "slugger",
      agentRoot,
      legacyRoot: invalidAllGuestsRoot,
      weddingId: "wedding-1",
      eventId: "event-1",
      importedAt: "2026-07-09T17:00:00.000Z",
    })
    expect(imported).toMatchObject({ ok: true, baselineSource: "sent" })
  })
})
