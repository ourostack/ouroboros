/**
 * Unit 1a: type-definition tests for the new RollupStatus / DaemonStatus
 * vocabulary plus their runtime guards. Written before the implementation
 * exists, so this file deliberately fails at import time until Unit 1b lands.
 *
 * Pinned contract:
 * - RollupStatus = "healthy" | "partial" | "degraded" | "safe-mode"
 *   What computeDaemonRollup returns. "down" is NOT a valid rollup output —
 *   the rollup function is only reachable post-inventory; "down" is owned by
 *   the daemon-entry caller path that runs before the rollup is computed.
 * - DaemonStatus  = RollupStatus | "down"
 *   What DaemonHealthState.status accepts. Caller assigns "down" outside the
 *   rollup function (pre-inventory failure path).
 */

import { describe, expect, it } from "vitest"
import {
  isRollupStatus,
  isDaemonStatus,
  type RollupStatus,
  type DaemonStatus,
} from "../../../heart/daemon/daemon-health"

describe("daemon-health rollup vocabulary", () => {
  describe("RollupStatus type", () => {
    it("accepts the four function-output literals at the type level", () => {
      // Type-level assertion: assigning each literal to a RollupStatus must compile.
      const healthy: RollupStatus = "healthy"
      const partial: RollupStatus = "partial"
      const degraded: RollupStatus = "degraded"
      const safeMode: RollupStatus = "safe-mode"

      // Use the values so the compiler can't elide them.
      expect([healthy, partial, degraded, safeMode]).toEqual([
        "healthy",
        "partial",
        "degraded",
        "safe-mode",
      ])
    })
  })

  describe("DaemonStatus type", () => {
    it("accepts the five rollup + caller-owned literals at the type level", () => {
      // Type-level assertion: assigning each literal to a DaemonStatus must compile.
      const healthy: DaemonStatus = "healthy"
      const partial: DaemonStatus = "partial"
      const degraded: DaemonStatus = "degraded"
      const safeMode: DaemonStatus = "safe-mode"
      const down: DaemonStatus = "down"

      expect([healthy, partial, degraded, safeMode, down]).toEqual([
        "healthy",
        "partial",
        "degraded",
        "safe-mode",
        "down",
      ])
    })

    it("widens RollupStatus into DaemonStatus", () => {
      // A RollupStatus value is always assignable to DaemonStatus (subset
      // relationship). This covers the caller pattern used in daemon-entry:
      // const result: DaemonStatus = computeDaemonRollup(...)
      const r: RollupStatus = "partial"
      const d: DaemonStatus = r
      expect(d).toBe("partial")
    })
  })

  describe("isRollupStatus", () => {
    it("validates each of the four rollup literals", () => {
      expect(isRollupStatus("healthy")).toBe(true)
      expect(isRollupStatus("partial")).toBe(true)
      expect(isRollupStatus("degraded")).toBe(true)
      expect(isRollupStatus("safe-mode")).toBe(true)
    })

    it("rejects 'down' — not a valid rollup output (caller-owned)", () => {
      expect(isRollupStatus("down")).toBe(false)
    })

    it("rejects junk strings", () => {
      expect(isRollupStatus("ok")).toBe(false)
      expect(isRollupStatus("running")).toBe(false)
      expect(isRollupStatus("Healthy")).toBe(false) // case-sensitive
      expect(isRollupStatus("")).toBe(false)
      expect(isRollupStatus("banana")).toBe(false)
    })

    it("rejects non-string inputs", () => {
      expect(isRollupStatus(undefined)).toBe(false)
      expect(isRollupStatus(null)).toBe(false)
      expect(isRollupStatus(0)).toBe(false)
      expect(isRollupStatus(false)).toBe(false)
      expect(isRollupStatus({ status: "healthy" })).toBe(false)
      expect(isRollupStatus(["healthy"])).toBe(false)
    })

    it("narrows the type at the call site", () => {
      const value: unknown = "partial"
      if (isRollupStatus(value)) {
        // Inside this branch, value is RollupStatus. If the guard is wrong,
        // tsc would error here. Assigning to a typed local proves narrowing.
        const narrowed: RollupStatus = value
        expect(narrowed).toBe("partial")
      } else {
        throw new Error("guard rejected a valid literal")
      }
    })
  })

  describe("isDaemonStatus", () => {
    it("validates each of the five daemon-status literals", () => {
      expect(isDaemonStatus("healthy")).toBe(true)
      expect(isDaemonStatus("partial")).toBe(true)
      expect(isDaemonStatus("degraded")).toBe(true)
      expect(isDaemonStatus("safe-mode")).toBe(true)
      expect(isDaemonStatus("down")).toBe(true)
    })

    it("rejects junk strings", () => {
      expect(isDaemonStatus("ok")).toBe(false)
      expect(isDaemonStatus("running")).toBe(false)
      expect(isDaemonStatus("stopping")).toBe(false)
      expect(isDaemonStatus("Down")).toBe(false) // case-sensitive
      expect(isDaemonStatus("")).toBe(false)
      expect(isDaemonStatus("banana")).toBe(false)
    })

    it("rejects non-string inputs", () => {
      expect(isDaemonStatus(undefined)).toBe(false)
      expect(isDaemonStatus(null)).toBe(false)
      expect(isDaemonStatus(0)).toBe(false)
      expect(isDaemonStatus(false)).toBe(false)
      expect(isDaemonStatus({ status: "down" })).toBe(false)
      expect(isDaemonStatus(["down"])).toBe(false)
    })

    it("narrows the type at the call site", () => {
      const value: unknown = "down"
      if (isDaemonStatus(value)) {
        const narrowed: DaemonStatus = value
        expect(narrowed).toBe("down")
      } else {
        throw new Error("guard rejected a valid literal")
      }
    })
  })
})
