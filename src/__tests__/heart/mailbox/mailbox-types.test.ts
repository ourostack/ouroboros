import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("mailbox types", () => {
  it("defines the canonical Mailbox identity and release defaults", async () => {
    const mod = await import("../../../heart/mailbox/mailbox-types")

    expect(mod.MAILBOX_PRODUCT_NAME).toBe("Ouro Mailbox")
    expect(mod.MAILBOX_RELEASE_INTERACTION_MODEL).toBe("read-only")
    expect(mod.MAILBOX_DEFAULT_INNER_VISIBILITY).toBe("summary")
  })

  it("extracts transcript text and prefers authored timestamps when available", async () => {
    const mod = await import("../../../heart/mailbox/mailbox-types")

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

    expect(mod.getMailboxTranscriptMessageText(stringMessage)).toBe("plain text")
    expect(mod.getMailboxTranscriptMessageText(structuredMessage)).toBe("hello world")
    expect(mod.getMailboxTranscriptMessageText(emptyMessage)).toBe("")

    expect(mod.getMailboxTranscriptTimestamp(stringMessage)).toBe("2026-04-09T10:00:00.000Z")
    expect(mod.getMailboxTranscriptTimestamp(structuredMessage)).toBe("2026-04-09T11:01:00.000Z")
    expect(mod.getMailboxTranscriptTimestamp(emptyMessage)).toBe("2026-04-09T12:02:00.000Z")
  })
})
