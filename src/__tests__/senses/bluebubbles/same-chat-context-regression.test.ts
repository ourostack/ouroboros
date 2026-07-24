import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

const manifestPath = path.resolve(__dirname, "../../../__fixtures__/bluebubbles/same-chat-context/manifest.json")

describe("BlueBubbles same-chat context regression", () => {
  it("bundles prior same-chat messages into model input before the agent answers", async () => {
    const { replayBlueBubblesContextFixture } = await import("../../../senses/bluebubbles/replay")
    const querySession = vi.fn(() => {
      throw new Error("query_session must not be needed for same-chat context")
    })

    const result = await replayBlueBubblesContextFixture({
      manifestPath,
      deps: { querySession },
    })

    expect(result).toMatchObject({
      sideEffect: false,
      contextPacketHash: "sha256:same-chat-context-packet",
      renderedModelInputHash: "sha256:same-chat-rendered-model-input",
    })
    expect(result.modelInput).toContain("Travel Update")
    expect(result.modelInput).toContain("Hotel room 412 is confirmed")
    expect(result.modelInput).toContain("which room?")
    expect(querySession).not.toHaveBeenCalled()
  })

  it("rejects stale, unsafe, or incomplete context manifests without live fallback", async () => {
    const { replayBlueBubblesContextFixture } = await import("../../../senses/bluebubbles/replay")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bluebubbles-context-"))
    const variantPath = path.join(root, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
    const querySession = vi.fn(() => {
      throw new Error("query_session must not be used while replaying malformed context")
    })
    try {
      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, policyVersion: "old" }), "utf-8")
      await expect(replayBlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("unsupported BlueBubbles context replay manifest")

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
        await expect(replayBlueBubblesContextFixture({
          manifestPath: variantPath,
          deps: { querySession },
        })).rejects.toThrow(variant.expectedViolation)
      }

      fs.writeFileSync(variantPath, JSON.stringify([]), "utf-8")
      await expect(replayBlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("manifest must be an object")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, expected: null }), "utf-8")
      await expect(replayBlueBubblesContextFixture({ manifestPath: variantPath })).rejects.toThrow("missing expected")

      fs.writeFileSync(variantPath, JSON.stringify({ ...manifest, conversation: null }), "utf-8")
      await expect(replayBlueBubblesContextFixture({ manifestPath: variantPath, deps: { querySession } })).resolves.toMatchObject({ modelInput: "" })

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        conversation: { messages: null },
      }), "utf-8")
      await expect(replayBlueBubblesContextFixture({ manifestPath: variantPath, deps: { querySession } })).resolves.toMatchObject({ modelInput: "" })

      fs.writeFileSync(variantPath, JSON.stringify({
        ...manifest,
        conversation: {
          ...manifest.conversation,
          messages: [
            { messageGuid: "missing-timestamp", authorLabel: "Assistant", body: "Travel Update" },
            { messageGuid: "missing-author", timestamp: "2026-07-09T17:00:00.000Z", body: "Travel Update" },
            { messageGuid: "missing-body", timestamp: "2026-07-09T17:00:00.000Z", authorLabel: "Assistant" },
          ],
        },
      }), "utf-8")
      await expect(replayBlueBubblesContextFixture({ manifestPath: variantPath, deps: { querySession } })).resolves.toMatchObject({ modelInput: "" })
      expect(querySession).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
