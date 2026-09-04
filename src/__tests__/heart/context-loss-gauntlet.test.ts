import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { writeFlightRecorderResume } from "../../arc/flight-recorder"
import { advanceObligation, createObligation } from "../../arc/obligations"
import { createPonderPacket } from "../../arc/packets"
import { formatContextLossGauntletText, runContextLossGauntlet } from "../../heart/context-loss-gauntlet"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-loss-gauntlet-"))
  tempDirs.push(dir)
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  }), "utf-8")
  return dir
}

function scaffoldDeskRecord(agentRoot: string): void {
  fs.mkdirSync(path.join(agentRoot, "desk", "_record", "diary", "daily"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "desk", "_record", "notes"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "desk", "_record", "diary", "facts.jsonl"), "", "utf-8")
  fs.writeFileSync(path.join(agentRoot, "desk", "_record", "diary", "entities.json"), "{}\n", "utf-8")
}

function writeReadyResume(agentRoot: string): void {
  writeFlightRecorderResume(agentRoot, {
    schemaVersion: 1,
    hasCompleteState: true,
    canContinue: true,
    missing: [],
    gaps: [],
    currentAsk: { value: "finish the context-loss drill", confidence: "current", sourceEventIds: ["fr-1"] },
    nextSafeAction: { value: "run the gauntlet and inspect the score", stopBefore: ["merge"], sourceEventIds: ["fr-1"] },
    blockedBecause: [],
    activeObligationIds: [],
    activeReturnObligationIds: [],
    activePacketIds: [],
    openEvolutionCaseIds: [],
    recentClaimIds: [],
    unverifiedClaimIds: [],
    lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
    recorderHealth: { status: "ok", issues: [] },
  })
}

