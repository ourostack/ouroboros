import { describe, expect, it } from "vitest"

import {
  RSVP_HABIT_POLICY_VERSION,
  isRsvpHabitName,
  parseRsvpHabitMetadata,
  rsvpHabitRuntimePolicy,
} from "../../rsvp/habit-policy"

const baseMetadata = {
  policyVersion: RSVP_HABIT_POLICY_VERSION,
  mode: "shadow",
  sense: "bluebubbles",
  source: "aisleplanner",
  routeRef: "rsvp/config.json#bluebubblesRoute",
  snapshotRef: "state/rsvp/snapshots/latest.json",
  outboundStateRef: "state/rsvp/outbound-state.json",
  budgetRef: "state/rsvp/spend-ledger.json",
  idempotencyRef: "state/rsvp/outbound-state.json",
  liveSendEligible: false,
}

describe("RSVP habit policy", () => {
  it("recognizes the canonical RSVP habit family", () => {
    expect(isRsvpHabitName("rsvp-ari-rachel")).toBe(true)
    expect(isRsvpHabitName("rsvp-test")).toBe(true)
    expect(isRsvpHabitName("heartbeat")).toBe(false)
  })

  it("treats absent RSVP metadata as non-RSVP and rejects non-object metadata", () => {
    expect(parseRsvpHabitMetadata(undefined)).toBeNull()
    expect(parseRsvpHabitMetadata(null)).toBeNull()
    expect(() => parseRsvpHabitMetadata("rsvp")).toThrow(/must be an object/i)
  })

  it("coerces string booleans for live-send eligibility", () => {
    expect(parseRsvpHabitMetadata({ ...baseMetadata, liveSendEligible: "true" })?.liveSendEligible).toBe(true)
    expect(parseRsvpHabitMetadata({ ...baseMetadata, liveSendEligible: "false" })?.liveSendEligible).toBe(false)
  })

  it("rejects stale channel terminology and invalid metadata values", () => {
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, channel: "bluebubbles" })).toThrow(/sense, not channel/i)
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, policyVersion: "rsvp-habit/v0" })).toThrow(/policyVersion/i)
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, mode: "dry-run" })).toThrow(/mode/i)
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, sense: "sms" })).toThrow(/sense/i)
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, source: "spreadsheet" })).toThrow(/source/i)
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, snapshotRef: " " })).toThrow(/snapshotRef/i)
    expect(() => parseRsvpHabitMetadata({ ...baseMetadata, liveSendEligible: "maybe" })).toThrow(/boolean liveSendEligible/i)
  })

  it("derives send permission only for live eligible habits", () => {
    expect(rsvpHabitRuntimePolicy(parseRsvpHabitMetadata(baseMetadata)!).sendAllowed).toBe(false)
    expect(rsvpHabitRuntimePolicy(parseRsvpHabitMetadata({
      ...baseMetadata,
      mode: "live",
      liveSendEligible: false,
    })!).sendAllowed).toBe(false)
    expect(rsvpHabitRuntimePolicy(parseRsvpHabitMetadata({
      ...baseMetadata,
      mode: "live",
      liveSendEligible: true,
    })!).sendAllowed).toBe(true)
  })
})
