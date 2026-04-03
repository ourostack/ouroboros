import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  createObligation,
  enrichObligation,
  type Obligation,
  type ObligationMeaning,
  type WaitingOnRef,
} from "../../heart/obligations"

describe("obligation enrichment", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-enrichment-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const sampleOrigin = { friendId: "friend-1", channel: "cli", key: "session" }

  describe("ObligationMeaning interface", () => {
    it("enrichObligation adds meaning to existing obligation", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "research architecture options",
      })

      const waitingOn: WaitingOnRef = {
        kind: "friend",
        target: "ari",
        detail: "PR review from Ari",
      }

      const meaning: ObligationMeaning = {
        salience: "high",
        careReason: "this affects the core harness stability",
        waitingOn,
        stalenessClass: "fresh",
        lastMeaningfulChangeAt: "2026-04-01T10:00:00.000Z",
        resumeHint: "start by reading the PR comments",
      }

      const enriched = enrichObligation(tmpDir, ob.id, meaning)

      expect(enriched.meaning).toBeDefined()
      expect(enriched.meaning!.salience).toBe("high")
      expect(enriched.meaning!.careReason).toBe("this affects the core harness stability")
      expect(enriched.meaning!.waitingOn).toEqual(waitingOn)
      expect(enriched.meaning!.stalenessClass).toBe("fresh")
      expect(enriched.meaning!.lastMeaningfulChangeAt).toBe("2026-04-01T10:00:00.000Z")
      expect(enriched.meaning!.resumeHint).toBe("start by reading the PR comments")
    })

    it("meaning fields allow optional properties to be omitted", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "test meaning fields",
      })

      const meaning: ObligationMeaning = {
        salience: "medium",
        stalenessClass: "warm",
      }

      const enriched = enrichObligation(tmpDir, ob.id, meaning)
      expect(enriched.meaning!.salience).toBe("medium")
      expect(enriched.meaning!.stalenessClass).toBe("warm")
      expect(enriched.meaning!.careReason).toBeUndefined()
      expect(enriched.meaning!.waitingOn).toBeUndefined()
      expect(enriched.meaning!.resumeHint).toBeUndefined()
      expect(enriched.meaning!.lastMeaningfulChangeAt).toBeUndefined()
    })

    it("waitingOn can be explicitly null", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "test null waitingOn",
      })

      const meaning: ObligationMeaning = {
        salience: "low",
        waitingOn: null,
        stalenessClass: "fresh",
      }

      const enriched = enrichObligation(tmpDir, ob.id, meaning)
      expect(enriched.meaning!.waitingOn).toBeNull()
    })

    it("salience is an enum string, not a number", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "test salience enum",
      })

      for (const salience of ["low", "medium", "high", "critical"] as const) {
        const enriched = enrichObligation(tmpDir, ob.id, {
          salience,
          stalenessClass: "fresh",
        })
        expect(enriched.meaning!.salience).toBe(salience)
        expect(typeof enriched.meaning!.salience).toBe("string")
      }
    })
  })

  describe("backward compatibility", () => {
    it("existing obligations without meaning parse correctly", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "plain obligation",
      })

      // Read the obligation back - should have no meaning field
      const filePath = path.join(tmpDir, "arc", "obligations", `${ob.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Obligation
      expect(stored.meaning).toBeUndefined()
      expect(stored.content).toBe("plain obligation")
    })
  })

  describe("enrichObligation", () => {
    it("persists meaning to disk", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "test persistence",
      })

      const meaning: ObligationMeaning = {
        salience: "high",
        stalenessClass: "stale",
        resumeHint: "check if blocker is resolved",
      }

      enrichObligation(tmpDir, ob.id, meaning)

      const filePath = path.join(tmpDir, "arc", "obligations", `${ob.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Obligation
      expect(stored.meaning).toBeDefined()
      expect(stored.meaning!.salience).toBe("high")
      expect(stored.meaning!.stalenessClass).toBe("stale")
      expect(stored.meaning!.resumeHint).toBe("check if blocker is resolved")
    })

    it("preserves original obligation fields", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "preserve fields test",
      })

      enrichObligation(tmpDir, ob.id, {
        salience: "critical",
        stalenessClass: "cold",
      })

      const filePath = path.join(tmpDir, "arc", "obligations", `${ob.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Obligation
      expect(stored.id).toBe(ob.id)
      expect(stored.content).toBe("preserve fields test")
      expect(stored.origin).toEqual(sampleOrigin)
      expect(stored.status).toBe("pending")
    })

    it("throws when obligation does not exist", () => {
      expect(() =>
        enrichObligation(tmpDir, "nonexistent-id", {
          salience: "medium",
          stalenessClass: "fresh",
        }),
      ).toThrow("Obligation not found: nonexistent-id")
    })

    it("overwrites previous meaning on re-enrichment", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "re-enrich test",
      })

      enrichObligation(tmpDir, ob.id, {
        salience: "low",
        stalenessClass: "fresh",
      })

      const updated = enrichObligation(tmpDir, ob.id, {
        salience: "critical",
        stalenessClass: "stale",
        careReason: "escalated priority",
      })

      expect(updated.meaning!.salience).toBe("critical")
      expect(updated.meaning!.stalenessClass).toBe("stale")
      expect(updated.meaning!.careReason).toBe("escalated priority")
    })

    it("supports all stalenessClass values", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "staleness test",
      })

      for (const stalenessClass of ["fresh", "warm", "stale", "cold", "at-risk"] as const) {
        const enriched = enrichObligation(tmpDir, ob.id, {
          salience: "medium",
          stalenessClass,
        })
        expect(enriched.meaning!.stalenessClass).toBe(stalenessClass)
      }
    })

    it("supports structured WaitingOnRef with all kind values", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "waitingOn test",
      })

      for (const kind of ["friend", "agent", "coding", "merge", "runtime", "time", "none"] as const) {
        const enriched = enrichObligation(tmpDir, ob.id, {
          salience: "medium",
          stalenessClass: "fresh",
          waitingOn: { kind, target: "test-target", detail: `waiting on ${kind}` },
        })
        expect(enriched.meaning!.waitingOn).toEqual({
          kind,
          target: "test-target",
          detail: `waiting on ${kind}`,
        })
      }
    })

    it("updates updatedAt timestamp on enrichment", () => {
      const ob = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "timestamp test",
      })

      const enriched = enrichObligation(tmpDir, ob.id, {
        salience: "low",
        stalenessClass: "fresh",
      })

      expect(enriched.updatedAt).toBeDefined()
      expect(new Date(enriched.updatedAt!).getTime()).toBeGreaterThan(0)
    })
  })
})
