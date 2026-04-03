import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  captureIntention,
  readOpenIntentions,
  resolveIntention,
  dismissIntention,
  type IntentionRecord,
} from "../../heart/intentions"

describe("intentions store", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "intentions-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("IntentionRecord interface compliance", () => {
    it("captureIntention returns a record with all required fields", () => {
      const intention = captureIntention(tmpDir, {
        content: "look into the context kernel optimization",
        salience: "medium",
        source: "thought",
      })

      expect(intention.id).toBeTruthy()
      expect(typeof intention.id).toBe("string")
      expect(intention.content).toBe("look into the context kernel optimization")
      expect(intention.status).toBe("open")
      expect(intention.salience).toBe("medium")
      expect(intention.source).toBe("thought")
      expect(intention.createdAt).toBeTruthy()
      expect(intention.updatedAt).toBeTruthy()
    })

    it("supports optional relation fields", () => {
      const intention = captureIntention(tmpDir, {
        content: "follow up on Ari's request",
        source: "tool",
        relatedFriendId: "friend-ari",
        relatedObligationId: "ob-123",
        relatedCareId: "care-456",
        nudgeAfter: "2026-04-03T10:00:00.000Z",
      })

      expect(intention.relatedFriendId).toBe("friend-ari")
      expect(intention.relatedObligationId).toBe("ob-123")
      expect(intention.relatedCareId).toBe("care-456")
      expect(intention.nudgeAfter).toBe("2026-04-03T10:00:00.000Z")
    })

    it("defaults salience to undefined when not provided", () => {
      const intention = captureIntention(tmpDir, {
        content: "quick thought",
        source: "thought",
      })
      expect(intention.salience).toBeUndefined()
    })
  })

  describe("captureIntention", () => {
    it("writes JSON to state/intentions/ directory", () => {
      const intention = captureIntention(tmpDir, {
        content: "test writing",
        source: "tool",
      })

      const filePath = path.join(tmpDir, "state", "intentions", `${intention.id}.json`)
      expect(fs.existsSync(filePath)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as IntentionRecord
      expect(stored.id).toBe(intention.id)
      expect(stored.content).toBe("test writing")
    })

    it("generates unique IDs", () => {
      const i1 = captureIntention(tmpDir, { content: "first", source: "thought" })
      const i2 = captureIntention(tmpDir, { content: "second", source: "thought" })
      expect(i1.id).not.toBe(i2.id)
    })

    it("creates the intentions directory if it does not exist", () => {
      const dir = path.join(tmpDir, "state", "intentions")
      expect(fs.existsSync(dir)).toBe(false)

      captureIntention(tmpDir, { content: "test", source: "thought" })
      expect(fs.existsSync(dir)).toBe(true)
    })

    it("supports all source types", () => {
      for (const source of ["thought", "tool", "coding", "reflection"] as const) {
        const intention = captureIntention(tmpDir, {
          content: `from ${source}`,
          source,
        })
        expect(intention.source).toBe(source)
      }
    })
  })

  describe("readOpenIntentions", () => {
    it("returns empty array when directory does not exist", () => {
      expect(readOpenIntentions(tmpDir)).toEqual([])
    })

    it("returns only open intentions", () => {
      captureIntention(tmpDir, { content: "open one", source: "thought" })
      captureIntention(tmpDir, { content: "open two", source: "thought" })
      const toResolve = captureIntention(tmpDir, { content: "to resolve", source: "thought" })
      resolveIntention(tmpDir, toResolve.id)

      const open = readOpenIntentions(tmpDir)
      expect(open).toHaveLength(2)
      expect(open.every((i) => i.status === "open")).toBe(true)
    })

    it("sorts by salience descending then createdAt descending", () => {
      const low = captureIntention(tmpDir, {
        content: "low priority",
        salience: "low",
        source: "thought",
      })
      const high = captureIntention(tmpDir, {
        content: "high priority",
        salience: "high",
        source: "thought",
      })
      const medium = captureIntention(tmpDir, {
        content: "medium priority",
        salience: "medium",
        source: "thought",
      })

      const open = readOpenIntentions(tmpDir)
      expect(open[0].id).toBe(high.id)
      expect(open[1].id).toBe(medium.id)
      expect(open[2].id).toBe(low.id)
    })

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        captureIntention(tmpDir, { content: `intention ${i}`, source: "thought" })
      }

      const limited = readOpenIntentions(tmpDir, { limit: 3 })
      expect(limited).toHaveLength(3)
    })

    it("defaults to limit of 20", () => {
      for (let i = 0; i < 25; i++) {
        captureIntention(tmpDir, { content: `intention ${i}`, source: "thought" })
      }

      const intentions = readOpenIntentions(tmpDir)
      expect(intentions).toHaveLength(20)
    })

    it("respects nudgeAfter field", () => {
      const intention = captureIntention(tmpDir, {
        content: "nudge me later",
        source: "thought",
        nudgeAfter: "2026-04-03T10:00:00.000Z",
      })

      const open = readOpenIntentions(tmpDir)
      const found = open.find((i) => i.id === intention.id)
      expect(found).toBeDefined()
      expect(found!.nudgeAfter).toBe("2026-04-03T10:00:00.000Z")
    })

    it("skips malformed JSON files", () => {
      captureIntention(tmpDir, { content: "valid", source: "thought" })

      const dir = path.join(tmpDir, "state", "intentions")
      fs.writeFileSync(path.join(dir, "bad.json"), "not valid{{{", "utf-8")

      const intentions = readOpenIntentions(tmpDir)
      expect(intentions).toHaveLength(1)
    })

    it("skips non-JSON files", () => {
      captureIntention(tmpDir, { content: "valid", source: "thought" })

      const dir = path.join(tmpDir, "state", "intentions")
      fs.writeFileSync(path.join(dir, "readme.txt"), "not an intention", "utf-8")

      const intentions = readOpenIntentions(tmpDir)
      expect(intentions).toHaveLength(1)
    })

    it("sorts intentions without salience after those with salience", () => {
      const withSalience = captureIntention(tmpDir, {
        content: "has salience",
        salience: "low",
        source: "thought",
      })
      const noSalience = captureIntention(tmpDir, {
        content: "no salience",
        source: "thought",
      })

      const open = readOpenIntentions(tmpDir)
      expect(open[0].id).toBe(withSalience.id)
      expect(open[1].id).toBe(noSalience.id)
    })

    it("handles unknown salience values gracefully (ranks as 0)", () => {
      const normal = captureIntention(tmpDir, {
        content: "normal salience",
        salience: "low",
        source: "thought",
      })
      const weird = captureIntention(tmpDir, {
        content: "unknown salience",
        source: "thought",
      })

      // Manually write an unrecognized salience value to disk
      const dir = path.join(tmpDir, "state", "intentions")
      const filePath = path.join(dir, `${weird.id}.json`)
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as IntentionRecord
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing backward-compat with unknown salience
      ;(data as any).salience = "unknown-value"
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")

      const open = readOpenIntentions(tmpDir)
      expect(open).toHaveLength(2)
      // Normal "low" salience (rank 1) should sort before unknown (rank 0)
      expect(open[0].id).toBe(normal.id)
    })
  })

  describe("resolveIntention", () => {
    it("sets status to done", () => {
      const intention = captureIntention(tmpDir, {
        content: "to resolve",
        source: "thought",
      })

      const resolved = resolveIntention(tmpDir, intention.id)
      expect(resolved.status).toBe("done")
      expect(resolved.updatedAt).toBeTruthy()
    })

    it("persists to disk", () => {
      const intention = captureIntention(tmpDir, {
        content: "to resolve",
        source: "thought",
      })

      resolveIntention(tmpDir, intention.id)

      const filePath = path.join(tmpDir, "state", "intentions", `${intention.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as IntentionRecord
      expect(stored.status).toBe("done")
    })

    it("throws when intention does not exist", () => {
      expect(() => resolveIntention(tmpDir, "nonexistent")).toThrow()
    })
  })

  describe("dismissIntention", () => {
    it("sets status to dismissed", () => {
      const intention = captureIntention(tmpDir, {
        content: "to dismiss",
        source: "thought",
      })

      const dismissed = dismissIntention(tmpDir, intention.id)
      expect(dismissed.status).toBe("dismissed")
      expect(dismissed.updatedAt).toBeTruthy()
    })

    it("persists to disk", () => {
      const intention = captureIntention(tmpDir, {
        content: "to dismiss",
        source: "thought",
      })

      dismissIntention(tmpDir, intention.id)

      const filePath = path.join(tmpDir, "state", "intentions", `${intention.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as IntentionRecord
      expect(stored.status).toBe("dismissed")
    })

    it("throws when intention does not exist", () => {
      expect(() => dismissIntention(tmpDir, "nonexistent")).toThrow()
    })
  })
})
