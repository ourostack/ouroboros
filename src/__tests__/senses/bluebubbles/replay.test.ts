import { beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => emitNervesEvent(...args),
}))

function makeProbeEvent(eventType: string, messageGuid: string) {
  return {
    kind: "message" as const,
    eventType,
    messageGuid,
    timestamp: Date.parse("2026-04-08T19:00:00.000Z"),
    fromMe: false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: "unknown",
      rawId: "unknown",
      displayName: "unknown",
    },
    chat: {
      isGroup: false,
      sessionKey: "chat_identifier:unknown",
      sendTarget: { kind: "chat_identifier" as const, value: "unknown" },
      participantHandles: [],
    },
    text: "",
    textForAgent: "",
    attachments: [],
    hasPayloadData: true,
    requiresRepair: true,
  }
}

describe("BlueBubbles replay helper", () => {
  beforeEach(() => {
    emitNervesEvent.mockReset()
  })

  it("replays historical messages as new-message probes by default and renders attachment handles", async () => {
    const normalizeEvent = vi.fn((payload: unknown) => {
      const envelope = payload as { type: string; data: { guid: string } }
      return makeProbeEvent(envelope.type, envelope.data.guid)
    })
    const repairEvent = vi.fn().mockResolvedValue({
      ...makeProbeEvent("new-message", "message-guid"),
      chat: {
        chatGuid: "any;-;ari@mendelow.me",
        chatIdentifier: "ari@mendelow.me",
        isGroup: false,
        sessionKey: "chat:any;-;ari@mendelow.me",
        sendTarget: { kind: "chat_guid" as const, value: "any;-;ari@mendelow.me" },
        participantHandles: [],
      },
      text: "ok booked!! here's the info -",
      textForAgent: "ok booked!! here's the info -\n[image description: booking confirmation screenshot]",
      attachments: [
        {
          guid: "attachment-guid",
          transferName: "IMG_0205.tiff.jpeg",
          mimeType: "image/jpeg",
          totalBytes: 21224262,
        },
      ],
    })
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()

    const { replayBlueBubblesMessage, formatBlueBubblesReplayText } = await import("../../../senses/bluebubbles/replay")
    const result = await replayBlueBubblesMessage(
      {
        agentName: "slugger",
        messageGuid: "message-guid",
      },
      {
        createClient: () => ({ repairEvent }) as any,
        normalizeEvent,
        setAgentName,
        resetIdentity,
      },
    )

    expect(normalizeEvent).toHaveBeenCalledWith({
      type: "new-message",
      data: {
        guid: "message-guid",
        hasPayloadData: true,
      },
    })
    expect(repairEvent).toHaveBeenCalledWith(makeProbeEvent("new-message", "message-guid"))
    expect(result.attachmentIds).toEqual(["attachment:bluebubbles:attachment-guid"])
    expect(result.attachmentBlock).toContain("attachment:bluebubbles:attachment-guid")
    expect(result.hint).toBeUndefined()
    expect(setAgentName).toHaveBeenCalledWith("slugger")
    expect(resetIdentity).toHaveBeenCalledTimes(1)
    expect(formatBlueBubblesReplayText(result)).toContain("probe: new-message")
    expect(formatBlueBubblesReplayText(result)).toContain("attachment:bluebubbles:attachment-guid")
    expect(formatBlueBubblesReplayText(result).match(/attachment:bluebubbles:attachment-guid/g)).toHaveLength(1)
  })

  it("adds a replay hint when updated-message repair lands on a state-only mutation", async () => {
    const normalizeEvent = vi.fn((payload: unknown) => {
      const envelope = payload as { type: string; data: { guid: string } }
      return makeProbeEvent(envelope.type, envelope.data.guid)
    })
    const repairEvent = vi.fn().mockResolvedValue({
      kind: "mutation" as const,
      eventType: "updated-message",
      mutationType: "read" as const,
      messageGuid: "message-guid",
      timestamp: Date.parse("2026-04-08T19:01:00.000Z"),
      fromMe: false,
      sender: {
        provider: "imessage-handle" as const,
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: {
        chatGuid: "any;-;ari@mendelow.me",
        chatIdentifier: "ari@mendelow.me",
        isGroup: false,
        sessionKey: "chat:any;-;ari@mendelow.me",
        sendTarget: { kind: "chat_guid" as const, value: "any;-;ari@mendelow.me" },
        participantHandles: [],
      },
      shouldNotifyAgent: false,
      textForAgent: "message marked as read",
      requiresRepair: false,
    })

    const { replayBlueBubblesMessage } = await import("../../../senses/bluebubbles/replay")
    const result = await replayBlueBubblesMessage(
      {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "updated-message",
      },
      {
        createClient: () => ({ repairEvent }) as any,
        normalizeEvent,
        setAgentName: vi.fn(),
        resetIdentity: vi.fn(),
      },
    )

    expect(result.hint).toContain("--event-type new-message")
  })
})
