import { describe, expect, it } from "vitest"

// The media MCP is a hand-written standalone .mjs deployed into the bundle as-is;
// it has no TypeScript types. It is imported here for its two pure exports, which
// are the deterministic core the agent must never have to reason out itself.
// @ts-expect-error - untyped hand-written module deployed verbatim
import { computeDownloadState, diagnose } from "../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs"

const GB = 1073741824
const hoursAgo = (now: number, h: number) => new Date(now - h * 3_600_000).toISOString()

function baseResult(over: Record<string, unknown> = {}) {
  return {
    file: { on_shelf: false },
    search: { grab_attempts: 1, last_grab_title: "Some Release", monitored: true },
    download: { active_downloads: 0, active_items: 0, states: [], tracked_states: [], errors: [], size_left_bytes: 0, size_total_bytes: 0, percent_complete: null, stalled: false, stalled_items: [] },
    ...over,
  }
}
const healthyChain = { healthy: true, problems: [] }

describe("media MCP — computeDownloadState", () => {
  const now = Date.parse("2026-09-22T00:00:00.000Z")

  it("counts a season pack once per download, not once per queue row", () => {
    // Three episode rows sharing one downloadId: summing rows would report the
    // pack at 3x its real size. Progressing, so not stalled.
    const rows = [1, 2, 3].map((n) => ({ id: n, downloadId: "pack-1", status: "downloading", trackedDownloadState: "downloading", size: 15 * GB, sizeleft: 5 * GB, added: hoursAgo(now, 1) }))
    const d = computeDownloadState(rows, now)
    expect(d.active_downloads).toBe(1)
    expect(d.active_items).toBe(3)
    expect(d.size_total_bytes).toBe(15 * GB)
    expect(d.stalled).toBe(false)
  })

  it("reports a release at zero bytes past the stall window as stalled", () => {
    // The exact production shape from 2026-09-21: 2.17 GB, nothing downloaded, 30h old.
    const rows = [{ id: 1356738359, downloadId: "abc", status: "downloading", trackedDownloadState: "downloading", title: "Autumn.in.New.York.2000.1080p.BluRay", size: 2166264964, sizeleft: 2166264964, added: hoursAgo(now, 30) }]
    const d = computeDownloadState(rows, now)
    expect(d.stalled).toBe(true)
    expect(d.percent_complete).toBe(0)
    expect(d.stalled_items).toHaveLength(1)
    expect(d.stalled_items[0]).toMatchObject({ age_hours: 30, size_gb: 2.02, queue_id: 1356738359 })
  })

  it("does not call a fresh zero-byte grab stalled inside the window", () => {
    const rows = [{ id: 1, downloadId: "x", status: "queued", size: 2 * GB, sizeleft: 2 * GB, added: hoursAgo(now, 2) }]
    expect(computeDownloadState(rows, now).stalled).toBe(false)
  })

  it("does not call a download stalled while it is making progress, however old", () => {
    const rows = [{ id: 1, downloadId: "x", status: "downloading", size: 4 * GB, sizeleft: 1 * GB, added: hoursAgo(now, 48) }]
    expect(computeDownloadState(rows, now).stalled).toBe(false)
  })

  it("computes percent complete from deduplicated totals", () => {
    const rows = [{ id: 1, downloadId: "x", status: "downloading", size: 100, sizeleft: 25, added: hoursAgo(now, 1) }]
    expect(computeDownloadState(rows, now).percent_complete).toBe(75)
  })

  it("is empty and quiet with no queue rows", () => {
    const d = computeDownloadState([], now)
    expect(d.active_downloads).toBe(0)
    expect(d.stalled).toBe(false)
    expect(d.percent_complete).toBeNull()
  })
})

describe("media MCP — diagnose", () => {
  it("calls a stalled download stuck, with the blocklist-and-research fix", () => {
    const download = computeDownloadState(
      [{ id: 9, downloadId: "d", status: "downloading", title: "Dead.Release", size: 2 * GB, sizeleft: 2 * GB, added: hoursAgo(Date.parse("2026-09-22T00:00:00.000Z"), 30) }],
      Date.parse("2026-09-22T00:00:00.000Z"),
    )
    const dx = diagnose({ shelf: {}, result: baseResult({ download }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_stage).toBe("download")
    expect(dx.stuck_reason).toBe("stalled_no_progress")
    expect(dx.likely_fix).toBe("blocklist_and_research")
    expect(dx.summary).toContain("Stalled, not slow")
    expect(dx.summary).toContain("30 hours")
  })

  it("calls a genuinely progressing download downloading, not stuck", () => {
    const download = { active_downloads: 1, active_items: 1, states: ["downloading"], tracked_states: ["downloading"], errors: [], size_left_bytes: 1 * GB, size_total_bytes: 4 * GB, percent_complete: 75, stalled: false, stalled_items: [] }
    const dx = diagnose({ shelf: {}, result: baseResult({ download }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_stage).toBeNull()
    expect(dx.summary).toContain("Downloading now")
  })

  it("says nothing is stuck when the movie is on the shelf", () => {
    const dx = diagnose({ shelf: {}, result: baseResult({ file: { on_shelf: true } }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_reason).toBeNull()
    expect(dx.summary).toContain("Nothing is stuck")
  })

  it("blames the acquisition chain, not the title, when the chain is down", () => {
    const chain = { healthy: false, problems: [{ service: "prowlarr", message: "Prowlarr has zero indexers configured." }] }
    const dx = diagnose({ shelf: {}, result: baseResult({ search: { grab_attempts: 0, monitored: true } }), chain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_reason).toBe("acquisition_chain_down")
    expect(dx.human_action_required).toBe(true)
  })

  it("names an unmonitored request rather than searching forever", () => {
    const dx = diagnose({ shelf: {}, result: baseResult(), chain: healthyChain, entity: { monitored: false }, kind: "movie" })
    expect(dx.stuck_reason).toBe("not_monitored")
  })

  it("points a never-grabbed title at a rescan", () => {
    const dx = diagnose({ shelf: {}, result: baseResult({ search: { grab_attempts: 0, monitored: true } }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(dx.stuck_reason).toBe("no_search_run_or_no_acceptable_release")
  })

  it("distinguishes grabbed-but-not-imported from a partial series", () => {
    const grabbed = diagnose({ shelf: {}, result: baseResult({ search: { grab_attempts: 1, last_grab_title: "The Grab", monitored: true } }), chain: healthyChain, entity: { monitored: true }, kind: "movie" })
    expect(grabbed.stuck_reason).toBe("grabbed_but_not_imported")

    const partial = diagnose({ shelf: {}, result: baseResult({ file: { episodes_on_disk: 4, episodes_total: 10 } }), chain: healthyChain, entity: { monitored: true }, kind: "series" })
    expect(partial.stuck_reason).toBe("partially_imported")
  })
})
