import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

describe("Arc flight recorder", () => {
  let agentRoot: string

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flight-recorder-"))
    mockEmitNervesEvent.mockReset()
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("returns a degraded resume when latest.json is missing", async () => {
    const { readFlightRecorderResume } = await import("../../arc/flight-recorder")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.canContinue).toBe(false)
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues).toContain("latest.json missing")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_resume_read",
    }))
  })

  it("returns a degraded resume when latest.json exists but is unreadable", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), "{", "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.canContinue).toBe(false)
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues[0]).toContain("latest.json unreadable")
  })

  it("returns a degraded resume when latest.json is parseable but malformed", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), "{}\n", "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.canContinue).toBe(false)
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues[0]).toContain("invalid flight-recorder resume shape")
  })

  it("refuses shape-valid latest state with unsafe continuation semantics", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: false,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: null, confidence: "unknown", sourceEventIds: [] },
      nextSafeAction: { value: "keep working", stopBefore: [], sourceEventIds: ["fr-bad"] },
      blockedBecause: [],
      activeObligationIds: ["ob-bad"],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-bad"] },
      recorderHealth: { status: "ok", issues: [] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.canContinue).toBe(false)
    expect(resume.hasCompleteState).toBe(false)
    expect(resume.missing).toContain("currentAsk")
    expect(resume.activeObligationIds).toEqual(["ob-bad"])
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues).toContain("canContinue true while hasCompleteState false")
  })

  it("removes stale missing fields when latest has complete continuation state", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: ["currentAsk"],
      gaps: [],
      currentAsk: { value: "finish the work", confidence: "current", sourceEventIds: ["fr-good"] },
      nextSafeAction: { value: "run validation", stopBefore: [], sourceEventIds: ["fr-good"] },
      blockedBecause: [],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-good"] },
      recorderHealth: { status: "ok", issues: [] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.canContinue).toBe(true)
    expect(resume.missing).toEqual([])
    expect(resume.recorderHealth).toEqual({ status: "ok", issues: [] })
  })

  it("records events, updates latest resume, and formats continuation state", async () => {
    const {
      flightRecorderLatestPath,
      formatFlightRecorderResume,
      readFlightRecorderResume,
      recordFlightRecorderEvent,
    } = await import("../../arc/flight-recorder")

    const event = recordFlightRecorderEvent(agentRoot, {
      id: "fr-test",
      kind: "post_turn_persisted",
      recordedAt: "2026-06-08T12:00:00.000Z",
      turnId: "turn-1",
      sessionRef: "self/cli/main",
      summary: "checkpoint saved",
      currentAsk: "finish Arc implementation",
      nextSafeAction: "run targeted tests",
      stopBefore: ["merge"],
      activeObligationIds: ["ob-1"],
    })

    expect(event.id).toBe("fr-test")
    expect(fs.existsSync(flightRecorderLatestPath(agentRoot))).toBe(true)
    expect(fs.readFileSync(path.join(agentRoot, "arc", "flight-recorder", "events", "2026-06-08.jsonl"), "utf-8")).toContain("fr-test")

    const resume = readFlightRecorderResume(agentRoot)
    expect(resume.canContinue).toBe(true)
    expect(resume.currentAsk.value).toBe("finish Arc implementation")
    expect(resume.nextSafeAction.value).toBe("run targeted tests")
    expect(formatFlightRecorderResume(resume)).toContain("next safe action: run targeted tests")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_resume_written",
    }))
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_event_recorded",
    }))
  })

  it("records maximal events with optional Arc references and unknown event day", async () => {
    const { recordFlightRecorderEvent } = await import("../../arc/flight-recorder")

    const event = recordFlightRecorderEvent(agentRoot, {
      kind: "claim_recorded",
      recordedAt: "",
      summary: "maximal event",
      currentAsk: null,
      nextSafeAction: null,
      stopBefore: ["merge"],
      blockedBecause: ["coverage"],
      activeReturnObligationIds: ["ret-1"],
      activePacketIds: ["packet-1"],
      openEvolutionCaseIds: ["case-1"],
      recentClaimIds: ["claim-0"],
      unverifiedClaimIds: ["claim-1"],
      producedRefs: [{ kind: "claim", locator: "arc/claims/claim-1.json" }],
      meta: { nested: { value: "kept" } },
    })

    expect(event.recordedAt).toBe("")
    expect(event.currentAsk).toBeNull()
    expect(event.nextSafeAction).toBeNull()
    expect(fs.existsSync(path.join(agentRoot, "arc", "flight-recorder", "events", "unknown.jsonl"))).toBe(true)
  })

  it("does not mark next-action-only state safe to continue", async () => {
    const { readFlightRecorderResume, recordFlightRecorderEvent } = await import("../../arc/flight-recorder")

    recordFlightRecorderEvent(agentRoot, {
      kind: "post_turn_persisted",
      summary: "checkpoint has only a next step",
      nextSafeAction: "run validation",
    })

    const resume = readFlightRecorderResume(agentRoot)
    expect(resume.hasCompleteState).toBe(false)
    expect(resume.canContinue).toBe(false)
    expect(resume.missing).toContain("currentAsk")
  })

  it("defaults recordedAt when recording an event without an explicit timestamp", async () => {
    const { recordFlightRecorderEvent } = await import("../../arc/flight-recorder")

    const event = recordFlightRecorderEvent(agentRoot, {
      kind: "post_turn_persisted",
      summary: "default timestamp",
    })

    expect(new Date(event.recordedAt).toString()).not.toBe("Invalid Date")
  })

  it("formats resume gaps and active durable references", async () => {
    const { formatFlightRecorderResume } = await import("../../arc/flight-recorder")

    const rendered = formatFlightRecorderResume({
      schemaVersion: 1,
      hasCompleteState: false,
      canContinue: false,
      missing: ["latest checkpoint"],
      gaps: ["context compacted mid-turn"],
      currentAsk: { value: null, confidence: "unknown", sourceEventIds: [] },
      nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
      blockedBecause: ["needs validation"],
      activeObligationIds: ["ob-1"],
      activeReturnObligationIds: ["ret-1"],
      activePacketIds: ["packet-1"],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: ["claim-1"],
      lastSafeCheckpoint: null,
      recorderHealth: { status: "degraded", issues: ["latest.json stale"] },
    })

    expect(rendered).toContain("blocked: needs validation")
    expect(rendered).toContain("missing: latest checkpoint")
    expect(rendered).toContain("gaps: context compacted mid-turn")
    expect(rendered).toContain("return obligations: ret-1")
    expect(rendered).toContain("packets: packet-1")
    expect(rendered).toContain("unverified claims: claim-1")
    expect(rendered).toContain("recorder health: degraded")

    const emptyObligations = formatFlightRecorderResume({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "keep moving", confidence: "current", sourceEventIds: ["fr-ready"] },
      nextSafeAction: { value: "run checks", stopBefore: [], sourceEventIds: ["fr-ready"] },
      blockedBecause: [],
      activeObligationIds: [],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: "turn-ready", sessionRef: "friend/cli/main", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-ready"] },
      recorderHealth: { status: "ok", issues: [] },
    })
    expect(emptyObligations).not.toContain("obligations:")
  })

  it("falls back to a generic slug when creating habit run ids from punctuation", async () => {
    const { createHabitRunId } = await import("../../arc/flight-recorder")

    expect(createHabitRunId("!!!", new Date("2026-06-08T12:00:00.000Z"))).toContain("-habit-")
  })

  it("writes habit run receipts and records them in the event log", async () => {
    const { createHabitRunId, writeHabitRunReceipt } = await import("../../arc/flight-recorder")
    const runId = createHabitRunId("daily-record", new Date("2026-06-08T12:00:00.000Z"))

    writeHabitRunReceipt(agentRoot, {
      schemaVersion: 1,
      runId,
      habitName: "daily-record",
      trigger: "poke",
      startedAt: "2026-06-08T12:00:00.000Z",
      endedAt: "2026-06-08T12:01:00.000Z",
      outcome: "surfaced",
      producedRefs: [{ kind: "surface", locator: "sessions/ari/cli/main" }],
      surfaceAttempts: [{
        recipient: "ari",
        channel: "cli",
        reason: "status",
        result: "sent",
      }],
      errors: ["minor habit issue"],
    })

    const receiptPath = path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", `${runId}.json`)
    expect(fs.existsSync(receiptPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf-8"))).toMatchObject({
      habitName: "daily-record",
      outcome: "surfaced",
      errors: ["minor habit issue"],
    })
    expect(fs.readFileSync(path.join(agentRoot, "arc", "flight-recorder", "events", "2026-06-08.jsonl"), "utf-8")).toContain("habit daily-record finished with surfaced")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_habit_receipt_written",
    }))
  })
})
