import { describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { listHabitRunReceipts } from "../../arc/flight-recorder"
import { readRunLedger } from "../../heart/run-ledger"
import { readHabitLastRun } from "../../heart/habits/habit-runtime-state"
import { readRsvpSpendLedger } from "../../rsvp/spend-ledger"
import { runNativeRsvpHabit } from "../../rsvp/native-habit-runner"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"

function seedRsvpHabit(mode: "shadow" | "live" = "live"): { bundlesRoot: string; agentRoot: string; cleanup: () => void } {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-rsvp-habit-"))
  const agentRoot = path.join(bundlesRoot, "slugger.ouro")
  const habitsDir = path.join(agentRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  fs.writeFileSync(
    path.join(habitsDir, "rsvp-ari-rachel.md"),
    [
      "---",
      "title: rsvp-ari-rachel",
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

describe("native RSVP habit runner", () => {
  it("runs live RSVP refresh and records habit/runtime/run ledger evidence without provider usage", async () => {
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
        snapshotId: "snap-live-1",
        reportText: "RSVP Update -- Ari & Rachel",
        outboundDecision: { action: "send" },
        delivery: { guid: "bluebubbles-guid-1" },
      },
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-ari-rachel",
        trigger: "launchd",
        occurrenceId: "launchd:first-run:0 10 * * *",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result).toMatchObject({
        ok: true,
        message: "native RSVP habit rsvp-ari-rachel completed for slugger",
        lifecycle: "completed",
      })
      expect(runRefresh).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rsvp.refresh",
          agent: "slugger",
          mode: "live",
          allowSend: true,
          json: true,
        }),
        expect.objectContaining({
          bundlesRoot: tmp.bundlesRoot,
          agentBundleRoot: tmp.agentRoot,
        }),
      )
      expect(readHabitLastRun(tmp.agentRoot, "rsvp-ari-rachel")).toBe("2026-07-12T17:00:05.000Z")

      const receipts = listHabitRunReceipts(tmp.agentRoot)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        habitName: "rsvp-ari-rachel",
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

      const runLedger = readRunLedger(tmp.agentRoot)
      expect(runLedger.map((row) => row.lifecycle)).toEqual(["started", "completed"])
      expect(runLedger[1]).toMatchObject({
        agent: "slugger",
        triggerType: "habit",
        sourceKind: "daemon",
        senseOrHabit: "rsvp-ari-rachel",
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
        habitName: "rsvp-ari-rachel",
        lifecycle: "completed",
        contentStored: false,
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
        habitName: "rsvp-ari-rachel",
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
          mode: "shadow",
          noSend: true,
          json: true,
        }),
        expect.any(Object),
      )
      expect(readHabitLastRun(tmp.agentRoot, "rsvp-ari-rachel")).toBe("2026-07-12T17:03:54.000Z")
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-ari-rachel",
        trigger: "overdue",
        outcome: "error",
        errors: ["RSVP refresh requires native RSVP config before live work can run"],
      })
      expect(readRunLedger(tmp.agentRoot).map((row) => row.lifecycle)).toEqual(["started", "error"])
      expect(readRsvpSpendLedger(tmp.agentRoot).runs).toHaveLength(2)
    } finally {
      tmp.cleanup()
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
        reportText: "RSVP Update -- Ari & Rachel",
        outboundDecision: { action: "send" },
        delivery: { guid: "bluebubbles-guid-2" },
      },
    }))

    try {
      const result = await runNativeRsvpHabit({
        agent: "slugger",
        bundlesRoot: tmp.bundlesRoot,
        habitName: "rsvp-ari-rachel",
        trigger: "launchd",
        occurrenceId: "launchd:first-run:0 10 * * *",
        now: () => "2026-07-12T17:00:05.000Z",
        runRefresh,
      })

      expect(result.ok).toBe(true)
      expect(readRunLedger(tmp.agentRoot).map((row) => row.lifecycle)).toEqual(["started", "completed"])
      expect(listHabitRunReceipts(tmp.agentRoot)[0]).toMatchObject({
        habitName: "rsvp-ari-rachel",
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
