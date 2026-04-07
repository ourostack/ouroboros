import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}))

describe("Content block assembly", () => {
  beforeEach(() => {
    vi.resetModules()
    emitNervesEvent({
      component: "senses",
      event: "senses.content_block_assembly_test_start",
      message: "Content block assembly test started",
      meta: {},
    })
  })

  describe("resolveImageContent integration", () => {
    it("produces image_url + text content parts for a single image", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-png-data"))
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")

      const images = new Map([[1, "/Users/foo/screenshot.png"]])
      const result = await resolveImageContent("[Image #1] describe this", images)

      expect(result).toHaveLength(2)
      expect(result[0].type).toBe("image_url")
      expect(result[1]).toEqual({ type: "text", text: "[Image #1] describe this" })
    })

    it("produces multiple image_url parts for multiple images", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-data"))
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")

      const images = new Map([
        [1, "/Users/foo/a.png"],
        [2, "/Users/foo/b.jpg"],
      ])
      const result = await resolveImageContent("[Image #1] and [Image #2]", images)

      expect(result).toHaveLength(3) // 2 images + 1 text
      expect(result[0].type).toBe("image_url")
      expect(result[1].type).toBe("image_url")
      expect(result[2]).toEqual({ type: "text", text: "[Image #1] and [Image #2]" })
    })

    it("returns text-only when images map is empty (no image paste)", async () => {
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")
      const result = await resolveImageContent("hello world", new Map())
      expect(result).toEqual([{ type: "text", text: "hello world" }])
    })

    it("clears stale images: resolving with empty map after a previous non-empty map", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-data"))
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")

      // First turn: has images
      const images1 = new Map([[1, "/Users/foo/a.png"]])
      const result1 = await resolveImageContent("[Image #1]", images1)
      expect(result1).toHaveLength(2)

      // Second turn: no images (map cleared per-message)
      const result2 = await resolveImageContent("just text", new Map())
      expect(result2).toEqual([{ type: "text", text: "just text" }])
    })

    it("skips images that fail to read and returns text-only", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")

      const images = new Map([[1, "/Users/foo/missing.png"]])
      const result = await resolveImageContent("[Image #1] describe", images)
      expect(result).toEqual([{ type: "text", text: "[Image #1] describe" }])
    })

    it("end-to-end: processSubmitInput -> resolveImageContent", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("png-bytes"))
      const { processSubmitInput, resolveImageContent } = await import("../../../senses/cli/image-paste")

      // Simulate user drag-drop input
      const input = "/Users/foo/Screenshot\\ 2026.png check this"
      const { text, images } = processSubmitInput(input)
      expect(text).toBe("[Image #1] check this")
      expect(images.size).toBe(1)

      // Resolve into content parts
      const parts = await resolveImageContent(text, images)
      expect(parts).toHaveLength(2)
      expect(parts[0].type).toBe("image_url")
      if (parts[0].type === "image_url") {
        expect(parts[0].image_url.url).toContain("data:image/png;base64,")
      }
      expect(parts[1]).toEqual({ type: "text", text: "[Image #1] check this" })
    })
  })
})
