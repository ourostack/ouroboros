import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { createEvolutionCase } from "../../arc/evolution"
import { writeFlightRecorderResume } from "../../arc/flight-recorder"
import { advanceObligation, createObligation } from "../../arc/obligations"
import { createPonderPacket } from "../../arc/packets"
import { buildWorkCard, formatWorkCardText, validateWorkCardAgentName } from "../../heart/work-card"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-card-"))
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("Work Card projection", () => {
  it("compiles durable arc work with source locators, redaction, unavailable claims, and degraded source issues", () => {
    const agentRoot = makeAgentRoot()
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "ship a real visibility layer",
    })
    advanceObligation(agentRoot, obligation.id, {
      status: "waiting_for_merge",
      nextAction: "Ask Ari for review only if the visibility contract changes.",
      latestNote: "Implementation is underway.",
    })
    fs.mkdirSync(path.join(agentRoot, "arc", "obligations", "inner"), { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "arc", "obligations", "inner", "return-1.json"),
      JSON.stringify({
        id: "return-1",
        status: "queued",
        delegatedContent: "bring the visibility summary back to Ari",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        createdAt: 2_000_000_000_000 - 1_000,
      }),
      "utf-8",
    )
    createPonderPacket(agentRoot, {
      kind: "research",
      objective: "Map the Workbench visibility surface",
      summary: "Find the minimal truthful projection.",
      successCriteria: ["No duplicate source of truth"],
      payload: {},
    })
    createEvolutionCase(agentRoot, {
      title: "Visibility drift",
      problemStatement: "Visibility counts can go stale if they are copied.",
      desiredBehavior: "Counts are derived from source records.",
      origin: { kind: "runtime", label: "test", locator: "test://work-card" },
    })
    fs.writeFileSync(path.join(agentRoot, "arc", "packets", "broken.json"), "{", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "packets", "invalid.json"), JSON.stringify({ id: "invalid" }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "packets", "array.json"), "[]", "utf-8")

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      nowMs: () => 2_000_000_000_000,
      homeDir: agentRoot,
    })

    expect(card.projection).toEqual({
      owner: "arc/work-card",
      scope: "durable-arc-work",
      relationToActiveWorkFrame: "complements-live-turn-frame",
    })
    expect(card.generatedAt).toBe("2026-06-08T12:00:00.000Z")
    expect(card.counts).toMatchObject({
      owed: 1,
      returnObligations: 1,
      activePackets: 1,
      evolutionCases: 1,
      waitingOnHuman: 1,
      unverifiedClaims: null,
      staleRiskyClaims: null,
    })
    expect(card.degraded.status).toBe("degraded")
    expect(card.degraded.issues.map((issue) => issue.code)).toContain("arc_json_unreadable")
    expect(card.degraded.issues.map((issue) => issue.code)).toContain("arc_json_invalid_shape")
    expect(card.degraded.issues.map((issue) => issue.code)).not.toContain("claims_unavailable")
    expect(card.claims.available).toBe(false)
    expect(card.claims.unavailableReason).toContain("WorkClaim store is not implemented yet")
    expect(card.claims.counts.unverified).toBeNull()
    expect(card.claims.counts.staleRisky).toBeNull()
    expect(card.owed[0].source).toMatchObject({
      kind: "obligation",
      locator: `arc/obligations/${obligation.id}.json`,
      redaction: "summary",
    })
    expect(card.capabilityHealth.available).toBe(true)
    expect(card.capabilityHealth.providers?.lanes).toHaveLength(2)

    const text = formatWorkCardText(card)
    expect(text).toContain("Work Card — slugger")
    expect(text).toContain("Claims")
    expect(text).toContain("unavailable")
    expect(text).toContain("Source Issues")
    expect(text).toContain("arc_json_unreadable")
  })

  it("rejects unsafe agent names before path construction", () => {
    expect(validateWorkCardAgentName("slugger")).toBe("slugger")
    expect(() => validateWorkCardAgentName("../slugger")).toThrow(/safe agent name/)
    expect(() => validateWorkCardAgentName("slugger/other")).toThrow(/safe agent name/)
    expect(() => validateWorkCardAgentName(".")).toThrow(/safe agent name/)
    expect(() => validateWorkCardAgentName("..")).toThrow(/safe agent name/)
  })

  it("uses the flight recorder for current ask and next safe action", () => {
    const agentRoot = makeAgentRoot()
    writeFlightRecorderResume(agentRoot, {
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "finish the Arc visibility layer", confidence: "current", sourceEventIds: ["fr-1"] },
      nextSafeAction: { value: "run the reviewer gate", stopBefore: ["merge"], sourceEventIds: ["fr-1"] },
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

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.degraded.status).toBe("ok")
    expect(card.currentAsk).toMatchObject({
      available: true,
      value: "finish the Arc visibility layer",
      source: "flight_recorder",
      confidence: "current",
    })
    expect(card.nextAction).toMatchObject({
      actor: "agent",
      summary: "run the reviewer gate",
      source: { kind: "flight_recorder", locator: "arc/flight-recorder/latest.json" },
    })
    expect(card.sources).toContainEqual(expect.objectContaining({
      kind: "flight_recorder",
      freshness: "current",
    }))
    expect(formatWorkCardText(card)).toContain("finish the Arc visibility layer")
  })

  it("does not let a blocked flight recorder action override the blocker state", () => {
    const agentRoot = makeAgentRoot()
    writeFlightRecorderResume(agentRoot, {
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: false,
      missing: [],
      gaps: [],
      currentAsk: { value: "finish the Arc visibility layer", confidence: "current", sourceEventIds: ["fr-1"] },
      nextSafeAction: { value: "merge the branch", stopBefore: ["merge"], sourceEventIds: ["fr-1"] },
      blockedBecause: ["review gate has not passed"],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
      recorderHealth: { status: "ok", issues: [] },
    })

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction).toMatchObject({
      actor: "unknown",
      summary: "flight recorder blocked: review gate has not passed",
      source: { kind: "flight_recorder" },
    })
  })

  it("marks unavailable recorder blockers as unknown-source unavailable issues", () => {
    const agentRoot = makeAgentRoot()
    writeFlightRecorderResume(agentRoot, {
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: false,
      missing: [],
      gaps: [],
      currentAsk: { value: "finish the Arc visibility layer", confidence: "current", sourceEventIds: ["fr-1"] },
      nextSafeAction: { value: "merge the branch", stopBefore: ["merge"], sourceEventIds: ["fr-1"] },
      blockedBecause: ["recorder backend unavailable"],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: "turn-1", sessionRef: "cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-1"] },
      recorderHealth: { status: "unavailable", issues: ["latest.json could not be read"] },
    })

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction.source).toMatchObject({
      kind: "flight_recorder",
      freshness: "unknown",
    })
    expect(card.degraded.issues).toContainEqual(expect.objectContaining({
      code: "flight_recorder_degraded",
      severity: "unavailable",
    }))
  })

  it("chooses return obligations when no flight recorder action or human wait exists", () => {
    const agentRoot = makeAgentRoot()
    fs.mkdirSync(path.join(agentRoot, "arc", "obligations", "inner"), { recursive: true })
    fs.writeFileSync(
      path.join(agentRoot, "arc", "obligations", "inner", "return-only.json"),
      JSON.stringify({
        id: "return-only",
        status: "running",
        delegatedContent: "finish the private check",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        createdAt: 2_000_000_000_000,
      }),
      "utf-8",
    )
    fs.writeFileSync(
      path.join(agentRoot, "arc", "obligations", "inner", "return-queued.json"),
      JSON.stringify({
        id: "return-queued",
        status: "queued",
        delegatedContent: "start the queued private check",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        packetId: "packet-queued",
        createdAt: 2_000_000_000_001,
      }),
      "utf-8",
    )

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction).toMatchObject({
      actor: "agent",
      summary: "finish and surface the delegated result",
      source: { kind: "return_obligation", locator: "arc/obligations/inner/return-only.json" },
    })
    expect(card.returnObligations[1]).toMatchObject({
      summary: "packet: packet-queued",
      nextAction: "start private work and preserve the return route",
    })
  })

  it("chooses owed obligations when there are no return obligations", () => {
    const agentRoot = makeAgentRoot()
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "answer Ari about the Arc plan",
    })
    const obligationPath = path.join(agentRoot, "arc", "obligations", `${obligation.id}.json`)
    const savedObligation = JSON.parse(fs.readFileSync(obligationPath, "utf-8"))
    delete savedObligation.updatedAt
    fs.writeFileSync(obligationPath, JSON.stringify({
      ...savedObligation,
      meaning: { stalenessClass: "at-risk" },
    }), "utf-8")

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction).toMatchObject({
      actor: "agent",
      summary: "answer Ari about the Arc plan",
      source: { kind: "obligation", locator: `arc/obligations/${obligation.id}.json`, freshness: "stale_risky" },
    })
    expect(formatWorkCardText(card)).toContain("[pending] answer Ari about the Arc plan (source:")
  })

  it("uses the waiting item's title when it has no next action", () => {
    const agentRoot = makeAgentRoot()
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "wait for the merge queue",
    })
    advanceObligation(agentRoot, obligation.id, { status: "waiting_for_merge" })

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction).toMatchObject({
      actor: "human",
      summary: "wait for the merge queue",
    })
  })

  it("chooses active packet work when no obligations exist", async () => {
    const agentRoot = makeAgentRoot()
    const packet = createPonderPacket(agentRoot, {
      kind: "research",
      objective: "compare habit receipts",
      summary: "Find the smallest validation surface.",
      successCriteria: ["receipt is written"],
      payload: {},
    })
    const { advancePonderPacket } = await import("../../arc/packets")
    advancePonderPacket(agentRoot, packet.id, { status: "processing" })
    advancePonderPacket(agentRoot, packet.id, { status: "blocked" })

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction).toMatchObject({
      actor: "human",
      summary: "resolve blocker or mark waiting",
      source: { kind: "ponder_packet" },
    })
  })

  it("chooses non-blocked active packet work when nothing is waiting", () => {
    const agentRoot = makeAgentRoot()
    createPonderPacket(agentRoot, {
      kind: "research",
      objective: "compare habit receipts",
      summary: "Find the smallest validation surface.",
      successCriteria: ["receipt is written"],
      payload: {},
    })

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })

    expect(card.nextAction).toMatchObject({
      actor: "agent",
      summary: "advance packet toward validation and return",
      source: { kind: "ponder_packet" },
    })
  })

  it("formats unavailable capability health and unknown next action without a source", () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "work-card-no-config-"))
    tempDirs.push(agentRoot)

    const card = buildWorkCard("slugger", agentRoot, {
      now: () => new Date("2026-06-08T12:00:00.000Z"),
      homeDir: agentRoot,
    })
    card.capabilityHealth = { available: false, unavailableReason: "provider config unavailable" }
    const text = formatWorkCardText(card)

    expect(card.capabilityHealth.available).toBe(false)
    expect(card.nextAction.actor).toBe("unknown")
    expect(text).toContain("Capability Health")
    expect(text).toContain("unavailable:")
    expect(text).not.toContain("source: undefined")
  })
})
