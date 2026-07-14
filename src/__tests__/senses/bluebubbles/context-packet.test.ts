import { beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => emitNervesEvent(...args),
}))

function message(overrides: Partial<any> = {}) {
  const timestamp = overrides.timestamp ?? Date.parse("2026-07-09T19:25:00.000Z")
  const chatGuid = Object.prototype.hasOwnProperty.call(overrides, "chatGuid")
    ? overrides.chatGuid
    : "any;+;thread-guid"
  const chatIdentifier = Object.prototype.hasOwnProperty.call(overrides, "chatIdentifier")
    ? overrides.chatIdentifier
    : "thread-guid"
  const senderExternalId = Object.prototype.hasOwnProperty.call(overrides, "senderExternalId")
    ? overrides.senderExternalId
    : "ari@mendelow.me"
  const senderRawId = Object.prototype.hasOwnProperty.call(overrides, "senderRawId")
    ? overrides.senderRawId
    : senderExternalId
  const senderDisplayName = Object.prototype.hasOwnProperty.call(overrides, "senderDisplayName")
    ? overrides.senderDisplayName
    : "Ari"
  return {
    kind: "message" as const,
    eventType: "new-message",
    messageGuid: overrides.messageGuid ?? "anchor-guid",
    timestamp,
    fromMe: overrides.fromMe ?? false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: senderExternalId,
      rawId: senderRawId,
      displayName: senderDisplayName,
    },
    chat: {
      chatGuid,
      chatIdentifier,
      isGroup: true,
      sessionKey: overrides.sessionKey ?? "chat:any;+;thread-guid",
      sendTarget: { kind: "chat_guid" as const, value: chatGuid ?? chatIdentifier ?? "unknown" },
      participantHandles: ["ari@mendelow.me"],
    },
    text: overrides.text ?? "who is pending?",
    textForAgent: overrides.textForAgent ?? overrides.text ?? "who is pending?",
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
}

