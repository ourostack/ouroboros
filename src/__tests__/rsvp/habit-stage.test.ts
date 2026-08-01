import * as fs from "fs"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { parseHabitFile } from "../../heart/habits/habit-parser"
import { RsvpHabitStageError, stageRsvpHabit } from "../../rsvp/habit-stage"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"

describe("RSVP native habit staging", () => {
  it("constructs a stable stage error when no lower-level cause exists", () => {
    const error = new RsvpHabitStageError("habit_stage_exists")

    expect(error).toMatchObject({
      name: "RsvpHabitStageError",
      message: "habit_stage_exists",
      code: "habit_stage_exists",
    })
    expect(error.cause).toBeUndefined()
  })

  it("writes a generic RSVP habit as a native typed habit instead of a script placeholder", async () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const result = await stageRsvpHabit({
        agent: "agent",
        agentRoot: tmp.agentRoot,
        mode: "shadow",
        cadence: "0 10 * * *",
        now: new Date("2026-07-09T20:00:00.000Z"),
      })
      const habitPath = path.join(tmp.agentRoot, "habits", "rsvp-updates.md")
      const outboundStatePath = path.join(tmp.agentRoot, "state", "rsvp", "outbound-state.json")
      const spendLedgerPath = path.join(tmp.agentRoot, "state", "rsvp", "spend-ledger.json")
      const content = fs.readFileSync(habitPath, "utf-8")
      const parsed = parseHabitFile(content, habitPath) as ReturnType<typeof parseHabitFile> & { rsvp?: Record<string, unknown> }
      const outboundState = JSON.parse(fs.readFileSync(outboundStatePath, "utf-8")) as Record<string, unknown>
      const spendLedger = JSON.parse(fs.readFileSync(spendLedgerPath, "utf-8")) as Record<string, unknown>

      expect(result).toMatchObject({
        ok: true,
        sideEffect: true,
        agent: "agent",
        habitName: "rsvp-updates",
        habitPath,
        mode: "shadow",
        cadence: "0 10 * * *",
        rsvp: {
          policyVersion: "rsvp-habit/v1",
          mode: "shadow",
          sense: "bluebubbles",
          source: "aisleplanner",
          routeRef: "rsvp/config.json#bluebubblesRoute",
          snapshotRef: "state/rsvp/snapshots/latest.json",
          outboundStateRef: "state/rsvp/outbound-state.json",
          budgetRef: "state/rsvp/spend-ledger.json",
          idempotencyRef: "state/rsvp/outbound-state.json",
          liveSendEligible: false,
          reportTitle: "RSVP Updates",
        },
      })
      expect(parsed).toMatchObject({
        name: "rsvp-updates",
        title: "RSVP Updates",
        cadence: "0 10 * * *",
        status: "active",
        tools: ["rsvp_query", "rsvp_summary"],
        continuity: { mode: "stateful" },
        rsvp: {
          policyVersion: "rsvp-habit/v1",
          mode: "shadow",
          sense: "bluebubbles",
          routeRef: "rsvp/config.json#bluebubblesRoute",
          snapshotRef: "state/rsvp/snapshots/latest.json",
          budgetRef: "state/rsvp/spend-ledger.json",
          idempotencyRef: "state/rsvp/outbound-state.json",
          liveSendEligible: false,
          reportTitle: "RSVP Updates",
        },
      })
      expect(outboundState).toMatchObject({
        policyVersion: "rsvp-outbound-state/v1",
        updatedAt: "2026-07-09T20:00:00.000Z",
        pendingReports: [],
      })
      expect(spendLedger).toMatchObject({
        policyVersion: "rsvp-spend-ledger/v1",
        createdAt: "2026-07-09T20:00:00.000Z",
        updatedAt: "2026-07-09T20:00:00.000Z",
        runs: [],
      })
    } finally {
      tmp.cleanup()
    }
  })

  it("lets the bundle own routine-specific naming and report title", async () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const result = await stageRsvpHabit({
        agent: "agent",
        agentRoot: tmp.agentRoot,
        habitName: "rsvp-wedding",
        title: "Wedding RSVPs",
        reportTitle: "Wedding RSVP Update",
        mode: "shadow",
        cadence: "0 10 * * *",
        now: new Date("2026-07-09T20:00:00.000Z"),
      })
      const content = fs.readFileSync(result.habitPath, "utf-8")

      expect(result.name).toBe("rsvp-wedding")
      expect(result.habitPath).toBe(path.join(tmp.agentRoot, "habits", "rsvp-wedding.md"))
      expect(content).toContain("title: Wedding RSVPs")
      expect(content).toContain("reportTitle: Wedding RSVP Update")
    } finally {
      tmp.cleanup()
    }
  })

  it("uses the current time when no staging timestamp is injected", async () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const result = await stageRsvpHabit({
        agent: "agent",
        agentRoot: tmp.agentRoot,
        mode: "live",
        cadence: "0 10 * * *",
      })
      const content = fs.readFileSync(result.habitPath, "utf-8")

      expect(result.name).toBe("rsvp-updates")
      expect(result.mode).toBe("live")
      expect(content).toMatch(/created: \d{4}-\d{2}-\d{2}T/)
      expect(content).toContain("mode: live")
      expect(content).toContain("tools: [rsvp_query, rsvp_summary]")
    } finally {
      tmp.cleanup()
    }
  })

  it("rejects habit names outside the RSVP habit family", async () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      await expect(Promise.resolve().then(() => stageRsvpHabit({
        agent: "agent",
        agentRoot: tmp.agentRoot,
        habitName: "rsvp",
        mode: "shadow",
        cadence: "0 10 * * *",
      }))).rejects.toThrow(/must start with rsvp-/)
    } finally {
      tmp.cleanup()
    }
  })

  it("refuses to reactivate a cancelled RSVP habit", async () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const habitPath = path.join(tmp.agentRoot, "habits", "rsvp-wedding.md")
      const cancelled = [
        "---",
        "title: Wedding RSVPs",
        "status: cancelled",
        "cancelledAt: 2026-07-10T20:00:00.000Z",
        "---",
        "",
        "Stopped.",
        "",
      ].join("\n")
      fs.mkdirSync(path.dirname(habitPath), { recursive: true })
      fs.writeFileSync(habitPath, cancelled, "utf-8")

      await expect(Promise.resolve().then(() => stageRsvpHabit({
        agent: "agent",
        agentRoot: tmp.agentRoot,
        habitName: "rsvp-wedding",
        mode: "live",
        cadence: "0 11 * * *",
        now: new Date("2026-07-11T20:00:00.000Z"),
      }))).rejects.toThrow("habit_stage_exists")
      expect(fs.readFileSync(habitPath, "utf-8")).toBe(cancelled)
      expect(fs.existsSync(path.join(tmp.agentRoot, "state", "rsvp", "outbound-state.json"))).toBe(false)
      expect(fs.existsSync(path.join(tmp.agentRoot, "state", "rsvp", "spend-ledger.json"))).toBe(false)
    } finally {
      tmp.cleanup()
    }
  })
})
