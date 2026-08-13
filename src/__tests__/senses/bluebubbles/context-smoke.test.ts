import { beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => emitNervesEvent(...args),
}))

function message(overrides: Partial<any> = {}) {
  const timestamp = overrides.timestamp ?? Date.parse("2026-07-09T19:25:00.000Z")
  return {
    kind: "message" as const,
    eventType: "new-message",
    messageGuid: overrides.messageGuid ?? "anchor-guid",
    timestamp,
    fromMe: false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: "ari@mendelow.me",
      rawId: "ari@mendelow.me",
      displayName: "Ari",
    },
    chat: {
      chatGuid: "any;+;thread-guid",
      chatIdentifier: "thread-guid",
      isGroup: true,
      sessionKey: "chat:any;+;thread-guid",
      sendTarget: { kind: "chat_guid" as const, value: "any;+;thread-guid" },
      participantHandles: ["ari@mendelow.me"],
    },
    text: overrides.text ?? "anchor body",
    textForAgent: overrides.textForAgent ?? overrides.text ?? "anchor body",
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
}

function queryResult(anchor: ReturnType<typeof message>, history: ReturnType<typeof message>[]) {
  const messages = [anchor, ...history]
  return {
    messages,
    rawRowCount: messages.length,
    normalizedRowCount: messages.length,
    skippedRowCount: 0,
    invalidCausalTimestampRowCount: 0,
    request: {
      limit: 41,
      offset: 0,
      sort: "DESC" as const,
      chatGuid: anchor.chat.chatGuid,
      beforeTimestamp: anchor.timestamp,
    },
  }
}

