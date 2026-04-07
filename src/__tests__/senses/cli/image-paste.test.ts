import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}))

describe("image-paste utilities", () => {
  beforeEach(() => {
    vi.resetModules()
    emitNervesEvent({
      component: "senses",
      event: "senses.image_paste_test_start",
      message: "Image paste test started",
      meta: {},
    })
  })

  describe("IMAGE_EXTENSION_REGEX", () => {
    it("matches .png", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.png")).toBe(true)
    })

    it("matches .jpg", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.jpg")).toBe(true)
    })

    it("matches .jpeg", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.jpeg")).toBe(true)
    })

    it("matches .gif", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.gif")).toBe(true)
    })

    it("matches .webp", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.webp")).toBe(true)
    })

    it("matches case-insensitive (.PNG)", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.PNG")).toBe(true)
    })

    it("rejects .pdf", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.pdf")).toBe(false)
    })

    it("rejects .txt", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.txt")).toBe(false)
    })

    it("rejects .mp4", async () => {
      const { IMAGE_EXTENSION_REGEX } = await import("../../../senses/cli/image-paste")
      expect(IMAGE_EXTENSION_REGEX.test("foo.mp4")).toBe(false)
    })
  })

  describe("isImagePath", () => {
    it("returns true for paths ending with image extensions", async () => {
      const { isImagePath } = await import("../../../senses/cli/image-paste")
      expect(isImagePath("/Users/foo/screenshot.png")).toBe(true)
      expect(isImagePath("/tmp/photo.jpg")).toBe(true)
    })

    it("returns false for non-image paths", async () => {
      const { isImagePath } = await import("../../../senses/cli/image-paste")
      expect(isImagePath("/Users/foo/doc.pdf")).toBe(false)
      expect(isImagePath("/tmp/notes.txt")).toBe(false)
    })

    it("handles backslash-escaped paths", async () => {
      const { isImagePath } = await import("../../../senses/cli/image-paste")
      expect(isImagePath("/Users/foo/Screenshot\\ 2026.png")).toBe(true)
    })
  })

  describe("unescapePath", () => {
    it("converts backslash-space to plain space", async () => {
      const { unescapePath } = await import("../../../senses/cli/image-paste")
      expect(unescapePath("/Users/foo/Screenshot\\ 2026.png")).toBe("/Users/foo/Screenshot 2026.png")
    })

    it("handles paths without escapes", async () => {
      const { unescapePath } = await import("../../../senses/cli/image-paste")
      expect(unescapePath("/Users/foo/screenshot.png")).toBe("/Users/foo/screenshot.png")
    })

    it("handles multiple escaped spaces", async () => {
      const { unescapePath } = await import("../../../senses/cli/image-paste")
      expect(unescapePath("/Users/foo/My\\ Cool\\ Image.png")).toBe("/Users/foo/My Cool Image.png")
    })
  })

  describe("tryReadImage", () => {
    it("returns base64 and mediaType on success for png", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-png-data"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/image.png")
      expect(result).not.toBeNull()
      expect(result!.base64).toBe(Buffer.from("fake-png-data").toString("base64"))
      expect(result!.mediaType).toBe("image/png")
    })

    it("returns correct mediaType for jpg", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-jpg-data"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/photo.jpg")
      expect(result).not.toBeNull()
      expect(result!.mediaType).toBe("image/jpeg")
    })

    it("returns correct mediaType for jpeg", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/photo.jpeg")
      expect(result!.mediaType).toBe("image/jpeg")
    })

    it("returns correct mediaType for gif", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/anim.gif")
      expect(result!.mediaType).toBe("image/gif")
    })

    it("returns correct mediaType for webp", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/pic.webp")
      expect(result!.mediaType).toBe("image/webp")
    })

    it("returns null on file-not-found", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/missing.png")
      expect(result).toBeNull()
    })

    it("returns null on read error", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockRejectedValue(new Error("EACCES"))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/noperm.png")
      expect(result).toBeNull()
    })
  })

  describe("formatImageRef", () => {
    it("returns [Image #1] for n=1", async () => {
      const { formatImageRef } = await import("../../../senses/cli/image-paste")
      expect(formatImageRef(1)).toBe("[Image #1]")
    })

    it("returns [Image #2] for n=2", async () => {
      const { formatImageRef } = await import("../../../senses/cli/image-paste")
      expect(formatImageRef(2)).toBe("[Image #2]")
    })
  })

  describe("replacePathsWithRefs", () => {
    it("replaces a single image path with [Image #1]", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/screenshot.png check this")
      expect(result.text).toBe("[Image #1] check this")
      expect(result.images.size).toBe(1)
      expect(result.images.get(1)).toBe("/Users/foo/screenshot.png")
    })

    it("handles backslash-escaped spaces in path", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/Screenshot\\ 2026-04-07\\ at\\ 14.37.17.png check this")
      expect(result.text).toBe("[Image #1] check this")
      expect(result.images.get(1)).toBe("/Users/foo/Screenshot 2026-04-07 at 14.37.17.png")
    })

    it("handles multiple images", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/a.png compare with /Users/foo/b.jpg")
      expect(result.text).toBe("[Image #1] compare with [Image #2]")
      expect(result.images.size).toBe(2)
      expect(result.images.get(1)).toBe("/Users/foo/a.png")
      expect(result.images.get(2)).toBe("/Users/foo/b.jpg")
    })

    it("returns original text when no image paths found", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("just some text")
      expect(result.text).toBe("just some text")
      expect(result.images.size).toBe(0)
    })

    it("handles empty input", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("")
      expect(result.text).toBe("")
      expect(result.images.size).toBe(0)
    })

    it("leaves non-image file paths as-is", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/doc.pdf check this")
      expect(result.text).toBe("/Users/foo/doc.pdf check this")
      expect(result.images.size).toBe(0)
    })
  })

  describe("resolveImageContent", () => {
    it("returns simple text content when images map is empty", async () => {
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")
      const result = await resolveImageContent("hello world", new Map())
      expect(result).toEqual([{ type: "text", text: "hello world" }])
    })

    it("returns image_url content blocks with base64 data for pasted images", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-png-data"))
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")
      const images = new Map([[1, "/Users/foo/screenshot.png"]])
      const result = await resolveImageContent("[Image #1] describe this", images)
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from("fake-png-data").toString("base64")}` },
      })
      expect(result[1]).toEqual({
        type: "text",
        text: "[Image #1] describe this",
      })
    })

    it("returns only text when all images fail to read", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")
      const images = new Map([[1, "/Users/foo/missing.png"]])
      const result = await resolveImageContent("[Image #1] describe this", images)
      expect(result).toEqual([{ type: "text", text: "[Image #1] describe this" }])
    })
  })

  // ─── Extended Edge Cases (Unit 6a) ───────────────────────────────
  describe("edge cases", () => {
    it("replacePathsWithRefs: multiple images separated by text", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/a.png some text /Users/foo/b.png more text")
      expect(result.text).toBe("[Image #1] some text [Image #2] more text")
      expect(result.images.size).toBe(2)
    })

    it("replacePathsWithRefs: path with no spaces (no escaping needed)", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/no-spaces-here.png")
      expect(result.text).toBe("[Image #1]")
      expect(result.images.get(1)).toBe("/Users/foo/no-spaces-here.png")
    })

    it("replacePathsWithRefs: path with multiple escaped spaces", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/My\\ Cool\\ Screenshot\\ 2026.png")
      expect(result.text).toBe("[Image #1]")
      expect(result.images.get(1)).toBe("/Users/foo/My Cool Screenshot 2026.png")
    })

    it("replacePathsWithRefs: path with special characters (parentheses, hyphens)", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/image-(1)-final.png")
      expect(result.text).toBe("[Image #1]")
      expect(result.images.get(1)).toBe("/Users/foo/image-(1)-final.png")
    })

    it("replacePathsWithRefs: only whitespace input", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("   ")
      expect(result.text).toBe("   ")
      expect(result.images.size).toBe(0)
    })

    it("replacePathsWithRefs: path that looks like a path but has no image extension", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const result = replacePathsWithRefs("/Users/foo/document.docx look at this")
      expect(result.text).toBe("/Users/foo/document.docx look at this")
      expect(result.images.size).toBe(0)
    })

    it("replacePathsWithRefs: very long path", async () => {
      const { replacePathsWithRefs } = await import("../../../senses/cli/image-paste")
      const longPath = "/Users/" + "a".repeat(200) + "/screenshot.png"
      const result = replacePathsWithRefs(longPath + " describe")
      expect(result.text).toBe("[Image #1] describe")
      expect(result.images.get(1)).toBe(longPath)
    })

    it("tryReadImage: 0-byte file returns base64 of empty buffer", async () => {
      const fs = await import("fs/promises")
      vi.mocked(fs.readFile).mockResolvedValue(Buffer.alloc(0))
      const { tryReadImage } = await import("../../../senses/cli/image-paste")
      const result = await tryReadImage("/Users/foo/empty.png")
      expect(result).not.toBeNull()
      expect(result!.base64).toBe("")
      expect(result!.mediaType).toBe("image/png")
    })

    it("resolveImageContent: skips unreadable image, keeps readable one", async () => {
      const fs = await import("fs/promises")
      let callCount = 0
      vi.mocked(fs.readFile).mockImplementation(async () => {
        callCount++
        if (callCount === 1) return Buffer.from("good-data")
        throw new Error("ENOENT")
      })
      const { resolveImageContent } = await import("../../../senses/cli/image-paste")
      const images = new Map([
        [1, "/Users/foo/good.png"],
        [2, "/Users/foo/missing.png"],
      ])
      const result = await resolveImageContent("[Image #1] and [Image #2]", images)
      // Should have 1 image_url (the good one) + 1 text
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe("image_url")
      expect(result[1]).toEqual({ type: "text", text: "[Image #1] and [Image #2]" })
    })
  })
})
