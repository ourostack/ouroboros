import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("outlook types", () => {
  it("defines the canonical Outlook identity and release defaults", async () => {
    const mod = await import("../../../heart/outlook/outlook-types")

    expect(mod.OUTLOOK_PRODUCT_NAME).toBe("Ouro Mailbox")
    expect(mod.OUTLOOK_RELEASE_INTERACTION_MODEL).toBe("read-only")
    expect(mod.OUTLOOK_DEFAULT_INNER_VISIBILITY).toBe("summary")
  })

  it("extracts transcript text and prefers authored timestamps when available", async () => {
    const mod = await import("../../../heart/outlook/outlook-types")

    const stringMessage = {
      content: "plain text",
      time: {
        authoredAt: "2026-04-09T10:00:00.000Z",
        observedAt: "2026-04-09T10:01:00.000Z",
        recordedAt: "2026-04-09T10:02:00.000Z",
      },
    } as any
    const structuredMessage = {
      content: [
        { type: "text", text: "hello " },
        { type: "image", image_url: "ignored.png" },
        { type: "text", text: "world" },
      ],
      time: {
        authoredAt: null,
        observedAt: "2026-04-09T11:01:00.000Z",
        recordedAt: "2026-04-09T11:02:00.000Z",
      },
    } as any
    const emptyMessage = {
      content: null,
      time: {
        authoredAt: null,
        observedAt: null,
        recordedAt: "2026-04-09T12:02:00.000Z",
      },
    } as any

    expect(mod.getOutlookTranscriptMessageText(stringMessage)).toBe("plain text")
    expect(mod.getOutlookTranscriptMessageText(structuredMessage)).toBe("hello world")
    expect(mod.getOutlookTranscriptMessageText(emptyMessage)).toBe("")

    expect(mod.getOutlookTranscriptTimestamp(stringMessage)).toBe("2026-04-09T10:00:00.000Z")
    expect(mod.getOutlookTranscriptTimestamp(structuredMessage)).toBe("2026-04-09T11:01:00.000Z")
    expect(mod.getOutlookTranscriptTimestamp(emptyMessage)).toBe("2026-04-09T12:02:00.000Z")
  })
})
