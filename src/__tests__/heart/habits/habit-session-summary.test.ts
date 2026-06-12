import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach } from "vitest"
import { describe, expect, it } from "vitest"
import { writeHabitRunReceipt, type HabitRunOutcome, type HabitRunReceipt } from "../../../arc/flight-recorder"
import {
  readHabitSessionSummary,
  selectHabitRunReceipt,
  type HabitSummaryReceipt,
} from "../../../heart/habits/habit-session-summary"

function makeReceipt(
  runId: string,
  overrides: Partial<HabitRunReceipt> & {
    operationId?: string | null
    summarySnapshot?: {
      summary?: string
      decisions?: string[]
      nextLikelyStep?: string | null
    }
  } = {},
): HabitSummaryReceipt {
  const habitName = overrides.habitName ?? "journal"
  const endedAt = overrides.endedAt ?? "2026-06-11T12:00:00.000Z"
  return {
    schemaVersion: 2,
    runId,
    sessionId: runId,
    habitName,
    trigger: overrides.trigger ?? "manual",
    startedAt: overrides.startedAt ?? "2026-06-11T11:59:00.000Z",
    endedAt,
    outcome: overrides.outcome ?? "no_change",
    definitionLocator: overrides.definitionLocator ?? `habits/${habitName}.md`,
    sessionLocator: overrides.sessionLocator ?? `state/habit-sessions/${runId}/session.json`,
    pendingLocator: overrides.pendingLocator ?? `state/habit-sessions/${runId}/pending`,
    runtimeStateLocator: overrides.runtimeStateLocator ?? `state/habits/${habitName}.json`,
    receiptLocator: overrides.receiptLocator ?? `arc/flight-recorder/habit-receipts/${runId}.json`,
    nextRunAt: overrides.nextRunAt ?? null,
    permissionEnvelope: overrides.permissionEnvelope ?? {
      schemaVersion: 1,
      canMessageOutward: true,
      returnRoutes: [],
      deniedTools: [],
      warnings: [],
    },
    toolPolicy: overrides.toolPolicy ?? {
      requestedTools: null,
      grantedTools: [],
      deniedTools: [],
      outwardMessagingAllowed: true,
    },
    producedRefs: overrides.producedRefs ?? [],
    surfaceAttempts: overrides.surfaceAttempts ?? [],
    errors: overrides.errors ?? [],
    operationId: overrides.operationId ?? null,
    ...(overrides.summarySnapshot ? { summarySnapshot: overrides.summarySnapshot } : {}),
  }
}

