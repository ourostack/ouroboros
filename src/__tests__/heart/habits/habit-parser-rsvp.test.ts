import { describe, expect, it } from "vitest"

import { parseHabitFile } from "../../../heart/habits/habit-parser"

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

  it("marks invalid RSVP metadata degraded instead of throwing or activating it", () => {
    const habit = parseHabitFile([
      "---",
      "title: Wedding RSVPs",
      "status: active",
      "cadence: 0 10 * * *",
      "tools: [send_message, shell]",
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
    ].join("\n"), "/bundles/slugger.ouro/habits/rsvp-wedding.md")

    expect(habit.status).toBe("degraded")
    expect("degradedReason" in habit ? habit.degradedReason : undefined).toBe("invalid_metadata")
    expect("degradedDetail" in habit ? habit.degradedDetail : undefined).toBe(
      "RSVP habit metadata requires sense, not channel",
    )
    expect(habit.rsvp).toBeUndefined()
    expect(habit.tools).toBeUndefined()
  })

  it("preserves typed RSVP metadata while recognizing cancelled lifecycle state", () => {
    const habit = parseHabitFile([
      "---",
      "title: Wedding RSVPs",
      "status: cancelled",
      "cadence: 0 10 * * *",
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
      "---",
      "",
      "Do not run again.",
    ].join("\n"), "/bundles/slugger.ouro/habits/rsvp-wedding.md")

    expect(habit.status).toBe("cancelled")
    expect(habit.rsvp?.sense).toBe("bluebubbles")
    expect(habit.tools).toEqual(["rsvp_query", "rsvp_summary"])
  })
})
