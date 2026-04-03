import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  createCare,
  readCares,
  readActiveCares,
  updateCare,
  resolveCare,
  type CareRecord,
} from "../../heart/cares"

describe("care store", () => {
  let tmpDir: string

  const baseCareInput = {
    label: "harness reliability",
    why: "agents need to trust their tools",
    kind: "project" as const,
    status: "active" as const,
    salience: "high" as const,
    steward: "mine" as const,
    relatedFriendIds: [] as string[],
    relatedAgentIds: [] as string[],
    relatedObligationIds: [] as string[],
    relatedEpisodeIds: [] as string[],
    currentRisk: null,
    nextCheckAt: null,
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cares-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("CareRecord interface compliance", () => {
    it("createCare returns a record with all required fields", () => {
      const care = createCare(tmpDir, {
        ...baseCareInput,
        relatedFriendIds: ["friend-1"],
        relatedObligationIds: ["ob-123"],
      })

      expect(care.id).toBeTruthy()
      expect(typeof care.id).toBe("string")
      expect(care.label).toBe("harness reliability")
      expect(care.why).toBe("agents need to trust their tools")
      expect(care.kind).toBe("project")
      expect(care.status).toBe("active")
      expect(care.salience).toBe("high")
      expect(care.steward).toBe("mine")
      expect(care.relatedFriendIds).toEqual(["friend-1"])
      expect(care.relatedAgentIds).toEqual([])
      expect(care.relatedObligationIds).toEqual(["ob-123"])
      expect(care.relatedEpisodeIds).toEqual([])
      expect(care.currentRisk).toBeNull()
      expect(care.nextCheckAt).toBeNull()
      expect(care.createdAt).toBeTruthy()
      expect(care.updatedAt).toBeTruthy()
      expect(care.resolvedAt).toBeUndefined()
    })
  })

  describe("createCare", () => {
    it("writes a JSON file under state/cares/", () => {
      const care = createCare(tmpDir, baseCareInput)

      const filePath = path.join(tmpDir, "state", "cares", `${care.id}.json`)
      expect(fs.existsSync(filePath)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expect(stored.id).toBe(care.id)
      expect(stored.label).toBe("harness reliability")
    })

    it("generates unique IDs", () => {
      const c1 = createCare(tmpDir, baseCareInput)
      const c2 = createCare(tmpDir, { ...baseCareInput, label: "second" })
      expect(c1.id).not.toBe(c2.id)
    })

    it("creates the cares directory if it does not exist", () => {
      const caresDir = path.join(tmpDir, "state", "cares")
      expect(fs.existsSync(caresDir)).toBe(false)

      createCare(tmpDir, baseCareInput)

      expect(fs.existsSync(caresDir)).toBe(true)
    })

    it("supports all CareKind types", () => {
      for (const kind of ["person", "agent", "project", "mission", "system"] as const) {
        const care = createCare(tmpDir, { ...baseCareInput, kind })
        expect(care.kind).toBe(kind)
      }
    })

    it("supports all steward types", () => {
      for (const steward of ["mine", "shared", "delegated"] as const) {
        const care = createCare(tmpDir, { ...baseCareInput, steward })
        expect(care.steward).toBe(steward)
      }
    })

    it("supports all status types on creation", () => {
      for (const status of ["active", "watching", "resolved", "dormant"] as const) {
        const care = createCare(tmpDir, { ...baseCareInput, status })
        expect(care.status).toBe(status)
      }
    })

    it("supports all salience levels", () => {
      for (const salience of ["low", "medium", "high", "critical"] as const) {
        const care = createCare(tmpDir, { ...baseCareInput, salience })
        expect(care.salience).toBe(salience)
      }
    })

    it("preserves currentRisk and nextCheckAt when set", () => {
      const care = createCare(tmpDir, {
        ...baseCareInput,
        currentRisk: "deployment may break overnight",
        nextCheckAt: "2026-04-03T09:00:00.000Z",
      })
      expect(care.currentRisk).toBe("deployment may break overnight")
      expect(care.nextCheckAt).toBe("2026-04-03T09:00:00.000Z")
    })
  })

  describe("readCares", () => {
    it("returns empty array when directory does not exist", () => {
      expect(readCares(tmpDir)).toEqual([])
    })

    it("returns all cares", () => {
      createCare(tmpDir, baseCareInput)
      createCare(tmpDir, { ...baseCareInput, label: "second", status: "resolved" })

      const all = readCares(tmpDir)
      expect(all).toHaveLength(2)
    })

    it("skips malformed JSON files", () => {
      createCare(tmpDir, baseCareInput)

      const caresDir = path.join(tmpDir, "state", "cares")
      fs.writeFileSync(path.join(caresDir, "bad.json"), "not valid json{{{", "utf-8")

      const cares = readCares(tmpDir)
      expect(cares).toHaveLength(1)
    })

    it("skips non-JSON files", () => {
      createCare(tmpDir, baseCareInput)

      const caresDir = path.join(tmpDir, "state", "cares")
      fs.writeFileSync(path.join(caresDir, "readme.txt"), "not a care", "utf-8")

      const cares = readCares(tmpDir)
      expect(cares).toHaveLength(1)
    })
  })

  describe("readActiveCares", () => {
    it("returns only active and watching cares", () => {
      createCare(tmpDir, { ...baseCareInput, label: "active one", status: "active" })
      createCare(tmpDir, { ...baseCareInput, label: "watching one", status: "watching" })
      createCare(tmpDir, { ...baseCareInput, label: "resolved one", status: "resolved" })
      createCare(tmpDir, { ...baseCareInput, label: "dormant one", status: "dormant" })

      const active = readActiveCares(tmpDir)
      expect(active).toHaveLength(2)
      expect(active.every((c) => c.status === "active" || c.status === "watching")).toBe(true)
    })

    it("returns empty array when no cares exist", () => {
      expect(readActiveCares(tmpDir)).toEqual([])
    })
  })

  describe("updateCare", () => {
    it("updates fields and preserves unchanged ones", () => {
      const care = createCare(tmpDir, baseCareInput)

      const updated = updateCare(tmpDir, care.id, {
        label: "updated label",
        salience: "critical",
      })

      expect(updated.label).toBe("updated label")
      expect(updated.salience).toBe("critical")
      expect(updated.why).toBe("agents need to trust their tools")
      expect(updated.updatedAt).toBeTruthy()
      expect(updated.createdAt).toBe(care.createdAt)
    })

    it("persists changes to disk", () => {
      const care = createCare(tmpDir, baseCareInput)

      updateCare(tmpDir, care.id, { label: "updated" })

      const filePath = path.join(tmpDir, "state", "cares", `${care.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expect(stored.label).toBe("updated")
    })

    it("throws when care does not exist", () => {
      expect(() => updateCare(tmpDir, "nonexistent-id", { label: "nope" })).toThrow()
    })
  })

  describe("resolveCare", () => {
    it("sets status to resolved and adds resolvedAt", () => {
      const care = createCare(tmpDir, baseCareInput)

      const resolved = resolveCare(tmpDir, care.id)
      expect(resolved.status).toBe("resolved")
      expect(resolved.resolvedAt).toBeTruthy()
      expect(resolved.updatedAt).toBeTruthy()
      expect(resolved.createdAt).toBe(care.createdAt)
    })

    it("persists resolution to disk", () => {
      const care = createCare(tmpDir, baseCareInput)

      resolveCare(tmpDir, care.id)

      const filePath = path.join(tmpDir, "state", "cares", `${care.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expect(stored.status).toBe("resolved")
      expect(stored.resolvedAt).toBeTruthy()
    })

    it("throws when care does not exist", () => {
      expect(() => resolveCare(tmpDir, "nonexistent-id")).toThrow()
    })
  })

  describe("backward compatibility", () => {
    it("handles care files from disk with missing optional fields", () => {
      const caresDir = path.join(tmpDir, "state", "cares")
      fs.mkdirSync(caresDir, { recursive: true })

      // Minimal care file (as might exist from older version)
      const minimalCare = {
        id: "minimal-1",
        label: "minimal care",
        why: "test",
        kind: "project",
        status: "active",
        salience: "medium",
        steward: "mine",
        relatedFriendIds: [],
        relatedAgentIds: [],
        relatedObligationIds: [],
        relatedEpisodeIds: [],
        currentRisk: null,
        nextCheckAt: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }
      fs.writeFileSync(
        path.join(caresDir, "minimal-1.json"),
        JSON.stringify(minimalCare, null, 2),
        "utf-8",
      )

      const cares = readCares(tmpDir)
      expect(cares).toHaveLength(1)
      expect(cares[0].label).toBe("minimal care")
    })
  })
})
