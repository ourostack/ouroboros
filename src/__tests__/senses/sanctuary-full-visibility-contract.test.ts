import { describe, expect, it } from "vitest"

import { sanctuaryFullVisibilityEmptyResponse, sanctuaryFullVisibilityRequiredToolCalls } from "../../senses/sanctuary-full-visibility-contract"

const requiredNames = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "sanctuary_get_download_queue"]
const advertised = [...requiredNames, "settle", "speak"]

describe("Sanctuary full-visibility read contract", () => {
  it.each([
    "What are you working on?",
    "What's going on with Sanctuary?",
    "  WHAT’S GOING ON WITH SANCTUARY?!  ",
  ])("requires all current household evidence for %j", (request) => {
    const contract = sanctuaryFullVisibilityRequiredToolCalls(request, advertised)

    expect(contract).toEqual({
      names: requiredNames,
      retryMessage: "Before answering, read current active work, cares, system health, service state, storage, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.",
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
    for (const name of requiredNames.slice(2, -1)) {
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
    "status?",
    "How much space is left?",
    "What's going on with the movie request?",
    "What are you working on tomorrow?",
    "",
  ])("leaves unrelated requests alone for %j", (request) => {
    expect(sanctuaryFullVisibilityRequiredToolCalls(request, advertised)).toBeUndefined()
  })

  it("stays inactive unless every current read is actually advertised", () => {
    for (const missing of requiredNames) {
      expect(sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised.filter((name) => name !== missing))).toBeUndefined()
    }
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
