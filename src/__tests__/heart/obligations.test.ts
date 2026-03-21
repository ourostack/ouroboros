import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  createObligation,
  readObligations,
  readPendingObligations,
  fulfillObligation,
  findPendingObligationForOrigin,
  advanceObligation,
} from "../../heart/obligations"

describe("obligations store", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "obligations-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const sampleOrigin = { friendId: "friend-1", channel: "cli", key: "session" }

  describe("createObligation", () => {
    it("writes a JSON file under state/obligations/", () => {
      const obligation = createObligation(tmpDir, {
        origin: sampleOrigin,
        content: "think about their architecture question",
      })

      expect(obligation.id).toBeTruthy()
      expect(obligation.status).toBe("pending")
      expect(obligation.createdAt).toBeTruthy()
      expect(obligation.origin).toEqual(sampleOrigin)
      expect(obligation.content).toBe("think about their architecture question")

      const filePath = path.join(tmpDir, "state", "obligations", `${obligation.id}.json`)
      expect(fs.existsSync(filePath)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      expect(stored.id).toBe(obligation.id)
      expect(stored.status).toBe("pending")
    })

    it("includes bridgeId when provided", () => {
      const obligation = createObligation(tmpDir, {
        origin: sampleOrigin,
        bridgeId: "bridge-42",
        content: "relay info across sessions",
      })

      expect(obligation.bridgeId).toBe("bridge-42")
    })

    it("generates unique IDs for multiple obligations", () => {
      const ob1 = createObligation(tmpDir, { origin: sampleOrigin, content: "first" })
      const ob2 = createObligation(tmpDir, { origin: sampleOrigin, content: "second" })
      expect(ob1.id).not.toBe(ob2.id)
    })
  })

  describe("readObligations", () => {
    it("returns empty array when directory does not exist", () => {
      expect(readObligations(tmpDir)).toEqual([])
    })

    it("returns all obligations", () => {
      createObligation(tmpDir, { origin: sampleOrigin, content: "first" })
      createObligation(tmpDir, { origin: sampleOrigin, content: "second" })

      const all = readObligations(tmpDir)
      expect(all).toHaveLength(2)
    })

    it("skips malformed JSON files", () => {
      createObligation(tmpDir, { origin: sampleOrigin, content: "valid" })

      const obligationsDir = path.join(tmpDir, "state", "obligations")
      fs.writeFileSync(path.join(obligationsDir, "bad.json"), "not json", "utf-8")

      const all = readObligations(tmpDir)
      expect(all).toHaveLength(1)
      expect(all[0].content).toBe("valid")
    })

    it("skips non-json files", () => {
      createObligation(tmpDir, { origin: sampleOrigin, content: "valid" })

      const obligationsDir = path.join(tmpDir, "state", "obligations")
      fs.writeFileSync(path.join(obligationsDir, "readme.txt"), "ignore me", "utf-8")

      const all = readObligations(tmpDir)
      expect(all).toHaveLength(1)
    })
  })

  describe("readPendingObligations", () => {
    it("returns only pending obligations", () => {
      const ob1 = createObligation(tmpDir, { origin: sampleOrigin, content: "pending one" })
      createObligation(tmpDir, { origin: sampleOrigin, content: "pending two" })
      fulfillObligation(tmpDir, ob1.id)

      const pending = readPendingObligations(tmpDir)
      expect(pending).toHaveLength(1)
      expect(pending[0].content).toBe("pending two")
    })

    it("keeps investigating obligations in the active set", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "debug the loop" })
      advanceObligation(tmpDir, ob.id, {
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-001" },
      })

      const pending = readPendingObligations(tmpDir)
      expect(pending).toHaveLength(1)
      expect(pending[0].status).toBe("investigating")
      expect(pending[0].currentSurface).toEqual({ kind: "coding", label: "codex coding-001" })
    })

    it("returns empty array when all are fulfilled", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "done" })
      fulfillObligation(tmpDir, ob.id)

      expect(readPendingObligations(tmpDir)).toEqual([])
    })
  })

  describe("fulfillObligation", () => {
    it("updates status to fulfilled and sets fulfilledAt", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "to fulfill" })
      fulfillObligation(tmpDir, ob.id)

      const all = readObligations(tmpDir)
      expect(all).toHaveLength(1)
      expect(all[0].status).toBe("fulfilled")
      expect(all[0].fulfilledAt).toBeTruthy()
    })

    it("is a no-op for non-existent obligation ID", () => {
      createObligation(tmpDir, { origin: sampleOrigin, content: "exists" })

      // Should not throw
      fulfillObligation(tmpDir, "nonexistent-id")

      const all = readObligations(tmpDir)
      expect(all).toHaveLength(1)
      expect(all[0].status).toBe("pending")
    })
  })

  describe("advanceObligation", () => {
    it("updates lifecycle state, current surface, and updatedAt", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "fix the visible loop" })
      advanceObligation(tmpDir, ob.id, {
        status: "waiting_for_merge",
        currentSurface: { kind: "merge", label: "PR #999" },
        latestNote: "checks green, ready to merge",
      })

      const all = readObligations(tmpDir)
      expect(all).toHaveLength(1)
      expect(all[0].status).toBe("waiting_for_merge")
      expect(all[0].currentSurface).toEqual({ kind: "merge", label: "PR #999" })
      expect(all[0].latestNote).toBe("checks green, ready to merge")
      expect(all[0].updatedAt).toBeTruthy()
    })

    it("can update note without changing status or surface", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "keep Ari posted" })
      advanceObligation(tmpDir, ob.id, {
        latestNote: "still tracing the issue",
      })

      const all = readObligations(tmpDir)
      expect(all[0].status).toBe("pending")
      expect(all[0].currentSurface).toBeUndefined()
      expect(all[0].latestNote).toBe("still tracing the issue")
      expect(all[0].updatedAt).toBeTruthy()
    })

    it("persists current artifact and next action for live status surfacing", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "close the loop visibly" })
      advanceObligation(tmpDir, ob.id, {
        status: "waiting_for_merge",
        currentSurface: { kind: "merge", label: "PR #123" },
        currentArtifact: "PR #123",
        nextAction: "wait for checks, merge PR #123, then update runtime",
        latestNote: "opened PR #123",
      })

      const all = readObligations(tmpDir)
      expect(all[0].currentArtifact).toBe("PR #123")
      expect(all[0].nextAction).toBe("wait for checks, merge PR #123, then update runtime")
      expect(all[0].latestNote).toBe("opened PR #123")
    })
  })

  describe("findPendingObligationForOrigin", () => {
    it("finds a pending obligation matching the origin", () => {
      createObligation(tmpDir, { origin: sampleOrigin, content: "the one" })
      createObligation(tmpDir, {
        origin: { friendId: "other", channel: "teams", key: "session" },
        content: "not this one",
      })

      const found = findPendingObligationForOrigin(tmpDir, sampleOrigin)
      expect(found).toBeDefined()
      expect(found!.content).toBe("the one")
    })

    it("returns undefined when no pending obligation matches", () => {
      createObligation(tmpDir, {
        origin: { friendId: "other", channel: "teams", key: "session" },
        content: "different origin",
      })

      const found = findPendingObligationForOrigin(tmpDir, sampleOrigin)
      expect(found).toBeUndefined()
    })

    it("does not return fulfilled obligations", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "fulfilled" })
      fulfillObligation(tmpDir, ob.id)

      const found = findPendingObligationForOrigin(tmpDir, sampleOrigin)
      expect(found).toBeUndefined()
    })

    it("returns active investigating obligations for the origin", () => {
      const ob = createObligation(tmpDir, { origin: sampleOrigin, content: "follow the coding session" })
      advanceObligation(tmpDir, ob.id, {
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-001" },
      })

      const found = findPendingObligationForOrigin(tmpDir, sampleOrigin)
      expect(found).toBeDefined()
      expect(found!.status).toBe("investigating")
    })
  })
})
