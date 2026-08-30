import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

const mockGetAgentRoot = vi.fn()
const mockGetAgentName = vi.fn(() => "slugger")
vi.mock("../../heart/identity", () => ({
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
}))

const mockDeliverAwaitAlert = vi.fn()
vi.mock("../../heart/awaiting/await-alert", () => ({
  deliverAwaitAlert: (...args: any[]) => mockDeliverAwaitAlert(...args),
}))

import {
  awaitingToolDefinitions,
  cancelRelationshipFollowUps,
  hasActiveExternalEventAwait,
  hasActiveRelationshipFollowUp,
  setAwaitToolDeps,
  resetAwaitToolDeps,
} from "../../repertoire/tools-awaiting"
import { expectedCappedContent, expectedTruncationMarker, expectCappedAgentContent, makeOversizedAgentContent } from "../helpers/content-cap"
import { claimExternalEvent, commitExternalEventDisposition, getExternalEventRoot, readExternalEventRecord, recordExternalEvent } from "../../heart/external-events/router"
import { advanceObligation, createObligation, readVerifiedPendingObligations } from "../../arc/obligations"

const fileAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "await_condition")!
const resolveAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "resolve_await")!
const cancelAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "cancel_await")!

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tools-await-"))
}

function parse(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>
}

function readDoneFile(agentRoot: string, name: string): string {
  return fs.readFileSync(path.join(agentRoot, "awaiting", ".done", `${name}.md`), "utf-8")
}

