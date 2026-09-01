import { describe, expect, it } from "vitest"

import { sanctuaryFullVisibilityEmptyResponse, sanctuaryFullVisibilityRequiredToolCalls, sanctuaryStaleDockerCareRequiredToolCalls } from "../../senses/sanctuary-full-visibility-contract"
import type { CareRecord } from "../../arc/cares"

const requiredNames = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "unraid_get_notifications", "sanctuary_get_download_queue"]
const advertised = [...requiredNames, "settle", "speak"]

describe("Sanctuary full-visibility read contract", () => {
  it.each([
    "What are you working on?",
    "What's going on with Sanctuary?",
    "  WHAT’S GOING ON WITH SANCTUARY?!  ",
    "Anything I should care about now?",
    "Is there anything going on that I should know about right now?",
    "What's up?",
    "Everything good?",
    "Anything wrong?",
  ])("requires all current household evidence for %j", (request) => {
    const contract = sanctuaryFullVisibilityRequiredToolCalls(request, advertised)

    expect(contract).toEqual({
      names: requiredNames,
      retryMessage: "Before answering, read current active work, cares, system health, service state, storage, notifications, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.",
      requireSuccessfulResults: true,
      validateRequiredToolResult: expect.any(Function),
      validateTerminalAnswer: expect.any(Function),
      emptyResponseFallback: expect.any(Function),
    })
  })

  it("accepts only the exact current-result shape for each required read", () => {
    const validate = sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised)!.validateRequiredToolResult

    expect(validate("query_active_work", "this is my current top-level live world-state.\nhealthy")).toBe(true)
    expect(validate("query_active_work", "current live world-state")).toBe(false)
    expect(validate("query_active_work", "  ")).toBe(false)
    expect(validate("query_active_work", "x".repeat(1_000_001))).toBe(false)
    expect(validate("query_cares", "[]")).toBe(true)
    expect(validate("query_cares", "{}")).toBe(false)
    for (const name of requiredNames.slice(2, -1).filter((name) => name !== "unraid_get_notifications")) {
      expect(validate(name, JSON.stringify({ ok: true, data: {} }))).toBe(true)
      for (const malformed of ["null", "[]", "{}", JSON.stringify({ ok: null }), "not-json"]) expect(validate(name, malformed)).toBe(false)
    }
    const queue = { paused: true, status: "Paused", queuedJobs: 12, observedAt: "2026-08-30T04:00:00.000Z", stateDigest: "a".repeat(64) }
    expect(validate("sanctuary_get_download_queue", JSON.stringify(queue))).toBe(true)
    for (const malformed of ["null", "[]", "{}", JSON.stringify({ ok: true }), JSON.stringify({ ...queue, queuedJobs: -1 }), JSON.stringify({ ...queue, extra: true })]) {
      expect(validate("sanctuary_get_download_queue", malformed)).toBe(false)
    }
  })

  it("accepts only the exact current credential-unavailable observation and then forbids guessed queue state", () => {
    const contract = sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised)!
    const unavailable = { ok: false, error: { code: "credential_unavailable" }, observedAt: "2026-08-30T04:00:00.000Z" }

    expect(contract.validateRequiredToolResult("sanctuary_get_download_queue", JSON.stringify(unavailable))).toBe(true)
    for (const code of ["request_unavailable", "malformed_response"]) {
      expect(contract.validateRequiredToolResult("sanctuary_get_download_queue", JSON.stringify({ ...unavailable, error: { code } }))).toBe(true)
    }
    for (const malformed of [
      { ...unavailable, stale: true },
      { ...unavailable, error: { code: "request_failed" } },
      { ...unavailable, observedAt: "yesterday" },
      { ...unavailable, error: { code: "credential_unavailable", message: "secret path" } },
    ]) expect(contract.validateRequiredToolResult("sanctuary_get_download_queue", JSON.stringify(malformed))).toBe(false)
    expect(contract.validateTerminalAnswer("")).toMatch(/do not return an empty answer/iu)
    for (const claim of ["Downloads are paused with 12 queued jobs.", "The download queue is healthy.", "The queue is clear.", "The queue is empty.", "Downloads are active.", "Downloads are fine; no problem."]) {
      expect(contract.validateTerminalAnswer(claim)).toMatch(/could not be verified/iu)
    }
    expect(contract.validateTerminalAnswer("The other checks are healthy; I can't currently verify the download queue.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("The download queue could not be verified.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("I couldn't verify whether downloads are paused.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("I don't know whether downloads are paused.")).toBeUndefined()
  })

  it("provides a narrow post-agent fallback only for whole-status requests", () => {
    expect(sanctuaryFullVisibilityEmptyResponse("What's going on with Sanctuary?")).toMatch(/won't guess or reuse old alerts/iu)
    expect(sanctuaryFullVisibilityEmptyResponse("status?")).toBeUndefined()
  })

  it("does not enable the empty fallback until every required current read completed", () => {
    const contract = sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised)!
    expect(contract.emptyResponseFallback()).toBeUndefined()
    const results: Record<string, string> = {
      query_active_work: "this is my current top-level live world-state.\nhealthy",
      query_cares: "[]",
      unraid_get_system: JSON.stringify({ ok: true }),
      unraid_list_containers: JSON.stringify({ ok: true }),
      unraid_get_storage: JSON.stringify({ ok: true }),
      unraid_get_notifications: JSON.stringify({ ok: true, data: { unacknowledged: [], truncated: false } }),
      sanctuary_get_download_queue: JSON.stringify({ ok: false, error: { code: "request_unavailable" }, observedAt: "2026-08-30T04:00:00.000Z" }),
    }
    for (const name of requiredNames) {
      expect(contract.validateRequiredToolResult(name, results[name]!)).toBe(true)
      if (name !== requiredNames.at(-1)) expect(contract.emptyResponseFallback()).toBeUndefined()
    }
    expect(contract.emptyResponseFallback()).toMatch(/won't guess or reuse old alerts/iu)
    expect(contract.validateRequiredToolResult("query_cares", "not-json")).toBe(false)
    expect(contract.emptyResponseFallback()).toMatch(/won't guess or reuse old alerts/iu)
  })

  it.each([
    "How much space is left?",
    "What's going on with the movie request?",
    "What are you working on tomorrow?",
    "Do you care about me right now?",
    "What did I care about yesterday?",
    "Should I care about Docker labels?",
    "What is Plex doing now?",
    "Anything I should care about in this document?",
    "What's up with this document?",
    "Is everything good in Plex?",
    "Is anything wrong with this movie request?",
    "",
  ])("leaves unrelated requests alone for %j", (request) => {
    expect(sanctuaryFullVisibilityRequiredToolCalls(request, advertised)).toBeUndefined()
  })

  it("accepts only bounded structured notification reads", () => {
    const validate = sanctuaryFullVisibilityRequiredToolCalls("Anything I should care about now?", advertised)!.validateRequiredToolResult
    expect(validate("unraid_get_notifications", JSON.stringify({ ok: true, data: { unacknowledged: [], truncated: false } }))).toBe(true)
    expect(validate("unraid_get_notifications", JSON.stringify({ ok: false, error: { code: "transport", message: "offline", degraded: true } }))).toBe(true)
    for (const value of [
      null,
      { ok: true, data: { unacknowledged: null, truncated: false } },
      { ok: true, data: { unacknowledged: [], truncated: "no" } },
      { ok: false, error: { code: "offline" } },
      { ok: false, error: { code: "transport", message: "offline", degraded: false } },
      { ok: false, error: { code: "transport", message: "x".repeat(513), degraded: true } },
    ]) expect(validate("unraid_get_notifications", JSON.stringify(value))).toBe(false)
  })

  it("returns a fail-closed contract even when a required current read is not advertised", () => {
    for (const missing of requiredNames) {
      expect(sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised.filter((name) => name !== missing))?.names).toEqual(requiredNames)
    }
  })

  describe("stale Docker Care verifier", () => {
    const now = Date.parse("2026-09-01T08:00:00.000Z")
    const staleCare: CareRecord = {
      id: "care-docker", label: "Docker is full", why: "writes fail", kind: "system", status: "active", salience: "critical", steward: "mine",
      relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [], currentRisk: "full", nextCheckAt: "2026-09-01T07:45:00.000Z",
      incidentBindings: [{ source: "sanctuary-health::Docker_critical_image_disk_utilization", incidentKey: "docker-image-disk-100pct-20260831T1427Z", classifiedRevision: "a".repeat(64) }],
      createdAt: "2026-08-31T14:27:00.000Z", updatedAt: "2026-09-01T07:40:00.000Z",
    }

    it("ignores legacy, malformed, future, and already-resolved neighbors", () => {
      const neighbors = [
        { ...staleCare, incidentBindings: undefined },
        { ...staleCare, id: "wrong-source", incidentBindings: [{ ...staleCare.incidentBindings![0]!, source: "manual" }] },
        { ...staleCare, id: "wrong-key", incidentBindings: [{ ...staleCare.incidentBindings![0]!, incidentKey: "docker-image-disk-current" }] },
        { ...staleCare, id: "future", nextCheckAt: "2026-09-01T08:01:00.000Z" },
        { ...staleCare, id: "resolved", incidentBindings: [{ ...staleCare.incidentBindings![0]!, resolvedAt: "2026-09-01T07:59:00.000Z" }] },
      ] as CareRecord[]
      expect(sanctuaryStaleDockerCareRequiredToolCalls(neighbors, now, ["unraid_get_notifications", "care_manage"])).toBeUndefined()
    })

    it("requires notification evidence before the exact active Care refresh", () => {
      const contract = sanctuaryStaleDockerCareRequiredToolCalls([staleCare], now, ["unraid_get_notifications", "care_manage"])!
      expect(contract.names).toEqual(["unraid_get_notifications"])
      expect(contract.retryMessage).toMatch(/Recheck the stale Docker/iu)
      expect(contract.validateToolCallBeforeDispatch("care_manage", { action: "resolve", id: staleCare.id })).toMatch(/notifications/iu)
      const result = JSON.stringify({ ok: true, data: { truncated: false, unacknowledged: [{ id: "docker-new", createdAt: "2026-09-01T07:50:00.000Z", severity: "critical", title: "Docker critical image disk utilization", summary: "Docker image disk utilization is 100%", degraded: false }] } })
      expect(contract.validateRequiredToolResult("unraid_get_notifications", result, {})).toBe(true)
      expect(contract.requiredToolCallsAfterResult("unraid_get_notifications", {}, result)).toEqual(["care_manage"])
      const expected = contract.expectedMutations()[0]!
      expect(expected).toMatchObject({ action: "upsert_incident", id: staleCare.id, label: "Docker image disk utilization", why: "Current Unraid notification evidence was checked.", currentRisk: "A fresh Unraid notification reports high Docker image disk utilization.", expectedUpdatedAt: staleCare.updatedAt, nextCheckAt: "2026-09-01T08:15:00.000Z" })
      expect(expected.classifiedRevision).toMatch(/^[a-f0-9]{64}$/u)
      expect(contract.validateToolCallBeforeDispatch("care_manage", expected)).toBeUndefined()
      const refreshedCare = { ...staleCare, status: "active" as const, label: expected.label, why: expected.why, currentRisk: expected.currentRisk, nextCheckAt: expected.nextCheckAt, updatedAt: "2026-09-01T08:00:01.000Z", incidentBindings: [{ ...staleCare.incidentBindings![0]!, classifiedRevision: expected.classifiedRevision }] }
      const careResult = JSON.stringify(refreshedCare)
      expect(contract.validateRequiredToolResult("care_manage", careResult, expected)).toBe(true)
      expect(sanctuaryStaleDockerCareRequiredToolCalls([refreshedCare], now, ["unraid_get_notifications", "care_manage"])).toBeUndefined()
    })

    it.each([
      { ok: true, data: { truncated: false, unacknowledged: [] } },
      { ok: true, data: { truncated: true, unacknowledged: [] } },
      { ok: true, data: { truncated: false, unacknowledged: [{ id: "unrelated", createdAt: "2026-09-01T07:50:00.000Z", severity: "info", title: "Array healthy", summary: "No issues", degraded: false }] } },
      { ok: true, data: { truncated: false, unacknowledged: [{ id: "degraded", createdAt: "2026-09-01T07:50:00.000Z", severity: "critical", title: "Docker image disk utilization", summary: "100%", degraded: true }] } },
      { ok: true, data: { truncated: false, unacknowledged: [null, { id: "malformed", title: "Docker image disk utilization" }] } },
      { ok: true, data: { truncated: false, unacknowledged: [{ id: "equal", createdAt: "2026-09-01T07:45:00.000Z", severity: "critical", title: "Docker image disk utilization", summary: "100%", degraded: false }] } },
      { ok: true, data: { truncated: false, unacknowledged: [{ id: "older", createdAt: "2026-09-01T07:44:59.999Z", severity: "critical", title: "Docker image disk utilization", summary: "100%", degraded: false }] } },
      { ok: true, data: { truncated: false, unacknowledged: [{ id: "neutral", createdAt: "2026-09-01T07:50:00.000Z", severity: "info", title: "Docker image disk utilization notice", summary: "Measurement completed", degraded: false }] } },
      { ok: false, error: { code: "request_unavailable" }, observedAt: "2026-09-01T08:00:00.000Z" },
      "not-json",
    ])("turns completed but non-authoritative evidence into a safe inconclusive refresh", (observation) => {
      const contract = sanctuaryStaleDockerCareRequiredToolCalls([staleCare], now, ["unraid_get_notifications", "care_manage"])!
      const result = typeof observation === "string" ? observation : JSON.stringify(observation)
      expect(contract.validateRequiredToolResult("unraid_get_notifications", result, {})).toBe(true)
      contract.requiredToolCallsAfterResult("unraid_get_notifications", {}, result)
      expect(contract.retryMessage).toMatch(/"action":"upsert_incident"/u)
      expect(contract.expectedMutations()[0]).toMatchObject({ action: "upsert_incident", id: staleCare.id, currentRisk: "Docker image disk utilization verification is inconclusive.", classifiedRevision: "a".repeat(64) })
    })

    it("resolves only from a fresh explicit recovery observation", () => {
      const contract = sanctuaryStaleDockerCareRequiredToolCalls([staleCare], now, ["unraid_get_notifications", "care_manage"])!
      const result = JSON.stringify({ ok: true, data: { truncated: false, unacknowledged: [{ id: "docker-recovered", createdAt: "2026-09-01T07:50:00.000Z", severity: "info", title: "Docker image disk utilization recovered", summary: "Utilization returned to normal", degraded: false }] } })
      expect(contract.validateRequiredToolResult("unraid_get_notifications", result, {})).toBe(true)
      contract.requiredToolCallsAfterResult("unraid_get_notifications", {}, result)
      const expected = contract.expectedMutations()[0]!
      expect(expected).toMatchObject({ action: "resolve_incident", id: staleCare.id, currentRisk: "", nextCheckAt: "" })
      const resolvedCare = { ...staleCare, status: "resolved" as const, label: expected.label, why: expected.why, currentRisk: null, nextCheckAt: null, updatedAt: "2026-09-01T08:00:01.000Z", incidentBindings: [{ ...staleCare.incidentBindings![0]!, resolvedAt: "2026-09-01T08:00:01.000Z" }] }
      const resolved = JSON.stringify(resolvedCare)
      expect(contract.validateRequiredToolResult("care_manage", resolved, expected)).toBe(true)
      expect(sanctuaryStaleDockerCareRequiredToolCalls([resolvedCare], now, ["unraid_get_notifications", "care_manage"])).toBeUndefined()
    })

    it("resolves only the Docker binding when another incident remains unresolved", () => {
      const multiBindingCare: CareRecord = { ...staleCare, incidentBindings: [...staleCare.incidentBindings!, { source: "other", incidentKey: "other", classifiedRevision: "rev" }] }
      const contract = sanctuaryStaleDockerCareRequiredToolCalls([multiBindingCare], now, ["unraid_get_notifications", "care_manage"])!
      const result = JSON.stringify({ ok: true, data: { truncated: false, unacknowledged: [{ id: "docker-recovered", createdAt: "2026-09-01T07:50:00.000Z", severity: "info", title: "Docker image disk utilization recovered", summary: "Utilization returned to normal", degraded: false }] } })
      contract.requiredToolCallsAfterResult("unraid_get_notifications", {}, result)
      expect(contract.expectedMutations()[0]).toMatchObject({
        action: "resolve_incident",
        currentRisk: "The verified incident recovered, but this Care still has unresolved context that needs review.",
        nextCheckAt: "2026-09-01T08:15:00.000Z",
      })
    })

    it("still clears quietly when the only neighboring binding is already resolved", () => {
      const resolvedNeighborCare: CareRecord = { ...staleCare, incidentBindings: [...staleCare.incidentBindings!, { source: "other", incidentKey: "old", classifiedRevision: "rev", resolvedAt: "2026-08-31T00:00:00.000Z" }] }
      const contract = sanctuaryStaleDockerCareRequiredToolCalls([resolvedNeighborCare], now, ["unraid_get_notifications", "care_manage"])!
      const result = JSON.stringify({ ok: true, data: { truncated: false, unacknowledged: [{ id: "docker-recovered", createdAt: "2026-09-01T07:50:00.000Z", severity: "info", title: "Docker image disk utilization recovered", summary: "Utilization returned to normal", degraded: false }] } })
      contract.requiredToolCallsAfterResult("unraid_get_notifications", {}, result)
      expect(contract.expectedMutations()[0]).toMatchObject({ action: "resolve_incident", currentRisk: "", nextCheckAt: "" })
    })

    it("rejects wrong, oversized, and malformed mutation results without expanding authority", () => {
      const contract = sanctuaryStaleDockerCareRequiredToolCalls([staleCare], now, ["unraid_get_notifications", "care_manage"])!
      expect(contract.validateRequiredToolResult("other", "{}", {})).toBe(false)
      expect(contract.validateRequiredToolResult("unraid_get_notifications", "x".repeat(1_000_001), {})).toBe(false)
      expect(contract.requiredToolCallsAfterResult("other", {}, "{}")).toEqual([])
      expect(contract.validateToolCallBeforeDispatch("other", {})).toBeUndefined()
      const result = JSON.stringify({ ok: true, data: { truncated: false, unacknowledged: [] } })
      contract.requiredToolCallsAfterResult("unraid_get_notifications", {}, result)
      expect(contract.validateToolCallBeforeDispatch("care_manage", { action: "resolve", id: staleCare.id })).toMatch(/Only these exact/iu)
      const expected = contract.expectedMutations()[0]!
      expect(contract.validateRequiredToolResult("care_manage", "not-json", expected)).toBe(false)
      expect(contract.validateRequiredToolResult("care_manage", "{}", expected)).toBe(false)
      expect(contract.validateRequiredToolResult("care_manage", JSON.stringify({ id: expected.id, label: expected.label, why: expected.why, currentRisk: expected.currentRisk, nextCheckAt: expected.nextCheckAt, status: expected.status, incidentBindings: [] }), expected)).toBe(false)
      expect(contract.validateRequiredToolResult("care_manage", "{}", { ...expected, extra: "no" })).toBe(false)
    })
  })

  it("rejects unsupported current Docker-image measurements but allows explicit uncertainty", () => {
    const validate = sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised)!.validateTerminalAnswer

    expect(validate("Docker image disk is at 100%.")).toMatch(/No current Butler tool measures/)
    expect(validate("docker.img is full")).toMatch(/No current Butler tool measures/)
    expect(validate("Docker image was 97.5% in a prior care.")).toMatch(/No current Butler tool measures/)
    expect(validate("I can't fix it, but Docker image is 100%.")).toMatch(/No current Butler tool measures/)
    expect(validate("Docker image has no space left; new writes will fail.")).toMatch(/No current Butler tool measures/)
    expect(validate("Docker image is healthy but needs a fresh check.")).toMatch(/No current Butler tool measures/)
    expect(validate("Docker image utilization needs a fresh authoritative check.")).toBeUndefined()
    expect(validate("I cannot currently measure Docker image utilization.")).toBeUndefined()
    expect(validate("Docker containers are running.")).toBeUndefined()
    expect(validate("The array is 74% used; Docker image needs a fresh check.")).toBeUndefined()
    expect(validate("Astraweb block credit ran out about 40 hours ago.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("SABnzbd hasn't authenticated since yesterday.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("The Usenet provider requires a top-up.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("Astraweb is still the blocker.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("Astraweb has no credit left.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("Provider credit is zero.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("Astraweb balance is zero.")).toMatch(/queue read does not prove provider credit/)
    expect(validate("Astraweb block credit exhaustion is unverified and needs a fresh authoritative check.")).toBeUndefined()
    expect(validate("The prior Astraweb alert is historical and needs verification.")).toBeUndefined()
    expect(validate("Downloads are paused with 12 queued jobs.")).toBeUndefined()
    expect(validate("SABnzbd is running and its queue is paused.")).toBeUndefined()
    expect(validate("SABnzbd authentication state is unverified.")).toBeUndefined()
  })
})
