import { describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { listHabitRunReceipts } from "../../arc/flight-recorder"
import { readRunLedger, runLedgerHash } from "../../heart/run-ledger"
import { readHabitLastRun } from "../../heart/habits/habit-runtime-state"
import { readRsvpSpendLedger } from "../../rsvp/spend-ledger"
import { runNativeRsvpHabit, type RunNativeRsvpHabitInput } from "../../rsvp/native-habit-runner"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"

function seedRsvpHabit(mode: "shadow" | "live" = "live"): { bundlesRoot: string; agentRoot: string; cleanup: () => void } {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-rsvp-habit-"))
  const agentRoot = path.join(bundlesRoot, "slugger.ouro")
  const habitsDir = path.join(agentRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  fs.writeFileSync(
    path.join(habitsDir, "rsvp-wedding.md"),
    [
      "---",
      "title: rsvp-wedding",
      "cadence: 0 10 * * *",
      "status: active",
      "rsvp:",
      "  policyVersion: rsvp-habit/v1",
      `  mode: ${mode}`,
      "  sense: bluebubbles",
      "  source: aisleplanner",
      "  routeRef: rsvp/config.json#bluebubblesRoute",
      "  snapshotRef: state/rsvp/snapshots/latest.json",
      "  outboundStateRef: state/rsvp/outbound-state.json",
      "  budgetRef: state/rsvp/spend-ledger.json",
      "  idempotencyRef: state/rsvp/outbound-state.json",
      `  liveSendEligible: ${mode === "live" ? "true" : "false"}`,
      "---",
      "",
      "Run the RSVP habit.",
    ].join("\n"),
    "utf-8",
  )
  return {
    bundlesRoot,
    agentRoot,
    cleanup: () => fs.rmSync(bundlesRoot, { recursive: true, force: true }),
  }
}

function seedHabitWithoutRsvp(): { bundlesRoot: string; agentRoot: string; cleanup: () => void } {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-rsvp-habit-missing-meta-"))
  const agentRoot = path.join(bundlesRoot, "slugger.ouro")
  const habitsDir = path.join(agentRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  fs.writeFileSync(
    path.join(habitsDir, "rsvp-wedding.md"),
    [
      "---",
      "title: rsvp-wedding",
      "cadence: 0 10 * * *",
      "status: active",
      "---",
      "",
      "Run the RSVP habit.",
    ].join("\n"),
    "utf-8",
  )
  return {
    bundlesRoot,
    agentRoot,
    cleanup: () => fs.rmSync(bundlesRoot, { recursive: true, force: true }),
  }
}

describe("native RSVP habit runner", () => {
  it("runs live RSVP refresh and records habit/runtime/run ledger evidence without provider usage", async () => {
    const tmp = seedRsvpHabit("live")
    const runRefresh = vi.fn(async (_command, deps) => {
      expect(await deps.sendCommand({ kind: "status" })).toEqual({
        ok: false,
        error: "daemon socket unavailable in native RSVP habit runner",
      })
      expect(await deps.startDaemonProcess()).toEqual({ pid: null })
      deps.writeStdout("ignored")
      expect(await deps.checkSocketAlive()).toBe(false)
      deps.cleanupStaleSocket()
      expect(deps.fallbackPendingMessage()).toBe("daemon socket unavailable in native RSVP habit runner")
      return JSON.stringify({
        ok: true,
        command: "rsvp.refresh",
        sideEffect: true,
        agent: "slugger",
        mode: "live",
        message: "RSVP refresh completed",
        sendAllowed: true,
        refresh: {
          snapshotId: "snap-live-1",
          reportText: "RSVP Update -- Wedding",
          outboundDecision: { action: "send" },
          delivery: { guid: "bluebubbles-guid-1" },
        },
      })
    })

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "launchd",
        occurrenceId: "launchd:first-run:0 10 * * *",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: true,
        message: "native RSVP habit rsvp-wedding completed for slugger",
        lifecycle: "completed",
      })
      expect(runRefresh).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rsvp.refresh",
          agent: "slugger",
          habitName: "rsvp-wedding",
          mode: "live",
          allowSend: true,
          json: true,
        }),
        expect.objectContaining({
          bundlesRoot: tmp.bundlesRoot,
          agentBundleRoot: tmp.agentRoot,
        }),
      )
      expect(readHabitLastRun(tmp.agentRoot, "rsvp-wedding")).toBe("2026-07-12T17:00:05.000Z")

      const receipts = listHabitRunReceipts(tmp.agentRoot)
      expect(receipts).toHaveLength(1)
      const receipt = receipts[0]
      expect(receipt).toMatchObject({
        habitName: "rsvp-wedding",
        trigger: "launchd",
        outcome: "surfaced",
        startedAt: "2026-07-12T17:00:05.000Z",
        endedAt: "2026-07-12T17:00:05.000Z",
        errors: [],
        surfaceAttempts: [
          expect.objectContaining({
            recipient: "rsvp",
            channel: "bluebubbles",
            result: "sent",
          }),
        ],
      })
      expect(receipt.traceSteps.map((step) => step.kind)).toEqual([
        "trigger",
        "habit_definition",
        "fetch",
        "snapshot",
        "render",
        "decision",
        "produced_ref",
        "surface_attempt",
        "send",
        "ledger",
        "error",
        "complete",
      ])
      expect(receipt.traceSteps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stepId: "habit-definition",
          kind: "habit_definition",
          refs: [{ kind: "habit_definition", locator: "habits/rsvp-wedding.md", label: "rsvp-wedding" }],
        }),
        expect.objectContaining({
          stepId: "decision",
          kind: "decision",
          decisions: ["mode=live", "sendAllowed=true", "outboundAction=send"],
        }),
        expect.objectContaining({
          stepId: "send",
          kind: "send",
          status: "succeeded",
          surfaceAttempt: expect.objectContaining({
            channel: "bluebubbles",
            result: "sent",
          }),
        }),
        expect.objectContaining({
          stepId: "error",
          kind: "error",
          status: "skipped",
        }),
      ]))
      expect(receipt.summarySnapshot.decisions).toEqual(["mode=live", "sendAllowed=true", "outboundAction=send"])

      const runLedger = readRunLedger(tmp.agentRoot)
      expect(runLedger.map((row) => row.lifecycle)).toEqual(["started", "completed"])
      expect(runLedger[1]).toMatchObject({
        agent: "slugger",
        triggerType: "habit",
        sourceKind: "daemon",
        senseOrHabit: "rsvp-wedding",
        usage: {
          source: "none",
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        },
      })

      const spendLedger = readRsvpSpendLedger(tmp.agentRoot)
      expect(spendLedger.runs).toHaveLength(2)
      expect(spendLedger.runs[1]).toMatchObject({
        habitName: "rsvp-wedding",
        lifecycle: "completed",
        contentStored: false,
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("threads hard no-send through a live send-eligible native probe", async () => {
    const tmp = seedRsvpHabit("live")
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: "slugger",
      mode: "live",
      message: "RSVP refresh completed",
      allowSend: true,
      noSend: true,
      sendAllowed: false,
      transportInvocationCount: 0,
      refresh: {
        snapshotId: "snap-probe-1",
        reportText: "RSVP Probe",
        outboundDecision: { action: "send" },
      },
    }))

    try {
      const input = {
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "manual",
        occurrenceId: "probe:manual",
        noSend: true,
        now: () => "2026-07-12T17:00:06.000Z",
        runRefresh,
      } satisfies RunNativeRsvpHabitInput
      const result = await runNativeRsvpHabit(input)

      expect(runRefresh).toHaveBeenCalledWith(expect.objectContaining({
        kind: "rsvp.refresh",
        mode: "live",
        allowSend: true,
        noSend: true,
        json: true,
      }), expect.any(Object))
      expect(result.payload).toMatchObject({
        noSend: true,
        sendAllowed: false,
        transportInvocationCount: 0,
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("records blocked refresh payloads as errored habit runs and advances the cursor", async () => {
    const tmp = seedRsvpHabit("shadow")
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: "slugger",
      mode: "shadow",
      message: "RSVP refresh requires native RSVP config before live work can run",
      requires: "native RSVP config",
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "overdue",
        occurrenceId: "overdue:first-run:0 10 * * *",
        now: () => "2026-07-12T17:03:54.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: false,
        lifecycle: "error",
      })
      expect(runRefresh).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rsvp.refresh",
          agent: "slugger",
          habitName: "rsvp-wedding",
          mode: "shadow",
          noSend: true,
          json: true,
        }),
        expect.any(Object),
      )
      expect(readHabitLastRun(tmp.agentRoot, "rsvp-wedding")).toBe("2026-07-12T17:03:54.000Z")
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-wedding",
        trigger: "overdue",
        outcome: "error",
        errors: ["RSVP refresh requires native RSVP config before live work can run"],
        traceSteps: expect.arrayContaining([
          expect.objectContaining({
            kind: "decision",
            decisions: ["mode=shadow", "sendAllowed=false", "outboundAction=unknown"],
          }),
          expect.objectContaining({
            stepId: "send",
            kind: "send",
            status: "skipped",
          }),
          expect.objectContaining({
            stepId: "error",
            kind: "error",
            status: "failed",
            error: "RSVP refresh requires native RSVP config before live work can run",
          }),
          expect.objectContaining({
            stepId: "complete",
            kind: "complete",
            status: "failed",
          }),
        ]),
      })
      expect(readRunLedger(tmp.agentRoot).map((row) => row.lifecycle)).toEqual(["started", "error"])
      expect(readRsvpSpendLedger(tmp.agentRoot).runs).toHaveLength(2)
    } finally {
      tmp.cleanup()
    }
  })

  it("uses the default RSVP refresh runner and records blocked live sends without private-runtime wake", async () => {
    const tmp = seedRsvpHabit("live")

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "launchd",
        occurrenceId: "launchd:first-run:0 10 * * *",
        now: () => "2026-07-12T17:00:05.000Z",
      })

      expect(result).toMatchObject({
        ok: false,
        lifecycle: "error",
        payload: expect.objectContaining({
          command: "rsvp.refresh",
          requires: "native RSVP config",
        }),
      })
      expect(readRunLedger(tmp.agentRoot).map((row) => row.lifecycle)).toEqual(["started", "error"])
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-wedding",
        trigger: "launchd",
        outcome: "error",
        surfaceAttempts: [
          expect.objectContaining({
            channel: "bluebubbles",
            result: "blocked",
            error: "RSVP refresh requires native RSVP config before live work can run",
          }),
        ],
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("records no-send refresh snapshots as no-change produced refs", async () => {
    const tmp = seedRsvpHabit("shadow")
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: "slugger",
      mode: "shadow",
      message: "RSVP refresh completed",
      sendAllowed: false,
      refresh: {
        snapshotId: "snap-shadow-1",
        reportText: "RSVP Update -- Wedding",
        outboundDecision: { action: "suppress" },
      },
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "overdue",
        now: () => "2026-07-12T17:03:54.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: true,
        lifecycle: "completed",
      })
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-wedding",
        outcome: "no_change",
        operationId: expect.stringContaining(result.runId),
        producedRefs: [
          {
            kind: "none",
            locator: "state/rsvp/snapshots/snap-shadow-1.json",
          },
        ],
        traceSteps: expect.arrayContaining([
          expect.objectContaining({
            stepId: "snapshot",
            kind: "snapshot",
            status: "succeeded",
            refs: [{ kind: "snapshot", locator: "state/rsvp/snapshots/snap-shadow-1.json" }],
          }),
          expect.objectContaining({
            stepId: "produced-ref",
            kind: "produced_ref",
            status: "succeeded",
            producedRefs: [{ kind: "none", locator: "state/rsvp/snapshots/snap-shadow-1.json" }],
          }),
          expect.objectContaining({
            stepId: "send",
            kind: "send",
            status: "skipped",
          }),
        ]),
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("records failed live delivery attempts and malformed outbound decisions in generic trace steps", async () => {
    const tmp = seedRsvpHabit("live")
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: true,
      agent: "slugger",
      mode: "live",
      message: "RSVP refresh completed",
      sendAllowed: true,
      refresh: {
        snapshotId: "snap-live-failed-delivery",
        reportText: "RSVP Update -- Wedding",
        outboundDecision: { action: 12 },
        delivery: {
          status: "failed",
          error: "BlueBubbles rejected the send",
        },
      },
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "launchd",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: true,
        lifecycle: "completed",
      })
      const receipt = listHabitRunReceipts(tmp.agentRoot)[0]
      expect(receipt).toMatchObject({
        surfaceAttempts: [
          expect.objectContaining({
            channel: "bluebubbles",
            result: "failed",
            rawStatus: "failed",
            error: "BlueBubbles rejected the send",
          }),
        ],
        traceSteps: expect.arrayContaining([
          expect.objectContaining({
            stepId: "decision",
            decisions: ["mode=live", "sendAllowed=true", "outboundAction=unknown"],
          }),
          expect.objectContaining({
            stepId: "surface-attempt",
            kind: "surface_attempt",
            status: "failed",
            surfaceAttempt: expect.objectContaining({
              result: "failed",
              error: "BlueBubbles rejected the send",
            }),
          }),
          expect.objectContaining({
            stepId: "send",
            kind: "send",
            status: "failed",
          }),
        ]),
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("maps optional live delivery status variants into surface attempt evidence", async () => {
    const noDelivery = seedRsvpHabit("live")
    const queuedDelivery = seedRsvpHabit("live")
    const messageOnlyFailure = seedRsvpHabit("live")
    const statusOnlyFailure = seedRsvpHabit("live")

    const runWithPayload = (payload: Record<string, unknown>) => runNativeRsvpHabit({
      agent: "slugger",
      bundlesRoot: payload.bundlesRoot as string,
      habitName: "rsvp-wedding",
      trigger: "launchd",
      now: () => "2026-07-12T17:00:05.000Z",
      runRefresh: async () => JSON.stringify(payload.refreshPayload),
    })
    const refreshPayload = (delivery?: Record<string, unknown>) => ({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: true,
      agent: "slugger",
      mode: "live",
      message: "RSVP refresh completed",
      sendAllowed: true,
      refresh: {
        snapshotId: "snap-live-delivery-status",
        reportText: "RSVP Update -- Wedding",
        outboundDecision: { action: "send" },
        ...(delivery ? { delivery } : {}),
      },
    })

    try {
      await runWithPayload({
        bundlesRoot: noDelivery.bundlesRoot,
        refreshPayload: refreshPayload(),
      })
      expect(listHabitRunReceipts(noDelivery.agentRoot)[0].surfaceAttempts[0]).toEqual(expect.objectContaining({
        result: "sent",
      }))
      expect(listHabitRunReceipts(noDelivery.agentRoot)[0].surfaceAttempts[0]).not.toHaveProperty("rawStatus")

      await runWithPayload({
        bundlesRoot: queuedDelivery.bundlesRoot,
        refreshPayload: refreshPayload({ status: "queued" }),
      })
      expect(listHabitRunReceipts(queuedDelivery.agentRoot)[0].surfaceAttempts[0]).toEqual(expect.objectContaining({
        result: "sent",
        rawStatus: "queued",
      }))

      await runWithPayload({
        bundlesRoot: messageOnlyFailure.bundlesRoot,
        refreshPayload: refreshPayload({ result: "error", message: "provider returned an error" }),
      })
      expect(listHabitRunReceipts(messageOnlyFailure.agentRoot)[0].surfaceAttempts[0]).toEqual(expect.objectContaining({
        result: "failed",
        rawStatus: "error",
        error: "provider returned an error",
      }))

      await runWithPayload({
        bundlesRoot: statusOnlyFailure.bundlesRoot,
        refreshPayload: refreshPayload({ status: "failed" }),
      })
      expect(listHabitRunReceipts(statusOnlyFailure.agentRoot)[0].surfaceAttempts[0]).toEqual(expect.objectContaining({
        result: "failed",
        rawStatus: "failed",
        error: "failed",
      }))
    } finally {
      noDelivery.cleanup()
      queuedDelivery.cleanup()
      messageOnlyFailure.cleanup()
      statusOnlyFailure.cleanup()
    }
  })

  it("uses clock fallback and default payload error text when refresh returns an error without a message", async () => {
    const tmp = seedRsvpHabit("shadow")
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: false,
      command: "rsvp.refresh",
      sideEffect: false,
      agent: "slugger",
      mode: "shadow",
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "overdue",
        occurrenceId: "overdue:payload-error-without-message",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: false,
        lifecycle: "error",
      })
      const lastRun = readHabitLastRun(tmp.agentRoot, "rsvp-wedding")
      expect(lastRun).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        outcome: "error",
        errors: ["RSVP refresh did not complete"],
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("fails closed with run evidence before refresh for every non-active or unreadable RSVP definition", async () => {
    const cases: Array<{
      label: string
      seed: () => ReturnType<typeof seedRsvpHabit>
      arrange: (habitPath: string) => void
      expectedStatus: "paused" | "cancelled" | "degraded"
      expectedReason: string | null
      expectedErrorCode: string
    }> = [
      {
        label: "paused",
        seed: () => seedRsvpHabit("live"),
        arrange: (habitPath) => fs.writeFileSync(
          habitPath,
          fs.readFileSync(habitPath, "utf-8").replace("status: active", "status: paused"),
          "utf-8",
        ),
        expectedStatus: "paused",
        expectedReason: null,
        expectedErrorCode: "habit_status_paused",
      },
      {
        label: "cancelled",
        seed: () => seedRsvpHabit("live"),
        arrange: (habitPath) => fs.writeFileSync(
          habitPath,
          fs.readFileSync(habitPath, "utf-8").replace("status: active", "status: cancelled"),
          "utf-8",
        ),
        expectedStatus: "cancelled",
        expectedReason: null,
        expectedErrorCode: "habit_status_cancelled",
      },
      {
        label: "parser-degraded",
        seed: () => seedRsvpHabit("live"),
        arrange: (habitPath) => fs.writeFileSync(
          habitPath,
          fs.readFileSync(habitPath, "utf-8").replace("status: active", "status: retired"),
          "utf-8",
        ),
        expectedStatus: "degraded",
        expectedReason: "invalid_status",
        expectedErrorCode: "habit_invalid_status",
      },
      {
        label: "missing",
        seed: () => seedRsvpHabit("live"),
        arrange: (habitPath) => fs.rmSync(habitPath),
        expectedStatus: "degraded",
        expectedReason: "read_error",
        expectedErrorCode: "habit_read_error",
      },
      {
        label: "io-error",
        seed: () => seedRsvpHabit("live"),
        arrange: (habitPath) => {
          fs.rmSync(habitPath)
          fs.mkdirSync(habitPath)
        },
        expectedStatus: "degraded",
        expectedReason: "read_error",
        expectedErrorCode: "habit_read_error",
      },
      {
        label: "missing-rsvp-metadata",
        seed: seedHabitWithoutRsvp,
        arrange: () => undefined,
        expectedStatus: "degraded",
        expectedReason: "invalid_metadata",
        expectedErrorCode: "habit_invalid_metadata",
      },
    ]
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event === "rsvp.habit_lifecycle_rejected") events.push(entry)
    })
    const cleanups: Array<() => void> = []
    const outcomes: Array<{
      testCase: (typeof cases)[number]
      agentRoot: string
      runRefresh: ReturnType<typeof vi.fn>
      result: Awaited<ReturnType<typeof runNativeRsvpHabit>> | null
      error: string | null
    }> = []

    try {
      for (const testCase of cases) {
        const tmp = testCase.seed()
        cleanups.push(tmp.cleanup)
        const habitPath = path.join(tmp.agentRoot, "habits", "rsvp-wedding.md")
        testCase.arrange(habitPath)
        const runRefresh = vi.fn(async () => JSON.stringify({ ok: true }))

        try {
          const result = await runNativeRsvpHabit({
            agent: "slugger",
            bundlesRoot: tmp.bundlesRoot,
            habitName: "rsvp-wedding",
            trigger: "manual",
            occurrenceId: `manual:${testCase.label}`,
            now: () => new Date("2026-07-12T17:00:05.000Z"),
            runRefresh,
          })
          outcomes.push({ testCase, agentRoot: tmp.agentRoot, runRefresh, result, error: null })
        } catch (error) {
          outcomes.push({
            testCase,
            agentRoot: tmp.agentRoot,
            runRefresh,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      for (const outcome of outcomes) {
        const { testCase } = outcome
        expect.soft(outcome.error, testCase.label).toBeNull()
        expect.soft(outcome.result, testCase.label).toMatchObject({
          ok: false,
          lifecycle: "error",
          payload: {
            ok: false,
            command: "rsvp.refresh",
            sideEffect: false,
            requires: "active RSVP habit",
            status: testCase.expectedStatus,
            degradedReason: testCase.expectedReason,
          },
        })
        expect.soft(outcome.result?.message, testCase.label).toMatch(/rejected.*lifecycle/i)
        expect.soft(outcome.runRefresh, testCase.label).not.toHaveBeenCalled()
        const runLedger = readRunLedger(outcome.agentRoot)
        const expectedTargetHash = runLedgerHash({
          habitName: "rsvp-wedding",
          runId: outcome.result?.runId,
          trigger: "manual",
          occurrenceId: `manual:${testCase.label}`,
          command: "rsvp.refresh",
        })
        expect.soft(runLedger.map((row) => row.lifecycle), testCase.label).toEqual(["started", "error"])
        expect.soft(runLedger[1], testCase.label).toMatchObject({
          runId: runLedger[0]?.runId,
          idempotencyKey: runLedger[0]?.idempotencyKey,
          targetHash: expectedTargetHash,
          sourceKind: "daemon",
          senseOrHabit: "rsvp-wedding",
          lifecycle: "error",
          errorName: "HabitLifecycleRejected",
          errorCode: testCase.expectedErrorCode,
        })
      }

      expect.soft(events.map((event) => ({
        component: event.component,
        event: event.event,
        entryPoint: event.meta?.entryPoint,
        habitName: event.meta?.habitName,
        status: event.meta?.status,
        degradedReason: event.meta?.degradedReason,
      }))).toEqual(cases.map((testCase) => ({
        component: "rsvp",
        event: "rsvp.habit_lifecycle_rejected",
        entryPoint: "native_runner",
        habitName: "rsvp-wedding",
        status: testCase.expectedStatus,
        degradedReason: testCase.expectedReason,
      })))
    } finally {
      unregister()
      for (const cleanup of cleanups) cleanup()
    }
  })

  it("keeps lifecycle rejection fail closed when durable run-ledger evidence cannot be written", async () => {
    const tmp = seedRsvpHabit("live")
    const habitPath = path.join(tmp.agentRoot, "habits", "rsvp-wedding.md")
    fs.writeFileSync(
      habitPath,
      fs.readFileSync(habitPath, "utf-8").replace("status: active", "status: cancelled"),
      "utf-8",
    )
    fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "run-ledger"), "not a directory", "utf-8")
    const runRefresh = vi.fn(async () => JSON.stringify({ ok: true }))
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (
        entry.event === "heart.run_ledger_record_error"
        || entry.event === "rsvp.habit_lifecycle_rejected"
        || entry.event === "rsvp.native_habit_error"
      ) events.push(entry)
    })

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "manual",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: false,
        lifecycle: "error",
        payload: {
          sideEffect: false,
          status: "cancelled",
          degradedReason: null,
        },
      })
      expect(runRefresh).not.toHaveBeenCalled()
      expect(events.filter((event) => event.event === "heart.run_ledger_record_error").map((event) => event.meta?.lifecycle))
        .toEqual(["started", "error"])
      expect(events.filter((event) => event.event === "rsvp.habit_lifecycle_rejected")).toHaveLength(1)
      expect(events.filter((event) => event.event === "rsvp.native_habit_error")).toHaveLength(1)
    } finally {
      unregister()
      tmp.cleanup()
    }
  })

  it("surfaces runtime-state recording failures after successful refreshes", async () => {
    const tmp = seedRsvpHabit("live")
    fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "habits"), "not a directory", "utf-8")
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: true,
      agent: "slugger",
      mode: "live",
      message: "RSVP refresh completed",
      sendAllowed: true,
      refresh: {
        snapshotId: "snap-live-runtime-state-failure",
        reportText: "RSVP Update -- Wedding",
        outboundDecision: { action: "send" },
        delivery: { guid: "bluebubbles-guid-runtime-state-failure" },
      },
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "launchd",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: false,
        lifecycle: "completed",
        message: "native RSVP habit rsvp-wedding failed for slugger: runtime state was not recorded",
      })
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-wedding",
        outcome: "surfaced",
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("records malformed refresh output and non-Error throws as errored habit runs", async () => {
    const malformed = seedRsvpHabit("shadow")
    const stringThrown = seedRsvpHabit("shadow")
    const blankError = seedRsvpHabit("shadow")

    try {
      const malformedResult = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: malformed.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "overdue",
        occurrenceId: "overdue:malformed",
        now: () => "2026-07-12T17:03:54.000Z",
        runRefresh: async () => "null",
      })
      expect(malformedResult).toMatchObject({
        ok: false,
        lifecycle: "error",
        payload: expect.objectContaining({
          message: "RSVP refresh returned a non-object payload",
        }),
      })
      expect(listHabitRunReceipts(malformed.agentRoot)[0]).toMatchObject({
        outcome: "error",
        errors: ["RSVP refresh returned a non-object payload"],
      })

      const stringThrownResult = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: stringThrown.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "overdue",
        occurrenceId: "overdue:string-error",
        now: () => "2026-07-12T17:03:55.000Z",
        runRefresh: async () => Promise.reject("string failure"),
      })
      expect(stringThrownResult).toMatchObject({
        ok: false,
        lifecycle: "error",
        payload: expect.objectContaining({
          message: "string failure",
        }),
      })
      expect(readRunLedger(stringThrown.agentRoot).map((row) => row.lifecycle)).toEqual(["started", "error"])

      const blankErrorResult = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: blankError.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "overdue",
        occurrenceId: "overdue:blank-error",
        now: () => "2026-07-12T17:03:56.000Z",
        runRefresh: async () => Promise.reject(new Error("")),
      })
      expect(blankErrorResult).toMatchObject({
        ok: false,
        lifecycle: "error",
        payload: expect.objectContaining({
          message: "",
        }),
      })
      expect(listHabitRunReceipts(blankError.agentRoot)[0]).toMatchObject({
        outcome: "error",
        errors: ["RSVP refresh failed"],
      })
    } finally {
      malformed.cleanup()
      stringThrown.cleanup()
      blankError.cleanup()
    }
  })

  it("keeps the habit run nonfatal and emits telemetry when spend-ledger writes fail", async () => {
    const tmp = seedRsvpHabit("live")
    fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "rsvp"), "not a directory", "utf-8")
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event === "rsvp.native_habit_spend_ledger_error") events.push(entry)
    })
    const runRefresh = vi.fn(async () => JSON.stringify({
      ok: true,
      command: "rsvp.refresh",
      sideEffect: true,
      agent: "slugger",
      mode: "live",
      message: "RSVP refresh completed",
      sendAllowed: true,
      refresh: {
        snapshotId: "snap-live-2",
        reportText: "RSVP Update -- Wedding",
        outboundDecision: { action: "send" },
        delivery: { guid: "bluebubbles-guid-2" },
      },
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-wedding",
        trigger: "launchd",
        occurrenceId: "launchd:first-run:0 10 * * *",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result.ok).toBe(true)
      expect(readRunLedger(tmp.agentRoot).map((row) => row.lifecycle)).toEqual(["started", "completed"])
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-wedding",
        outcome: "surfaced",
      })
      expect(events).toHaveLength(2)
      expect(events.map((event) => event.level)).toEqual(["error", "error"])
      expect(events[0]).toMatchObject({
        component: "rsvp",
        event: "rsvp.native_habit_spend_ledger_error",
        meta: expect.objectContaining({
          lifecycle: "started",
        }),
      })
      expect(events[1]).toMatchObject({
        component: "rsvp",
        event: "rsvp.native_habit_spend_ledger_error",
        meta: expect.objectContaining({
          lifecycle: "completed",
        }),
      })
    } finally {
      unregister()
      tmp.cleanup()
    }
  })
})
