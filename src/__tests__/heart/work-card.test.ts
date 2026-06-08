import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { createEvolutionCase } from "../../arc/evolution"
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
    expect(card.degraded.issues.map((issue) => issue.code)).toContain("claims_unavailable")
    expect(card.claims.available).toBe(false)
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
  })
})
