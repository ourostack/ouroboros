import * as fs from "fs"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { parseHabitFile } from "../../heart/habits/habit-parser"
import { stageRsvpHabit } from "../../rsvp/habit-stage"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"

describe("RSVP native habit staging", () => {
  it("writes the Slugger RSVP habit as a native typed habit instead of a script placeholder", () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const result = stageRsvpHabit({
        agent: "slugger",
        agentRoot: tmp.agentRoot,
        mode: "shadow",
        cadence: "0 10 * * *",
        now: new Date("2026-07-09T20:00:00.000Z"),
      })
      const habitPath = path.join(tmp.agentRoot, "habits", "rsvp-ari-rachel.md")
      const content = fs.readFileSync(habitPath, "utf-8")
      const parsed = parseHabitFile(content, habitPath) as ReturnType<typeof parseHabitFile> & { rsvp?: Record<string, unknown> }

      expect(result).toMatchObject({
        ok: true,
        sideEffect: true,
        agent: "slugger",
        habitName: "rsvp-ari-rachel",
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
        },
      })
      expect(parsed).toMatchObject({
        name: "rsvp-ari-rachel",
        title: "RSVP Ari & Rachel",
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
        },
      })
      expect(content).not.toMatch(/beep boop|script, not slugger|no need to reply/i)
    } finally {
      tmp.cleanup()
    }
  })

  it("uses the current time when no staging timestamp is injected", () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const result = stageRsvpHabit({
        agent: "slugger",
        agentRoot: tmp.agentRoot,
        mode: "live",
        cadence: "0 10 * * *",
      })
      const content = fs.readFileSync(result.habitPath, "utf-8")

      expect(result.name).toBe("rsvp-ari-rachel")
      expect(result.mode).toBe("live")
      expect(content).toMatch(/created: \d{4}-\d{2}-\d{2}T/)
      expect(content).toContain("mode: live")
      expect(content).toContain("tools: [rsvp_query, rsvp_summary]")
    } finally {
      tmp.cleanup()
    }
  })
})
