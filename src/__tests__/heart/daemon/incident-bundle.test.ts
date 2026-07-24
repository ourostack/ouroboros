import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  buildRsvpIncidentBundle,
  writeRsvpIncidentBundle,
} from "../../../rsvp/incident-bundle"

const tempRoots: string[] = []
const forbiddenChatGuid = "any;+;incident-secret-chat"
const forbiddenServerUrl = "http://127.0.0.1:1234"
const forbiddenSecret = "incident-bluebubbles-secret"

function makeAgentRoot(): string {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-incident-bundles-"))
  tempRoots.push(bundlesRoot)
  const agentRoot = path.join(bundlesRoot, "slugger.ouro")
  fs.mkdirSync(path.join(agentRoot, "rsvp"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "state", "senses", "context-packets"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "state", "rsvp", "outbound"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "state", "rsvp", "snapshots"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ version: 2, enabled: true }), "utf-8")
  fs.writeFileSync(path.join(agentRoot, "habits", "rsvp-wedding.md"), [
    "---",
    "name: rsvp-wedding",
    "status: active",
    "cadence: 0 10 * * *",
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
  ].join("\n"), "utf-8")
  fs.writeFileSync(path.join(agentRoot, "rsvp", "config.json"), JSON.stringify({
    schemaVersion: 1,
    policyVersion: "rsvp-config/v1",
    agent: "slugger",
    mode: "shadow",
    source: { kind: "aisleplanner", weddingId: "484532", eventId: "2081539" },
    credentialRef: { runtimeConfigItem: "runtime/config", runtimeConfigPath: "rsvp.aisleplanner" },
    bluebubblesRoute: { chatGuid: forbiddenChatGuid, chatIdentifier: "wedding-chat" },
  }), "utf-8")
  fs.writeFileSync(path.join(agentRoot, "state", "senses", "context-packets", "ledger.jsonl"), `${JSON.stringify({
    id: "ctx_1",
    sense: "bluebubbles",
    scope: "same-chat",
    createdAt: "2026-07-09T18:00:00.000Z",
    sourceMessageGuid: "msg_1",
    preview: "redacted summary only",
  })}\n`, "utf-8")
  fs.writeFileSync(path.join(agentRoot, "state", "rsvp", "outbound", "ledger.json"), JSON.stringify({
    reservations: [
      { idempotencyKey: "rsvp:2026-07-09", status: "accepted", messageGuid: "sent-guid" },
    ],
  }), "utf-8")
  fs.writeFileSync(path.join(agentRoot, "state", "rsvp", "snapshots", "latest.json"), JSON.stringify({
    snapshotId: "snap_latest",
    fetchedAt: "2026-07-09T17:59:00.000Z",
    counts: { attending: 149, declined: 123, pending: 1 },
  }), "utf-8")
  fs.writeFileSync(path.join(agentRoot, "state", "rsvp", "spend-ledger.json"), JSON.stringify({
    runs: [{ operationId: "habit_1", provider: "none", tokens: 0 }],
  }), "utf-8")
  return agentRoot
}

function makeBareAgentRoot(): string {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-incident-bare-"))
  tempRoots.push(bundlesRoot)
  const agentRoot = path.join(bundlesRoot, "slugger.ouro")
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ version: 2, enabled: true }), "utf-8")
  return agentRoot
}

function incidentDeps(): Parameters<typeof buildRsvpIncidentBundle>[0]["deps"] {
  return {
    existsSync: fs.existsSync,
    readFileSync: (filePath) => fs.readFileSync(filePath, "utf-8"),
    readdirSync: (dirPath) => fs.readdirSync(dirPath),
    statSync: (filePath) => fs.statSync(filePath),
    checkSocketAlive: vi.fn(async () => false),
    now: () => new Date("2026-07-09T19:30:00.000Z"),
    runDoctorChecks: vi.fn(async () => ({
      categories: [{
        name: "RSVP",
        checks: [
          { id: "rsvp.native_config", label: "slugger.ouro RSVP native config", status: "pass", detail: "present" },
          { id: "rsvp.cutover.live_send_preflight", label: "slugger.ouro RSVP legacy live-send preflight", status: "fail", detail: "sendAllowed=false" },
        ],
      }],
      summary: { passed: 1, warnings: 0, failed: 1 },
    })),
  }
}

function expectRedacted(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(forbiddenChatGuid)
  expect(serialized).not.toContain(forbiddenServerUrl)
  expect(serialized).not.toContain(forbiddenSecret)
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("RSVP incident bundle", () => {
  it("collects a side-effect-free redacted incident summary across RSVP health surfaces", async () => {
    const agentRoot = makeAgentRoot()

    const bundle = await buildRsvpIncidentBundle({
      agent: "slugger",
      agentRoot,
      deps: incidentDeps(),
    })

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      agent: "slugger",
      generatedAt: "2026-07-09T19:30:00.000Z",
      sideEffect: false,
      doctor: {
        summary: { passed: 1, warnings: 0, failed: 1 },
      },
      contextPacketLedger: {
        status: "pass",
        latestPacketId: "ctx_1",
      },
      habitSchedule: {
        status: "pass",
        activeHabit: "rsvp-wedding",
        cadence: "0 10 * * *",
      },
      latestFetch: {
        status: "pass",
        snapshotId: "snap_latest",
        counts: { attending: 149, declined: 123, pending: 1 },
      },
      deliveryReconciliation: {
        status: "pass",
        accepted: 1,
      },
      spendTimeline: {
        status: "pass",
        runs: 1,
      },
    })
    expectRedacted(bundle)
  })

  it("writes incident output JSON without contacting the daemon or mutating RSVP state", async () => {
    const agentRoot = makeAgentRoot()
    const outputPath = path.join(os.tmpdir(), `rsvp-incident-${process.pid}-${Date.now()}.json`)
    tempRoots.push(outputPath)

    const result = await writeRsvpIncidentBundle({
      agent: "slugger",
      agentRoot,
      outputPath,
      deps: incidentDeps(),
    })

    expect(result.outputPath).toBe(outputPath)
    const written = JSON.parse(fs.readFileSync(outputPath, "utf-8"))
    expect(written).toMatchObject({
      schemaVersion: 1,
      agent: "slugger",
      sideEffect: false,
    })
    expectRedacted(written)
  })

  it("falls back to the side-effect-free generic doctor when no doctor runner is injected", async () => {
    const agentRoot = makeBareAgentRoot()
    const depsWithoutDoctor = incidentDeps()
    delete depsWithoutDoctor.runDoctorChecks

    const bundle = await buildRsvpIncidentBundle({
      agent: "slugger",
      agentRoot,
      deps: depsWithoutDoctor,
    })

    expect(bundle.doctor).toMatchObject({ categories: [] })
    expect(bundle.sideEffect).toBe(false)
    expectRedacted(bundle)
  })

  it("uses the current time when an incident clock is not injected", async () => {
    const agentRoot = makeAgentRoot()
    const depsWithoutClock = incidentDeps()
    delete depsWithoutClock.now

    const bundle = await buildRsvpIncidentBundle({
      agent: "slugger",
      agentRoot,
      deps: depsWithoutClock,
    })

    expect(Number.isFinite(Date.parse(bundle.generatedAt))).toBe(true)
    expect(bundle.generatedAt).not.toBe("2026-07-09T19:30:00.000Z")
    expectRedacted(bundle)
  })
})
