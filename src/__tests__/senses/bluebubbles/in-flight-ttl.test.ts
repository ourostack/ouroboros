/**
 * Regression test for the 2026-05-11 BlueBubbles inbound wedge: a leaked
 * in-flight marker blocked all subsequent recovery attempts for the same
 * (sessionKey, messageGuid) until the BB sense process restarted. Slugger's
 * queue grew unboundedly for 12+ hours with no forward progress.
 *
 * The fix: in-flight markers carry a claim timestamp and expire after
 * BB_IN_FLIGHT_MAX_AGE_MS. `isInFlight` returns false for stale markers;
 * `begin` is allowed to replace a stale marker, emitting a nerves event
 * so the recovery is observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { nervesEvents } = vi.hoisted(() => ({
  nervesEvents: [] as Array<Record<string, unknown>>,
}))
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import {
  BB_IN_FLIGHT_MAX_AGE_MS,
  __resetBlueBubblesInFlightForTests,
  beginBlueBubblesMessageInFlight,
  endBlueBubblesMessageInFlight,
  isBlueBubblesMessageInFlight,
} from "../../../senses/bluebubbles/index"

describe("BB in-flight marker TTL", () => {
  beforeEach(() => {
    __resetBlueBubblesInFlightForTests()
    nervesEvents.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-11T20:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("TTL constant audit", () => {
    it("is longer than the recovery-turn timeout (10 min) — owners need full headroom", () => {
      expect(BB_IN_FLIGHT_MAX_AGE_MS).toBeGreaterThanOrEqual(10 * 60_000)
    })

    it("is not so long that a leaked marker blocks forward progress for hours", () => {
      expect(BB_IN_FLIGHT_MAX_AGE_MS).toBeLessThanOrEqual(60 * 60_000)
    })
  })

  describe("happy path", () => {
    it("begin/isInFlight/end form a normal claim+release cycle", () => {
      const session = "chat:any;-;ari@mendelow.me"
      const guid = "63268A55-A5FC-4316-A69E-646E9419BBFE"

      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(false)
      expect(beginBlueBubblesMessageInFlight(session, guid)).toBe(true)
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(true)

      endBlueBubblesMessageInFlight(session, guid)
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(false)
    })

    it("re-claim after end succeeds (no leftover state)", () => {
      const session = "x"
      const guid = "abc-123"

      expect(beginBlueBubblesMessageInFlight(session, guid)).toBe(true)
      endBlueBubblesMessageInFlight(session, guid)
      expect(beginBlueBubblesMessageInFlight(session, guid)).toBe(true)
    })

    it("a second begin while marker is live (and fresh) returns false — proper dedupe", () => {
      const session = "x"
      const guid = "abc-123"

      expect(beginBlueBubblesMessageInFlight(session, guid)).toBe(true)
      expect(beginBlueBubblesMessageInFlight(session, guid)).toBe(false)
    })

    it("empty/whitespace guid is never tracked (true on begin, false on isInFlight)", () => {
      expect(beginBlueBubblesMessageInFlight("x", "")).toBe(true)
      expect(beginBlueBubblesMessageInFlight("x", "   ")).toBe(true)
      expect(isBlueBubblesMessageInFlight("x", "")).toBe(false)
      expect(isBlueBubblesMessageInFlight("x", "  ")).toBe(false)
    })
  })

  describe("TTL expiry — the leak-survival behavior", () => {
    it("isInFlight returns false once the claim is older than the TTL", () => {
      const session = "x"
      const guid = "abc-123"

      beginBlueBubblesMessageInFlight(session, guid)
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(true)

      // Advance just past TTL.
      vi.advanceTimersByTime(BB_IN_FLIGHT_MAX_AGE_MS)
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(false)
    })

    it("isInFlight stays true at TTL-1ms (boundary)", () => {
      const session = "x"
      const guid = "abc-123"
      beginBlueBubblesMessageInFlight(session, guid)
      vi.advanceTimersByTime(BB_IN_FLIGHT_MAX_AGE_MS - 1)
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(true)
    })

    it("begin replaces a stale marker (the leak-survival path) and re-claim succeeds", () => {
      const session = "chat:any;-;ari@mendelow.me"
      const guid = "63268A55-A5FC-4316-A69E-646E9419BBFE"

      // Simulate a leak: someone called begin but never called end.
      beginBlueBubblesMessageInFlight(session, guid)
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(true)

      // Time passes beyond the TTL — the leak is now self-clearing.
      vi.advanceTimersByTime(BB_IN_FLIGHT_MAX_AGE_MS + 1000)

      // The next recovery pass attempts to re-claim and SUCCEEDS.
      expect(beginBlueBubblesMessageInFlight(session, guid)).toBe(true)

      // And the marker is observably fresh again.
      expect(isBlueBubblesMessageInFlight(session, guid)).toBe(true)
    })

    it("emits senses.bluebubbles_in_flight_marker_expired when re-claiming over a stale marker", () => {
      const session = "x"
      const guid = "abc-123"
      beginBlueBubblesMessageInFlight(session, guid)
      vi.advanceTimersByTime(BB_IN_FLIGHT_MAX_AGE_MS + 1000)

      nervesEvents.length = 0
      beginBlueBubblesMessageInFlight(session, guid)

      const evt = nervesEvents.find((e) => e.event === "senses.bluebubbles_in_flight_marker_expired")
      expect(evt).toBeDefined()
      expect(evt?.message).toContain("expired by TTL")
      expect((evt?.meta as Record<string, unknown>)).toMatchObject({
        sessionKey: session,
        messageGuid: guid,
        ttlMs: BB_IN_FLIGHT_MAX_AGE_MS,
      })
    })

    it("does NOT emit the expired-marker event when claiming a fresh slot (no false alarms)", () => {
      const session = "x"
      const guid = "abc-123"
      beginBlueBubblesMessageInFlight(session, guid)

      const evt = nervesEvents.find((e) => e.event === "senses.bluebubbles_in_flight_marker_expired")
      expect(evt).toBeUndefined()
    })

    it("does NOT emit when claiming on top of a still-live marker (begin returns false instead)", () => {
      const session = "x"
      const guid = "abc-123"
      beginBlueBubblesMessageInFlight(session, guid)

      nervesEvents.length = 0
      const second = beginBlueBubblesMessageInFlight(session, guid)
      expect(second).toBe(false)
      expect(nervesEvents.find((e) => e.event === "senses.bluebubbles_in_flight_marker_expired")).toBeUndefined()
    })
  })

  describe("multi-session isolation", () => {
    it("separate (sessionKey, guid) pairs don't interfere", () => {
      beginBlueBubblesMessageInFlight("s1", "guid-A")
      beginBlueBubblesMessageInFlight("s2", "guid-A") // same guid, different session

      expect(isBlueBubblesMessageInFlight("s1", "guid-A")).toBe(true)
      expect(isBlueBubblesMessageInFlight("s2", "guid-A")).toBe(true)

      endBlueBubblesMessageInFlight("s1", "guid-A")
      expect(isBlueBubblesMessageInFlight("s1", "guid-A")).toBe(false)
      // s2 marker untouched.
      expect(isBlueBubblesMessageInFlight("s2", "guid-A")).toBe(true)
    })

    it("end on a non-existent marker is a safe no-op", () => {
      expect(() => endBlueBubblesMessageInFlight("nope", "nope")).not.toThrow()
    })
  })
})
