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
    expect(resume.nextSafeAction.value).toBe("inspect unverifiable active obligations before acting: ob-bad")
    expect(resume.nextSafeAction.stopBefore).toContain("acting on unverifiable obligation state")
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues).toContain("canContinue true while hasCompleteState false")
    expect(resume.recorderHealth.issues).toContain("active obligation ids could not be verified in arc/obligations: ob-bad")
  })

  it("removes fulfilled obligation ids from returned latest state on read without mutating latest.json", async () => {
    const { createObligation, fulfillObligation } = await import("../../arc/obligations")
    const { flightRecorderLatestPath, readFlightRecorderResume, recordFlightRecorderEvent } = await import("../../arc/flight-recorder")
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "friend-1", channel: "cli", key: "session" },
      content: "ship the validation proof",
    })
    recordFlightRecorderEvent(agentRoot, {
      id: "fr-open-obligation",
      kind: "post_turn_persisted",
      summary: "checkpoint with open obligation",
      currentAsk: "finish validation",
      nextSafeAction: "ship the validation proof",
      activeObligationIds: [obligation.id],
    })
    fulfillObligation(agentRoot, obligation.id)

    const resume = readFlightRecorderResume(agentRoot)
    const persisted = JSON.parse(fs.readFileSync(flightRecorderLatestPath(agentRoot), "utf-8"))

    expect(resume.activeObligationIds).toEqual([])
    expect(resume.hasCompleteState).toBe(true)
    expect(resume.canContinue).toBe(false)
    expect(resume.nextSafeAction.value).toBe(`wait for new input; reconciled completed or missing obligations: ${obligation.id}`)
    expect(resume.nextSafeAction.sourceEventIds).toEqual(["reconcile:active-obligations"])
    expect(persisted.activeObligationIds).toEqual([obligation.id])
    expect(persisted.nextSafeAction.value).toBe("ship the validation proof")
    expect(persisted.canContinue).toBe(true)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_resume_reconciled",
      meta: expect.objectContaining({
        staleActiveObligationIds: [obligation.id],
        missingActiveObligationIds: [],
        unverifiableActiveObligationIds: [],
      }),
    }))
  })

  it("preserves and degrades active obligation ids that the obligation store cannot verify", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.join(agentRoot, "arc", "obligations"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "arc", "obligations", "ob-corrupt.json"), "{", "utf-8")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "recover safely", confidence: "current", sourceEventIds: ["fr-corrupt"] },
      nextSafeAction: { value: "continue old obligation", stopBefore: [], sourceEventIds: ["fr-corrupt"] },
      blockedBecause: [],
      activeObligationIds: ["ob-corrupt"],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-corrupt"] },
      recorderHealth: { status: "ok", issues: [] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)
    const persisted = JSON.parse(fs.readFileSync(flightRecorderLatestPath(agentRoot), "utf-8"))

    expect(resume.activeObligationIds).toEqual(["ob-corrupt"])
    expect(resume.canContinue).toBe(false)
    expect(resume.nextSafeAction.value).toBe("inspect unverifiable active obligations before acting: ob-corrupt")
    expect(resume.nextSafeAction.sourceEventIds).toEqual(["reconcile:active-obligations"])
    expect(resume.nextSafeAction.stopBefore).toContain("acting on unverifiable obligation state")
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues).toContain("active obligation ids could not be verified in arc/obligations: ob-corrupt")
    expect(persisted.activeObligationIds).toEqual(["ob-corrupt"])
    expect(persisted.canContinue).toBe(true)
    expect(persisted.nextSafeAction.sourceEventIds).toEqual(["fr-corrupt"])
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_resume_reconciled",
      meta: expect.objectContaining({
        staleActiveObligationIds: [],
        missingActiveObligationIds: [],
        unverifiableActiveObligationIds: ["ob-corrupt"],
      }),
    }))
  })

  it("treats parseable-invalid obligation records as unverifiable active state", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.join(agentRoot, "arc", "obligations"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "arc", "obligations", "ob-invalid.json"), `${JSON.stringify({
      id: "ob-invalid",
      content: "parseable but invalid",
    })}\n`, "utf-8")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "recover safely", confidence: "current", sourceEventIds: ["fr-invalid"] },
      nextSafeAction: { value: "continue invalid obligation", stopBefore: [], sourceEventIds: ["fr-invalid"] },
      blockedBecause: [],
      activeObligationIds: ["ob-invalid"],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-invalid"] },
      recorderHealth: { status: "ok", issues: [] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.activeObligationIds).toEqual(["ob-invalid"])
    expect(resume.canContinue).toBe(false)
    expect(resume.nextSafeAction.value).toBe("inspect unverifiable active obligations before acting: ob-invalid")
    expect(resume.nextSafeAction.sourceEventIds).toEqual(["reconcile:active-obligations"])
    expect(resume.recorderHealth.status).toBe("degraded")
    expect(resume.recorderHealth.issues).toContain("active obligation ids could not be verified in arc/obligations: ob-invalid")
  })

  it("refreshes synthesized next-action provenance even when the text was already synthesized", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "recover safely", confidence: "current", sourceEventIds: ["fr-identical"] },
      nextSafeAction: {
        value: "inspect unverifiable active obligations before acting: ob-identical",
        stopBefore: [],
        sourceEventIds: ["fr-stale"],
      },
      blockedBecause: [],
      activeObligationIds: ["ob-identical"],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-identical"] },
      recorderHealth: { status: "ok", issues: [] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.nextSafeAction.value).toBe("inspect unverifiable active obligations before acting: ob-identical")
    expect(resume.nextSafeAction.sourceEventIds).toEqual(["reconcile:active-obligations"])
  })

  it("keeps unavailable recorder health unavailable while preserving unverifiable obligation ids", async () => {
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: false,
      missing: [],
      gaps: [],
      currentAsk: { value: "recover safely", confidence: "current", sourceEventIds: ["fr-unavailable"] },
      nextSafeAction: { value: "continue old obligation", stopBefore: [], sourceEventIds: ["fr-unavailable"] },
      blockedBecause: [],
      activeObligationIds: ["ob-unavailable"],
      activeReturnObligationIds: [],
      activePacketIds: [],
      openEvolutionCaseIds: [],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-unavailable"] },
      recorderHealth: { status: "unavailable", issues: ["source unavailable"] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.activeObligationIds).toEqual(["ob-unavailable"])
    expect(resume.canContinue).toBe(false)
    expect(resume.recorderHealth.status).toBe("unavailable")
    expect(resume.recorderHealth.issues).toContain("source unavailable")
    expect(resume.recorderHealth.issues).toContain("active obligation ids could not be verified in arc/obligations: ob-unavailable")
  })

  it("adds missing open obligation ids from the obligation store on read", async () => {
    const { createObligation } = await import("../../arc/obligations")
    const { readFlightRecorderResume, recordFlightRecorderEvent } = await import("../../arc/flight-recorder")
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "friend-1", channel: "cli", key: "session" },
      content: "keep the live state truthful",
    })
    recordFlightRecorderEvent(agentRoot, {
      id: "fr-missing-obligation",
      kind: "post_turn_persisted",
      summary: "checkpoint missing open obligation",
      currentAsk: "finish validation",
      nextSafeAction: "run checks",
      activeObligationIds: [],
    })

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.activeObligationIds).toEqual([obligation.id])
    expect(resume.nextSafeAction.value).toBe("run checks")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.flight_recorder_resume_reconciled",
      meta: expect.objectContaining({
        staleActiveObligationIds: [],
        missingActiveObligationIds: [obligation.id],
        unverifiableActiveObligationIds: [],
      }),
    }))
  })

  it("uses a missing open obligation as the safe action when latest has no next action", async () => {
    const { createObligation } = await import("../../arc/obligations")
    const { readFlightRecorderResume, recordFlightRecorderEvent } = await import("../../arc/flight-recorder")
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "friend-1", channel: "cli", key: "session" },
      content: "repair the recovery snapshot",
    })
    recordFlightRecorderEvent(agentRoot, {
      id: "fr-no-next-action",
      kind: "post_turn_persisted",
      summary: "checkpoint without next action",
      currentAsk: "finish validation",
      nextSafeAction: null,
      activeObligationIds: [],
    })

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.hasCompleteState).toBe(true)
    expect(resume.canContinue).toBe(true)
    expect(resume.missing).toEqual([])
    expect(resume.activeObligationIds).toEqual([obligation.id])
    expect(resume.nextSafeAction.value).toBe(`continue open obligation ${obligation.id}: repair the recovery snapshot`)
  })

  it("keeps remaining Arc work as the next safe action when reconciling stale obligations", async () => {
    const { createObligation, fulfillObligation } = await import("../../arc/obligations")
    const { flightRecorderLatestPath, readFlightRecorderResume } = await import("../../arc/flight-recorder")
    const obligation = createObligation(agentRoot, {
      origin: { friendId: "friend-1", channel: "cli", key: "session" },
      content: "fulfilled work",
    })
    fulfillObligation(agentRoot, obligation.id)
    fs.mkdirSync(path.dirname(flightRecorderLatestPath(agentRoot)), { recursive: true })
    fs.writeFileSync(flightRecorderLatestPath(agentRoot), `${JSON.stringify({
      schemaVersion: 1,
      hasCompleteState: true,
      canContinue: true,
      missing: [],
      gaps: [],
      currentAsk: { value: "finish remaining work", confidence: "current", sourceEventIds: ["fr-packet"] },
      nextSafeAction: { value: "stale obligation action", stopBefore: [], sourceEventIds: ["fr-packet"] },
      blockedBecause: [],
      activeObligationIds: [obligation.id],
      activeReturnObligationIds: ["ret-1"],
      activePacketIds: ["packet-1"],
      openEvolutionCaseIds: ["case-1"],
      recentClaimIds: [],
      unverifiedClaimIds: [],
      lastSafeCheckpoint: { turnId: null, sessionRef: "friend/cli/session", recordedAt: "2026-06-08T12:00:00.000Z", sourceEventIds: ["fr-packet"] },
      recorderHealth: { status: "ok", issues: [] },
    }, null, 2)}\n`, "utf-8")

    const resume = readFlightRecorderResume(agentRoot)

    expect(resume.activeObligationIds).toEqual([])
    expect(resume.nextSafeAction.value).toBe("continue remaining Arc work: return obligation ret-1, packet packet-1, evolution case case-1")
    expect(resume.nextSafeAction.sourceEventIds).toEqual(["reconcile:active-obligations"])
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

  it("inherits blocked checkpoint event ids until a later event clears the blocker", async () => {
    const { readFlightRecorderResume, recordFlightRecorderEvent } = await import("../../arc/flight-recorder")

    recordFlightRecorderEvent(agentRoot, {
      id: "fr-blocked",
      kind: "blocker_detected",
      summary: "blocked",
      currentAsk: "finish the work",
      nextSafeAction: "wait",
      blockedBecause: ["needs evidence"],
    })
    recordFlightRecorderEvent(agentRoot, {
      id: "fr-followup",
      kind: "tool_completed",
      summary: "follow-up while still blocked",
      currentAsk: "finish the work",
      nextSafeAction: "collect evidence",
    })

    expect(readFlightRecorderResume(agentRoot).lastSafeCheckpoint.sourceEventIds).toEqual(["fr-blocked", "fr-followup"])
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
    const { createHabitRunId, isHabitRunTrigger } = await import("../../arc/flight-recorder")

    expect(createHabitRunId("!!!", new Date("2026-06-08T12:00:00.000Z"))).toContain("-habit-")
    expect(["cron", "launchd", "poke", "overdue", "manual"].map((trigger) => isHabitRunTrigger(trigger)))
      .toEqual([true, true, true, true, true])
    expect(isHabitRunTrigger("later")).toBe(false)
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
      surfaceAttempts: [],
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

  it("rejects unsafe habit receipt run ids before writing paths", async () => {
    const { writeHabitRunReceipt } = await import("../../arc/flight-recorder")

    expect(() => writeHabitRunReceipt(agentRoot, {
      schemaVersion: 1,
      runId: "../escape",
      habitName: "daily-record",
      trigger: "poke",
      startedAt: "2026-06-08T12:00:00.000Z",
      endedAt: "2026-06-08T12:01:00.000Z",
      outcome: "blocked",
      producedRefs: [],
      surfaceAttempts: [],
      errors: ["unsafe"],
    })).toThrow("unsafe habit run id")
    expect(fs.existsSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "../escape.json"))).toBe(false)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "mind.flight_recorder_habit_receipt_malformed",
    }))
  })

  it("reads and lists schema v2 habit run receipts without loading transcripts", async () => {
    const recorder = await import("../../arc/flight-recorder") as any
    expect(recorder.listHabitRunReceipts(agentRoot)).toEqual([])
    const first = {
      schemaVersion: 2,
      runId: "2026-06-08T12-00-00-000Z-checkup-11111111",
      sessionId: "2026-06-08T12-00-00-000Z-checkup-11111111",
      habitName: "checkup",
      trigger: "poke",
      startedAt: "2026-06-08T12:00:00.000Z",
      endedAt: "2026-06-08T12:01:00.000Z",
      outcome: "surfaced",
      definitionLocator: "habits/checkup.md",
      sessionLocator: "state/habit-sessions/2026-06-08T12-00-00-000Z-checkup-11111111/session.json",
      pendingLocator: "state/habit-sessions/2026-06-08T12-00-00-000Z-checkup-11111111/pending",
      runtimeStateLocator: "state/habits/checkup.json",
      receiptLocator: "arc/flight-recorder/habit-receipts/2026-06-08T12-00-00-000Z-checkup-11111111.json",
      operationId: "op-checkup",
      nextRunAt: "2026-06-08T12:31:00.000Z",
      permissionEnvelope: {
        schemaVersion: 1,
        canMessageOutward: true,
        returnRoutes: [{ kind: "family", recipient: "family", status: "allowed" }],
        deniedTools: [],
        warnings: [],
      },
      toolPolicy: {
        requestedTools: null,
        grantedTools: ["read_file", "surface"],
        deniedTools: ["shell"],
        outwardMessagingAllowed: true,
      },
      producedRefs: [{ kind: "surface", locator: "state/pending/ari/cli/main" }],
      surfaceAttempts: [{
        recipient: "ari",
        channel: "cli",
        reason: "status",
        result: "queued",
        routeKind: "family",
      }],
      errors: [],
    }
    const second = {
      ...first,
      runId: "2026-06-08T12-05-00-000Z-checkup-22222222",
      sessionId: "2026-06-08T12-05-00-000Z-checkup-22222222",
      startedAt: "2026-06-08T12:05:00.000Z",
      endedAt: "2026-06-08T12:01:00.000Z",
      receiptLocator: "arc/flight-recorder/habit-receipts/2026-06-08T12-05-00-000Z-checkup-22222222.json",
      operationId: null,
      surfaceAttempts: [{
        recipient: "ari",
        channel: "cli",
        reason: "answer",
        result: "deferred",
        rawStatus: "deferred",
        routeKind: "family",
      }],
    }

    recorder.writeHabitRunReceipt(agentRoot, first)
    recorder.writeHabitRunReceipt(agentRoot, second)
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "malformed.json"), "{", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "array.json"), "[]", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-shape.json"), JSON.stringify({ schemaVersion: 2, runId: "wrong-shape" }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-legacy.json"), JSON.stringify({ schemaVersion: 1, runId: "wrong-legacy" }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "old-schema.json"), JSON.stringify({
      schemaVersion: 1,
      runId: "old-schema",
      habitName: "legacy-checkup",
      trigger: "poke",
      startedAt: "2026-06-08T11:00:00.000Z",
      endedAt: "2026-06-08T11:01:00.000Z",
      outcome: "surfaced",
      producedRefs: [{ kind: "surface", locator: "sessions/ari/cli/main" }],
      surfaceAttempts: [{
        recipient: "ari",
        channel: "cli",
        reason: "status",
        result: "sent",
      }],
      errors: ["legacy warning"],
    }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-envelope.json"), JSON.stringify({ ...first, runId: "wrong-envelope", permissionEnvelope: [] }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-policy.json"), JSON.stringify({ ...first, runId: "wrong-policy", toolPolicy: [] }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-operation-id.json"), JSON.stringify({ ...first, runId: "wrong-operation-id", operationId: 42 }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "missing-operation-id.json"), JSON.stringify({ ...first, runId: "missing-operation-id", operationId: undefined }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-attempts.json"), JSON.stringify({ ...first, runId: "wrong-attempts", surfaceAttempts: {} }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-attempt-entry.json"), JSON.stringify({ ...first, runId: "wrong-attempt-entry", surfaceAttempts: [{}] }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-produced-entry.json"), JSON.stringify({ ...first, runId: "wrong-produced-entry", producedRefs: [{}] }), "utf-8")

    expect(recorder.readHabitRunReceipt(agentRoot, first.runId)).toMatchObject({
      runId: first.runId,
      schemaVersion: 2,
      operationId: "op-checkup",
      sessionLocator: first.sessionLocator,
      surfaceAttempts: first.surfaceAttempts,
    })
    expect(recorder.readHabitRunReceipt(agentRoot, "../escape")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "bad%2fescape")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "array")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-shape")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-legacy")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "old-schema")).toMatchObject({
      schemaVersion: 2,
      runId: "old-schema",
      sessionId: "old-schema",
      habitName: "legacy-checkup",
      operationId: null,
      definitionLocator: "habits/legacy-checkup.md",
      receiptLocator: "arc/flight-recorder/habit-receipts/old-schema.json",
      permissionEnvelope: expect.objectContaining({
        schemaVersion: 1,
        canMessageOutward: true,
      }),
      errors: ["legacy warning"],
    })
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-envelope")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-policy")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-operation-id")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "missing-operation-id")).toMatchObject({
      runId: "missing-operation-id",
      operationId: null,
    })
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-attempts")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-attempt-entry")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-produced-entry")).toBeNull()

    const listed = recorder.listHabitRunReceipts(agentRoot, { limit: 10 })
    expect(listed.map((receipt: { runId: string }) => receipt.runId)).toEqual(["missing-operation-id", second.runId, first.runId, "old-schema"])
    expect(recorder.listHabitRunReceipts(agentRoot).map((receipt: { runId: string }) => receipt.runId)).toEqual(["missing-operation-id", second.runId, first.runId, "old-schema"])
    expect(recorder.listHabitRunReceipts(agentRoot, { limit: -1 }).map((receipt: { runId: string }) => receipt.runId)).toEqual(["missing-operation-id", second.runId, first.runId, "old-schema"])
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "partial-snapshot.json"), JSON.stringify({
      ...first,
      runId: "partial-snapshot",
      sessionId: "partial-snapshot",
      receiptLocator: "arc/flight-recorder/habit-receipts/partial-snapshot.json",
      summarySnapshot: {
        summary: 7,
        decisions: "bad",
        nextLikelyStep: 42,
      },
    }), "utf-8")
	    expect(recorder.readHabitRunReceipt(agentRoot, "partial-snapshot")).toMatchObject({
	      runId: "partial-snapshot",
	      summarySnapshot: {
	        summary: "Habit checkup surfaced via ari/cli.",
	        decisions: [],
	        nextLikelyStep: null,
	      },
	    })
	    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "error-snapshot.json"), JSON.stringify({
	      ...first,
	      runId: "error-snapshot",
	      sessionId: "error-snapshot",
	      receiptLocator: "arc/flight-recorder/habit-receipts/error-snapshot.json",
	      producedRefs: [],
	      surfaceAttempts: [],
	      errors: ["boom"],
	    }), "utf-8")
	    expect(recorder.readHabitRunReceipt(agentRoot, "error-snapshot")).toMatchObject({
	      runId: "error-snapshot",
	      summarySnapshot: {
	        summary: "Habit checkup finished with errors: boom",
	        decisions: [],
	        nextLikelyStep: null,
	      },
	    })
	    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "produced-snapshot.json"), JSON.stringify({
	      ...first,
	      runId: "produced-snapshot",
	      sessionId: "produced-snapshot",
	      receiptLocator: "arc/flight-recorder/habit-receipts/produced-snapshot.json",
	      producedRefs: [{ kind: "desk_task", locator: "desk/tasks/follow-up" }],
	      surfaceAttempts: [],
	      errors: [],
	    }), "utf-8")
	    expect(recorder.readHabitRunReceipt(agentRoot, "produced-snapshot")).toMatchObject({
	      runId: "produced-snapshot",
	      summarySnapshot: {
	        summary: "Habit checkup produced desk_task: desk/tasks/follow-up.",
	        decisions: [],
	        nextLikelyStep: null,
	      },
	    })
	    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
	      level: "warn",
	      event: "mind.flight_recorder_habit_receipt_malformed",
    }))
  })

  it("preserves lossless habit attempt statuses in schema v2 receipts", async () => {
    const recorder = await import("../../arc/flight-recorder") as any
    const runId = "2026-06-08T12-10-00-000Z-checkup-33333333"
    const receipt = {
      schemaVersion: 2,
      runId,
      sessionId: runId,
      habitName: "checkup",
      trigger: "poke",
      startedAt: "2026-06-08T12:10:00.000Z",
      endedAt: "2026-06-08T12:11:00.000Z",
      outcome: "surfaced",
      definitionLocator: "habits/checkup.md",
      sessionLocator: `state/habit-sessions/${runId}/session.json`,
      pendingLocator: `state/habit-sessions/${runId}/pending`,
      runtimeStateLocator: "state/habits/checkup.json",
      receiptLocator: `arc/flight-recorder/habit-receipts/${runId}.json`,
      nextRunAt: null,
      permissionEnvelope: {
        schemaVersion: 1,
        canMessageOutward: true,
        returnRoutes: [
          { kind: "family", recipient: "family", status: "allowed" },
          { kind: "originator", recipient: "ari", status: "allowed", friendId: "ari", channel: "cli", key: "main" },
          { kind: "extra", recipient: "Ari", status: "allowed", friendId: "ari", channel: "cli", key: "main" },
          { kind: "extra", recipient: "missing", status: "unresolved", reason: "missing friend" },
        ],
        deniedTools: [],
        warnings: [],
      },
      toolPolicy: {
        requestedTools: ["send_message", "surface"],
        grantedTools: ["send_message", "surface"],
        deniedTools: [],
        outwardMessagingAllowed: true,
      },
      producedRefs: [
        { kind: "arc", locator: "arc/claims/claim-1.json" },
        { kind: "desk_task", locator: "desk/task" },
        { kind: "desk_record", locator: "desk/_record" },
        { kind: "claim", locator: "arc/claims/claim-2.json" },
        { kind: "surface", locator: "state/pending/ari/cli/main" },
        { kind: "none", locator: "" },
      ],
      surfaceAttempts: [
        { recipient: "ari", channel: "cli", reason: "needed_input", result: "sent", routeKind: "family" },
        { recipient: "ari", channel: "cli", reason: "status", result: "queued", routeKind: "originator" },
        { recipient: "ari", channel: "mcp", reason: "status", result: "deferred", routeKind: "extra" },
        { recipient: "ari", channel: "cli", reason: "status", result: "delivered", routeKind: "family" },
        { recipient: "ari", channel: "bluebubbles", reason: "answer", result: "delivered_now", rawStatus: "delivered_now", routeKind: "family" },
        { recipient: "ari", channel: "cli", reason: "other", result: "blocked", routeKind: "family" },
        { recipient: "ari", channel: "cli", reason: "blocked", result: "unavailable", error: "provider down", routeKind: "family" },
        { recipient: "ari", channel: "cli", reason: "blocked", result: "failed", rawStatus: "failed", routeKind: "family" },
      ],
      errors: [],
    }

    recorder.writeHabitRunReceipt(agentRoot, receipt)

    expect(recorder.readHabitRunReceipt(agentRoot, runId)).toMatchObject({
      runId,
      surfaceAttempts: receipt.surfaceAttempts,
    })
  })

  it("accepts every habit trigger and outcome variant in schema v2 receipts", async () => {
    const recorder = await import("../../arc/flight-recorder") as any
    const triggers = ["cron", "launchd", "poke", "overdue", "manual"]
    const outcomes = ["no_change", "wrote_arc", "updated_desk", "wrote_record", "surfaced", "blocked", "error"]

    for (const [index, outcome] of outcomes.entries()) {
      const runId = `2026-06-08T12-${String(index).padStart(2, "0")}-00-000Z-checkup-${index}4444444`
      recorder.writeHabitRunReceipt(agentRoot, {
        schemaVersion: 2,
        runId,
        sessionId: runId,
        habitName: "checkup",
        trigger: triggers[index % triggers.length],
        startedAt: "2026-06-08T12:00:00.000Z",
        endedAt: `2026-06-08T12:${String(index).padStart(2, "0")}:30.000Z`,
        outcome,
        definitionLocator: "habits/checkup.md",
        sessionLocator: `state/habit-sessions/${runId}/session.json`,
        pendingLocator: `state/habit-sessions/${runId}/pending`,
        runtimeStateLocator: "state/habits/checkup.json",
        receiptLocator: `arc/flight-recorder/habit-receipts/${runId}.json`,
        nextRunAt: null,
        permissionEnvelope: {
          schemaVersion: 1,
          canMessageOutward: false,
          returnRoutes: [],
          deniedTools: ["send_message", "surface"],
          warnings: [],
        },
        toolPolicy: {
          requestedTools: null,
          grantedTools: [],
          deniedTools: ["send_message", "surface"],
          outwardMessagingAllowed: false,
        },
        producedRefs: [],
        surfaceAttempts: [],
        errors: [],
      })

      expect(recorder.readHabitRunReceipt(agentRoot, runId)).toMatchObject({
        runId,
        trigger: triggers[index % triggers.length],
        outcome,
      })
    }
  })

  it("normalizes every legacy habit trigger and outcome variant from disk", async () => {
    const recorder = await import("../../arc/flight-recorder") as any
    const triggers = ["cron", "launchd", "poke", "overdue", "manual"]
    const outcomes = ["no_change", "wrote_arc", "updated_desk", "wrote_record", "surfaced", "blocked", "error"]
    const receiptDir = path.join(agentRoot, "arc", "flight-recorder", "habit-receipts")
    fs.mkdirSync(receiptDir, { recursive: true })

    for (const [index, outcome] of outcomes.entries()) {
      const runId = `legacy-${index}5555555`
      fs.writeFileSync(path.join(receiptDir, `${runId}.json`), JSON.stringify({
        schemaVersion: 1,
        runId,
        habitName: "legacy-checkup",
        trigger: triggers[index % triggers.length],
        startedAt: "2026-06-08T12:00:00.000Z",
        endedAt: `2026-06-08T12:${String(index).padStart(2, "0")}:30.000Z`,
        outcome,
        producedRefs: [],
        surfaceAttempts: [],
        errors: [],
      }), "utf-8")

      expect(recorder.readHabitRunReceipt(agentRoot, runId)).toMatchObject({
        schemaVersion: 2,
        runId,
        trigger: triggers[index % triggers.length],
        outcome,
        definitionLocator: "habits/legacy-checkup.md",
      })
    }
  })
})
