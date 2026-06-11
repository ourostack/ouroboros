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
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "old-schema.json"), JSON.stringify({ ...first, runId: "old-schema", schemaVersion: 1 }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-envelope.json"), JSON.stringify({ ...first, runId: "wrong-envelope", permissionEnvelope: [] }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-policy.json"), JSON.stringify({ ...first, runId: "wrong-policy", toolPolicy: [] }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-attempts.json"), JSON.stringify({ ...first, runId: "wrong-attempts", surfaceAttempts: {} }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-attempt-entry.json"), JSON.stringify({ ...first, runId: "wrong-attempt-entry", surfaceAttempts: [{}] }), "utf-8")
    fs.writeFileSync(path.join(agentRoot, "arc", "flight-recorder", "habit-receipts", "wrong-produced-entry.json"), JSON.stringify({ ...first, runId: "wrong-produced-entry", producedRefs: [{}] }), "utf-8")

    expect(recorder.readHabitRunReceipt(agentRoot, first.runId)).toMatchObject({
      runId: first.runId,
      schemaVersion: 2,
      sessionLocator: first.sessionLocator,
      surfaceAttempts: first.surfaceAttempts,
    })
    expect(recorder.readHabitRunReceipt(agentRoot, "../escape")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "bad%2fescape")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "array")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-shape")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "old-schema")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-envelope")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-policy")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-attempts")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-attempt-entry")).toBeNull()
    expect(recorder.readHabitRunReceipt(agentRoot, "wrong-produced-entry")).toBeNull()

    const listed = recorder.listHabitRunReceipts(agentRoot, { limit: 10 })
    expect(listed.map((receipt: { runId: string }) => receipt.runId)).toEqual([second.runId, first.runId])
    expect(recorder.listHabitRunReceipts(agentRoot).map((receipt: { runId: string }) => receipt.runId)).toEqual([second.runId, first.runId])
    expect(recorder.listHabitRunReceipts(agentRoot, { limit: -1 }).map((receipt: { runId: string }) => receipt.runId)).toEqual([second.runId, first.runId])
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
})