describe("tools-awaiting", () => {
  const cleanup: string[] = []
  let agentRoot: string

  beforeEach(() => {
    vi.clearAllMocks()
    agentRoot = makeTempRoot()
    cleanup.push(agentRoot)
    mockGetAgentRoot.mockReturnValue(agentRoot)
    mockGetAgentName.mockReturnValue("slugger")
    resetAwaitToolDeps()
    setAwaitToolDeps({ buildDeliveryDeps: () => ({ agentName: "slugger", queuePending: vi.fn() }) })
    mockDeliverAwaitAlert.mockResolvedValue({ attempted: true, delivery: { status: "delivered_now", detail: "ok" } })
  })

  afterEach(() => {
    resetAwaitToolDeps()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  describe("await_condition", () => {
    it("files external-event awaits with exact event provenance and no human obligation", async () => {
      const recordPath = path.join(agentRoot, "external-events", "sanctuary", "usenet", "event-1.json")
      const result = parse(await fileAwaitDef.handler(
        { name: "unsafe_event_wait", condition: "later", cadence: "5m" },
        {
          context: { friend: { id: "owner" } },
          currentExternalEvent: { schemaVersion: 1, recordPath, agent: "sanctuary", source: "usenet", eventId: "event-1", generation: 2, observationRevision: "revision-1", claimOwner: "worker" },
        } as any,
      ) as string)

      expect(result.filed).toBe("unsafe_event_wait")
      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "unsafe_event_wait.md"), "utf8")
      expect(content).toContain("filed_from: external-event")
      expect(content).toContain("alert: null")
      expect(content).toContain("filed_for_friend_id: owner")
      expect(content).toContain(`filed_from_key: ${recordPath}`)
      expect(content).toContain("request_id: null")
      expect(content).not.toContain("obligation_id:")
    })

    it("authorizes an external-event await only for its exact handled disposition and wake time", () => {
      const eventRoot = path.join(agentRoot, "external-events")
      const first = recordExternalEvent({ agent: "sanctuary", source: "usenet", eventType: "credit.low", eventId: "event-1" }, { root: eventRoot })
      const claim = claimExternalEvent(first.recordPath, { owner: "worker", expectedVersion: first.version, expectedGeneration: first.generation })
      commitExternalEventDisposition(first.recordPath, {
        owner: "worker", expectedVersion: claim.version, expectedGeneration: claim.generation,
        disposition: { classifiedRevision: first.observationRevision, classification: "snoozed", stewardPolicy: { kind: "none" }, decision: "silent", reason: "Wait.", nextWake: { kind: "at", at: "2026-08-30T17:00:00.000Z" }, careId: null, awaitId: "event-wait", actionRefs: [], verificationRefs: [] },
      })

      expect(hasActiveExternalEventAwait("sanctuary", { recordPath: first.recordPath, awaitName: "event-wait", wakeAt: "2026-08-30T17:00:00.000Z" }, eventRoot)).toBe(true)
      expect(hasActiveExternalEventAwait("sanctuary", { recordPath: first.recordPath, awaitName: "event-wait", wakeAt: "2026-08-30T17:01:00.000Z" }, eventRoot)).toBe(false)
      expect(hasActiveExternalEventAwait("sanctuary", { recordPath: first.recordPath, awaitName: "other", wakeAt: "2026-08-30T17:00:00.000Z" }, eventRoot)).toBe(false)

      const second = recordExternalEvent({ agent: "sanctuary", source: "storage", eventType: "credit.low", eventId: "event-2" }, { root: eventRoot })
      const secondClaim = claimExternalEvent(second.recordPath, { owner: "worker-2", expectedVersion: second.version, expectedGeneration: second.generation })
      commitExternalEventDisposition(second.recordPath, {
        owner: "worker-2", expectedVersion: secondClaim.version, expectedGeneration: secondClaim.generation,
        disposition: { classifiedRevision: second.observationRevision, classification: "snoozed", stewardPolicy: { kind: "none" }, decision: "silent", reason: "Wait.", nextWake: { kind: "at", at: "2026-08-30T17:00:00.000Z" }, careId: null, awaitId: "event-wait", actionRefs: [], verificationRefs: [] },
      })
      expect(hasActiveExternalEventAwait("sanctuary", { recordPath: first.recordPath, awaitName: "event-wait", wakeAt: "2026-08-30T17:00:00.000Z" }, eventRoot)).toBe(true)

      const changed = readExternalEventRecord(first.recordPath)
      fs.writeFileSync(first.recordPath, JSON.stringify({ ...changed, executionState: "received", disposition: null }), "utf8")
      expect(hasActiveExternalEventAwait("sanctuary", { recordPath: first.recordPath, awaitName: "event-wait", wakeAt: "2026-08-30T17:00:00.000Z" }, eventRoot)).toBe(false)
    })

    it("does not classify an unreadable exact external-event record as stale", () => {
      const eventRoot = path.join(agentRoot, "external-events")
      const event = recordExternalEvent({ agent: "sanctuary", source: "usenet", eventType: "credit.low", eventId: "event-corrupt" }, { root: eventRoot })
      fs.writeFileSync(event.recordPath, "{not-json", "utf8")

      expect(() => hasActiveExternalEventAwait("sanctuary", { recordPath: event.recordPath, awaitName: "event-wait", wakeAt: "2026-08-30T17:00:00.000Z" }, eventRoot)).toThrow()
    })

    it("files a new await with required fields", async () => {
      const ctx = { currentSession: { friendId: "ari", channel: "bluebubbles", key: "+15551112222;-;ari", sessionPath: "" } }
      const result = parse(await fileAwaitDef.handler(
        { name: "hey_export", condition: "HEY export visible", cadence: "5m" },
        ctx as any,
      ) as string)
      expect(result.filed).toBe("hey_export")

      const filePath = path.join(agentRoot, "awaiting", "hey_export.md")
      expect(fs.existsSync(filePath)).toBe(true)
      const content = fs.readFileSync(filePath, "utf-8")
      expect(content).toContain("condition: HEY export visible")
      expect(content).toContain("cadence: 5m")
      expect(content).toContain("status: pending")
      expect(content).toContain("alert: bluebubbles") // inherited from currentSession.channel
      expect(content).toContain("filed_for_friend_id: ari")
    })

    it("binds a relationship await to the exact durable request obligation and return route", async () => {
      const ctx = {
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: {
          requestId: "telegram-inbound:request-1",
          authorizedContextScopes: ["own_requests"],
          advertisedToolNames: ["await_condition"],
          authorizeTool: vi.fn(),
        },
      }
      await fileAwaitDef.handler({ name: "movie_ready", condition: "Requested movie is available", cadence: "5m", max_age: "2h" }, ctx as any)

      const awaitText = fs.readFileSync(path.join(agentRoot, "awaiting", "movie_ready.md"), "utf8")
      expect(awaitText).toContain("request_id: telegram-inbound:request-1")
      expect(awaitText).toContain("filed_from_key: telegram:777:888")
      const obligations = fs.readdirSync(path.join(agentRoot, "arc", "obligations")).filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(agentRoot, "arc", "obligations", name), "utf8")))
      expect(obligations).toHaveLength(1)
      expect(obligations[0]).toMatchObject({
        origin: { friendId: "sibling", channel: "telegram", key: "telegram:777:888" },
        owedTo: { friendId: "sibling", channel: "telegram", key: "telegram:777:888" },
        requestId: "telegram-inbound:request-1",
        currentArtifact: "awaiting/movie_ready.md",
        status: "pending",
      })
      expect(awaitText).toContain(`obligation_id: ${obligations[0].id}`)
    })

    it("uses explicit alert + mode + max_age + body", async () => {
      const result = parse(await fileAwaitDef.handler(
        {
          name: "hey_export",
          condition: "x",
          cadence: "5m",
          alert: "teams",
          mode: "quick",
          max_age: "24h",
          body: "what would count as ready",
        },
        undefined,
      ) as string)
      expect(result.filed).toBe("hey_export")

      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "hey_export.md"), "utf-8")
      expect(content).toContain("alert: teams")
      expect(content).toContain("mode: quick")
      expect(content).toContain("max_age: 24h")
      expect(content).toContain("what would count as ready")
    })

    it("persists a canonical future wake time", async () => {
      await fileAwaitDef.handler({ name: "scheduled", condition: "x", cadence: "5m", wake_at: "2099-08-30T01:00:00.000Z" }, undefined)
      expect(fs.readFileSync(path.join(agentRoot, "awaiting", "scheduled.md"), "utf8")).toContain("wake_at: 2099-08-30T01:00:00.000Z")
    })

    it("caps oversized agent-authored condition and body text while preserving markdown", async () => {
      const oversizedCondition = makeOversizedAgentContent("await condition ")
      const oversizedBody = makeOversizedAgentContent("await body ")
      const result = parse(await fileAwaitDef.handler(
        {
          name: "oversized",
          condition: oversizedCondition,
          cadence: "5m",
          body: oversizedBody,
        },
        undefined,
      ) as string)
      expect(result.filed).toBe("oversized")

      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "oversized.md"), "utf-8")
      expect(content.includes(expectedTruncationMarker(oversizedCondition))).toBe(true)
      expect(content.includes(expectedTruncationMarker(oversizedBody))).toBe(true)
      expect(content).toContain(`condition: ${expectedCappedContent(oversizedCondition)}`)
      expect(content).toContain("---\n")
      expect(content).toContain(expectedCappedContent(oversizedBody))
    })

    it("falls back to mode=full for unknown mode", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m", mode: "weird" }, undefined)
      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "x.md"), "utf-8")
      expect(content).toContain("mode: full")
    })

    it("rejects empty name", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "", condition: "c", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/required/)
    })

    it("rejects name with invalid chars", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "bad name!", condition: "c", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/alphanumeric/)
    })

    it("rejects missing condition", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "x", condition: "  ", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/condition is required/)
    })

    it("rejects missing cadence", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "" }, undefined) as string)
      expect(result.error).toMatch(/cadence is required/)
    })

    it("rejects duplicate name", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m" }, undefined)
      const result = parse(await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/already exists/)
    })

    it.each(["not-a-date", "2026-08-30T01:00:00Z"])("rejects non-canonical wake_at %s", async (wakeAt) => {
      const result = parse(await fileAwaitDef.handler({ name: `wake_${wakeAt.length}`, condition: "c", cadence: "5m", wake_at: wakeAt }, undefined) as string)
      expect(result.error).toMatch(/canonical ISO timestamp/)
    })

    it("cleans up a newly-created obligation when the await file cannot be written", async () => {
      const awaiting = path.join(agentRoot, "awaiting")
      fs.mkdirSync(awaiting, { recursive: true })
      fs.chmodSync(awaiting, 0o500)
      const ctx = {
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId: "request-write-fail", authorizedContextScopes: ["own_requests"], advertisedToolNames: ["await_condition"], authorizeTool: vi.fn() },
      }
      expect(() => fileAwaitDef.handler({ name: "write_fail", condition: "c", cadence: "5m" }, ctx as any)).toThrow()
      fs.chmodSync(awaiting, 0o700)
      expect(readVerifiedPendingObligations(agentRoot)).toEqual([])
    })

    it("propagates an unbound await write failure without obligation cleanup", async () => {
      const awaiting = path.join(agentRoot, "awaiting")
      fs.mkdirSync(awaiting, { recursive: true })
      fs.chmodSync(awaiting, 0o500)
      expect(() => fileAwaitDef.handler({ name: "unbound_write_fail", condition: "c", cadence: "5m" }, undefined)).toThrow()
      fs.chmodSync(awaiting, 0o700)
      expect(readVerifiedPendingObligations(agentRoot)).toEqual([])
    })

    it("defaults filed_from to 'unknown' when no session context", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m" }, undefined)
      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "x.md"), "utf-8")
      expect(content).toContain("filed_from: unknown")
    })
  })

  describe("resolve_await", () => {
    async function file(name: string) {
      await fileAwaitDef.handler(
        { name, condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "+15551112222;-;ari", sessionPath: "" } } as any,
      )
    }

    it("verdict=yes archives + alerts", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "download appeared" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      expect(result.archived).toContain("/.done/hey_export.md")
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "hey_export.md"))).toBe(false)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", ".done", "hey_export.md"))).toBe(true)
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).toContain("status: resolved")
      expect(content).toContain("resolution_observation: download appeared")
      expect(mockDeliverAwaitAlert).toHaveBeenCalledWith(expect.objectContaining({
        reason: "resolved",
        observation: "download appeared",
      }))
    })

    it("advances the exact handled external event linked to the resolved await", async () => {
      const previousHome = process.env.HOME
      process.env.HOME = agentRoot
      try {
        const first = recordExternalEvent({ agent: "slugger", source: "guard", eventType: "health.observed", eventId: "books", observationRevision: "rev-1" }, { root: getExternalEventRoot() })
        const claimed = claimExternalEvent(first.recordPath, { owner: "lease-1", expectedVersion: first.version, expectedGeneration: 1 })
        const handled = commitExternalEventDisposition(first.recordPath, {
          owner: "lease-1", expectedVersion: claimed.version, expectedGeneration: 1,
          disposition: {
            classifiedRevision: "rev-1", classification: "snoozed", stewardPolicy: { kind: "current", key: "service:books", version: 1 }, decision: "silent",
            reason: "Check again later.", nextWake: { kind: "at", at: "2026-08-30T12:00:00.000Z" }, careId: null, awaitId: "books-recheck", actionRefs: [], verificationRefs: [],
          },
        })
        await fileAwaitDef.handler({ name: "books-recheck", condition: "The recheck time has arrived", cadence: "5m", wake_at: "2026-08-30T12:00:00.000Z" }, {
          context: { friend: { id: "owner" } },
          currentExternalEvent: claimed,
        } as any)
        await resolveAwaitDef.handler({ name: "books-recheck", verdict: "yes", observation: "recheck time reached" }, {
          currentSession: { friendId: "owner", channel: "external-event", key: handled.recordPath, sessionPath: "/private/session.json" },
          relationshipAuthorization: { profileId: "sanctuary-event", authorizedContextScopes: [], advertisedToolNames: ["resolve_await"], authorizeTool: vi.fn() },
        } as any)

        expect(readExternalEventRecord(handled.recordPath)).toMatchObject({ executionState: "queued", generation: 2, disposition: null })
      } finally {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
      }
    })

    it("verdict=no records observation, does not archive", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "no", observation: "no sign yet" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("no")
      expect(result.recorded).toBe(true)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "hey_export.md"))).toBe(true)

      // runtime state recorded
      const state = JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "awaits", "hey_export.json"), "utf-8")) as Record<string, unknown>
      expect(state.last_observation).toBe("no sign yet")
      expect(state.checked_count).toBe(1)
    })

    it("verdict=no caps oversized observation in runtime state JSON", async () => {
      await file("hey_export")
      const oversized = makeOversizedAgentContent("await observation ")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "no", observation: oversized },
        undefined,
      ) as string)

      expect(result.verdict).toBe("no")
      expect(result.recorded).toBe(true)

      const raw = fs.readFileSync(path.join(agentRoot, "state", "awaits", "hey_export.json"), "utf-8")
      const state = JSON.parse(raw) as Record<string, unknown>
      expectCappedAgentContent(state.last_observation as string, oversized)
      expect(state.checked_count).toBe(1)
    })

    it("rejects unknown await", async () => {
      const result = parse(await resolveAwaitDef.handler(
        { name: "nope", verdict: "yes", observation: "x" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("rejects invalid name", async () => {
      const result = parse(await resolveAwaitDef.handler(
        { name: "bad name!", verdict: "yes", observation: "x" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/alphanumeric/)
    })

    it("rejects invalid verdict", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "maybe", observation: "x" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/verdict/)
    })

    it("rejects missing observation", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/observation is required/)
    })

    it("rejects resolving an already-archived await", async () => {
      await file("hey_export")
      await resolveAwaitDef.handler({ name: "hey_export", verdict: "yes", observation: "ok" }, undefined)
      // Second call: file no longer exists in awaiting/
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("catches alert delivery errors without failing the resolution", async () => {
      mockDeliverAwaitAlert.mockRejectedValueOnce(new Error("delivery boom"))
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      expect(result.alert).toBeNull()
      expect(fs.existsSync(path.join(agentRoot, "awaiting", ".done", "hey_export.md"))).toBe(true)
    })

    it("rejects resolving a non-pending await (manually-edited file)", async () => {
      // Write a non-pending file directly to simulate a tampered/stuck file
      fs.mkdirSync(path.join(agentRoot, "awaiting"), { recursive: true })
      fs.writeFileSync(
        path.join(agentRoot, "awaiting", "weird.md"),
        ["---", "condition: c", "cadence: 5m", "status: resolved", "---", "", ""].join("\n"),
        "utf-8",
      )
      const result = parse(await resolveAwaitDef.handler(
        { name: "weird", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/not pending/)
    })

    it("reports skipped alert (attempted=false)", async () => {
      mockDeliverAwaitAlert.mockResolvedValueOnce({ attempted: false, skipped: "no session key" })
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      const alert = result.alert as Record<string, unknown>
      expect(alert.attempted).toBe(false)
      expect(alert.status).toBeNull()
      expect(alert.skipped).toBe("no session key")
    })

    it("catches alert delivery errors (non-Error throw)", async () => {
      mockDeliverAwaitAlert.mockRejectedValueOnce("string-error")
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
    })

    it.each([new Error("request delivery boom"), "request-string-boom"])("keeps a request-bound await pending when delivery throws", async (failure) => {
      const ctx = {
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId: `request-${typeof failure}`, authorizedContextScopes: ["own_requests"], advertisedToolNames: ["await_condition"], authorizeTool: vi.fn() },
      }
      await fileAwaitDef.handler({ name: `request_${typeof failure}`, condition: "c", cadence: "5m" }, ctx as any)
      mockDeliverAwaitAlert.mockRejectedValueOnce(failure)
      const result = parse(await resolveAwaitDef.handler({ name: `request_${typeof failure}`, verdict: "yes", observation: "ready" }, undefined) as string)
      expect(result).toMatchObject({ verdict: "yes", archived: null, alert: null, advancedExternalEvents: [] })
      expect(fs.existsSync(path.join(agentRoot, "awaiting", `request_${typeof failure}.md`))).toBe(true)
    })

    it("reports a request-bound skipped delivery without archiving", async () => {
      const ctx = {
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId: "request-skipped", authorizedContextScopes: ["own_requests"], advertisedToolNames: ["await_condition"], authorizeTool: vi.fn() },
      }
      await fileAwaitDef.handler({ name: "request_skipped", condition: "c", cadence: "5m" }, ctx as any)
      mockDeliverAwaitAlert.mockResolvedValueOnce({ attempted: false })
      const result = parse(await resolveAwaitDef.handler({ name: "request_skipped", verdict: "yes", observation: "ready" }, undefined) as string)
      expect(result.alert).toEqual({ attempted: false, status: null, skipped: null })
      expect(result.archived).toBeNull()
    })
  })

  describe("cancel_await", () => {
    async function file(name: string) {
      await fileAwaitDef.handler(
        { name, condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )
    }

    it("cancels with reason", async () => {
      await file("hey_export")
      const result = parse(cancelAwaitDef.handler({ name: "hey_export", reason: "nevermind" }, undefined) as string)
      expect(result.canceled).toBe("hey_export")
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).toContain("status: canceled")
      expect(content).toContain("cancel_reason: nevermind")
    })

    it("cancels without reason", async () => {
      await file("hey_export")
      const result = parse(cancelAwaitDef.handler({ name: "hey_export" }, undefined) as string)
      expect(result.canceled).toBe("hey_export")
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).toContain("status: canceled")
      expect(content).not.toContain("cancel_reason:")
    })

    it("cancels with whitespace reason (treated as no reason)", async () => {
      await file("hey_export")
      cancelAwaitDef.handler({ name: "hey_export", reason: "   " }, undefined)
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).not.toContain("cancel_reason:")
    })

    it("rejects unknown await", () => {
      const result = parse(cancelAwaitDef.handler({ name: "nope" }, undefined) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("rejects invalid name", () => {
      const result = parse(cancelAwaitDef.handler({ name: "bad name!" }, undefined) as string)
      expect(result.error).toMatch(/alphanumeric/)
    })

    it("rejects canceling a non-pending await (manually-edited file)", async () => {
      fs.mkdirSync(path.join(agentRoot, "awaiting"), { recursive: true })
      fs.writeFileSync(
        path.join(agentRoot, "awaiting", "weird.md"),
        ["---", "condition: c", "cadence: 5m", "status: resolved", "---", "", ""].join("\n"),
        "utf-8",
      )
      const result = parse(cancelAwaitDef.handler({ name: "weird" }, undefined) as string)
      expect(result.error).toMatch(/not pending/)
    })

    it("rejects double-cancel", async () => {
      await file("hey_export")
      cancelAwaitDef.handler({ name: "hey_export" }, undefined)
      const result = parse(cancelAwaitDef.handler({ name: "hey_export" }, undefined) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("limits relationship cancellation to the exact friend, channel, key, and request", async () => {
      const context = (friendId: string, requestId: string) => ({
        currentSession: { friendId, channel: "telegram", key: `telegram:777:${friendId}`, sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId, authorizedContextScopes: ["own_requests"], advertisedToolNames: ["await_condition", "cancel_await"], authorizeTool: vi.fn() },
      })
      const mine = context("sibling", "request-mine")
      const otherRequest = context("sibling", "request-other")
      const otherFriend = context("cousin", "request-mine")
      await fileAwaitDef.handler({ name: "mine", condition: "mine", cadence: "5m" }, mine as any)
      await fileAwaitDef.handler({ name: "other", condition: "other", cadence: "5m" }, otherRequest as any)

      expect(parse(cancelAwaitDef.handler({ name: "other" }, mine as any) as string).error).toMatch(/current relationship request/u)
      expect(parse(cancelAwaitDef.handler({ name: "mine" }, otherFriend as any) as string).error).toMatch(/current relationship request/u)
      expect(parse(cancelAwaitDef.handler({ name: "mine" }, mine as any) as string).canceled).toBe("mine")
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "other.md"))).toBe(true)

      expect(parse(cancelAwaitDef.handler({}, mine as any) as string).error).toMatch(/current relationship request/u)
    })
  })

  describe("relationship resolve_await", () => {
    it("resolves only the await bound to the exact current relationship request", async () => {
      const context = (requestId: string) => ({
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId, authorizedContextScopes: ["own_requests"], advertisedToolNames: ["resolve_await"], authorizeTool: vi.fn() },
      })
      const mine = context("request-mine")
      const other = context("request-other")
      await fileAwaitDef.handler({ name: "mine", condition: "ready", cadence: "5m" }, mine as any)

      expect(parse(await resolveAwaitDef.handler({ name: "mine", verdict: "yes", observation: "ready" }, other as any) as string).error).toMatch(/current relationship request/u)
      expect(parse(await resolveAwaitDef.handler({ name: "mine", verdict: "yes", observation: "ready" }, mine as any) as string)).toMatchObject({ verdict: "yes", archived: expect.stringContaining("mine.md") })
      expect(mockDeliverAwaitAlert).toHaveBeenCalledWith(expect.objectContaining({
        awaitFile: expect.objectContaining({ filed_for_friend_id: "sibling", filed_from: "telegram", filed_from_key: "telegram:777:888", request_id: "request-mine" }),
      }))
    })

    it("terminally cancels an await whose exact request obligation became stale before dispatch", async () => {
      const ctx = {
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId: "request-stale", authorizedContextScopes: ["own_requests"], advertisedToolNames: ["resolve_await"], authorizeTool: vi.fn() },
      }
      await fileAwaitDef.handler({ name: "stale", condition: "ready", cadence: "5m" }, ctx as any)
      const [obligation] = readVerifiedPendingObligations(agentRoot)
      advanceObligation(agentRoot, obligation!.id, { status: "fulfilled" })

      const result = parse(await resolveAwaitDef.handler({ name: "stale", verdict: "yes", observation: "ready" }, ctx as any) as string)

      expect(result.error).toMatch(/no longer active/u)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "stale.md"))).toBe(false)
      expect(readDoneFile(agentRoot, "stale")).toContain("status: canceled")
      expect(readDoneFile(agentRoot, "stale")).toContain("cancel_reason: request obligation is no longer active")
    })

    it("preserves an await when its exact obligation record exists but cannot be verified", async () => {
      const ctx = {
        currentSession: { friendId: "sibling", channel: "telegram", key: "telegram:777:888", sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId: "request-corrupt", authorizedContextScopes: ["own_requests"], advertisedToolNames: ["resolve_await"], authorizeTool: vi.fn() },
      }
      await fileAwaitDef.handler({ name: "corrupt", condition: "ready", cadence: "5m" }, ctx as any)
      const [obligation] = readVerifiedPendingObligations(agentRoot)
      fs.writeFileSync(path.join(agentRoot, "arc", "obligations", `${obligation!.id}.json`), "{not-json", "utf8")

      await expect(resolveAwaitDef.handler({ name: "corrupt", verdict: "yes", observation: "ready" }, ctx as any)).rejects.toThrow(/could not be verified/u)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "corrupt.md"))).toBe(true)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", ".done", "corrupt.md"))).toBe(false)
    })
  })

  describe("delivery deps injection", () => {
    it("resetAwaitToolDeps clears injection and uses default writer", async () => {
      resetAwaitToolDeps()
      // file an await
      await fileAwaitDef.handler(
        { name: "hey_export", condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )
      // mock identity for default deps
      const { getPrivateRuntimePendingDir } = await import("../../mind/pending")
      const pendingDir = getPrivateRuntimePendingDir("slugger")
      cleanup.push(path.dirname(path.dirname(pendingDir))) // catch parent dirs

      // make alert path go through buildAwaitDeliveryDeps -> default
      mockDeliverAwaitAlert.mockImplementationOnce(async ({ deliveryDeps }) => {
        // exercise queuePending to ensure default writer works
        deliveryDeps.queuePending({
          from: "slugger",
          friendId: "ari",
          channel: "bluebubbles",
          key: "x",
          content: "msg",
          timestamp: 123,
        })
        return { attempted: true, delivery: { status: "queued_for_later", detail: "queued" } }
      })

      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      // a pending envelope was queued
      const files = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []
      expect(files.length).toBeGreaterThan(0)
    })

    it("default writer caps oversized pending message content before queueing", async () => {
      resetAwaitToolDeps()
      await fileAwaitDef.handler(
        { name: "hey_export", condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )
      const { getPrivateRuntimePendingDir } = await import("../../mind/pending")
      const pendingDir = getPrivateRuntimePendingDir("slugger")
      cleanup.push(path.dirname(path.dirname(pendingDir)))
      const oversized = makeOversizedAgentContent("await fallback pending ")

      mockDeliverAwaitAlert.mockImplementationOnce(async ({ deliveryDeps }) => {
        deliveryDeps.queuePending({
          from: "slugger",
          friendId: "ari",
          channel: "bluebubbles",
          key: "x",
          content: oversized,
          timestamp: 123,
        })
        return { attempted: true, delivery: { status: "queued_for_later", detail: "queued" } }
      })

      await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      )

      const [queuedFile] = fs.readdirSync(pendingDir)
      const queued = JSON.parse(fs.readFileSync(path.join(pendingDir, queuedFile), "utf-8")) as { content: string }
      const expected = expectedCappedContent(oversized)
      const marker = expectedTruncationMarker(oversized)
      expect({
        equalsExpected: queued.content === expected,
        includesMarker: queued.content.includes(marker),
      }).toEqual({ equalsExpected: true, includesMarker: true })
    })

    it("setAwaitToolDeps overrides delivery deps factory", async () => {
      const customQueue = vi.fn()
      setAwaitToolDeps({
        buildDeliveryDeps: () => ({ agentName: "custom-agent", queuePending: customQueue }),
      })

      await fileAwaitDef.handler(
        { name: "hey_export", condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )

      mockDeliverAwaitAlert.mockImplementationOnce(async ({ deliveryDeps }) => {
        expect(deliveryDeps.agentName).toBe("custom-agent")
        deliveryDeps.queuePending({ from: "x", friendId: "ari", channel: "bluebubbles", key: "x", content: "y", timestamp: 1 })
        return { attempted: true, delivery: { status: "queued_for_later", detail: "ok" } }
      })

      await resolveAwaitDef.handler({ name: "hey_export", verdict: "yes", observation: "ok" }, undefined)
      expect(customQueue).toHaveBeenCalled()
    })
  })

  describe("relationship follow-up verification", () => {
    it("rejects malformed or missing await artifacts and fulfills orphaned revocation obligations", () => {
      const route = { friendId: "sibling", channel: "telegram", key: "telegram:777:888" }
      createObligation(agentRoot, { origin: route, owedTo: route, requestId: "request-unbound", content: "c" })
      const malformed = createObligation(agentRoot, { origin: route, owedTo: route, requestId: "request-malformed", content: "c" })
      advanceObligation(agentRoot, malformed.id, { currentSurface: { kind: "session", label: "telegram" }, currentArtifact: "awaiting/.md", nextAction: "c" })
      expect(hasActiveRelationshipFollowUp(agentRoot, { ...route, requestId: "request-malformed" })).toBe(false)

      const missing = createObligation(agentRoot, { origin: route, owedTo: route, requestId: "request-missing", content: "c" })
      advanceObligation(agentRoot, missing.id, { currentSurface: { kind: "session", label: "telegram" }, currentArtifact: "awaiting/missing.md", nextAction: "c" })
      expect(hasActiveRelationshipFollowUp(agentRoot, { ...route, requestId: "request-missing" })).toBe(false)

      cancelRelationshipFollowUps(agentRoot, "slugger", route)
      expect(readVerifiedPendingObligations(agentRoot)).toEqual([])
    })

    it("cancels an exact live request await when the relationship is revoked", async () => {
      const route = { friendId: "sibling", channel: "telegram", key: "telegram:777:888" }
      await fileAwaitDef.handler({ name: "revoked_request", condition: "c", cadence: "5m" }, {
        currentSession: { ...route, sessionPath: "/tmp/session.json" },
        relationshipAuthorization: { requestId: "request-revoked", authorizedContextScopes: ["own_requests"], advertisedToolNames: ["await_condition"], authorizeTool: vi.fn() },
      } as any)

      cancelRelationshipFollowUps(agentRoot, "slugger", route)

      expect(fs.existsSync(path.join(agentRoot, "awaiting", "revoked_request.md"))).toBe(false)
      expect(readDoneFile(agentRoot, "revoked_request")).toContain("cancel_reason: relationship revoked")
      expect(readVerifiedPendingObligations(agentRoot)).toEqual([])
    })
  })

  describe("tool registration shape", () => {
    it("exposes three tools with the expected names and required params", () => {
      const names = awaitingToolDefinitions.map((d) => d.tool.function.name).sort()
      expect(names).toEqual(["await_condition", "cancel_await", "resolve_await"])
    })
  })
})
