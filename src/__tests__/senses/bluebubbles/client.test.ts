import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => emitNervesEvent(...args),
}))

vi.mock("../../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  })),
  getAgentToolsRoot: () => "/tmp/AgentBundles/slugger.ouro/state/tools",
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
    vi.doUnmock("../../../senses/bluebubbles/media")
  })

  it("sends threaded replies through the BlueBubbles text endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { guid: "sent-guid" } }), { status: 200 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

  it("edits outbound messages through the BlueBubbles edit endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 })) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      client.editMessage({
        messageGuid: "sent-guid",
        text: "  updated text  ",
      }),
    ).resolves.toBeUndefined()

    expect(global.fetch).toHaveBeenCalledWith(
      "http://bluebubbles.local/api/v1/message/sent-guid/edit?password=secret-token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          editedMessage: "updated text",
          backwardsCompatibilityMessage: "Edited to: updated text",
          partIndex: 0,
        }),
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("supports explicit backwards-compatibility text and part indexes for edits", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 })) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await client.editMessage({
      messageGuid: "sent-guid",
      text: "updated text",
      backwardsCompatibilityMessage: "compat text",
      partIndex: 2,
    })

    expect(JSON.parse((global.fetch as any).mock.calls[0][1].body)).toEqual({
      editedMessage: "updated text",
      backwardsCompatibilityMessage: "compat text",
      partIndex: 2,
    })
  })

  it("rejects empty edit message ids and bodies before calling fetch", async () => {
    global.fetch = vi.fn() as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.editMessage({ messageGuid: "   ", text: "updated" })).rejects.toThrow(
      "BlueBubbles edit requires messageGuid.",
    )
    await expect(client.editMessage({ messageGuid: "sent-guid", text: "   " })).rejects.toThrow(
      "BlueBubbles edit requires non-empty text.",
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("marks chats as read and toggles typing through the BlueBubbles chat endpoints", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 })) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.markChatRead(dmChat)).resolves.toBeUndefined()
    await expect(client.setTyping(dmChat, true)).resolves.toBeUndefined()
    await expect(client.setTyping(dmChat, false)).resolves.toBeUndefined()

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "http://bluebubbles.local/api/v1/chat/any%3B-%3Bari%40mendelow.me/read?password=secret-token",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    )
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "http://bluebubbles.local/api/v1/chat/any%3B-%3Bari%40mendelow.me/typing?password=secret-token",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    )
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "http://bluebubbles.local/api/v1/chat/any%3B-%3Bari%40mendelow.me/typing?password=secret-token",
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    )
  })

  it("surfaces edit, typing, and read transport errors with response details", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("edit nope", { status: 500 }))
      .mockResolvedValueOnce(new Response("typing nope", { status: 502 }))
      .mockResolvedValueOnce(new Response("read nope", { status: 503 })) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.editMessage({ messageGuid: "sent-guid", text: "updated" })).rejects.toThrow(
      "BlueBubbles edit failed (500): edit nope",
    )
    await expect(client.setTyping(dmChat, true)).rejects.toThrow(
      "BlueBubbles typing failed (502): typing nope",
    )
    await expect(client.markChatRead(dmChat)).rejects.toThrow(
      "BlueBubbles read failed (503): read nope",
    )
  })

  it("falls back to unknown when edit, typing, or read error bodies cannot be read", async () => {
    const unreadable = (status: number) => ({
      ok: false,
      status,
      text: vi.fn().mockRejectedValue(new Error("body stream gone")),
    })
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(unreadable(500))
      .mockResolvedValueOnce(unreadable(502))
      .mockResolvedValueOnce(unreadable(503)) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.editMessage({ messageGuid: "sent-guid", text: "updated" })).rejects.toThrow(
      "BlueBubbles edit failed (500): unknown",
    )
    await expect(client.setTyping(dmChat, true)).rejects.toThrow(
      "BlueBubbles typing failed (502): unknown",
    )
    await expect(client.markChatRead(dmChat)).rejects.toThrow(
      "BlueBubbles read failed (503): unknown",
    )
  })

  it("no-ops typing and read operations when no chat guid can be resolved", async () => {
    global.fetch = vi.fn() as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const unresolvedChat = {
      isGroup: false,
      sessionKey: "chat_identifier:missing",
      sendTarget: { kind: "chat_identifier", value: "missing" } as const,
    }

    await expect(client.setTyping(unresolvedChat, true)).resolves.toBeUndefined()
    await expect(client.markChatRead(unresolvedChat)).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("rejects empty text and missing routable chat identity before calling fetch", async () => {
    global.fetch = vi.fn() as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

  it("can recover chat identifiers from guid-only chat query rows", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              guid: "any;-;ari@mendelow.me",
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ guid: "guid-only-result" }), { status: 200 }),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      text: "guid fallback",
    })

    expect(result).toEqual({ messageGuid: "guid-only-result" })
  })

  it("treats malformed guid-only chat query rows as unresolved routing", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              guid: "chat-guid-only",
            },
          ]),
          { status: 200 },
        ),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat_identifier:ari@mendelow.me",
          sendTarget: { kind: "chat_identifier", value: "ari@mendelow.me" },
        },
        text: "bad guid shape",
      }),
    ).rejects.toThrow("requires chat.chatGuid")
  })

  it("treats empty identifiers embedded in chat guids as unresolved routing", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              guid: "any;-;",
            },
          ]),
          { status: 200 },
        ),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat_identifier:ari@mendelow.me",
          sendTarget: { kind: "chat_identifier", value: "ari@mendelow.me" },
        },
        text: "empty guid identifier",
      }),
    ).rejects.toThrow("requires chat.chatGuid")
  })

  it("fails clearly when identifier-only routing cannot be resolved", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ identifier: "someone-else" }, {}] }), { status: 200 }),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat_identifier:ari@mendelow.me",
          sendTarget: { kind: "chat_identifier", value: "ari@mendelow.me" },
        },
        text: "still needs routing",
      }),
    ).rejects.toThrow("requires chat.chatGuid")
  })

  it("treats invalid chat-query payloads as unresolved routing instead of crashing", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { guid: "not-an-array" } }), { status: 200 }),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat_identifier:ari@mendelow.me",
          sendTarget: { kind: "chat_identifier", value: "ari@mendelow.me" },
        },
        text: "bad payload",
      }),
    ).rejects.toThrow("requires chat.chatGuid")
  })

  it("fails clearly when identifier lookup returns an HTTP error", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("no query access", { status: 503 })) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat_identifier:ari@mendelow.me",
          sendTarget: { kind: "chat_identifier", value: "ari@mendelow.me" },
        },
        text: "query failed",
      }),
    ).rejects.toThrow("requires chat.chatGuid")
  })

  it("surfaces BlueBubbles send errors with response details", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("private api required", { status: 403 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

  it("probes upstream availability through the BlueBubbles message count endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { total: 42 } }), { status: 200 })) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.checkHealth()).resolves.toBeUndefined()
    expect(global.fetch).toHaveBeenCalledWith(
      "http://bluebubbles.local/api/v1/message/count?password=secret-token",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("surfaces upstream health probe failures with the response body when BlueBubbles is unreachable", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("connection refused", { status: 503 }),
    ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.checkHealth()).rejects.toThrow(
      "BlueBubbles upstream health check failed (503): connection refused",
    )
  })

  it("falls back to an unknown reason when BlueBubbles health probe responses cannot be read", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: vi.fn().mockRejectedValue(new Error("socket closed")),
    }) as unknown as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    await expect(client.checkHealth()).rejects.toThrow(
      "BlueBubbles upstream health check failed (502): unknown",
    )
  })

  it("promotes repaired state-only delivery mutations into inbound message events when the full message exists", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            guid: "delivery-guid",
            text: "you missed this while the webhook path was sick",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            isDelivered: true,
            dateDelivered: 1772949155000,
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
        kind: "message",
        messageGuid: "delivery-guid",
        textForAgent: "you missed this while the webhook path was sick",
        requiresRepair: false,
      }),
    )
  })

  it("keeps repaired state-only mutations as mutations when the fetched record still has no recoverable content", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            guid: "delivery-guid",
            text: "",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
        kind: "message",
        eventType: "updated-message",
        textForAgent: "",
        requiresRepair: false,
      }),
    )
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
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
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("image-bytes"), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      ) as typeof fetch

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
        inputPartsForAgent: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${Buffer.from("image-bytes").toString("base64")}`,
              detail: "auto",
            },
          },
        ],
      }),
    )
  })

  it("adds repaired voice-note transcripts to agent text when the provider cannot use raw audio", async () => {
    const hydrateBlueBubblesAttachments = vi.fn().mockResolvedValue({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: hello from audio"],
      notices: [],
    })
    vi.doMock("../../../senses/bluebubbles/media", () => ({
      hydrateBlueBubblesAttachments,
    }))

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "voice-guid",
              text: "",
              handle: {
                address: "ari@mendelow.me",
                service: "iMessage",
              },
              attachments: [
                {
                  guid: "audio-1",
                  mimeType: "audio/mp3",
                  transferName: "Audio Message.mp3",
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
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("audio-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      ) as typeof fetch

    vi.resetModules()
    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      messageGuid: "voice-guid",
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
      attachments: [{ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "message",
        requiresRepair: false,
        inputPartsForAgent: undefined,
        textForAgent:
          "[audio attachment: Audio Message.mp3]\n[voice note transcript: hello from audio]",
      }),
    )
    expect(hydrateBlueBubblesAttachments.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }),
    ])
    expect(hydrateBlueBubblesAttachments.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ preferAudioInput: false }),
    )
  })

  it("keeps OpenAI Codex voice notes on the local-transcription path for the current Responses contract", async () => {
    const { loadAgentConfig } = await import("../../../heart/identity")
    vi.mocked(loadAgentConfig).mockReturnValue({ humanFacing: { provider: "openai-codex", model: "gpt-5.4" }, agentFacing: { provider: "openai-codex", model: "gpt-5.4" } } as any)
    const hydrateBlueBubblesAttachments = vi.fn().mockResolvedValue({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: hello from codex"],
      notices: [],
    })
    vi.doMock("../../../senses/bluebubbles/media", () => ({
      hydrateBlueBubblesAttachments,
    }))

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              guid: "voice-guid",
              text: "",
              handle: {
                address: "ari@mendelow.me",
                service: "iMessage",
              },
              attachments: [
                {
                  guid: "audio-1",
                  mimeType: "audio/mp3",
                  transferName: "Audio Message.mp3",
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
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("audio-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      ) as typeof fetch

    vi.resetModules()
    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      messageGuid: "voice-guid",
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
      attachments: [{ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "message",
        requiresRepair: false,
        textForAgent: "[audio attachment: Audio Message.mp3]\n[voice note transcript: hello from codex]",
        inputPartsForAgent: undefined,
      }),
    )
    expect(hydrateBlueBubblesAttachments).toHaveBeenCalledWith(
      [{ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ preferAudioInput: false }),
    )
  })

  it("keeps MiniMax voice notes on the local-transcription path", async () => {
    const { loadAgentConfig } = await import("../../../heart/identity")
    vi.mocked(loadAgentConfig).mockReturnValue({ humanFacing: { provider: "minimax", model: "minimax-text-01" }, agentFacing: { provider: "minimax", model: "minimax-text-01" } } as any)
    const hydrateBlueBubblesAttachments = vi.fn().mockResolvedValue({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: hello from minimax"],
      notices: [],
    })
    vi.doMock("../../../senses/bluebubbles/media", () => ({
      hydrateBlueBubblesAttachments,
    }))

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            guid: "voice-guid",
            text: "",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [
              {
                guid: "audio-1",
                mimeType: "audio/mp3",
                transferName: "Audio Message.mp3",
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

    vi.resetModules()
    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      messageGuid: "voice-guid",
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
      attachments: [{ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        kind: "message",
        requiresRepair: false,
        textForAgent: "[audio attachment: Audio Message.mp3]\n[voice note transcript: hello from minimax]",
        inputPartsForAgent: undefined,
      }),
    )
    expect(hydrateBlueBubblesAttachments).toHaveBeenCalledWith(
      [{ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ preferAudioInput: false }),
    )
  })

  it("appends repair notices from hydrated media when no structured input is available", async () => {
    const hydrateBlueBubblesAttachments = vi.fn().mockResolvedValue({
      inputParts: [],
      transcriptAdditions: [],
      notices: ["attachment hydration failed for file.pdf: socket reset"],
    })
    vi.doMock("../../../senses/bluebubbles/media", () => ({
      hydrateBlueBubblesAttachments,
    }))

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            guid: "file-guid",
            text: "",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [
              {
                guid: "file-1",
                mimeType: "application/pdf",
                transferName: "file.pdf",
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

    vi.resetModules()
    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      messageGuid: "file-guid",
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
      textForAgent: "[file attachment: file.pdf]",
      attachments: [{ guid: "file-1", mimeType: "application/pdf", transferName: "file.pdf" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        requiresRepair: false,
        inputPartsForAgent: undefined,
        textForAgent:
          "[attachment: file.pdf]\n[attachment hydration failed for file.pdf: socket reset]",
      }),
    )
  })

  it("appends hydrated media suffixes cleanly when the repaired agent text is empty", async () => {
    const hydrateBlueBubblesAttachments = vi.fn().mockResolvedValue({
      inputParts: [],
      transcriptAdditions: ["voice note transcript: hello"],
      notices: [],
    })
    vi.doMock("../../../senses/bluebubbles/media", () => ({
      hydrateBlueBubblesAttachments,
    }))

    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            guid: "audio-guid",
            text: "",
            handle: {
              address: "ari@mendelow.me",
              service: "iMessage",
            },
            attachments: [
              {
                guid: "audio-1",
                mimeType: "audio/mp3",
                transferName: "Audio Message.mp3",
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

    vi.resetModules()
    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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
      messageGuid: "audio-guid",
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
      textForAgent: "",
      attachments: [{ guid: "audio-1", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: true,
    })

    expect(result).toEqual(
      expect.objectContaining({
        requiresRepair: false,
        textForAgent: "[audio attachment: Audio Message.mp3]\n[voice note transcript: hello]",
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

    const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
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

  describe("getMessageText", () => {
    it("returns text when API responds with valid payload", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { text: "Hello from the thread" } }), { status: 200 }),
      ) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-123")
      expect(text).toBe("Hello from the thread")
    })

    it("returns null when API returns non-ok status", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      ) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-404")
      expect(text).toBeNull()
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "senses.bluebubbles_get_message_text_error",
      }))
    })

    it("returns null when payload is missing text field", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { guid: "msg-guid-no-text" } }), { status: 200 }),
      ) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-no-text")
      expect(text).toBeNull()
    })

    it("returns null when fetch throws a non-Error value", async () => {
      global.fetch = vi.fn().mockRejectedValue("string rejection") as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-string-err")
      expect(text).toBeNull()
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "senses.bluebubbles_get_message_text_error",
        meta: expect.objectContaining({ reason: "string rejection" }),
      }))
    })

    it("returns null when fetch throws (network error)", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-err")
      expect(text).toBeNull()
      expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "senses.bluebubbles_get_message_text_error",
        meta: expect.objectContaining({ reason: "Network error" }),
      }))
    })

    it("returns null when text is empty after trimming", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { text: "   " } }), { status: 200 }),
      ) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-empty")
      expect(text).toBeNull()
    })

    it("returns null when payload data is null (extractRepairData returns null)", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response("null", { status: 200 }),
      ) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-null-payload")
      expect(text).toBeNull()
    })

    it("returns null when data has no text property (not a string)", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { text: 42 } }), { status: 200 }),
      ) as typeof fetch

      const { createBlueBubblesClient } = await import("../../../senses/bluebubbles/client")
      const client = createBlueBubblesClient(
        { serverUrl: "http://bluebubbles.local", password: "secret-token", accountId: "default" },
        { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30000 },
      )

      const text = await client.getMessageText("msg-guid-nonstring")
      expect(text).toBeNull()
    })
  })
})
