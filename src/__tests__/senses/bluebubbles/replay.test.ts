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
        {
          guid: "   ",
          transferName: "ignored.tiff",
          mimeType: "image/tiff",
          totalBytes: 1024,
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

  it("rejects blank replay identifiers before touching identity or repair logic", async () => {
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()

    const { replayBlueBubblesMessage } = await import("../../../senses/bluebubbles/replay")

    await expect(
      replayBlueBubblesMessage(
        {
          agentName: "slugger",
          messageGuid: "   ",
        },
        {
          createClient: () => ({ repairEvent: vi.fn() }) as any,
          normalizeEvent: vi.fn(),
          setAgentName,
          resetIdentity,
        },
      ),
    ).rejects.toThrow("messageGuid")

    expect(setAgentName).not.toHaveBeenCalled()
    expect(resetIdentity).not.toHaveBeenCalled()
  })

  it("rejects blank replay agent names before touching repair logic", async () => {
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()

    const { replayBlueBubblesMessage } = await import("../../../senses/bluebubbles/replay")

    await expect(
      replayBlueBubblesMessage(
        {
          agentName: "   ",
          messageGuid: "message-guid",
        },
        {
          createClient: () => ({ repairEvent: vi.fn() }) as any,
          normalizeEvent: vi.fn(),
          setAgentName,
          resetIdentity,
        },
      ),
    ).rejects.toThrow("agentName")

    expect(setAgentName).not.toHaveBeenCalled()
    expect(resetIdentity).not.toHaveBeenCalled()
  })

  it("formats repair notices and hints when present", async () => {
    const { formatBlueBubblesReplayText } = await import("../../../senses/bluebubbles/replay")

    const rendered = formatBlueBubblesReplayText({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "new-message",
      },
      event: {
        ...makeProbeEvent("new-message", "message-guid"),
        textForAgent: "booking screenshot",
        repairNotice: "repair fell back to hydrated payload",
      },
      attachmentIds: [],
      attachmentBlock: "",
      hint: "rerun with --event-type updated-message to inspect the mutation path",
    })

    expect(rendered).toContain("repair_notice: repair fell back to hydrated payload")
    expect(rendered).toContain("[hint]")
    expect(rendered).toContain("rerun with --event-type updated-message")
  })

  it("formats mutation replays and reports input part counts for messages", async () => {
    const { formatBlueBubblesReplayText } = await import("../../../senses/bluebubbles/replay")

    const mutationRendered = formatBlueBubblesReplayText({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "updated-message",
      },
      event: {
        kind: "mutation",
        eventType: "updated-message",
        mutationType: "read",
        messageGuid: "message-guid",
        timestamp: Date.parse("2026-04-08T19:01:00.000Z"),
        fromMe: false,
        sender: {
          provider: "imessage-handle",
          externalId: "ari@mendelow.me",
          rawId: "ari@mendelow.me",
          displayName: "ari@mendelow.me",
        },
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
          participantHandles: [],
        },
        shouldNotifyAgent: false,
        textForAgent: "message marked as read",
        requiresRepair: false,
      },
      attachmentIds: [],
      attachmentBlock: "",
    })

    const messageRendered = formatBlueBubblesReplayText({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "new-message",
      },
      event: {
        ...makeProbeEvent("new-message", "message-guid"),
        textForAgent: "booking screenshot",
        inputPartsForAgent: [
          {
            type: "text",
            text: "booking screenshot",
          },
        ],
      },
      attachmentIds: [],
      attachmentBlock: "",
    })

    expect(mutationRendered).toContain("mutation_type: read")
    expect(messageRendered).toContain("input_parts_for_agent: 1")
  })

  it("formats empty text and avoids duplicating inline attachment blocks", async () => {
    const { formatBlueBubblesReplayText } = await import("../../../senses/bluebubbles/replay")
    const attachmentBlock = "[attachments]\n- attachment:bluebubbles:attachment-guid | image | IMG_0205.tiff.jpeg | image/jpeg | 20.2 MB"

    const inlineRendered = formatBlueBubblesReplayText({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "new-message",
      },
      event: {
        ...makeProbeEvent("new-message", "message-guid"),
        textForAgent: `ok booked!! here's the info -\n${attachmentBlock}`,
      },
      attachmentIds: ["attachment:bluebubbles:attachment-guid"],
      attachmentBlock,
    })

    const emptyRendered = formatBlueBubblesReplayText({
      probe: {
        agentName: "slugger",
        messageGuid: "message-guid",
        eventType: "new-message",
      },
      event: makeProbeEvent("new-message", "message-guid"),
      attachmentIds: [],
      attachmentBlock: "",
    })

    expect(inlineRendered.match(/attachment:bluebubbles:attachment-guid/g)).toHaveLength(1)
    expect(emptyRendered).toContain("(empty)")
  })

  it("emits replay_error and still resets identity when repair throws", async () => {
    const repairEvent = vi.fn().mockRejectedValue("repair exploded")
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()
    const normalizeEvent = vi.fn(() => makeProbeEvent("new-message", "message-guid"))

    const { replayBlueBubblesMessage } = await import("../../../senses/bluebubbles/replay")

    await expect(
      replayBlueBubblesMessage(
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
      ),
    ).rejects.toBe("repair exploded")

    expect(resetIdentity).toHaveBeenCalledTimes(1)
    const replayError = emitNervesEvent.mock.calls.find(
      (call: unknown[]) => (call[0] as { event?: string })?.event === "senses.bluebubbles_replay_error",
    )
    expect(replayError).toBeDefined()
  })

  it("records replay_error reason from Error instances", async () => {
    const repairEvent = vi.fn().mockRejectedValue(new Error("repair exploded"))
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()
    const normalizeEvent = vi.fn(() => makeProbeEvent("new-message", "message-guid"))

    const { replayBlueBubblesMessage } = await import("../../../senses/bluebubbles/replay")

    await expect(
      replayBlueBubblesMessage(
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
      ),
    ).rejects.toThrow("repair exploded")

    const replayError = emitNervesEvent.mock.calls.find(
      (call: unknown[]) => (call[0] as { event?: string })?.event === "senses.bluebubbles_replay_error",
    )
    expect(replayError?.[0]).toMatchObject({
      meta: {
        reason: "repair exploded",
      },
    })
  })

  it("uses default helpers when overrides are absent", async () => {
    vi.resetModules()
    const createBlueBubblesClient = vi.fn()
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()
    const normalizeBlueBubblesEvent = vi.fn((payload: unknown) => {
      const envelope = payload as { type: string; data: { guid: string } }
      return makeProbeEvent(envelope.type, envelope.data.guid)
    })
    const repairEvent = vi.fn().mockResolvedValue({
      kind: "mutation" as const,
      eventType: "updated-message",
      mutationType: "delivery" as const,
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
      textForAgent: "message delivered",
      requiresRepair: false,
    })
    createBlueBubblesClient.mockReturnValue({ repairEvent })

    vi.doMock("../../../senses/bluebubbles/client", () => ({
      createBlueBubblesClient,
    }))
    vi.doMock("../../../heart/identity", () => ({
      setAgentName,
      resetIdentity,
    }))
    vi.doMock("../../../senses/bluebubbles/model", () => ({
      normalizeBlueBubblesEvent,
    }))

    const { replayBlueBubblesMessage } = await import("../../../senses/bluebubbles/replay")
    const result = await replayBlueBubblesMessage({
      agentName: "slugger",
      messageGuid: "message-guid",
      eventType: "updated-message",
    })

    expect(createBlueBubblesClient).toHaveBeenCalledTimes(1)
    expect(normalizeBlueBubblesEvent).toHaveBeenCalledWith({
      type: "updated-message",
      data: {
        guid: "message-guid",
        hasPayloadData: true,
      },
    })
    expect(setAgentName).toHaveBeenCalledWith("slugger")
    expect(resetIdentity).toHaveBeenCalledTimes(1)
    expect(result.hint).toContain("--event-type new-message")
  })
})
