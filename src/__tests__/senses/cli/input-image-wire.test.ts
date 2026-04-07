import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}))

describe("InputArea image detection wiring", () => {
  beforeEach(() => {
    vi.resetModules()
    emitNervesEvent({
      component: "senses",
      event: "senses.input_image_wire_test_start",
      message: "Input image wire test started",
      meta: {},
    })
  })

  describe("processSubmitInput", () => {
    it("returns text unchanged when no image paths present", async () => {
      const { processSubmitInput } = await import("../../../senses/cli/image-paste")
      const result = processSubmitInput("hello world")
      expect(result.text).toBe("hello world")
      expect(result.images.size).toBe(0)
    })

    it("replaces image paths with [Image #N] refs and populates images map", async () => {
      const { processSubmitInput } = await import("../../../senses/cli/image-paste")
      const result = processSubmitInput("/Users/foo/screenshot.png describe this")
      expect(result.text).toBe("[Image #1] describe this")
      expect(result.images.size).toBe(1)
      expect(result.images.get(1)).toBe("/Users/foo/screenshot.png")
    })

    it("handles backslash-escaped macOS drag-drop paths", async () => {
      const { processSubmitInput } = await import("../../../senses/cli/image-paste")
      const result = processSubmitInput("/Users/foo/Screenshot\\ 2026-04-07\\ at\\ 14.37.17.png check this")
      expect(result.text).toBe("[Image #1] check this")
      expect(result.images.get(1)).toBe("/Users/foo/Screenshot 2026-04-07 at 14.37.17.png")
    })

    it("handles multiple images in a single input", async () => {
      const { processSubmitInput } = await import("../../../senses/cli/image-paste")
      const result = processSubmitInput("/Users/foo/a.png compare /Users/foo/b.jpg")
      expect(result.text).toBe("[Image #1] compare [Image #2]")
      expect(result.images.size).toBe(2)
    })

    it("does not replace non-image file paths", async () => {
      const { processSubmitInput } = await import("../../../senses/cli/image-paste")
      const result = processSubmitInput("/Users/foo/doc.pdf check this")
      expect(result.text).toBe("/Users/foo/doc.pdf check this")
      expect(result.images.size).toBe(0)
    })
  })
})
