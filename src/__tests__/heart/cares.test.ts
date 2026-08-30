import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import Database from "better-sqlite3"
import {
  createCare,
  readCares,
  readActiveCares,
  updateCare,
  resolveCare,
  bindCareIncident,
  resolveCareIncident,
  upsertCareForIncident,
  type CareRecord,
} from "../../arc/cares"
import { expectCappedAgentContent, makeOversizedAgentContent } from "../helpers/content-cap"

describe("care store", () => {
  let tmpDir: string

  function createMutationLease(pid?: number): string {
    const lockPath = path.join(tmpDir, "arc", "cares", ".mutation.turn.lock")
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const database = new Database(lockPath)
    database.exec(`
      CREATE TABLE session_turn_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        pid INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        owner_token TEXT NOT NULL
      )
    `)
    if (pid !== undefined) {
      database.prepare("INSERT INTO session_turn_lease (singleton, pid, owner_id, owner_token) VALUES (1, ?, ?, ?)")
        .run(pid, "test-owner", "test-token")
    }
    database.close()
    return lockPath
  }

  function mutationLeaseCount(lockPath: string): number {
    const database = new Database(lockPath)
    try {
      return (database.prepare("SELECT COUNT(*) AS count FROM session_turn_lease").get() as { count: number }).count
    } finally {
      database.close()
    }
  }

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
    it("writes a JSON file under arc/cares/", () => {
      const care = createCare(tmpDir, baseCareInput)

      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
      expect(fs.existsSync(filePath)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expect(stored.id).toBe(care.id)
      expect(stored.label).toBe("harness reliability")
    })

    it("caps oversized agent-authored care fields before writing JSON", () => {
      const oversized = makeOversizedAgentContent("care reason ")
      const care = createCare(tmpDir, {
        ...baseCareInput,
        label: oversized,
        why: oversized,
        currentRisk: oversized,
      })

      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expectCappedAgentContent(stored.label, oversized)
      expectCappedAgentContent(stored.why, oversized)
      expectCappedAgentContent(stored.currentRisk ?? "", oversized)
    })

    it("generates unique IDs", () => {
      const c1 = createCare(tmpDir, baseCareInput)
      const c2 = createCare(tmpDir, { ...baseCareInput, label: "second" })
      expect(c1.id).not.toBe(c2.id)
    })

    it("creates the cares directory if it does not exist", () => {
      const caresDir = path.join(tmpDir, "arc", "cares")
      expect(fs.existsSync(caresDir)).toBe(false)

      createCare(tmpDir, baseCareInput)

      expect(fs.existsSync(caresDir)).toBe(true)
    })

    it("claims an ownerless canonical mutation lease", () => {
      const lockPath = createMutationLease()

      const care = createCare(tmpDir, baseCareInput)

      expect(care.label).toBe("harness reliability")
      expect(mutationLeaseCount(lockPath)).toBe(0)
    })

    it("recovers a canonical mutation lease owned by a dead process", () => {
      const lockPath = createMutationLease(2_147_483_647)

      expect(createCare(tmpDir, baseCareInput).label).toBe("harness reliability")
      expect(mutationLeaseCount(lockPath)).toBe(0)
    })

    it("fails closed while another live process owns the canonical mutation lease", () => {
      createMutationLease(process.pid)

      expect(() => createCare(tmpDir, baseCareInput)).toThrow(/busy/u)
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

      const caresDir = path.join(tmpDir, "arc", "cares")
      fs.writeFileSync(path.join(caresDir, "bad.json"), "not valid json{{{", "utf-8")

      const cares = readCares(tmpDir)
      expect(cares).toHaveLength(1)
    })

    it("skips non-JSON files", () => {
      createCare(tmpDir, baseCareInput)

      const caresDir = path.join(tmpDir, "arc", "cares")
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

      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expect(stored.label).toBe("updated")
    })

    it("caps oversized agent-authored update fields before writing JSON", () => {
      const care = createCare(tmpDir, baseCareInput)
      const oversized = makeOversizedAgentContent("updated care ")

      updateCare(tmpDir, care.id, {
        label: oversized,
        why: oversized,
        currentRisk: oversized,
      })

      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expectCappedAgentContent(stored.label, oversized)
      expectCappedAgentContent(stored.why, oversized)
      expectCappedAgentContent(stored.currentRisk ?? "", oversized)
    })

    it("preserves the existing label when capping an oversized why-only update", () => {
      const care = createCare(tmpDir, baseCareInput)
      const oversized = makeOversizedAgentContent("updated care why ")

      updateCare(tmpDir, care.id, { why: oversized })

      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CareRecord
      expect(stored.label).toBe("harness reliability")
      expectCappedAgentContent(stored.why, oversized)
    })

    it("throws when care does not exist", () => {
      expect(() => updateCare(tmpDir, "nonexistent-id", { label: "nope" })).toThrow()
    })

    it("repairs an invalid legacy updatedAt while updating", () => {
      const care = createCare(tmpDir, baseCareInput)
      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
      fs.writeFileSync(filePath, JSON.stringify({ ...care, updatedAt: "invalid" }))
      expect(updateCare(tmpDir, care.id, { label: "repaired" }).updatedAt).toMatch(/^\d{4}-/u)
    })
  })

  describe("incident bindings", () => {
    it("binds several incidents to one care and resolves them independently", () => {
      const care = createCare(tmpDir, baseCareInput)
      const first = bindCareIncident(tmpDir, care.id, {
        source: "sanctuary-health", incidentKey: "container:jellyfin", classifiedRevision: "rev-1", correlationKey: "media-stack",
      }, { expectedUpdatedAt: care.updatedAt })
      const second = bindCareIncident(tmpDir, care.id, {
        source: "sanctuary-health", incidentKey: "container:sonarr", classifiedRevision: "rev-2", correlationKey: "media-stack",
      }, { expectedUpdatedAt: first.updatedAt })
      const partial = resolveCareIncident(tmpDir, care.id, {
        source: "sanctuary-health", incidentKey: "container:jellyfin", expectedUpdatedAt: second.updatedAt,
      })

      expect(partial.status).toBe("active")
      expect(partial.incidentBindings).toHaveLength(2)
      expect(partial.incidentBindings?.find((binding) => binding.incidentKey === "container:jellyfin")?.resolvedAt).toBeTruthy()
      expect(partial.incidentBindings?.find((binding) => binding.incidentKey === "container:sonarr")?.resolvedAt).toBeUndefined()
      expect(() => bindCareIncident(tmpDir, care.id, {
        source: "sanctuary-health", incidentKey: "container:lidarr", classifiedRevision: "rev-3",
      }, { expectedUpdatedAt: care.updatedAt })).toThrow(/CAS/u)
    })

    it("upserts a later revision of the same incident without duplicating its binding", () => {
      const care = createCare(tmpDir, baseCareInput)
      const first = bindCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1" }, { expectedUpdatedAt: care.updatedAt })
      const second = bindCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-2" }, { expectedUpdatedAt: first.updatedAt })
      expect(second.incidentBindings).toEqual([{ source: "guard", incidentKey: "usenet", classifiedRevision: "rev-2" }])
    })

    it("returns an exact repeated incident binding without advancing its CAS version", () => {
      const care = createCare(tmpDir, baseCareInput)
      const binding = { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1" }
      const first = bindCareIncident(tmpDir, care.id, binding, { expectedUpdatedAt: care.updatedAt })
      expect(bindCareIncident(tmpDir, care.id, binding, { expectedUpdatedAt: first.updatedAt })).toEqual(first)
    })

    it("creates and binds one care idempotently by canonical incident identity", () => {
      const input = { ...baseCareInput, incident: { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1" } }
      const first = upsertCareForIncident(tmpDir, input)
      const duplicate = upsertCareForIncident(tmpDir, { ...input, label: "duplicate must not be created" })
      expect(duplicate.id).toBe(first.id)
      expect(readCares(tmpDir)).toHaveLength(1)
    })

    it("CAS-upserts a later incident revision with current risk and next check", () => {
      const first = upsertCareForIncident(tmpDir, {
        ...baseCareInput,
        currentRisk: "downloads are stalled",
        nextCheckAt: "2026-08-29T20:00:00.000Z",
        incident: { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1" },
      })
      const updated = upsertCareForIncident(tmpDir, {
        ...baseCareInput,
        currentRisk: "credit is being wasted",
        nextCheckAt: "2026-08-29T20:15:00.000Z",
        incident: { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-2" },
        expectedUpdatedAt: first.updatedAt,
      })

      expect(updated.id).toBe(first.id)
      expect(updated.currentRisk).toBe("credit is being wasted")
      expect(updated.nextCheckAt).toBe("2026-08-29T20:15:00.000Z")
      expect(updated.incidentBindings).toEqual([{ source: "guard", incidentKey: "usenet", classifiedRevision: "rev-2" }])
      const cleared = upsertCareForIncident(tmpDir, {
        ...baseCareInput,
        currentRisk: null,
        nextCheckAt: null,
        incident: { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-clear" },
        expectedUpdatedAt: updated.updatedAt,
      })
      expect(cleared.currentRisk).toBeNull()
      expect(() => upsertCareForIncident(tmpDir, {
        ...baseCareInput,
        incident: { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-3" },
        expectedUpdatedAt: first.updatedAt,
      })).toThrow(/CAS/u)
    })

    it("validates incident identity and resolution CAS", () => {
      const care = createCare(tmpDir, baseCareInput)
      expect(() => bindCareIncident(tmpDir, care.id, { source: "", incidentKey: "usenet", classifiedRevision: "rev-1" }, { expectedUpdatedAt: care.updatedAt })).toThrow(/invalid/u)
      expect(() => resolveCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "missing", expectedUpdatedAt: care.updatedAt })).toThrow(/not found/u)
      expect(() => resolveCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "missing", expectedUpdatedAt: "stale" })).toThrow(/CAS/u)
    })

    it("preserves optional resolved metadata and makes repeated resolution idempotent", () => {
      const care = createCare(tmpDir, baseCareInput)
      const bound = bindCareIncident(tmpDir, care.id, {
        source: "guard",
        incidentKey: "usenet",
        classifiedRevision: "rev-1",
        resolvedAt: "2026-08-29T12:00:00.000Z",
      }, { expectedUpdatedAt: care.updatedAt })
      const repeated = resolveCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "usenet", expectedUpdatedAt: bound.updatedAt })
      expect(repeated).toEqual(bound)
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

      const filePath = path.join(tmpDir, "arc", "cares", `${care.id}.json`)
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
      const caresDir = path.join(tmpDir, "arc", "cares")
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
