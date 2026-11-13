import { describe, expect, it } from "vitest"
import { extensionForAttachment } from "../../../heart/attachments/originals"
import { emitNervesEvent } from "../../../nerves/runtime"

describe("extensionForAttachment", () => {
  it("keeps the name's own extension, else names voice notes and clips by their type", () => {
    emitNervesEvent({ component: "engine", event: "engine.test_run", message: "attachment extension table", meta: { test: true } })
    expect(extensionForAttachment("Voice Note.caf", "audio/ogg")).toBe(".caf")
    const byType = Object.fromEntries(
      ["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/bmp", "image/heic", "application/pdf",
        "audio/mp3", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/wav", "audio/x-wav", "audio/x-caf", "audio/aac",
        "video/mp4", "video/quicktime", " Audio/OGG ", "text/plain"].map((mime) => [mime, extensionForAttachment("voice", mime)]),
    )
    expect(byType).toEqual({
      "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/tiff": ".tiff", "image/bmp": ".bmp",
      "image/heic": ".heic", "application/pdf": ".pdf", "audio/mp3": ".mp3", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
      "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/x-caf": ".caf", "audio/aac": ".aac",
      "video/mp4": ".mp4", "video/quicktime": ".mov", " Audio/OGG ": ".ogg", "text/plain": "",
    })
    expect(extensionForAttachment("voice")).toBe("")
  })
})