describe("habit-session-summary selector", () => {
  it("selects an explicit run id and rejects run id combined with filters", () => {
    const receipts = [
      makeReceipt("run-a", { habitName: "journal" }),
      makeReceipt("run-b", { habitName: "heartbeat" }),
    ]

    expect(selectHabitRunReceipt(receipts, { runId: "run-b" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-b" },
    })
    expect(selectHabitRunReceipt(receipts, { runId: "missing" })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "no habit run matched selector",
      },
    })

    expect(selectHabitRunReceipt(receipts, { runId: "run-b", habitName: "heartbeat" })).toEqual({
      ok: false,
      error: {
        code: "run_id_exclusive",
        message: "runId cannot be combined with habitName, operationId, or which",
      },
    })
    expect(selectHabitRunReceipt(receipts, { runId: "run-b", which: "latest" })).toMatchObject({
      ok: false,
      error: { code: "run_id_exclusive" },
    })
    expect(selectHabitRunReceipt(receipts, { runId: "run-b", operationId: "op-1" })).toMatchObject({
      ok: false,
      error: { code: "run_id_exclusive" },
    })
  })

  it("requires habitName or operationId when no explicit run id is supplied", () => {
    expect(selectHabitRunReceipt([], {})).toEqual({
      ok: false,
      error: {
        code: "selector_required",
        message: "provide runId, habitName, or operationId",
      },
    })
    expect(selectHabitRunReceipt([], { habitName: "journal" })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "no habit run matched selector",
      },
    })
  })

  it("defaults to latest and sorts by endedAt descending then runId descending", () => {
    const receipts = [
      makeReceipt("run-a", { endedAt: "2026-06-11T12:01:00.000Z" }),
      makeReceipt("run-c", { endedAt: "2026-06-11T12:01:00.000Z" }),
      makeReceipt("run-z", { endedAt: "2026-06-11T12:00:00.000Z" }),
    ]

    expect(selectHabitRunReceipt(receipts, { habitName: "journal" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-c" },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "previous" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-a" },
    })
    expect(receipts.map((receipt) => receipt.runId)).toEqual(["run-a", "run-c", "run-z"])
  })

  it("filters by operationId with an optional habitName", () => {
    const receipts = [
      makeReceipt("run-a", { habitName: "journal", operationId: "op-a", endedAt: "2026-06-11T12:00:00.000Z" }),
      makeReceipt("run-b", { habitName: "heartbeat", operationId: "op-a", endedAt: "2026-06-11T12:03:00.000Z" }),
      makeReceipt("run-c", { habitName: "journal", operationId: "op-b", endedAt: "2026-06-11T12:04:00.000Z" }),
    ]

    expect(selectHabitRunReceipt(receipts, { operationId: "op-a" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-b" },
    })
    expect(selectHabitRunReceipt(receipts, { operationId: "op-a", habitName: "journal" })).toMatchObject({
      ok: true,
      receipt: { runId: "run-a" },
    })
  })

  it("maps latest-success and latest-failure to explicit outcome sets", () => {
    const successOutcomes: HabitRunOutcome[] = ["no_change", "wrote_arc", "updated_desk", "wrote_record", "surfaced"]
    const failureOutcomes: HabitRunOutcome[] = ["blocked", "error"]
    const receipts = [
      ...successOutcomes.map((outcome, index) => makeReceipt(`success-${index}`, {
        outcome,
        endedAt: `2026-06-11T12:0${index}:00.000Z`,
      })),
      ...failureOutcomes.map((outcome, index) => makeReceipt(`failure-${index}`, {
        outcome,
        endedAt: `2026-06-11T12:1${index}:00.000Z`,
      })),
    ]

    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "latest-success" })).toMatchObject({
      ok: true,
      receipt: { runId: "success-4", outcome: "surfaced" },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "latest-failure" })).toMatchObject({
      ok: true,
      receipt: { runId: "failure-1", outcome: "error" },
    })
  })

  it("returns typed errors for invalid which values and missing matches", () => {
    const receipts = [makeReceipt("run-a", { habitName: "journal" })]

    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "banana" })).toEqual({
      ok: false,
      error: {
        code: "invalid_which",
        message: "which must be latest, previous, latest-success, or latest-failure",
      },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "missing" })).toEqual({
      ok: false,
      error: {
        code: "not_found",
        message: "no habit run matched selector",
      },
    })
    expect(selectHabitRunReceipt(receipts, { habitName: "journal", which: "previous" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
  })
})

