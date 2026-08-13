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
    fromMe: Object.prototype.hasOwnProperty.call(overrides, "fromMe")
      ? overrides.fromMe
      : false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: senderExternalId,
      rawId: senderRawId,
      displayName: senderDisplayName,
      observed: overrides.senderObserved,
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

function metadataResult(anchor: ReturnType<typeof message>, messages: any[], overrides: Record<string, unknown> = {}) {
  return {
    messages,
    rawRowCount: messages.length,
    normalizedRowCount: messages.length,
    skippedRowCount: 0,
    invalidCausalTimestampRowCount: 0,
    request: {
      limit: 41,
      offset: 0,
      sort: "DESC",
      chatGuid: anchor.chat.chatGuid,
      beforeTimestamp: anchor.timestamp,
    },
    ...overrides,
  }
}

function metadataClient(anchor: ReturnType<typeof message>, messages: any[], overrides: Record<string, unknown> = {}) {
  return {
    queryRecentMessagesWithMetadata: vi.fn().mockResolvedValue(metadataResult(anchor, messages, overrides)),
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
    const client = metadataClient(anchor, [anchor, prior])

    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")
    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client,
      event: anchor,
    })

    expect(client.queryRecentMessagesWithMetadata).toHaveBeenCalledWith({
      beforeTimestamp: anchor.timestamp,
      limit: 41,
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
    expect(result?.verifiedPredecessorMessage.content).toContain("bluebubbles_verified_predecessor")
    expect(result?.verifiedPredecessorMessage.content).toContain("previous same-thread body")
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
      client: metadataClient(message(), [message()]),
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
      client: metadataClient(anchor, [anchor, fresh, blankBody, containedKnown, normalizedKnown, exactKnown]),
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
    const queryRecentMessagesWithMetadata = vi.fn()

    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { queryRecentMessagesWithMetadata },
      event: message({ timestamp: Number.NaN }),
    })).resolves.toBeNull()
    expect(queryRecentMessagesWithMetadata).not.toHaveBeenCalled()

    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: {},
      event: message(),
    })).resolves.toBeNull()
  })

  it("labels shared-account outbound rows without claiming Slugger authorship", async () => {
    const anchor = message()
    const fromMe = message({
      messageGuid: "from-me-guid",
      fromMe: true,
      timestamp: Date.parse("2026-07-09T19:20:00.000Z"),
      textForAgent: "",
      text: "sent by slugger",
    })
    const externalOnly = message({
      messageGuid: "external-only-guid",
      timestamp: Date.parse("2026-07-09T19:21:00.000Z"),
      senderDisplayName: "",
      senderExternalId: "external-only",
      text: "external label body",
    })
    const unknownWithRaw = message({
      messageGuid: "raw-only-guid",
      timestamp: Date.parse("2026-07-09T19:22:00.000Z"),
      senderDisplayName: "",
      senderExternalId: "",
      senderRawId: "raw-only",
      text: "unknown label body",
    })
    const unknownWithoutIds = message({
      messageGuid: "unknown-id-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      senderDisplayName: "",
      senderExternalId: "",
      senderRawId: "",
      text: "unknown id body",
    })
    const client = metadataClient(anchor, [anchor, unknownWithoutIds, unknownWithRaw, externalOnly, fromMe])

    const {
      blueBubblesContextChatKey,
      buildBlueBubblesContextPacket,
    } = await import("../../../senses/bluebubbles/context-packet")
    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client,
      event: anchor,
    })

    expect(blueBubblesContextChatKey(anchor)).toBe("any;+;thread-guid")
    expect(blueBubblesContextChatKey(message({
      chatGuid: undefined,
      chatIdentifier: undefined,
      sessionKey: "chat:fallback",
    }))).toBe("chat:fallback")
    expect(client.queryRecentMessagesWithMetadata).toHaveBeenCalledWith({
      beforeTimestamp: anchor.timestamp,
      limit: 41,
      offset: 0,
      chatGuid: "any;+;thread-guid",
    })
    expect(result?.packet.messages.map((entry) => entry.authorLabel)).toEqual([
      "shared-account outbound",
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
    expect(result?.rendered.text).not.toContain("Slugger:")
  })

  it("renders only observed inbound sender evidence and preserves unknown direction", async () => {
    const anchor = message()
    const { renderVerifiedBlueBubblesPredecessor } = await import("../../../senses/bluebubbles/context-packet")
    const rendered = [
      message({
        messageGuid: "observed-display",
        timestamp: anchor.timestamp - 1,
        senderObserved: true,
        senderDisplayName: "Observed Name",
        senderExternalId: "observed@example.test",
      }),
      message({
        messageGuid: "observed-external",
        timestamp: anchor.timestamp - 2,
        senderObserved: true,
        senderDisplayName: "",
        senderExternalId: "external@example.test",
      }),
      message({
        messageGuid: "observed-unknown",
        timestamp: anchor.timestamp - 3,
        senderObserved: true,
        senderDisplayName: "",
        senderExternalId: "",
      }),
      message({
        messageGuid: "unknown-direction",
        timestamp: anchor.timestamp - 4,
        fromMe: null,
      }),
    ].map((predecessor) => renderVerifiedBlueBubblesPredecessor(anchor, predecessor, "chat-hash").content)

    expect(rendered[0]).toContain('"sender":"Observed Name"')
    expect(rendered[1]).toContain('"sender":"external@example.test"')
    expect(rendered[2]).toContain('"sender":"unknown inbound sender"')
    expect(rendered[3]).toContain('"direction":"direction unknown"')
    expect(rendered[3]).not.toContain('"sender"')
  })

  it("accepts a full anchor-inclusive page and preserves its exact predecessor", async () => {
    const anchor = message()
    const messages = [anchor, ...Array.from({ length: 40 }, (_, index) => message({
      messageGuid: `full-page-prior-${index}`,
      timestamp: anchor.timestamp - index - 1,
    }))]
    const client = metadataClient(anchor, messages)
    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")

    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client,
      event: anchor,
    })

    expect(result?.verifiedPredecessorMessage.content).toContain("full-page-prior-0")
    expect(result?.historyCount).toBe(40)
  })

  it.each([
    ["more rows than requested", (anchor: ReturnType<typeof message>) => ({
      messages: [anchor, ...Array.from({ length: 41 }, (_, index) => message({
        messageGuid: `prior-${index}`,
        timestamp: anchor.timestamp - index - 1,
      }))],
      rawRowCount: 42,
      normalizedRowCount: 42,
      skippedRowCount: 0,
      invalidCausalTimestampRowCount: 0,
    })],
    ["a skipped malformed row", (anchor: ReturnType<typeof message>) => ({
      messages: [anchor, message({ messageGuid: "prior", timestamp: anchor.timestamp - 1 })],
      rawRowCount: 3,
      normalizedRowCount: 2,
      skippedRowCount: 1,
      invalidCausalTimestampRowCount: 0,
    })],
    ["a normalized non-message row", (anchor: ReturnType<typeof message>) => ({
      messages: [anchor, { kind: "typing", timestamp: anchor.timestamp - 1 }],
    })],
    ["a duplicate guid", (anchor: ReturnType<typeof message>) => ({
      messages: [anchor, message({ messageGuid: "duplicate", timestamp: anchor.timestamp - 1 }), message({ messageGuid: "duplicate", timestamp: anchor.timestamp - 2 })],
    })],
    ["a wrong-chat row", (anchor: ReturnType<typeof message>) => ({
      messages: [anchor, message({ messageGuid: "wrong-chat", timestamp: anchor.timestamp - 1, chatGuid: "any;+;other" })],
    })],
    ["an equal-time ambiguity", (anchor: ReturnType<typeof message>) => ({
      messages: [anchor, message({ messageGuid: "equal-time", timestamp: anchor.timestamp })],
    })],
    ["ascending rows", (anchor: ReturnType<typeof message>) => ({
      messages: [message({ messageGuid: "old", timestamp: anchor.timestamp - 2 }), message({ messageGuid: "new", timestamp: anchor.timestamp - 1 }), anchor],
    })],
    ["a missing anchor", (anchor: ReturnType<typeof message>) => ({
      messages: [message({ messageGuid: "prior", timestamp: anchor.timestamp - 1 })],
    })],
    ["a mismatched anchor identity", (anchor: ReturnType<typeof message>) => ({
      messages: [{ ...anchor, timestamp: anchor.timestamp - 1 }, message({ messageGuid: "prior", timestamp: anchor.timestamp - 2 })],
    })],
  ])("fails closed when the anchor-inclusive query contains %s", async (_label, build) => {
    const anchor = message()
    const shape = build(anchor) as Record<string, any>
    const client = metadataClient(anchor, shape.messages, shape)
    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")

    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client,
      event: anchor,
    })).resolves.toBeNull()
  })

  it("keeps the exact verified predecessor even when it is older than the optional history window", async () => {
    const anchor = message()
    const predecessor = message({
      messageGuid: "older-required-predecessor",
      timestamp: anchor.timestamp - (48 * 60 * 60 * 1000) - 1,
      text: "the exact prior turn still orients this reply",
    })
    const client = metadataClient(anchor, [anchor, predecessor])
    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")

    const result = await buildBlueBubblesContextPacket({
      agentName: "slugger",
      client,
      event: anchor,
    })

    expect(result?.verifiedPredecessorMessage.content).toContain("the exact prior turn still orients this reply")
    expect(result?.historyCount).toBe(1)
  })

  it("requires an exact chat guid and metadata-capable query", async () => {
    const { buildBlueBubblesContextPacket } = await import("../../../senses/bluebubbles/context-packet")
    const identifierOnly = message({ chatGuid: undefined, chatIdentifier: "thread-id" })
    const queryRecentMessagesWithMetadata = vi.fn()

    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: { queryRecentMessagesWithMetadata },
      event: identifierOnly,
    })).resolves.toBeNull()
    await expect(buildBlueBubblesContextPacket({
      agentName: "slugger",
      client: {},
      event: message(),
    })).resolves.toBeNull()
    expect(queryRecentMessagesWithMetadata).not.toHaveBeenCalled()
  })
})
