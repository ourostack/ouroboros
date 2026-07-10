import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildRsvpSnapshot, type RsvpSnapshot } from "../../rsvp/snapshot"
import { rsvpToolDefinitions } from "../../repertoire/tools-rsvp"
import { baseToolDefinitions } from "../../repertoire/tools-base"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const tempRoots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-tool-"))
  tempRoots.push(root)
  return root
}

function snapshot(): RsvpSnapshot {
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
    },
    allGuests: {},
    provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
  })
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("RSVP repertoire tools", () => {
  it("registers native RSVP tools in the base tool registry", () => {
    const names = baseToolDefinitions.map((definition) => definition.tool.function.name)
    expect(names).toContain("rsvp_query")
    expect(names).toContain("rsvp_summary")
  })

  it("answers pending questions from a native snapshot file without calling a model summarizer", async () => {
    const root = tempRoot()
    const snapshotPath = path.join(root, "snapshot.json")
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot()), "utf-8")
    const summarize = vi.fn(async () => "model answer")
    const tool = rsvpToolDefinitions.find((definition) => definition.tool.function.name === "rsvp_query")

    const result = await tool!.handler({
      snapshot_path: snapshotPath,
      query: "who is pending?",
    }, { summarize } as never)

    expect(result).toBe("Pending (1/2): Rachel Example")
    expect(summarize).not.toHaveBeenCalled()
  })

  it("summarizes native snapshot files", async () => {
    const root = tempRoot()
    const value = snapshot()
    const snapshotPath = path.join(root, "snapshot.json")
    fs.writeFileSync(snapshotPath, JSON.stringify(value), "utf-8")
    const tool = rsvpToolDefinitions.find((definition) => definition.tool.function.name === "rsvp_summary")

    await expect(tool!.handler({ snapshot_path: snapshotPath })).resolves.toBe(
      `RSVP snapshot ${value.snapshotId}: 1 attending / 0 declined / 1 pending / 0 unknown (2 total), fetched 2026-07-09T12:00:00.000Z`,
    )
    await expect(tool!.handler({ snapshot_path: path.join(root, "missing-summary.json") })).resolves.toBe(
      "RSVP snapshot not found.",
    )
  })

  it("returns redacted, actionable errors for missing or malformed snapshots", async () => {
    const root = tempRoot()
    const malformed = path.join(root, "bad.json")
    const invalidSnapshot = path.join(root, "invalid-snapshot.json")
    fs.writeFileSync(malformed, "{not-json with secret-token}", "utf-8")
    fs.writeFileSync(invalidSnapshot, "{}", "utf-8")
    const tool = rsvpToolDefinitions.find((definition) => definition.tool.function.name === "rsvp_query")

    await expect(tool!.handler({})).resolves.toBe(
      "RSVP snapshot not found.",
    )
    await expect(tool!.handler({ snapshot_path: "   " })).resolves.toBe(
      "RSVP snapshot not found.",
    )
    await expect(tool!.handler({ snapshot_path: path.join(root, "missing.json"), status: "pending" })).resolves.toBe(
      "RSVP snapshot not found.",
    )
    await expect(tool!.handler({ snapshot_path: invalidSnapshot, status: "pending" })).resolves.toBe(
      "RSVP snapshot could not be read or failed integrity validation.",
    )
    await expect(tool!.handler({ snapshot_path: malformed, status: "pending" })).resolves.toBe(
      "RSVP snapshot could not be read or failed integrity validation.",
    )
  })
})
