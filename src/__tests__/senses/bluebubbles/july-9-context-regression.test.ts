import * as fs from "node:fs"
import * as os from "node:os"
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

  it("rejects stale or incomplete July 9 context manifests", async () => {
    const { replayJuly9BlueBubblesContextFixture } = await import("../../../senses/bluebubbles/replay")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "july9-bluebubbles-"))
    const variantPath = path.join(root, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    try {
      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, policyVersion: "old" }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("unsupported July 9 replay manifest")

      fs.writeFileSync(variantPath, JSON.stringify([]), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("manifest must be an object")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, expected: null }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("missing expected")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, conversation: null }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).resolves.toMatchObject({
        modelInput: "",
      })

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        conversation: { messages: null },
      }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).resolves.toMatchObject({
        modelInput: "",
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
