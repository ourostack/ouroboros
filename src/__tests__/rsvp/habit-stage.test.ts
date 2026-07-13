import * as fs from "fs"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { parseHabitFile } from "../../heart/habits/habit-parser"
import { stageRsvpHabit } from "../../rsvp/habit-stage"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"

describe("RSVP native habit staging", () => {
  it("writes a generic RSVP habit as a native typed habit instead of a script placeholder", () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const result = stageRsvpHabit({
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

  it("lets the bundle own routine-specific naming and report title", () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const result = stageRsvpHabit({
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

  it("uses the current time when no staging timestamp is injected", () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      const result = stageRsvpHabit({
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

  it("rejects habit names outside the RSVP habit family", () => {
    const tmp = createTmpBundle({ agentName: "agent" })
    try {
      expect(() => stageRsvpHabit({
        agent: "agent",
        agentRoot: tmp.agentRoot,
        habitName: "rsvp",
        mode: "shadow",
        cadence: "0 10 * * *",
      })).toThrow(/must start with rsvp-/)
    } finally {
      tmp.cleanup()
    }
  })
})
