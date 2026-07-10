import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { replayJuly9PendingAnswerFixture } from "../../rsvp/replay"

const manifestPath = path.resolve(__dirname, "../../__fixtures__/rsvp/july-9-context/manifest.json")

describe("July 9 RSVP pending-answer regression", () => {
  it("answers who is pending from native RSVP state without query_session", async () => {
    const querySession = vi.fn(() => {
      throw new Error("query_session must not be used for the pending answer")
    })

    const result = await replayJuly9PendingAnswerFixture({
      manifestPath,
      deps: { querySession },
    })

    expect(result).toMatchObject({
      sideEffect: false,
      usedNativeRsvpState: true,
      answer: expect.stringContaining("Casey Pending"),
      counts: { attending: 149, declined: 123, pending: 1 },
    })
    expect(querySession).not.toHaveBeenCalled()
  })

  it("rejects stale manifests, missing RSVP state, and malformed counts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "july9-rsvp-"))
    const variantPath = path.join(root, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    try {
      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, policyVersion: "old" }), "utf-8")
      await expect(replayJuly9PendingAnswerFixture({ manifestPath: variantPath })).rejects.toThrow("unsupported July 9 RSVP replay manifest")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, rsvpState: null }), "utf-8")
      await expect(replayJuly9PendingAnswerFixture({ manifestPath: variantPath })).rejects.toThrow("RSVP state missing")

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        rsvpState: {
          ...manifest.rsvpState,
          counts: null,
        },
      }), "utf-8")
      await expect(replayJuly9PendingAnswerFixture({ manifestPath: variantPath })).rejects.toThrow("counts missing")

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        rsvpState: {
          ...manifest.rsvpState,
          counts: { attending: 149, declined: "bad", pending: 1 },
        },
      }), "utf-8")
      await expect(replayJuly9PendingAnswerFixture({ manifestPath: variantPath })).rejects.toThrow("counts must be numeric")

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        rsvpState: {
          ...manifest.rsvpState,
          pendingGuests: null,
        },
      }), "utf-8")
      const result = await replayJuly9PendingAnswerFixture({ manifestPath: variantPath })
      expect(result.answer).toBe("No pending guests in the replay fixture.")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
