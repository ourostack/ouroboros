import { describe, expect, it, vi } from "vitest"

import { createSanctuarySabClient } from "../../senses/sanctuary-sab"

const loadApiKey = () => Promise.resolve("test-only")

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("Sanctuary SAB client", () => {
  it("constructs lazily with an explicit credential loader", () => {
    expect(createSanctuarySabClient({ loadApiKey })).toMatchObject({ readQueue: expect.any(Function), resumeQueue: expect.any(Function) })
  })

  it("reads a bounded queue snapshot without exposing its credential", async () => {
    const fetch = vi.fn(async () => response({ queue: { paused: true, status: "Paused", noofslots: "12" } }))
    const loadRotatingApiKey = vi.fn().mockResolvedValueOnce("test-only").mockResolvedValueOnce("rotated-test-only")
    const client = createSanctuarySabClient({ loadApiKey: loadRotatingApiKey, fetch, now: () => "2026-08-30T04:00:00.000Z" })
    await expect(client.readQueue()).resolves.toEqual({ paused: true, status: "Paused", queuedJobs: 12, observedAt: "2026-08-30T04:00:00.000Z", stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:8090\/api\?mode=queue&output=json&apikey=/u), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(JSON.stringify(await client.readQueue())).not.toContain("test-only")
    expect(fetch.mock.calls[1]?.[0]).toContain("apikey=rotated-test-only")
    expect(loadRotatingApiKey).toHaveBeenCalledTimes(2)
  })

  it("resumes exactly once and independently verifies paused=false", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ queue: { paused: true, status: "Paused", noofslots: 2 } }))
      .mockResolvedValueOnce(response({ status: true }))
      .mockResolvedValueOnce(response({ queue: { paused: false, status: "Downloading", noofslots: 2 } }))
    const result = await createSanctuarySabClient({ loadApiKey, fetch, now: () => "2026-08-30T04:00:00.000Z" }).resumeQueue()
    expect(result).toMatchObject({ changed: true, before: { paused: true }, after: { paused: false }, verified: true, receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(fetch.mock.calls[1]?.[0]).toMatch(/mode=resume/u)
  })

  it("tolerates an unreadable resume body while independently verifying the queue", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("body already closed"))
    const resumeResponse = { ok: true, body: { cancel } } as unknown as Response
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ queue: { paused: true } }))
      .mockResolvedValueOnce(resumeResponse)
      .mockResolvedValueOnce(response({ queue: { paused: false } }))

    await expect(createSanctuarySabClient({ loadApiKey, fetch, now: () => "2026-08-30T04:00:00.000Z" }).resumeQueue()).resolves.toMatchObject({
      changed: true,
      before: { paused: true, status: "unknown", queuedJobs: 0 },
      after: { paused: false, status: "unknown", queuedJobs: 0 },
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("is idempotent when already resumed and fails if after-state remains paused", async () => {
    const already = vi.fn(async () => response({ queue: { paused: false, status: "Idle", noofslots: 0 } }))
    await expect(createSanctuarySabClient({ loadApiKey, fetch: already }).resumeQueue()).resolves.toMatchObject({ changed: false, verified: true, before: { paused: false }, after: { paused: false } })
    expect(already).toHaveBeenCalledOnce()

    const failed = vi.fn()
      .mockResolvedValueOnce(response({ queue: { paused: true, status: "Paused", noofslots: 1 } }))
      .mockResolvedValueOnce(response({ status: true }))
      .mockResolvedValueOnce(response({ queue: { paused: true, status: "Paused", noofslots: 1 } }))
    await expect(createSanctuarySabClient({ loadApiKey, fetch: failed }).resumeQueue()).rejects.toThrow("could not be verified")
  })

  it.each([
    ["missing credential", "", null],
    ["request failure", "test-only", new Error("offline")],
    ["HTTP failure", "test-only", response({}, 503)],
    ["malformed queue", "test-only", response({ queue: { paused: "yes" } })],
  ])("fails closed for %s", async (_label, credential, result) => {
    const fetch = vi.fn(async () => { if (result instanceof Error) throw result; return result as Response })
    const client = createSanctuarySabClient({ loadApiKey: async () => credential, fetch })
    if (!credential) await expect(client.readQueue()).rejects.toThrow(/credential/u)
    else await expect(client.readQueue()).rejects.toThrow(/request|malformed/u)
  })

  it.each([
    ["non-integer job count", { queue: { paused: false, noofslots: 1.5 } }],
    ["negative job count", { queue: { paused: false, noofslots: -1 } }],
    ["excessive job count", { queue: { paused: false, noofslots: 1_000_001 } }],
    ["missing body", null],
    ["primitive body", "invalid"],
    ["array body", []],
    ["missing queue", {}],
    ["primitive queue", { queue: "invalid" }],
    ["array queue", { queue: [] }],
  ])("rejects malformed queue response: %s", async (_label, body) => {
    const fetch = vi.fn(async () => response(body))
    await expect(createSanctuarySabClient({ loadApiKey, fetch }).readQueue()).rejects.toThrow("SAB queue response is malformed")
  })

  it("isolates an unavailable vault credential until an SAB operation is requested", async () => {
    const client = createSanctuarySabClient({ loadApiKey: async () => { throw new Error("vault unavailable") } })
    expect(client).toMatchObject({ readQueue: expect.any(Function), resumeQueue: expect.any(Function) })
    await expect(client.readQueue()).rejects.toThrow("credential is unavailable")
  })
})