describe("BlueBubbles context packet builder", () => {
  beforeEach(() => {
    emitNervesEvent.mockReset()
  })

  it("builds a private same-thread packet from prior BlueBubbles history", async () => {
    const anchor = message()
    const prior = message({
      messageGuid: "prior-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      text: "previous same-thread body",
    })
    const listRecentMessages = vi.fn().mockResolvedValue([
      message({ messageGuid: "anchor-guid", text: "duplicate anchor" }),
      message({
        messageGuid: "future-guid",
        timestamp: Date.parse("2026-07-09T19:26:00.000Z"),
        text: "future body",
      }),
      message({
        messageGuid: "other-thread-guid",
        sessionKey: "chat:any;+;other",
        chatGuid: "any;+;other",
        chatIdentifier: "other",
        text: "other thread",
      }),
      prior,
    ])

    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")
    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { listRecentMessages },
      event: anchor,
    })

    expect(listRecentMessages).toHaveBeenCalledWith({
      beforeTimestamp: anchor.timestamp,
      limit: 40,
      offset: 0,
      chatGuid: "any;+;thread-guid",
    })
    expect(result?.historyCount).toBe(1)
    expect(result?.packet).toMatchObject({
      agent: "slugger",
      sense: "bluebubbles",
      anchorMessageGuid: "anchor-guid",
      privacyClass: "private-runtime",
      indexPolicy: { search: false, vector: false },
    })
    expect(result?.packet.messages.map((entry) => entry.sourceRef.messageGuid)).toEqual(["prior-guid"])
    expect(result?.rendered.text).toContain("previous same-thread body")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_context_packet_built",
      meta: expect.objectContaining({
        messageGuid: "anchor-guid",
        contextMessages: 1,
      }),
    }))
  })

  it("returns null when same-thread history is empty", async () => {
    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")
    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { listRecentMessages: vi.fn().mockResolvedValue([]) },
      event: message(),
    })

    expect(result).toBeNull()
  })

  it("filters same-thread history already present in provider-visible messages", async () => {
    const anchor = message()
    const exactKnown = message({
      messageGuid: "exact-known-guid",
      timestamp: Date.parse("2026-07-09T19:20:00.000Z"),
      text: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
    })
    const normalizedKnown = message({
      messageGuid: "normalized-known-guid",
      timestamp: Date.parse("2026-07-09T19:21:00.000Z"),
      text: "Already     In The Session",
    })
    const containedKnown = message({
      messageGuid: "contained-known-guid",
      timestamp: Date.parse("2026-07-09T19:22:00.000Z"),
      text: "contained body text",
    })
    const blankBody = message({
      messageGuid: "blank-body-guid",
      timestamp: Date.parse("2026-07-09T19:22:30.000Z"),
      text: "",
      textForAgent: "",
    })
    const fresh = message({
      messageGuid: "fresh-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      text: "fresh unseen context",
    })

    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")
    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { listRecentMessages: vi.fn().mockResolvedValue([exactKnown, normalizedKnown, containedKnown, blankBody, fresh]) },
      event: anchor,
      knownMessageTexts: [
        "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
        " already in the session ",
        "the existing transcript contains this contained body text already",
        "   ",
      ],
    })

    expect(result?.historyCount).toBe(1)
    expect(result?.packet.messages.map((entry) => entry.sourceRef.messageGuid)).toEqual(["fresh-guid"])
  })

  it("returns null before querying when the anchor timestamp or client query is unavailable", async () => {
    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")
    const listRecentMessages = vi.fn()

    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { listRecentMessages },
      event: message({ timestamp: Number.NaN }),
    })).resolves.toBeNull()
    expect(listRecentMessages).not.toHaveBeenCalled()

    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: {},
      event: message(),
    })).resolves.toBeNull()
  })

  it("uses chat and author fallbacks while keeping query filters scoped", async () => {
    const anchor = message({
      chatGuid: undefined,
      chatIdentifier: "thread-id",
      sessionKey: "chat:thread-id",
    })
    const fromMe = message({
      messageGuid: "from-me-guid",
      fromMe: true,
      chatGuid: undefined,
      chatIdentifier: "thread-id",
      sessionKey: "chat:thread-id",
      timestamp: Date.parse("2026-07-09T19:20:00.000Z"),
      textForAgent: "",
      text: "sent by slugger",
    })
    const externalOnly = message({
      messageGuid: "external-only-guid",
      chatGuid: undefined,
      chatIdentifier: "thread-id",
      sessionKey: "chat:thread-id",
      timestamp: Date.parse("2026-07-09T19:21:00.000Z"),
      senderDisplayName: "",
      senderExternalId: "external-only",
      text: "external label body",
    })
    const unknownWithRaw = message({
      messageGuid: "raw-only-guid",
      chatGuid: undefined,
      chatIdentifier: "thread-id",
      sessionKey: "chat:thread-id",
      timestamp: Date.parse("2026-07-09T19:22:00.000Z"),
      senderDisplayName: "",
      senderExternalId: "",
      senderRawId: "raw-only",
      text: "unknown label body",
    })
    const unknownWithoutIds = message({
      messageGuid: "unknown-id-guid",
      chatGuid: undefined,
      chatIdentifier: "thread-id",
      sessionKey: "chat:thread-id",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      senderDisplayName: "",
      senderExternalId: "",
      senderRawId: "",
      text: "unknown id body",
    })
    const listRecentMessages = vi.fn().mockResolvedValue([unknownWithoutIds, unknownWithRaw, externalOnly, fromMe])

    const {
      blueBubblesContextChatKey,
      buildBlueBubblesContextPacket,
    } = await import("../../../senses/bluebubbles/context-packet")
    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { listRecentMessages },
      event: anchor,
    })

    expect(blueBubblesContextChatKey(anchor)).toBe("thread-id")
    expect(blueBubblesContextChatKey(message({
      chatGuid: undefined,
      chatIdentifier: undefined,
      sessionKey: "chat:fallback",
    }))).toBe("chat:fallback")
    expect(listRecentMessages).toHaveBeenCalledWith({
      beforeTimestamp: anchor.timestamp,
      limit: 40,
      offset: 0,
      chatIdentifier: "thread-id",
    })
    expect(result?.packet.messages.map((entry) => entry.authorLabel)).toEqual([
      "Slugger",
      "external-only",
      "Unknown",
      "Unknown",
    ])
    expect(result?.packet.messages.map((entry) => entry.bodyPreview)).toEqual([
      "sent by slugger",
      "external label body",
      "unknown label body",
      "unknown id body",
    ])
  })
})
