import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  recordInteraction,
  readRelationships,
  readRelationship,
  recordOutcome,
  type AgentRelationship,
} from "../../heart/agent-relationships"

describe("agent relationship store", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relationships-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("AgentRelationship interface compliance", () => {
    it("recordInteraction returns a relationship with all required fields", () => {
      const rel = recordInteraction(tmpDir, "Slugger", {
        displayName: "Slugger",
        note: "first meeting",
      })

      expect(rel.agentName).toBe("slugger") // normalized to lowercase
      expect(rel.displayName).toBe("Slugger")
      expect(rel.familiarity).toBe(1)
      expect(rel.trust).toBe("neutral")
      expect(rel.sharedMissions).toEqual([])
      expect(rel.lastInteraction).toBeTruthy()
      expect(rel.outcomes).toEqual([])
      expect(rel.notes).toEqual(["first meeting"])
    })
  })

  describe("recordInteraction", () => {
    it("creates a new relationship on first interaction", () => {
      const rel = recordInteraction(tmpDir, "Slugger", {
        displayName: "Slugger",
      })

      const filePath = path.join(tmpDir, "state", "relationships", "slugger.json")
      expect(fs.existsSync(filePath)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentRelationship
      expect(stored.agentName).toBe("slugger")
      expect(stored.familiarity).toBe(1)
    })

    it("increments familiarity on subsequent interactions", () => {
      recordInteraction(tmpDir, "slugger", { displayName: "Slugger" })
      const rel2 = recordInteraction(tmpDir, "slugger", { note: "second meeting" })

      expect(rel2.familiarity).toBe(2)
      expect(rel2.notes).toContain("second meeting")
    })

    it("normalizes agent name to lowercase", () => {
      const rel = recordInteraction(tmpDir, "SLUGGER", { displayName: "Slugger" })
      expect(rel.agentName).toBe("slugger")

      const filePath = path.join(tmpDir, "state", "relationships", "slugger.json")
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it("updates displayName if provided", () => {
      recordInteraction(tmpDir, "slugger", { displayName: "Slug" })
      const rel2 = recordInteraction(tmpDir, "slugger", { displayName: "Slugger" })
      expect(rel2.displayName).toBe("Slugger")
    })

    it("adds missionId to sharedMissions if provided", () => {
      const rel = recordInteraction(tmpDir, "slugger", {
        displayName: "Slugger",
        missionId: "mission-1",
      })
      expect(rel.sharedMissions).toContain("mission-1")
    })

    it("adds new missionId to existing relationship", () => {
      recordInteraction(tmpDir, "slugger", { missionId: "mission-1" })
      const rel = recordInteraction(tmpDir, "slugger", { missionId: "mission-2" })
      expect(rel.sharedMissions).toContain("mission-1")
      expect(rel.sharedMissions).toContain("mission-2")
      expect(rel.sharedMissions).toHaveLength(2)
    })

    it("does not duplicate missionIds in sharedMissions", () => {
      recordInteraction(tmpDir, "slugger", {
        displayName: "Slugger",
        missionId: "mission-1",
      })
      const rel2 = recordInteraction(tmpDir, "slugger", {
        missionId: "mission-1",
      })
      expect(rel2.sharedMissions.filter((m) => m === "mission-1")).toHaveLength(1)
    })

    it("records interaction without optional fields", () => {
      const rel = recordInteraction(tmpDir, "slugger", {})
      expect(rel.agentName).toBe("slugger")
      expect(rel.displayName).toBe("slugger") // defaults to normalized name
      expect(rel.notes).toEqual([])
    })

    it("creates the relationships directory if it does not exist", () => {
      const relDir = path.join(tmpDir, "state", "relationships")
      expect(fs.existsSync(relDir)).toBe(false)

      recordInteraction(tmpDir, "slugger", {})
      expect(fs.existsSync(relDir)).toBe(true)
    })
  })

  describe("readRelationships", () => {
    it("returns empty array when directory does not exist", () => {
      expect(readRelationships(tmpDir)).toEqual([])
    })

    it("returns all relationships", () => {
      recordInteraction(tmpDir, "slugger", {})
      recordInteraction(tmpDir, "copilot", {})

      const all = readRelationships(tmpDir)
      expect(all).toHaveLength(2)
    })

    it("skips malformed JSON files", () => {
      recordInteraction(tmpDir, "slugger", {})

      const relDir = path.join(tmpDir, "state", "relationships")
      fs.writeFileSync(path.join(relDir, "bad.json"), "not valid json{{{", "utf-8")

      const rels = readRelationships(tmpDir)
      expect(rels).toHaveLength(1)
    })

    it("skips non-JSON files", () => {
      recordInteraction(tmpDir, "slugger", {})

      const relDir = path.join(tmpDir, "state", "relationships")
      fs.writeFileSync(path.join(relDir, "readme.txt"), "not a relationship", "utf-8")

      const rels = readRelationships(tmpDir)
      expect(rels).toHaveLength(1)
    })
  })

  describe("readRelationship", () => {
    it("returns a single relationship by agent name", () => {
      recordInteraction(tmpDir, "slugger", { displayName: "Slugger" })

      const rel = readRelationship(tmpDir, "slugger")
      expect(rel).not.toBeNull()
      expect(rel!.agentName).toBe("slugger")
      expect(rel!.displayName).toBe("Slugger")
    })

    it("normalizes agent name for lookup", () => {
      recordInteraction(tmpDir, "slugger", {})

      const rel = readRelationship(tmpDir, "SLUGGER")
      expect(rel).not.toBeNull()
      expect(rel!.agentName).toBe("slugger")
    })

    it("returns null for unknown agent", () => {
      const rel = readRelationship(tmpDir, "unknown-agent")
      expect(rel).toBeNull()
    })

    it("returns null when directory does not exist", () => {
      const rel = readRelationship(tmpDir, "slugger")
      expect(rel).toBeNull()
    })
  })

  describe("recordOutcome", () => {
    it("adds an outcome to the relationship", () => {
      recordInteraction(tmpDir, "slugger", {})

      const rel = recordOutcome(tmpDir, "slugger", {
        missionId: "mission-1",
        result: "success",
        timestamp: new Date().toISOString(),
        note: "completed the task well",
      })

      expect(rel.outcomes).toHaveLength(1)
      expect(rel.outcomes[0].missionId).toBe("mission-1")
      expect(rel.outcomes[0].result).toBe("success")
      expect(rel.outcomes[0].note).toBe("completed the task well")
    })

    it("appends outcomes without overwriting existing ones", () => {
      recordInteraction(tmpDir, "slugger", {})
      recordOutcome(tmpDir, "slugger", {
        missionId: "mission-1",
        result: "success",
        timestamp: new Date().toISOString(),
      })
      const rel = recordOutcome(tmpDir, "slugger", {
        missionId: "mission-2",
        result: "partial",
        timestamp: new Date().toISOString(),
      })

      expect(rel.outcomes).toHaveLength(2)
    })

    it("throws when agent relationship does not exist", () => {
      expect(() =>
        recordOutcome(tmpDir, "unknown", {
          missionId: "m1",
          result: "success",
          timestamp: new Date().toISOString(),
        }),
      ).toThrow()
    })

    it("supports all result types", () => {
      recordInteraction(tmpDir, "slugger", {})

      for (const result of ["success", "partial", "failed"] as const) {
        recordOutcome(tmpDir, "slugger", {
          missionId: `mission-${result}`,
          result,
          timestamp: new Date().toISOString(),
        })
      }

      const rel = readRelationship(tmpDir, "slugger")
      expect(rel!.outcomes).toHaveLength(3)
    })
  })
})
