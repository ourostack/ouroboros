import { describe, expect, it } from "vitest"

import { parseRsvpAwareHabitFile as parseHabitFile } from "../../../rsvp/habit-parser"

describe("RSVP habit metadata parsing", () => {
  it("parses typed RSVP policy metadata and derives the allowed RSVP tool set", () => {
    const habit = parseHabitFile([
      "---",
      "title: Wedding RSVPs",
      "status: active",
      "cadence: 0 10 * * *",
      "tools: [shell, rsvp_query]",
      "continuity:",
      "  mode: stateful",
      "rsvp:",
      "  policyVersion: rsvp-habit/v1",
      "  mode: shadow",
      "  sense: bluebubbles",
      "  source: aisleplanner",
      "  routeRef: rsvp/config.json#bluebubblesRoute",
      "  snapshotRef: state/rsvp/snapshots/latest.json",
      "  outboundStateRef: state/rsvp/outbound-state.json",
      "  budgetRef: state/rsvp/spend-ledger.json",
      "  idempotencyRef: state/rsvp/outbound-state.json",
      "  liveSendEligible: false",
      "  reportTitle: Wedding RSVP Update",
      "---",
      "",
      "Check native RSVP state.",
      "",
    ].join("\n"), "/bundles/slugger.ouro/habits/rsvp-wedding.md") as ReturnType<typeof parseHabitFile> & { rsvp?: Record<string, unknown> }

    expect(habit.tools).toEqual(["rsvp_query", "rsvp_summary"])
    expect(habit.rsvp).toEqual({
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
      reportTitle: "Wedding RSVP Update",
    })
  })

  it("rejects RSVP habits that use channel-shaped metadata instead of sense-shaped metadata", () => {
    expect(() => parseHabitFile([
      "---",
      "title: Wedding RSVPs",
      "cadence: 0 10 * * *",
      "rsvp:",
      "  policyVersion: rsvp-habit/v1",
      "  mode: shadow",
      "  channel: bluebubbles",
      "  source: aisleplanner",
      "  routeRef: rsvp/config.json#bluebubblesRoute",
      "  snapshotRef: state/rsvp/snapshots/latest.json",
      "---",
      "",
      "Check native RSVP state.",
      "",
    ].join("\n"), "/bundles/slugger.ouro/habits/rsvp-wedding.md")).toThrow(/rsvp.*sense/i)
  })
})