describe("BlueBubbles context smoke", () => {
  beforeEach(() => {
    emitNervesEvent.mockReset()
  })

  it("repairs an anchor message and verifies context without persisting by default", async () => {
    const anchor = message()
    const prior = message({
      messageGuid: "prior-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      text: "prior context body",
    })
    const normalizeEvent = vi.fn(() => message({ messageGuid: "anchor-guid", requiresRepair: true }))
    const repairEvent = vi.fn().mockResolvedValue(anchor)
    const queryRecentMessagesWithMetadata = vi.fn().mockResolvedValue(queryResult(anchor, [prior]))
    const setAgentName = vi.fn()
    const resetIdentity = vi.fn()
    const writePacket = vi.fn()

    const { smokeBlueBubblesContext, formatBlueBubblesContextSmokeText } = await import("../../../senses/bluebubbles/context-smoke")
    const result = await smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
    }, {
      createClient: () => ({ repairEvent, queryRecentMessagesWithMetadata }) as any,
      normalizeEvent,
      setAgentName,
      resetIdentity,
      writePacket,
    })

    expect(normalizeEvent).toHaveBeenCalledWith({
      type: "new-message",
      data: {
        guid: "anchor-guid",
        hasPayloadData: true,
      },
    })
    expect(repairEvent).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      sideEffect: false,
      agentName: "slugger",
      messageGuid: "anchor-guid",
      contextMessages: 1,
    })
    expect(writePacket).not.toHaveBeenCalled()
    expect(setAgentName).toHaveBeenCalledWith("slugger")
    expect(resetIdentity).toHaveBeenCalledTimes(1)
    expect(formatBlueBubblesContextSmokeText(result)).not.toContain("prior context body")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_context_smoke_start",
    }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_context_smoke_end",
      meta: expect.objectContaining({
        sideEffect: false,
      }),
    }))
  })

  it("rejects blank inputs before touching identity", async () => {
    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")

    await expect(smokeBlueBubblesContext({
      agentName: " ",
      messageGuid: "anchor-guid",
    })).rejects.toThrow("requires agentName")
    await expect(smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: " ",
    })).rejects.toThrow("requires messageGuid")

    expect(emitNervesEvent).not.toHaveBeenCalled()
  })

  it("persists the packet when --persist behavior is requested", async () => {
    const anchor = message()
    const prior = message({
      messageGuid: "prior-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      text: "prior context body",
    })
    const writePacket = vi.fn(() => ({
      ledgerPath: "/tmp/ledger.jsonl",
      packetPath: "/tmp/packet.json",
      receiptPath: "/tmp/receipt.json",
    }))

    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")
    const result = await smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
      persist: true,
    }, {
      createClient: () => ({
        repairEvent: vi.fn().mockResolvedValue(anchor),
        queryRecentMessagesWithMetadata: vi.fn().mockResolvedValue(queryResult(anchor, [prior])),
      }) as any,
      normalizeEvent: vi.fn(() => message({ messageGuid: "anchor-guid", requiresRepair: true })),
      setAgentName: vi.fn(),
      resetIdentity: vi.fn(),
      getAgentRoot: vi.fn(() => "/agents/slugger.ouro"),
      writePacket,
    })

    expect(writePacket).toHaveBeenCalledWith("/agents/slugger.ouro", expect.objectContaining({
      anchorMessageGuid: "anchor-guid",
    }))
    expect(result).toMatchObject({
      sideEffect: "private-runtime-ledger-write",
      ledgerPath: "/tmp/ledger.jsonl",
      packetPath: "/tmp/packet.json",
      receiptPath: "/tmp/receipt.json",
    })
  })

  it("formats persisted smoke results without transcript text", async () => {
    const { formatBlueBubblesContextSmokeText } = await import("../../../senses/bluebubbles/context-smoke")

    const text = formatBlueBubblesContextSmokeText({
      ok: true,
      sideEffect: "private-runtime-ledger-write",
      agentName: "slugger",
      messageGuid: "anchor-guid",
      packetId: "scp_packet",
      contextMessages: 2,
      renderedMessages: 2,
      renderedCharacters: 240,
      omittedMessages: 0,
      truncatedMessages: 0,
      ledgerPath: "/tmp/ledger.jsonl",
      packetPath: "/tmp/packet.json",
      receiptPath: "/tmp/receipt.json",
    })

    expect(text).toContain("bluebubbles context smoke passed")
    expect(text).toContain("ledger_path: /tmp/ledger.jsonl")
    expect(text).toContain("packet_path: /tmp/packet.json")
    expect(text).toContain("receipt_path: /tmp/receipt.json")
    expect(text).not.toContain("prior context body")
  })

  it("emits an error nerve and resets identity when no context can be built", async () => {
    const resetIdentity = vi.fn()
    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")

    await expect(smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
    }, {
      createClient: () => ({
        repairEvent: vi.fn().mockResolvedValue(message()),
        queryRecentMessagesWithMetadata: vi.fn().mockResolvedValue(queryResult(message(), [])),
      }) as any,
      normalizeEvent: vi.fn(() => message({ messageGuid: "anchor-guid", requiresRepair: true })),
      setAgentName: vi.fn(),
      resetIdentity,
    })).rejects.toThrow("no same-thread history")

    expect(resetIdentity).toHaveBeenCalledTimes(1)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_context_smoke_error",
      meta: expect.objectContaining({
        reason: expect.stringContaining("no same-thread history"),
      }),
    }))
  })

  it("records non-Error failure reasons", async () => {
    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")

    await expect(smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
    }, {
      createClient: () => ({
        repairEvent: vi.fn().mockRejectedValue("repair boom"),
        queryRecentMessagesWithMetadata: vi.fn(),
      }) as any,
      normalizeEvent: vi.fn(() => message({ messageGuid: "anchor-guid", requiresRepair: true })),
      setAgentName: vi.fn(),
      resetIdentity: vi.fn(),
    })).rejects.toBe("repair boom")

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_context_smoke_error",
      meta: expect.objectContaining({
        reason: "repair boom",
      }),
    }))
  })

  it("rejects repaired non-message events before querying context", async () => {
    const resetIdentity = vi.fn()
    const queryRecentMessagesWithMetadata = vi.fn()
    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")

    await expect(smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
    }, {
      createClient: () => ({
        repairEvent: vi.fn().mockResolvedValue({
          kind: "mutation",
          eventType: "updated-message",
          mutationType: "read",
          messageGuid: "anchor-guid",
          timestamp: Date.parse("2026-07-09T19:25:00.000Z"),
          fromMe: false,
          sender: {
            provider: "imessage-handle",
            externalId: "ari@mendelow.me",
            rawId: "ari@mendelow.me",
            displayName: "Ari",
          },
          chat: {
            chatGuid: "any;+;thread-guid",
            chatIdentifier: "thread-guid",
            isGroup: true,
            sessionKey: "chat:any;+;thread-guid",
            sendTarget: { kind: "chat_guid", value: "any;+;thread-guid" },
            participantHandles: ["ari@mendelow.me"],
          },
          shouldNotifyAgent: false,
          textForAgent: "message marked as read",
          requiresRepair: false,
        }),
        queryRecentMessagesWithMetadata,
      }) as any,
      normalizeEvent: vi.fn(() => message({ messageGuid: "anchor-guid", requiresRepair: true })),
      setAgentName: vi.fn(),
      resetIdentity,
    })).rejects.toThrow("requires a message event")

    expect(queryRecentMessagesWithMetadata).not.toHaveBeenCalled()
    expect(resetIdentity).toHaveBeenCalledTimes(1)
  })

  it("refreshes machine runtime credentials before creating the default live client", async () => {
    const anchor = message()
    const prior = message({
      messageGuid: "prior-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      text: "prior context body",
    })
    const repairEvent = vi.fn().mockResolvedValue(anchor)
    const queryRecentMessagesWithMetadata = vi.fn().mockResolvedValue(queryResult(anchor, [prior]))
    const createDefaultClient = vi.fn(() => ({ repairEvent, queryRecentMessagesWithMetadata }) as any)
    const refreshMachineRuntimeConfig = vi.fn().mockResolvedValue(undefined)

    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")
    const result = await smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
    }, {
      normalizeEvent: vi.fn(() => message({ messageGuid: "anchor-guid", requiresRepair: true })),
      setAgentName: vi.fn(),
      resetIdentity: vi.fn(),
      loadMachineId: () => "machine-test",
      refreshMachineRuntimeConfig,
      createDefaultClient,
    })

    expect(refreshMachineRuntimeConfig).toHaveBeenCalledWith(
      "slugger",
      "machine-test",
      { preserveCachedOnFailure: true },
    )
    expect(createDefaultClient).toHaveBeenCalledTimes(1)
    expect(result.contextMessages).toBe(1)
  })
})
