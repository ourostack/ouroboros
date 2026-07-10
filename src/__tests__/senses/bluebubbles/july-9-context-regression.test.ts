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

  it("rejects stale, unsafe, or incomplete July 9 context manifests without live fallback", async () => {
    const { replayJuly9BlueBubblesContextFixture } = await import("../../../senses/bluebubbles/replay")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "july9-bluebubbles-"))
    const variantPath = path.join(root, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    const querySession = vi.fn(() => {
      throw new Error("query_session must not be used while replaying malformed context")
    })
    try {
      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, policyVersion: "old" }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("unsupported July 9 replay manifest")

      const unsafePrivacyVariants = [
        { privacy: null, expectedViolation: "privacy" },
        {
          privacy: { ...manifest.privacy, rawLiveTranscriptStored: true },
          expectedViolation: "rawLiveTranscriptStored",
        },
        {
          privacy: { ...manifest.privacy, credentialsStored: true },
          expectedViolation: "credentialsStored",
        },
        {
          privacy: { ...manifest.privacy, searchIndex: true },
          expectedViolation: "searchIndex",
        },
        {
          privacy: { ...manifest.privacy, vectorIndex: true },
          expectedViolation: "vectorIndex",
        },
      ]
      for (const variant of unsafePrivacyVariants) {
        fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, privacy: variant.privacy }), "utf-8")
        await expect(replayJuly9BlueBubblesContextFixture({
          manifestPath: variantPath,
          deps: { querySession },
        })).rejects.toThrow(variant.expectedViolation)
      }

      fs.writeFileSync(variantPath, JSON.stringify([]), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("manifest must be an object")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, expected: null }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("missing expected")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, conversation: null }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({
        manifestPath: variantPath,
        deps: { querySession },
      })).resolves.toMatchObject({
        modelInput: "",
      })

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        conversation: { messages: null },
      }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({
        manifestPath: variantPath,
        deps: { querySession },
      })).resolves.toMatchObject({
        modelInput: "",
      })

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        conversation: {
          ...manifest.conversation,
          messages: [
            { messageGuid: "missing-timestamp", authorLabel: "Slugger", body: "RSVP Update" },
            { messageGuid: "missing-author", timestamp: "2026-07-09T17:00:00.000Z", body: "RSVP Update" },
            { messageGuid: "missing-body", timestamp: "2026-07-09T17:00:00.000Z", authorLabel: "Slugger" },
          ],
        },
      }), "utf-8")
      await expect(replayJuly9BlueBubblesContextFixture({
        manifestPath: variantPath,
        deps: { querySession },
      })).resolves.toMatchObject({
        modelInput: "",
      })
      expect(querySession).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
