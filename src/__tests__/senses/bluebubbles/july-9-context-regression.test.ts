import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

const manifestPath = path.resolve(__dirname, "../../../__fixtures__/rsvp/july-9-context/manifest.json")

describe("July 9 BlueBubbles context regression", () => {
  it("bundles prior same-chat RSVP script context into the model input before Slugger answers", async () => {
    const { replayJuly9BlueBubblesContextFixture } = await import("../../../senses/bluebubbles/replay")
    const querySession = vi.fn(() => {
      throw new Error("query_session must not be needed for same-chat context")
    })

    const result = await replayJuly9BlueBubblesContextFixture({
      manifestPath,
      deps: { querySession },
    })

    expect(result).toMatchObject({
      sideEffect: false,
      contextPacketHash: "sha256:july9-context-packet",
      renderedModelInputHash: "sha256:july9-rendered-model-input",
    })
    expect(result.modelInput).toContain("RSVP Update")
    expect(result.modelInput).toContain("149 attending / 123 declined / 1 pending")
    expect(result.modelInput).toContain("who is pending?")
    expect(querySession).not.toHaveBeenCalled()
  })
})
