import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { collectRsvpDiagnostics, type RsvpDiagnosticsDeps } from "../../rsvp/diagnostics"

const tempRoots: string[] = []

function makeAgentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-diagnostics-"))
  tempRoots.push(root)
  const agentRoot = path.join(root, "slugger.ouro")
  fs.mkdirSync(agentRoot, { recursive: true })
  return agentRoot
}

function deps(overrides: Partial<RsvpDiagnosticsDeps> = {}): RsvpDiagnosticsDeps {
  return {
    existsSync: fs.existsSync,
    readFileSync: (filePath) => fs.readFileSync(filePath, "utf-8"),
    readdirSync: (dirPath) => fs.readdirSync(dirPath),
    ...overrides,
  }
}

function writeFile(agentRoot: string, relativePath: string, content: string): void {
  const filePath = path.join(agentRoot, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf-8")
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("RSVP diagnostics", () => {
  it("reports missing passive health surfaces as warnings", () => {
    const agentRoot = makeAgentRoot()

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics).toMatchObject({
      contextPacketLedger: { status: "warn", rows: 0 },
      habitSchedule: { status: "warn", detail: "habits directory missing" },
      latestFetch: { status: "warn", detail: "latest RSVP snapshot missing" },
      deliveryReconciliation: { status: "warn", accepted: 0 },
      spendTimeline: { status: "warn", runs: 0 },
    })
  })

  it("surfaces malformed passive state without leaking contents or throwing", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "state/senses/context-packets/ledger.jsonl", [
      "{not json}",
      JSON.stringify({ createdAt: "not-a-date", sense: "bluebubbles" }),
      "",
    ].join("\n"))
    writeFile(agentRoot, "habits/rsvp-paused.md", "---\nname: rsvp-paused\nstatus: paused\n---\n")
    writeFile(agentRoot, "state/rsvp/snapshots/latest.json", "{not json}")
    writeFile(agentRoot, "state/rsvp/outbound-state.json", "[]")
    writeFile(agentRoot, "state/rsvp/spend-ledger.json", "{}")

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics.contextPacketLedger).toMatchObject({
      status: "warn",
      detail: "rows=1; latest packet id missing",
      rows: 1,
    })
    expect(diagnostics.habitSchedule).toMatchObject({
      status: "warn",
      detail: "no active RSVP habit found",
    })
    expect(diagnostics.latestFetch).toMatchObject({
      status: "fail",
      detail: "latest RSVP snapshot is malformed",
    })
    expect(diagnostics.deliveryReconciliation).toMatchObject({
      status: "fail",
      detail: "RSVP outbound state is malformed",
      accepted: 0,
    })
    expect(diagnostics.spendTimeline).toMatchObject({
      status: "fail",
      detail: "RSVP spend ledger is malformed",
      runs: 0,
    })
  })

  it("reads modern ledger, summary snapshot, unspecified cadence, and outbound baseline fallbacks", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "state/senses/context-packets/bluebubbles/ledger.jsonl", [
      JSON.stringify({ packetId: "ctx_old", createdAt: "2026-07-09T17:00:00.000Z" }),
      JSON.stringify({ packetId: "ctx_new", anchorTimestamp: "2026-07-09T18:00:00.000Z" }),
      "",
    ].join("\n"))
    writeFile(agentRoot, "habits/rsvp-active.md", [
      "---",
      "name: rsvp-active",
      "status: active",
      "rsvp:",
      "  policyVersion: rsvp-habit/v1",
      "  mode: shadow",
      "  sense: bluebubbles",
      "  source: aisleplanner",
      "  routeRef: rsvp/config.json#bluebubblesRoute",
      "  snapshotRef: state/rsvp/snapshots/latest.json",
      "  outboundStateRef: state/rsvp/outbound-state.json",
      "  budgetRef: state/rsvp/spend-ledger.json",
      "  idempotencyRef: state/rsvp/outbound-state.json",
      "  liveSendEligible: false",
      "---",
      "",
    ].join("\n"))
    writeFile(agentRoot, "state/rsvp/snapshots/latest.json", JSON.stringify({
      snapshotId: "snap_summary",
      summary: { attending: 1, declined: 2, pending: 3 },
    }))
    writeFile(agentRoot, "state/rsvp/outbound-state.json", JSON.stringify({
      baseline: { snapshotId: "snap_summary" },
    }))
    writeFile(agentRoot, "state/rsvp/spend-ledger.json", JSON.stringify({ runs: [] }))

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics).toMatchObject({
      contextPacketLedger: { status: "pass", latestPacketId: "ctx_new", rows: 2 },
      habitSchedule: { status: "pass", activeHabit: "rsvp-active", cadence: "unspecified" },
      latestFetch: {
        status: "pass",
        snapshotId: "snap_summary",
        counts: { attending: 1, declined: 2, pending: 3 },
      },
      deliveryReconciliation: { status: "pass", accepted: 1 },
      spendTimeline: { status: "pass", runs: 0 },
    })
  })

  it("accepts context packet ledger rows that have no timestamp", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "state/senses/context-packets/bluebubbles/ledger.jsonl", [
      JSON.stringify({ packetId: "ctx_invalid_timestamp", createdAt: "not-a-date" }),
      JSON.stringify({ packetId: "ctx_no_timestamp" }),
      "",
    ].join("\n"))

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics.contextPacketLedger).toMatchObject({
      status: "pass",
      rows: 2,
    })
    expect(["ctx_invalid_timestamp", "ctx_no_timestamp"]).toContain(diagnostics.contextPacketLedger.latestPacketId)
  })

  it("fails habit schedule health when RSVP habit files cannot be read", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "habits/rsvp-broken.md", "---\nname: rsvp-broken\n---\n")

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps({
      readFileSync: (filePath) => {
        if (filePath.endsWith("rsvp-broken.md")) throw new Error("permission denied")
        return fs.readFileSync(filePath, "utf-8")
      },
    }))

    expect(diagnostics.habitSchedule).toMatchObject({
      status: "fail",
      detail: "habit schedule unreadable: permission denied",
    })
  })

  it("stringifies non-Error habit read failures", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "habits/rsvp-broken.md", "---\nname: rsvp-broken\n---\n")

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps({
      readFileSync: (filePath) => {
        if (filePath.endsWith("rsvp-broken.md")) throw "string failure"
        return fs.readFileSync(filePath, "utf-8")
      },
    }))

    expect(diagnostics.habitSchedule).toMatchObject({
      status: "fail",
      detail: "habit schedule unreadable: string failure",
    })
  })

  it("treats malformed legacy outbound ledgers and empty modern baselines as zero accepted", () => {
    const legacyRoot = makeAgentRoot()
    writeFile(legacyRoot, "state/rsvp/outbound/ledger.json", "[]")

    const legacyDiagnostics = collectRsvpDiagnostics(legacyRoot, deps())

    expect(legacyDiagnostics.deliveryReconciliation).toMatchObject({
      status: "pass",
      accepted: 0,
    })

    const modernRoot = makeAgentRoot()
    writeFile(modernRoot, "state/rsvp/outbound-state.json", "{}")

    const modernDiagnostics = collectRsvpDiagnostics(modernRoot, deps())

    expect(modernDiagnostics.deliveryReconciliation).toMatchObject({
      status: "pass",
      accepted: 0,
    })
  })

  it("counts accepted entries in legacy outbound ledgers", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "state/rsvp/outbound/ledger.json", JSON.stringify({
      reservations: [
        { status: "accepted" },
        { status: "failed" },
        { status: "accepted" },
        "ignored",
      ],
    }))

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics.deliveryReconciliation).toMatchObject({
      status: "pass",
      accepted: 2,
    })
  })

  it("fails latest snapshot health when id or counts are missing", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "state/rsvp/snapshots/latest.json", JSON.stringify({ snapshotId: "snap_missing_counts" }))

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics.latestFetch).toMatchObject({
      status: "fail",
      detail: "latest RSVP snapshot missing id or counts",
    })
  })

  it("fails latest snapshot health when count fields are not finite numbers", () => {
    const agentRoot = makeAgentRoot()
    writeFile(agentRoot, "state/rsvp/snapshots/latest.json", JSON.stringify({
      snapshotId: "snap_bad_counts",
      counts: { attending: 1, declined: "two", pending: 3 },
    }))

    const diagnostics = collectRsvpDiagnostics(agentRoot, deps())

    expect(diagnostics.latestFetch).toMatchObject({
      status: "fail",
      detail: "latest RSVP snapshot missing id or counts",
    })
  })
})
