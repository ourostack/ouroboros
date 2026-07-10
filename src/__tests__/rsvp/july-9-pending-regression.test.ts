import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { replayJuly9PendingAnswerFixture } from "../../rsvp/replay"

const manifestPath = path.resolve(__dirname, "../fixtures/rsvp/july-9-context/manifest.json")

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
})
