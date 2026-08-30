import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createSanctuarySabClient } from "../../senses/sanctuary-sab"

function config(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-sab-"))
  const iniPath = path.join(root, "sabnzbd.ini")
  fs.writeFileSync(iniPath, "api_key = test-only\n")
  return iniPath
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("Sanctuary SAB client", () => {
  it("reads a bounded queue snapshot without exposing its credential", async () => {
    const fetch = vi.fn(async () => response({ queue: { paused: true, status: "Paused", noofslots: "12" } }))
    const client = createSanctuarySabClient({ iniPath: config(), fetch, now: () => "2026-08-30T04:00:00.000Z" })
    await expect(client.readQueue()).resolves.toEqual({ paused: true, status: "Paused", queuedJobs: 12, observedAt: "2026-08-30T04:00:00.000Z", stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:8090\/api\?mode=queue&output=json&apikey=/u), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(JSON.stringify(await client.readQueue())).not.toContain("test-only")
  })

  it("resumes exactly once and independently verifies paused=false", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ queue: { paused: true, status: "Paused", noofslots: 2 } }))
      .mockResolvedValueOnce(response({ status: true }))
      .mockResolvedValueOnce(response({ queue: { paused: false, status: "Downloading", noofslots: 2 } }))
    const result = await createSanctuarySabClient({ iniPath: config(), fetch, now: () => "2026-08-30T04:00:00.000Z" }).resumeQueue()
    expect(result).toMatchObject({ changed: true, before: { paused: true }, after: { paused: false }, verified: true, receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(fetch.mock.calls[1]?.[0]).toMatch(/mode=resume/u)
  })

  it("is idempotent when already resumed and fails if after-state remains paused", async () => {
    const already = vi.fn(async () => response({ queue: { paused: false, status: "Idle", noofslots: 0 } }))
    await expect(createSanctuarySabClient({ iniPath: config(), fetch: already }).resumeQueue()).resolves.toMatchObject({ changed: false, verified: true, before: { paused: false }, after: { paused: false } })
    expect(already).toHaveBeenCalledOnce()

    const failed = vi.fn()
      .mockResolvedValueOnce(response({ queue: { paused: true, status: "Paused", noofslots: 1 } }))
      .mockResolvedValueOnce(response({ status: true }))
      .mockResolvedValueOnce(response({ queue: { paused: true, status: "Paused", noofslots: 1 } }))
    await expect(createSanctuarySabClient({ iniPath: config(), fetch: failed }).resumeQueue()).rejects.toThrow("could not be verified")
  })

  it.each([
    ["missing credential", "", null],
    ["request failure", "api_key = test-only\n", new Error("offline")],
    ["HTTP failure", "api_key = test-only\n", response({}, 503)],
    ["malformed queue", "api_key = test-only\n", response({ queue: { paused: "yes" } })],
  ])("fails closed for %s", async (_label, contents, result) => {
    const iniPath = config()
    fs.writeFileSync(iniPath, contents)
    const fetch = vi.fn(async () => { if (result instanceof Error) throw result; return result as Response })
    if (!contents) await expect(createSanctuarySabClient({ iniPath, fetch }).readQueue()).rejects.toThrow(/credential/u)
    else await expect(createSanctuarySabClient({ iniPath, fetch }).readQueue()).rejects.toThrow(/request|malformed/u)
  })

  it("isolates a missing SAB attachment until an SAB operation is requested", async () => {
    const client = createSanctuarySabClient({ iniPath: path.join(os.tmpdir(), `missing-sab-${Date.now()}.ini`) })
    expect(client).toMatchObject({ readQueue: expect.any(Function), resumeQueue: expect.any(Function) })
    await expect(client.readQueue()).rejects.toThrow("credential is unavailable")
  })
})