describe("habit-session-summary artifact reader", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeAgentRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "habit-summary-"))
    cleanup.push(dir)
    return dir
  }

  function writeSummaryReceipt(
    agentRoot: string,
    runId: string,
    overrides: Partial<HabitSummaryReceipt> & {
      operationId?: string | null
      summarySnapshot?: {
        summary?: string
        decisions?: string[]
        nextLikelyStep?: string | null
      }
    } = {},
  ): HabitSummaryReceipt {
    const receipt = makeReceipt(runId, overrides)
    writeHabitRunReceipt(agentRoot, receipt as HabitRunReceipt)
    return receipt
  }

  function writeSession(agentRoot: string, runId: string, payload: unknown): void {
    const sessionPath = path.join(agentRoot, "state", "habit-sessions", runId, "session.json")
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    fs.writeFileSync(sessionPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8")
  }

  it("builds a receipt-authoritative summary enriched by session, pending dir, and runtime cursor", () => {
    const agentRoot = makeAgentRoot()
    const runId = "run-rich"
    writeSummaryReceipt(agentRoot, runId, {
      operationId: "op-live",
      outcome: "surfaced",
      producedRefs: [{ kind: "desk_record", locator: "desk/tasks/follow-up" }],
      surfaceAttempts: [{
        recipient: "ari",
        channel: "bluebubbles",
        reason: "needed_input",
        result: "queued",
        routeKind: "originator",
        rawStatus: "queued",
      }],
      errors: ["minor warning"],
      summarySnapshot: {
        summary: "Receipt says Slugger asked Ari for the missing decision.",
        decisions: ["Ask Ari for the missing decision."],
        nextLikelyStep: "Wait for Ari to reply.",
      },
    })
    writeSession(agentRoot, runId, {
      messages: [
        { role: "assistant", content: "I will ask Ari and wait." },
        { role: "tool", name: "send_message", content: "queued" },
      ],
      summary: {
        decisions: ["Use iMessage rather than an internal note."],
        nextLikelyStep: "Check the reply queue.",
      },
    })
    const pendingDir = path.join(agentRoot, "state", "habit-sessions", runId, "pending")
    fs.mkdirSync(pendingDir, { recursive: true })
    fs.writeFileSync(path.join(pendingDir, "ask-ari.json"), JSON.stringify({ content: "need decision" }), "utf-8")
    const runtimeStatePath = path.join(agentRoot, "state", "habits", "journal.json")
    fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true })
    fs.writeFileSync(runtimeStatePath, JSON.stringify({
      schemaVersion: 1,
      name: "journal",
      lastRun: "2026-06-11T12:00:00.000Z",
      updatedAt: "2026-06-11T12:00:00.000Z",
      activeOperationId: "op-live",
      latestRunId: runId,
      latestReceiptLocator: `arc/flight-recorder/habit-receipts/${runId}.json`,
    }, null, 2), "utf-8")

    expect(readHabitSessionSummary(agentRoot, { runId })).toMatchObject({
      runId,
      habitName: "journal",
      operationId: "op-live",
      status: "surfaced",
      summary: "Receipt says Slugger asked Ari for the missing decision.",
      decisions: ["Ask Ari for the missing decision.", "Use iMessage rather than an internal note."],
      pending: {
        count: 1,
        files: ["ask-ari.json"],
      },
      messagesSent: [{
        recipient: "ari",
        channel: "bluebubbles",
        result: "queued",
      }],
      toolsUsed: ["send_message"],
      producedRefs: [{ kind: "desk_record", locator: "desk/tasks/follow-up" }],
      errors: ["minor warning"],
      nextLikelyStep: "Wait for Ari to reply.",
      sources: expect.objectContaining({
        receipt: `arc/flight-recorder/habit-receipts/${runId}.json`,
        session: `state/habit-sessions/${runId}/session.json`,
        pending: `state/habit-sessions/${runId}/pending`,
        runtimeState: "state/habits/journal.json",
      }),
      warnings: [],
    })
  })

  it("returns a receipt-only summary with warnings when session artifacts are missing, empty, or malformed", () => {
    const agentRoot = makeAgentRoot()
    writeSummaryReceipt(agentRoot, "run-missing", {
      summarySnapshot: { summary: "Receipt summary survived missing session." },
    })
    writeSummaryReceipt(agentRoot, "run-empty", {
      endedAt: "2026-06-11T12:01:00.000Z",
      summarySnapshot: { summary: "Receipt summary survived empty session." },
    })
    writeSession(agentRoot, "run-empty", { messages: [] })
    writeSummaryReceipt(agentRoot, "run-bad", {
      endedAt: "2026-06-11T12:02:00.000Z",
      summarySnapshot: { summary: "Receipt summary survived malformed session." },
    })
    const badSessionPath = path.join(agentRoot, "state", "habit-sessions", "run-bad", "session.json")
    fs.mkdirSync(path.dirname(badSessionPath), { recursive: true })
    fs.writeFileSync(badSessionPath, "{bad", "utf-8")

    expect(readHabitSessionSummary(agentRoot, { runId: "run-missing" })).toMatchObject({
      summary: "Receipt summary survived missing session.",
      warnings: ["session file missing"],
    })
    expect(readHabitSessionSummary(agentRoot, { runId: "run-empty" })).toMatchObject({
      summary: "Receipt summary survived empty session.",
      warnings: ["session file had no usable messages"],
    })
    expect(readHabitSessionSummary(agentRoot, { runId: "run-bad" })).toMatchObject({
      summary: "Receipt summary survived malformed session.",
      warnings: [expect.stringContaining("session file malformed")],
    })
  })

  it("normalizes legacy receipts and falls back to deterministic receipt prose", () => {
    const agentRoot = makeAgentRoot()
    const receiptDir = path.join(agentRoot, "arc", "flight-recorder", "habit-receipts")
    fs.mkdirSync(receiptDir, { recursive: true })
    fs.writeFileSync(path.join(receiptDir, "legacy-run.json"), JSON.stringify({
      schemaVersion: 1,
      runId: "legacy-run",
      habitName: "legacy-checkup",
      trigger: "poke",
      startedAt: "2026-06-11T11:00:00.000Z",
      endedAt: "2026-06-11T11:01:00.000Z",
      outcome: "blocked",
      producedRefs: [],
      surfaceAttempts: [],
      errors: ["legacy block"],
    }, null, 2), "utf-8")

    expect(readHabitSessionSummary(agentRoot, { runId: "legacy-run" })).toMatchObject({
      runId: "legacy-run",
      habitName: "legacy-checkup",
      operationId: null,
      status: "blocked",
      summary: "Habit legacy-checkup finished with blocked.",
      errors: ["legacy block"],
      sources: expect.objectContaining({
        receipt: "arc/flight-recorder/habit-receipts/legacy-run.json",
      }),
      warnings: expect.arrayContaining(["legacy receipt normalized without summary snapshot", "session file missing"]),
    })
  })
})
