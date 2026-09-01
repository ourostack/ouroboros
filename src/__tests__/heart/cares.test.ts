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
  projectCareEvidence,
  CARE_INCIDENT_RECOVERY_REVIEW_RISK,
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

    it("applies canonical defaults when a new incident has no display or policy metadata", () => {
      const care = upsertCareForIncident(tmpDir, {
        relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [],
        incident: { source: "guard", incidentKey: "minimal", classifiedRevision: "rev-1" },
      })
      expect(care).toMatchObject({
        label: "untitled", why: "", kind: "system", status: "active", salience: "medium", steward: "mine", currentRisk: null, nextCheckAt: null,
      })
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

    it("atomically resolves an incident and replaces stale display prose under the same CAS", () => {
      const created = createCare(tmpDir, { ...baseCareInput, kind: "system", label: "Docker at 100%", why: "writes fail", currentRisk: "full", nextCheckAt: "2020-01-01T00:00:00.000Z" })
      const bound = bindCareIncident(tmpDir, created.id, { source: "sanctuary-health::Docker_critical_image_disk_utilization", incidentKey: "docker-image-disk-100pct-20260831T1427Z", classifiedRevision: "a".repeat(64) }, { expectedUpdatedAt: created.updatedAt })
      expect(() => resolveCareIncident(tmpDir, created.id, {
        source: "sanctuary-health::Docker_critical_image_disk_utilization", incidentKey: "docker-image-disk-100pct-20260831T1427Z", expectedUpdatedAt: created.updatedAt,
        display: { label: "Docker image disk utilization", why: "Verified from current Unraid notifications.", currentRisk: null, nextCheckAt: null },
      })).toThrow(/CAS/u)
      expect(readCares(tmpDir).find((care) => care.id === created.id)).toEqual(bound)
      const resolved = resolveCareIncident(tmpDir, created.id, {
        source: "sanctuary-health::Docker_critical_image_disk_utilization",
        incidentKey: "docker-image-disk-100pct-20260831T1427Z",
        expectedUpdatedAt: bound.updatedAt,
        display: { label: "Docker image disk utilization", why: "Verified from current Unraid notifications.", currentRisk: null, nextCheckAt: null },
      })
      expect(resolved).toMatchObject({ label: "Docker image disk utilization", why: "Verified from current Unraid notifications.", currentRisk: null, nextCheckAt: null })
      expect(resolved.status).toBe("resolved")
      expect(resolved.incidentBindings?.[0]?.resolvedAt).toBeTruthy()
    })

    it("refreshes existing incident display and status through upsert under CAS", () => {
      const first = upsertCareForIncident(tmpDir, { ...baseCareInput, kind: "system", incident: { source: "guard", incidentKey: "docker", classifiedRevision: "rev-1" } })
      const refreshed = upsertCareForIncident(tmpDir, {
        ...baseCareInput,
        id: first.id,
        kind: "system",
        label: "Docker image disk utilization",
        why: "Verified from current Unraid notifications.",
        currentRisk: "Docker image disk utilization verification is inconclusive.",
        nextCheckAt: "2026-09-01T08:00:00.000Z",
        incident: { source: "guard", incidentKey: "docker", classifiedRevision: "rev-2" },
        expectedUpdatedAt: first.updatedAt,
      })
      expect(refreshed).toMatchObject({ id: first.id, label: "Docker image disk utilization", why: "Verified from current Unraid notifications.", currentRisk: "Docker image disk utilization verification is inconclusive.", nextCheckAt: "2026-09-01T08:00:00.000Z" })
      expect(upsertCareForIncident(tmpDir, {
        ...baseCareInput, id: first.id, kind: "system", label: refreshed.label, why: refreshed.why, currentRisk: refreshed.currentRisk,
        nextCheckAt: refreshed.nextCheckAt, incident: refreshed.incidentBindings![0]!, expectedUpdatedAt: refreshed.updatedAt,
      })).toEqual(refreshed)
      expect(() => upsertCareForIncident(tmpDir, {
        ...baseCareInput, id: "different-care", kind: "system", incident: refreshed.incidentBindings![0]!, expectedUpdatedAt: refreshed.updatedAt,
      })).toThrow(/target not found/u)
      expect(() => upsertCareForIncident(tmpDir, {
        ...baseCareInput, id: first.id, kind: "system", incident: { source: "guard", incidentKey: "missing", classifiedRevision: "rev" }, expectedUpdatedAt: refreshed.updatedAt,
      })).toThrow(/target not found/u)
    })

    it("preserves omitted display and policy metadata during an exact-id incident refresh", () => {
      const first = upsertCareForIncident(tmpDir, {
        ...baseCareInput, label: "Books service", why: "Keep the library available", kind: "project", status: "watching", salience: "high", steward: "shared",
        incident: { source: "guard", incidentKey: "books", classifiedRevision: "rev-1" },
      })
      const refreshed = upsertCareForIncident(tmpDir, {
        id: first.id, currentRisk: "Container is restarting", nextCheckAt: "2026-09-01T08:15:00.000Z",
        relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [],
        incident: { source: "guard", incidentKey: "books", classifiedRevision: "rev-2" }, expectedUpdatedAt: first.updatedAt,
      })
      expect(refreshed).toMatchObject({
        label: "Books service", why: "Keep the library available", kind: "project", status: "watching", salience: "high", steward: "shared",
        currentRisk: "Container is restarting", nextCheckAt: "2026-09-01T08:15:00.000Z",
      })
      const revisionOnly = upsertCareForIncident(tmpDir, {
        id: first.id, relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [],
        incident: { source: "guard", incidentKey: "books", classifiedRevision: "rev-3" }, expectedUpdatedAt: refreshed.updatedAt,
      })
      expect(revisionOnly).toMatchObject({ currentRisk: "Container is restarting", nextCheckAt: "2026-09-01T08:15:00.000Z" })
    })

    it("updates safe display on an already-resolved binding without re-resolving it", () => {
      const care = createCare(tmpDir, { ...baseCareInput, kind: "system", currentRisk: "old" })
      const bound = bindCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "docker", classifiedRevision: "rev", resolvedAt: "2026-09-01T07:00:00.000Z" }, { expectedUpdatedAt: care.updatedAt })
      const updated = resolveCareIncident(tmpDir, care.id, {
        source: "guard", incidentKey: "docker", expectedUpdatedAt: bound.updatedAt,
        display: { label: "Docker image disk utilization", why: "Current evidence checked.", currentRisk: "another incident remains", nextCheckAt: "2026-09-01T08:15:00.000Z" },
      })
      expect(updated).toMatchObject({ status: "active", currentRisk: "another incident remains", nextCheckAt: "2026-09-01T08:15:00.000Z" })
      expect(updated.incidentBindings![0]!.resolvedAt).toBe("2026-09-01T07:00:00.000Z")
      expect(resolveCareIncident(tmpDir, care.id, {
        source: "guard", incidentKey: "docker", expectedUpdatedAt: updated.updatedAt,
        display: { label: updated.label, why: updated.why, currentRisk: updated.currentRisk, nextCheckAt: updated.nextCheckAt },
      })).toEqual(updated)
    })

    it("preserves omitted display fields during partial incident resolution", () => {
      const care = createCare(tmpDir, { ...baseCareInput, label: "Books service", why: "Keep the library available", currentRisk: "Restarting", nextCheckAt: "2026-09-01T08:15:00.000Z" })
      const bound = bindCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "books", classifiedRevision: "rev-1" }, { expectedUpdatedAt: care.updatedAt })
      const resolved = resolveCareIncident(tmpDir, care.id, {
        source: "guard", incidentKey: "books", expectedUpdatedAt: bound.updatedAt, display: { currentRisk: "Recovery needs review" },
      })
      expect(resolved).toMatchObject({
        label: "Books service", why: "Keep the library available", currentRisk: "Recovery needs review", nextCheckAt: "2026-09-01T08:15:00.000Z",
      })
      expect(resolveCareIncident(tmpDir, care.id, {
        source: "guard", incidentKey: "books", expectedUpdatedAt: resolved.updatedAt, display: { label: resolved.label },
      })).toEqual(resolved)
    })

    it("does not close the whole Care while another incident remains unresolved", () => {
      const care = createCare(tmpDir, { ...baseCareInput, kind: "system", currentRisk: "old" })
      const first = bindCareIncident(tmpDir, care.id, { source: "sanctuary-health::Docker_critical_image_disk_utilization", incidentKey: "docker-image-disk-100pct-20260831T1427Z", classifiedRevision: "a".repeat(64) }, { expectedUpdatedAt: care.updatedAt })
      const second = bindCareIncident(tmpDir, care.id, { source: "guard", incidentKey: "other", classifiedRevision: "rev" }, { expectedUpdatedAt: first.updatedAt })
      const updated = resolveCareIncident(tmpDir, care.id, {
        source: "sanctuary-health::Docker_critical_image_disk_utilization", incidentKey: "docker-image-disk-100pct-20260831T1427Z", expectedUpdatedAt: second.updatedAt,
        display: { label: "Docker image disk utilization", why: "Current evidence checked.", currentRisk: null, nextCheckAt: null },
      })
      expect(updated).toMatchObject({ status: "active", currentRisk: CARE_INCIDENT_RECOVERY_REVIEW_RISK })
      expect(updated.incidentBindings!.filter((binding) => !binding.resolvedAt)).toHaveLength(1)
    })

    it("lets the sole unresolved managed binding own risk despite a resolved historical neighbor", () => {
      const target = { source: "sanctuary-health::Docker_critical_image_disk_utilization", incidentKey: "docker-image-disk-100pct-20260831T1427Z", classifiedRevision: "a".repeat(64) }
      const care = createCare(tmpDir, { ...baseCareInput, kind: "system", currentRisk: "historical Docker risk", incidentBindings: [target, { source: "other", incidentKey: "old", classifiedRevision: "rev", resolvedAt: "2026-08-31T00:00:00.000Z" }] })
      const updated = resolveCareIncident(tmpDir, care.id, {
        source: target.source, incidentKey: target.incidentKey, expectedUpdatedAt: care.updatedAt,
        display: { label: "Docker image disk utilization", why: "Current evidence checked.", currentRisk: null, nextCheckAt: null },
      })
      expect(updated).toMatchObject({ status: "resolved", currentRisk: null, nextCheckAt: null })
      expect(updated.incidentBindings!.every((binding) => binding.resolvedAt)).toBe(true)
    })

    it("targets duplicate incident identities by exact Care id", () => {
      const binding = { source: "guard", incidentKey: "duplicate", classifiedRevision: "rev-1" }
      const first = createCare(tmpDir, { ...baseCareInput, incidentBindings: [binding] })
      const second = createCare(tmpDir, { ...baseCareInput, label: "second", incidentBindings: [binding] })
      const secondUpdated = upsertCareForIncident(tmpDir, {
        ...baseCareInput, id: second.id, label: "second refreshed", incident: { ...binding, classifiedRevision: "rev-2" }, expectedUpdatedAt: second.updatedAt,
      })
      const firstUpdated = upsertCareForIncident(tmpDir, {
        ...baseCareInput, id: first.id, label: "first refreshed", incident: { ...binding, classifiedRevision: "rev-2" }, expectedUpdatedAt: first.updatedAt,
      })
      expect([firstUpdated.id, secondUpdated.id]).toEqual([first.id, second.id])
      expect(firstUpdated.label).toBe("first refreshed")
      expect(secondUpdated.label).toBe("second refreshed")
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

  describe("projectCareEvidence", () => {
    const now = Date.parse("2026-09-01T07:30:00.000Z")
    const systemCare = (nextCheckAt: string | null, overrides: Partial<CareRecord> = {}): CareRecord => ({
      id: "care-system",
      label: "Docker image disk at 100%",
      why: "historical warning",
      kind: "system",
      status: "active",
      salience: "critical",
      steward: "mine",
      relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [],
      currentRisk: "Docker image was measured at 100%",
      nextCheckAt,
      createdAt: "2026-09-01T06:00:00.000Z",
      updatedAt: "2026-09-01T07:00:00.000Z",
      ...overrides,
    })

    it.each([
      ["equal", "2026-09-01T07:30:00.000Z"],
      ["overdue", "2026-09-01T07:29:59.999Z"],
      ["malformed", "not-a-time"],
    ])("suppresses stale system prose at the captured %s boundary", (_label, nextCheckAt) => {
      expect(projectCareEvidence(systemCare(nextCheckAt), now)).toEqual({
        id: "care-system",
        kind: "system",
        status: "active",
        salience: "critical",
        steward: "mine",
        evidenceStatus: "stale",
        recheckRequired: true,
        staleAt: nextCheckAt,
        lastAssessedAt: "2026-09-01T07:00:00.000Z",
      })
    })

    it("keeps null and future checks current and never projects non-system or terminal cares as stale", () => {
      const nullCheck = systemCare(null)
      const future = systemCare("2026-09-01T07:30:00.001Z")
      const project = systemCare("2026-09-01T07:00:00.000Z", { kind: "project" })
      const resolved = systemCare("2026-09-01T07:00:00.000Z", { status: "resolved" })
      expect(projectCareEvidence(nullCheck, now)).toBe(nullCheck)
      expect(projectCareEvidence(future, now)).toBe(future)
      expect(projectCareEvidence(project, now)).toBe(project)
      expect(projectCareEvidence(resolved, now)).toBe(resolved)
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