function checkStatus(report: ReturnType<typeof runContextLossGauntlet>, id: string): string {
  return report.checks.find((check) => check.id === id)?.status ?? "missing"
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("context-loss gauntlet", () => {
  it("scores a ready recovery run from durable Arc, flight recorder, and Desk state", () => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "ship the recovery drill",
    })
    advanceObligation(agentRoot, obligation.id, {
      nextAction: "finish the gauntlet implementation",
      latestNote: "tests are defining the contract",
    })
    fs.mkdirSync(path.join(agentRoot, "arc", "obligations", "inner"), { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "arc", "obligations", "inner", "return-1.json"),
      JSON.stringify({
        id: "return-1",
        status: "queued",
        delegatedContent: "surface the result back to Ari",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        createdAt: 2_000_000_000_000,
      }),
      "utf-8",
    )
    writeReadyResume(agentRoot)

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      nowMs: () => 2_000_000_000_000,
      homeDir: agentRoot,
    })

    expect(report.schemaVersion).toBe(1)
    expect(report.verdict).toBe("ready")
    expect(report.score).toEqual({ earned: 95, possible: 95, percentage: 100 })
    expect(report.currentAsk.value).toBe("finish the context-loss drill")
    expect(report.nextAction.summary).toBe("run the gauntlet and inspect the score")
    expect(checkStatus(report, "current_ask")).toBe("pass")
    expect(checkStatus(report, "next_safe_action")).toBe("pass")
    expect(checkStatus(report, "obligations_visible")).toBe("pass")
    expect(checkStatus(report, "return_routes_visible")).toBe("pass")
    expect(checkStatus(report, "blockers_surface")).toBe("not_applicable")
    expect(report.checks.find((check) => check.id === "return_routes_visible")?.evidence[0]).toMatchObject({
      kind: "return_obligation",
      locator: "arc/obligations/inner/return-1.json",
    })
  })

  it("blocks the report when the resume is unsafe, Arc sources are broken, and legacy journal is active", () => {
    const agentRoot = makeAgentRoot()
    fs.mkdirSync(path.join(agentRoot, "journal"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "journal", "stale.md"), "old record", "utf-8")
    fs.mkdirSync(path.join(agentRoot, "arc", "flight-recorder"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "latest.json"), JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: false,
      canContinue: true,
      missing: ["nextSafeAction"],
      gaps: [],
      currentAsk: { value: "recover without hallucinating", confidence: "current", sourceEventIds: ["fr-1"] },
      nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
      blockedBecause: [],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
      recorderHealth: { status: "ok", issues: [] },
    }), "utf-8")
    fs.mkdirSync(path.join(agentRoot, "arc", "packets"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "arc", "packets", "broken.json"), "{", "utf-8")

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.verdict).toBe("blocked")
    expect(checkStatus(report, "stale_guard")).toBe("fail")
    expect(report.checks.find((check) => check.id === "stale_guard")?.detail).toContain("continuation is unsafe")
    expect(checkStatus(report, "next_safe_action")).toBe("fail")
    expect(checkStatus(report, "desk_record_ready")).toBe("fail")
    expect(checkStatus(report, "source_provenance")).toBe("fail")
    expect(report.summary).toContain("would lose or mislead")
  })

  it("warns when canonical Desk scaffolding has not been created yet", () => {
    const agentRoot = makeAgentRoot()
    writeReadyResume(agentRoot)

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.verdict).toBe("watch")
    expect(checkStatus(report, "desk_record_ready")).toBe("warn")
    expect(report.score.percentage).toBeLessThan(100)
  })

  it("fails when no durable current ask exists", () => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.verdict).toBe("blocked")
    expect(checkStatus(report, "current_ask")).toBe("fail")
    expect(report.checks.find((check) => check.id === "current_ask")?.detail).toContain("No durable current ask")
    expect(formatContextLossGauntletText(report)).toContain("current ask: unavailable")
  })

  it("warns when the current ask exists but is stale-risky", () => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)
    writeFlightRecorderResume(agentRoot, {
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "recover stale work", confidence: "stale_risky", sourceEventIds: ["fr-1"] },
      nextSafeAction: { value: "verify the stale ask before continuing", stopBefore: [], sourceEventIds: ["fr-1"] },
      blockedBecause: [],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
      recorderHealth: { status: "ok", issues: [] },
    })

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.verdict).toBe("watch")
    expect(checkStatus(report, "current_ask")).toBe("warn")
    expect(report.checks.find((check) => check.id === "current_ask")?.detail).toContain("stale_risky")
  })

  it.each(["settled", "observed", "rested", "superseded"])("treats a terminal %s turn waiting for input as ready", (outcome) => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)
    writeFlightRecorderResume(agentRoot, {
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: false,
      missing: [],
      gaps: [],
      currentAsk: { value: "wait for the next external event", confidence: "current", sourceEventIds: ["fr-idle"] },
      nextSafeAction: {
        value: "inspect the latest session and wait for new input before acting",
        stopBefore: ["acting on stale context"],
        sourceEventIds: ["fr-idle"],
      },
      blockedBecause: [`turn outcome ${outcome}; wait for new input before acting`],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "self/inner/dialog", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-idle"] },
      recorderHealth: { status: "ok", issues: [] },
    })

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.verdict).toBe("ready")
    expect(checkStatus(report, "next_safe_action")).toBe("pass")
    expect(checkStatus(report, "stale_guard")).toBe("pass")
  })

  it("passes the blocker surface check when waiting work controls the next action", () => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "wait for a deploy window",
    })
    advanceObligation(agentRoot, obligation.id, { status: "waiting_for_merge" })
    writeReadyResume(agentRoot)

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.verdict).toBe("ready")
    expect(report.nextAction.actor).toBe("human")
    expect(checkStatus(report, "blockers_surface")).toBe("pass")
  })

  it("does not let waiting work mask an unsafe flight recorder", () => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "wait for Ari's approval",
    })
    advanceObligation(agentRoot, obligation.id, { status: "waiting_for_merge" })
    writeFlightRecorderResume(agentRoot, {
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: false,
      missing: [],
      gaps: [],
      currentAsk: { value: "finish the context-loss drill", confidence: "current", sourceEventIds: ["fr-1"] },
      nextSafeAction: { value: "run the gauntlet and inspect the score", stopBefore: ["merge"], sourceEventIds: ["fr-1"] },
      blockedBecause: ["review gate has not passed"],
      activeObligationIds: [obligation.id],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
      recorderHealth: { status: "ok", issues: [] },
    })

    const report = runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(report.nextAction.actor).toBe("human")
    expect(checkStatus(report, "blockers_surface")).toBe("pass")
    expect(checkStatus(report, "stale_guard")).toBe("fail")
    expect(report.verdict).toBe("blocked")
  })

  it("formats a compact text report for IRL validation", () => {
    const agentRoot = makeAgentRoot()
    scaffoldDeskRecord(agentRoot)
    createPonderPacket(agentRoot, {
      kind: "research",
      objective: "validate the harness recovery path",
      summary: "Run the deterministic drill.",
      successCriteria: ["agent can resume without session context"],
      payload: {},
    })
    writeReadyResume(agentRoot)

    const text = formatContextLossGauntletText(runContextLossGauntlet("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    }))

    expect(text).toContain("Context-loss gauntlet - slugger")
    expect(text).toContain("verdict: ready")
    expect(text).toContain("current ask: finish the context-loss drill")
    expect(text).toContain("PASS current_ask")
    expect(text).toContain("N/A return_routes_visible")
  })
})
