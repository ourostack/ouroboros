import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => emitNervesEvent(...args),
}))

const dmChat = {
  chatGuid: "any;-;ari@mendelow.me",
  chatIdentifier: "ari@mendelow.me",
  isGroup: false,
  sessionKey: "chat:any;-;ari@mendelow.me",
  sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" } as const,
}

describe("BlueBubbles client", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    emitNervesEvent.mockReset()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("sends threaded replies through the BlueBubbles text endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { guid: "sent-guid" } }), { status: 200 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.sendText({
      chat: {
        chatGuid: "any;-;ari@mendelow.me",
        chatIdentifier: "ari@mendelow.me",
        isGroup: false,
        sessionKey: "chat:any;-;ari@mendelow.me",
        sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
      },
      text: "  hello from ouro  ",
      replyToMessageGuid: "incoming-guid",
    })

    expect(result).toEqual({ messageGuid: "sent-guid" })
    expect(global.fetch).toHaveBeenCalledWith(
      "http://bluebubbles.local/api/v1/message/text?password=secret-token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    )

    const request = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(request).toMatchObject({
      chatGuid: "any;-;ari@mendelow.me",
      message: "hello from ouro",
      method: "private-api",
      selectedMessageGuid: "incoming-guid",
      partIndex: 0,
    })
  })

  it("supports plain sends and root-level message guid responses", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ guid: "root-guid" }), { status: 200 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local/",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.sendText({
      chat: {
        chatGuid: "any;+;group-guid",
        chatIdentifier: "group-guid",
        displayName: "Consciousness TBD",
        isGroup: true,
        sessionKey: "chat:any;+;group-guid",
        sendTarget: { kind: "chat_guid", value: "any;+;group-guid" },
      },
      text: "plain send",
    })

    expect(result).toEqual({ messageGuid: "root-guid" })
    const request = JSON.parse((global.fetch as any).mock.calls[0][1].body)
    expect(request).not.toHaveProperty("method")
    expect(request).not.toHaveProperty("selectedMessageGuid")
  })

  it("rejects empty text and missing routable chat identity before calling fetch", async () => {
    global.fetch = vi.fn() as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    await expect(
      client.sendText({
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
        },
        text: "   ",
      }),
    ).rejects.toThrow("non-empty text")

    await expect(
      client.sendText({
        chat: {
          isGroup: false,
          sessionKey: "chat_identifier:unknown",
          sendTarget: { kind: "chat_identifier", value: "unknown" },
        },
        text: "hello",
      }),
    ).rejects.toThrow("requires chat.chatGuid")

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("resolves identifier-only chats to a chatGuid before sending", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                guid: "any;-;ari@mendelow.me",
                chatIdentifier: "ari@mendelow.me",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { guid: "resolved-guid" } }), { status: 200 }),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.sendText({
      chat: {
        chatIdentifier: "ari@mendelow.me",
        isGroup: false,
        sessionKey: "chat_identifier:ari@mendelow.me",
        sendTarget: { kind: "chat_identifier", value: "ari@mendelow.me" },
      },
      text: "hello from identifier",
    })

    expect(result).toEqual({ messageGuid: "resolved-guid" })
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://bluebubbles.local/api/v1/chat/query?password=secret-token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 500,
          offset: 0,
          with: ["participants"],
        }),
      }),
    )
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://bluebubbles.local/api/v1/message/text?password=secret-token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    )
    const sendBody = JSON.parse((global.fetch as any).mock.calls[1][1].body)
    expect(sendBody.chatGuid).toBe("any;-;ari@mendelow.me")
  })

  it("surfaces BlueBubbles send errors with response details", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("private api required", { status: 403 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    await expect(
      client.sendText({
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
        },
        text: "hello",
      }),
    ).rejects.toThrow("BlueBubbles send failed (403): private api required")
  })

  it("treats empty or invalid response bodies as guid-less success and repairs events as passthrough", async () => {
    const responses = [
      new Response("", { status: 200 }),
      new Response("not-json", { status: 200 }),
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    ]
    global.fetch = vi.fn().mockImplementation(async () => responses.shift()!) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    await expect(client.sendText({ chat: dmChat, text: "hello once" })).resolves.toEqual({ messageGuid: undefined })
    await expect(client.sendText({ chat: dmChat, text: "hello twice" })).resolves.toEqual({ messageGuid: undefined })
    await expect(client.sendText({ chat: dmChat, text: "hello thrice" })).resolves.toEqual({ messageGuid: undefined })

    const event = {
      kind: "message" as const,
      eventType: "new-message",
      messageGuid: "msg-1",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle" as const,
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "hi",
      textForAgent: "hi",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    }

    await expect(client.repairEvent(event)).resolves.toBe(event)
  })

  it("hydrates repairable OG-card messages by fetching the full BlueBubbles message record", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            guid: "msg-og",
            text: "https://ouroboros.bot",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [
              {
                guid: "payload-guid",
                transferName: "preview.pluginPayloadAttachment",
                totalBytes: 1234,
              },
            ],
            balloonBundleId: "com.apple.messages.URLBalloonProvider",
            hasPayloadData: true,
            payloadData: [
              {
                title: "Ouroboros Bot",
                summary: "Agent harness for iMessage",
              },
            ],
            chats: [
              {
                guid: "any;-;ari@mendelow.me",
                style: 45,
                chatIdentifier: "ari@mendelow.me",
                displayName: "",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "msg-og",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "https://ouroboros.bot",
      textForAgent: "https://ouroboros.bot\n[link preview attached]",
      attachments: [{ guid: "payload-guid", transferName: "preview.pluginPayloadAttachment" }],
      balloonBundleId: "com.apple.messages.URLBalloonProvider",
      hasPayloadData: true,
      requiresRepair: true,
    })

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/message/msg-og?"),
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    )
    expect(result).toEqual(
      expect.objectContaining({
        kind: "message",
        messageGuid: "msg-og",
        requiresRepair: false,
      }),
    )
    expect(result.textForAgent).toContain("Ouroboros Bot")
    expect(result.textForAgent).toContain("Agent harness for iMessage")
  })

  it("returns an explicit fallback notice when repair fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "msg-audio",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "",
      textForAgent: "[audio attachment: Audio Message.mp3]",
      attachments: [{ guid: "audio-guid", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result.requiresRepair).toBe(false)
    expect(result.textForAgent).toContain("audio attachment")
    expect(result).toEqual(
      expect.objectContaining({
        repairNotice: expect.stringContaining("network down"),
      }),
    )
  })

  it("returns an explicit fallback notice when the repair endpoint returns an HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("missing private api helper", { status: 503 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "edit",
      messageGuid: "edit-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      shouldNotifyAgent: true,
      textForAgent: "edited message: newer text",
      requiresRepair: true,
    })

    expect(result.requiresRepair).toBe(false)
    expect(result).toEqual(
      expect.objectContaining({
        repairNotice: "BlueBubbles repair failed: missing private api helper",
      }),
    )
  })

  it("falls back to HTTP status/unknown when the repair endpoint errors without a readable body", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("", { status: 503 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "unsend",
      messageGuid: "unsend-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      shouldNotifyAgent: true,
      textForAgent: "unsent a message",
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        repairNotice: "BlueBubbles repair failed: HTTP 503",
      }),
    )
  })

  it("falls back to HTTP status/unknown when reading the repair error body throws", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: vi.fn().mockRejectedValue(new Error("no body")),
    }) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "delivery-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      shouldNotifyAgent: false,
      textForAgent: "message marked as delivered",
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        repairNotice: "BlueBubbles repair failed: HTTP 502",
      }),
    )
  })

  it("returns an explicit fallback notice when the repair endpoint payload is unusable", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { text: "missing guid" } }), { status: 200 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "broken-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "https://ouroboros.bot",
      textForAgent: "https://ouroboros.bot\n[link preview attached]",
      attachments: [{ guid: "payload-guid", transferName: "preview.pluginPayloadAttachment" }],
      balloonBundleId: "com.apple.messages.URLBalloonProvider",
      hasPayloadData: true,
      requiresRepair: true,
    })

    expect(result.requiresRepair).toBe(false)
    expect(result).toEqual(
      expect.objectContaining({
        repairNotice: "BlueBubbles repair failed: invalid message payload",
      }),
    )
  })

  it("marks repaired mutations as no longer requiring repair when fetch succeeds", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            guid: "edit-guid",
            text: "edited version",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [],
            dateEdited: 1772949005000,
            chats: [
              {
                guid: "any;-;ari@mendelow.me",
                style: 45,
                chatIdentifier: "ari@mendelow.me",
                displayName: "",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "edit",
      messageGuid: "edit-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      shouldNotifyAgent: true,
      textForAgent: "edited message: older version",
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "mutation",
        mutationType: "edit",
        requiresRepair: false,
      }),
    )
  })

  it("marks repaired non-balloon messages as no longer requiring repair without changing their text", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            guid: "image-guid",
            text: "",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [
              {
                guid: "image-1",
                mimeType: "image/jpeg",
                transferName: "IMG_5045.heic.jpeg",
                width: 600,
                height: 800,
              },
            ],
            chats: [
              {
                guid: "any;-;ari@mendelow.me",
                style: 45,
                chatIdentifier: "ari@mendelow.me",
                displayName: "",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "image-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "",
      textForAgent: "[image attachment: IMG_5045.heic.jpeg (600x800)]",
      attachments: [{ guid: "image-1", mimeType: "image/jpeg", transferName: "IMG_5045.heic.jpeg", width: 600, height: 800 }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "message",
        requiresRepair: false,
        textForAgent: "[image attachment: IMG_5045.heic.jpeg (600x800)]",
      }),
    )
  })

  it("keeps generic OG-card fallback text when repair succeeds but no preview metadata is available", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            guid: "msg-og-no-preview",
            text: "https://ouroboros.bot",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [
              {
                guid: "payload-guid",
                transferName: "preview.pluginPayloadAttachment",
                totalBytes: 1234,
              },
            ],
            balloonBundleId: "com.apple.messages.URLBalloonProvider",
            hasPayloadData: true,
            payloadData: [],
            chats: [
              {
                guid: "any;-;ari@mendelow.me",
                style: 45,
                chatIdentifier: "ari@mendelow.me",
                displayName: "",
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "msg-og-no-preview",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "https://ouroboros.bot",
      textForAgent: "https://ouroboros.bot\n[link preview attached]",
      attachments: [{ guid: "payload-guid", transferName: "preview.pluginPayloadAttachment" }],
      balloonBundleId: "com.apple.messages.URLBalloonProvider",
      hasPayloadData: true,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        requiresRepair: false,
        textForAgent: "https://ouroboros.bot\n[link preview attached]",
      }),
    )
  })

  it("accepts root-level repair payloads without a wrapping data envelope", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          guid: "root-level-guid",
          text: "plain repaired text",
          handle: {
            address: "ari@mendelow.me",
            service: "iMessage",
          },
          attachments: [],
          chats: [
            {
              guid: "any;-;ari@mendelow.me",
              style: 45,
              chatIdentifier: "ari@mendelow.me",
              displayName: "",
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "root-level-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "plain repaired text",
      textForAgent: "plain repaired text",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        messageGuid: "root-level-guid",
        requiresRepair: false,
        textForAgent: "plain repaired text",
      }),
    )
  })

  it("hydrates empty-text OG cards with preview metadata while capping noisy payload strings", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          guid: "root-level-preview-guid",
          text: "",
          handle: {
            address: "ari@mendelow.me",
            service: "iMessage",
          },
          attachments: [
            {
              guid: "payload-guid",
              transferName: "preview.pluginPayloadAttachment",
            },
          ],
          balloonBundleId: "com.apple.messages.URLBalloonProvider",
          payloadData: [
            {
              title: "   ",
              summary: "One",
              subtitle: "Two",
              previewText: "Three",
              siteName: "Four",
              host: "Five",
            },
            {
              title: "Six",
            },
          ],
          chats: [
            {
              guid: "any;-;ari@mendelow.me",
              style: 45,
              chatIdentifier: "ari@mendelow.me",
              displayName: "",
            },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "root-level-preview-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "",
      textForAgent: "[link preview attached]",
      attachments: [{ guid: "payload-guid", transferName: "preview.pluginPayloadAttachment" }],
      balloonBundleId: "com.apple.messages.URLBalloonProvider",
      hasPayloadData: true,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        requiresRepair: false,
        textForAgent: "[link preview: One — Two]",
      }),
    )
  })

  it("turns non-Error repair throws into explicit fallback notices too", async () => {
    global.fetch = vi.fn().mockRejectedValue("socket reset") as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    const result = await client.repairEvent({
      kind: "message",
      eventType: "new-message",
      messageGuid: "string-throw-guid",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "ari@mendelow.me",
        rawId: "ari@mendelow.me",
        displayName: "ari@mendelow.me",
      },
      chat: dmChat,
      text: "",
      textForAgent: "[audio attachment: Audio Message.mp3]",
      attachments: [{ guid: "audio-guid", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        repairNotice: "BlueBubbles repair failed: socket reset",
      }),
    )
  })

  it("falls back to an unknown error body when reading the error response fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockRejectedValue(new Error("no body")),
    }) as typeof fetch

    const { createBlueBubblesClient } = await import("../../senses/bluebubbles-client")
    const client = createBlueBubblesClient(
      {
        serverUrl: "http://bluebubbles.local",
        password: "secret-token",
        accountId: "default",
      },
      {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
        requestTimeoutMs: 30000,
      },
    )

    await expect(
      client.sendText({
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:any;-;ari@mendelow.me",
          sendTarget: { kind: "chat_guid", value: "any;-;ari@mendelow.me" },
        },
        text: "hello",
      }),
    ).rejects.toThrow("BlueBubbles send failed (500): unknown")
  })
})
