import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Readable } from "node:stream"

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  buildSystem: vi.fn().mockResolvedValue("system prompt"),
  createSummarize: vi.fn(() => vi.fn()),
  sessionPath: vi.fn().mockReturnValue("/tmp/bluebubbles-session.json"),
  getBlueBubblesConfig: vi.fn().mockReturnValue({
    serverUrl: "http://bluebubbles.local",
    password: "secret-token",
    accountId: "default",
  }),
  getBlueBubblesChannelConfig: vi.fn().mockReturnValue({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  }),
  loadSession: vi.fn().mockReturnValue(null),
  postTurn: vi.fn(),
  accumulateFriendTokens: vi.fn(),
  resolveContext: vi.fn(),
  resolverCtor: vi.fn(),
  storeCtor: vi.fn(),
  emitNervesEvent: vi.fn(),
  sendText: vi.fn().mockResolvedValue({ messageGuid: "sent-guid" }),
  editMessage: vi.fn().mockResolvedValue(undefined),
  setTyping: vi.fn().mockResolvedValue(undefined),
  markChatRead: vi.fn().mockResolvedValue(undefined),
  repairEvent: vi.fn(async (event: unknown) => event),
  recordMutation: vi.fn(),
  createServer: vi.fn(),
  listen: vi.fn((_: number, cb?: () => void) => cb?.()),
}))

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-runtime-cleanup-"))
  tempDirs.push(dir)
  return dir
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "{}")
}

vi.mock("../../heart/core", () => ({
  runAgent: (...args: any[]) => mocks.runAgent(...args),
  createSummarize: () => mocks.createSummarize(),
}))

vi.mock("../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mocks.buildSystem(...args),
}))

vi.mock("../../heart/config", () => ({
  sessionPath: (...args: any[]) => mocks.sessionPath(...args),
  getBlueBubblesConfig: (...args: any[]) => mocks.getBlueBubblesConfig(...args),
  getBlueBubblesChannelConfig: (...args: any[]) => mocks.getBlueBubblesChannelConfig(...args),
}))

vi.mock("../../mind/context", () => ({
  loadSession: (...args: any[]) => mocks.loadSession(...args),
  postTurn: (...args: any[]) => mocks.postTurn(...args),
  deleteSession: vi.fn(),
}))

vi.mock("../../mind/friends/tokens", () => ({
  accumulateFriendTokens: (...args: any[]) => mocks.accumulateFriendTokens(...args),
}))

vi.mock("../../mind/friends/store-file", () => ({
  FileFriendStore: vi.fn(function (this: any, root: string) {
    mocks.storeCtor(root)
    this.get = vi.fn()
    this.put = vi.fn()
    this.delete = vi.fn()
    this.findByExternalId = vi.fn()
    this.hasAnyFriends = vi.fn().mockResolvedValue(true)
  }),
}))

vi.mock("../../mind/friends/resolver", () => ({
  FriendResolver: vi.fn(function (this: any, store: unknown, params: unknown) {
    mocks.resolverCtor(store, params)
    this.resolve = (...args: any[]) => mocks.resolveContext(...args)
  }),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/agent/root"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: {
      thinking: ["thinking"],
      tool: ["tool"],
      followup: ["followup"],
    },
  })),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mocks.emitNervesEvent(...args),
}))

vi.mock("../../senses/bluebubbles-client", () => ({
  createBlueBubblesClient: vi.fn(() => ({
    sendText: (...args: any[]) => mocks.sendText(...args),
    editMessage: (...args: any[]) => mocks.editMessage(...args),
    setTyping: (...args: any[]) => mocks.setTyping(...args),
    markChatRead: (...args: any[]) => mocks.markChatRead(...args),
    repairEvent: (...args: any[]) => mocks.repairEvent(...args),
  })),
}))

vi.mock("node:http", () => ({
  createServer: (...args: any[]) => mocks.createServer(...args),
}))

const dmThreadPayload = {
  type: "new-message",
  data: {
    guid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
    text: "threaded reply",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772946888623,
    isFromMe: false,
    threadOriginatorGuid: "54D4109C-7170-41A1-8161-F6F8C863CC0D",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const dmTopLevelPayload = {
  type: "new-message",
  data: {
    guid: "B20D4E2B-2E6E-48B5-95CD-6E24A368E4A7",
    text: "top-level follow-up",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772946889999,
    isFromMe: false,
    threadOriginatorGuid: null,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const groupThreadPayload = {
  type: "new-message",
  data: {
    guid: "E29915DA-FC59-412A-BACC-B5EEDBA414EB",
    text: "yay!",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772947679927,
    isFromMe: false,
    threadOriginatorGuid: "3E02B90F-D374-4381-BDD2-3572D3EB1195",
    chats: [
      {
        guid: "any;+;35820e69c97c459992d29a334f412979",
        style: 43,
        chatIdentifier: "35820e69c97c459992d29a334f412979",
        displayName: "Consciousness TBD",
      },
    ],
  },
}

const reactionPayload = {
  type: "new-message",
  data: {
    guid: "BA2CFB68-52D2-4D8F-8A33-394C37035347",
    text: "Loved “great”",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772948058386,
    isFromMe: false,
    associatedMessageGuid: "p:0/CB4EB152-A678-4F0E-8075-1AB09B5496F8",
    associatedMessageType: "love",
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const readPayload = {
  type: "updated-message",
  data: {
    guid: "174D57C8-5985-4528-8539-E4DBD777FE59",
    text: "still here",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772948413321,
    dateRead: 1772948415000,
    isFromMe: false,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const editPayload = {
  type: "updated-message",
  data: {
    guid: "4A4F2A85-21AD-4AC6-98A8-34B8F4D07AA9",
    text: "edited version",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772949000000,
    dateEdited: 1772949005000,
    isFromMe: false,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const unsendPayload = {
  type: "updated-message",
  data: {
    guid: "A9C0AB3C-858A-42BC-9951-66A5C9B1B2B8",
    text: "",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772949100000,
    dateRetracted: 1772949105000,
    isFromMe: false,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const deliveryPayload = {
  type: "updated-message",
  data: {
    guid: "D4CF9CC0-C1B5-4CF0-9397-E29FE23BAE51",
    text: "delivered",
    handle: {
      address: "ari@mendelow.me",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772949150000,
    isDelivered: true,
    isFromMe: false,
    chats: [
      {
        guid: "any;-;ari@mendelow.me",
        style: 45,
        chatIdentifier: "ari@mendelow.me",
        displayName: "",
      },
    ],
  },
}

const fromMePayload = {
  ...dmThreadPayload,
  data: {
    ...dmThreadPayload.data,
    guid: "EAC6F0AD-2869-4D99-B6F4-10D6D8A03C4A",
    isFromMe: true,
  },
}

const groupReactionPayload = {
  ...reactionPayload,
  data: {
    ...reactionPayload.data,
    chats: [
      {
        guid: "any;+;35820e69c97c459992d29a334f412979",
        style: 43,
        chatIdentifier: "35820e69c97c459992d29a334f412979",
        displayName: "Consciousness TBD",
      },
    ],
  },
}

const identifierOnlyPayload = {
  type: "new-message",
  data: {
    guid: "E5F304D7-12E2-42FD-8E15-8130BDA37C80",
    text: "identifier only",
    handle: {
      id: "+1 (973) 508-0289",
    },
    attachments: [],
    chats: [
      {
        identifier: "+1 (973) 508-0289",
      },
    ],
  },
}

function resetMocks(): void {
  mocks.runAgent.mockReset().mockImplementation(async (_messages: any, callbacks: any) => {
    callbacks.onModelStart()
    callbacks.onTextChunk("got it")
    return {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 0,
        total_tokens: 15,
      },
    }
  })
  mocks.buildSystem.mockReset().mockResolvedValue("system prompt")
  mocks.sessionPath.mockReset().mockReturnValue("/tmp/bluebubbles-session.json")
  mocks.getBlueBubblesConfig.mockReset().mockReturnValue({
    serverUrl: "http://bluebubbles.local",
    password: "secret-token",
    accountId: "default",
  })
  mocks.getBlueBubblesChannelConfig.mockReset().mockReturnValue({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  })
  mocks.loadSession.mockReset().mockReturnValue(null)
  mocks.postTurn.mockReset()
  mocks.accumulateFriendTokens.mockReset()
  mocks.resolveContext.mockReset().mockResolvedValue({
    friend: {
      id: "friend-uuid",
      name: "Ari",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    },
    channel: {
      channel: "bluebubbles",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: false,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    },
  })
  mocks.resolverCtor.mockReset()
  mocks.storeCtor.mockReset()
  mocks.emitNervesEvent.mockReset()
  mocks.sendText.mockReset().mockResolvedValue({ messageGuid: "sent-guid" })
  mocks.editMessage.mockReset().mockResolvedValue(undefined)
  mocks.setTyping.mockReset().mockResolvedValue(undefined)
  mocks.markChatRead.mockReset().mockResolvedValue(undefined)
  mocks.repairEvent.mockReset().mockImplementation(async (event: unknown) => event)
  mocks.recordMutation.mockReset()
  mocks.listen.mockReset().mockImplementation((_: number, cb?: () => void) => cb?.())
  mocks.createServer.mockReset().mockImplementation((handler: unknown) => ({
    listen: mocks.listen,
    close: vi.fn(),
    handler,
  }))
}

function createMockRequest(method: string, url: string, body?: unknown): Readable & {
  method: string
  url: string
  headers: Record<string, string>
} {
  const payload = typeof body === "undefined"
    ? []
    : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]
  const req = Readable.from(payload) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
  }
  req.method = method
  req.url = url
  req.headers = { "content-type": "application/json" }
  return req
}

function createMockResponse() {
  let statusCode = 200
  const headers = new Map<string, string>()
  let body = ""
  let resolver: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolver = resolve
  })

  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(value: number) {
      statusCode = value
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value)
    },
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      statusCode = code
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        headers.set(name.toLowerCase(), value)
      }
    },
    end(chunk?: string | Buffer) {
      if (typeof chunk !== "undefined") {
        body += chunk.toString()
      }
      resolver?.()
    },
  }

  return {
    res,
    done,
    getBody: () => body,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  }
}

describe("BlueBubbles sense runtime", () => {
  beforeEach(() => {
    vi.resetModules()
    resetMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handles DM threaded messages on the shared chat trunk and preserves the threaded send target", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.sessionPath).toHaveBeenCalledWith(
      "friend-uuid",
      "bluebubbles",
      "chat:any;-;ari@mendelow.me",
    )
    expect(mocks.buildSystem).toHaveBeenCalledWith(
      "bluebubbles",
      undefined,
      expect.objectContaining({
        friend: expect.objectContaining({ id: "friend-uuid" }),
        channel: expect.objectContaining({ channel: "bluebubbles" }),
      }),
    )
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: "system prompt" }),
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.objectContaining({
        toolContext: expect.objectContaining({
          context: expect.objectContaining({
            friend: expect.objectContaining({ id: "friend-uuid" }),
          }),
        }),
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "got it",
      }),
    )
    expect(mocks.postTurn).toHaveBeenCalledTimes(1)
    expect(mocks.accumulateFriendTokens).toHaveBeenCalledWith(
      expect.anything(),
      "friend-uuid",
      expect.objectContaining({ total_tokens: 15 }),
    )
  })

  it("routes top-level and threaded DM turns into the same persisted chat trunk", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")

    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.sessionPath).toHaveBeenNthCalledWith(
      1,
      "friend-uuid",
      "bluebubbles",
      "chat:any;-;ari@mendelow.me",
    )
    expect(mocks.sessionPath).toHaveBeenNthCalledWith(
      2,
      "friend-uuid",
      "bluebubbles",
      "chat:any;-;ari@mendelow.me",
    )
  })

  it("prefixes threaded inbound turns with chat-trunk metadata", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("prefixes top-level inbound turns with chat-trunk metadata", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\ntop-level follow-up",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("detects obsolete sibling thread lanes without deleting them before loading the shared chat trunk", async () => {
    const dir = makeTempDir()
    const trunk = path.join(dir, "chat_any;-;ari@mendelow.me.json")
    const staleThread = path.join(dir, "chat_any;-;ari@mendelow.me_thread_123.json")
    const unrelatedThread = path.join(dir, "chat_any;-;someoneelse_thread_999.json")
    writeFile(trunk)
    writeFile(staleThread)
    writeFile(unrelatedThread)
    mocks.sessionPath.mockReturnValueOnce(trunk)

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.loadSession).toHaveBeenCalledWith(trunk)
    expect(fs.existsSync(trunk)).toBe(true)
    expect(fs.existsSync(staleThread)).toBe(true)
    expect(fs.existsSync(unrelatedThread)).toBe(true)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_thread_lane_artifacts_detected",
        meta: expect.objectContaining({
          sessionPath: trunk,
          artifactCount: 1,
        }),
      }),
    )
  })

  it("defaults top-level inbound turns to top-level outbound replies", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: undefined,
        text: "got it",
      }),
    )
  })

  it("lets the turn widen a threaded inbound reply back to top-level", async () => {
    let selectionMessage = ""
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks, _channel, _signal, options) => {
      selectionMessage = options.toolContext.bluebubblesReplyTarget.setSelection({ target: "top_level" })
      callbacks.onModelStart()
      callbacks.onTextChunk("got it")
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: undefined,
        text: "got it",
      }),
    )
    expect(selectionMessage).toBe("bluebubbles reply target override: top_level")
  })

  it("surfaces recent active lanes so the agent can target another thread explicitly", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD | default outbound target for this turn: current_lane]\nold thread topic",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\nrecent top-level topic",
        },
      ],
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[recent active lanes]\n- top_level: recent top-level topic\n- thread:THREAD-OLD: old thread topic\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("extracts recent active lanes from multimodal trunk history too", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-MEDIA | default outbound target for this turn: current_lane]\nmedia thread topic",
            },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\n[recent active lanes]\n- thread:THREAD-MEDIA: media thread topic\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\ntop-level follow-up",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("ignores empty or irrelevant historical user entries and falls back when a lane has no body text", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,BBBB" },
            },
          ],
        },
        { role: "user", content: "plain text without lane metadata" },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]",
        },
      ],
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[recent active lanes]\n- top_level: (no recent text)\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("ignores historical entries with unsupported content payloads", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content: {
            type: "input_file",
            file_id: "file-123",
          } as unknown as OpenAI.ChatCompletionMessageParam["content"],
        },
      ],
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("lets the turn explicitly stay in the current inbound lane", async () => {
    let selectionMessage = ""
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks, _channel, _signal, options) => {
      selectionMessage = options.toolContext.bluebubblesReplyTarget.setSelection({ target: "current_lane" })
      callbacks.onModelStart()
      callbacks.onTextChunk("staying here")
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "staying here",
      }),
    )
    expect(selectionMessage).toBe("bluebubbles reply target: using default for this turn (current_lane)")
  })

  it("treats current_lane on a top-level inbound turn as top-level", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks, _channel, _signal, options) => {
      options.toolContext.bluebubblesReplyTarget.setSelection({ target: "current_lane" })
      callbacks.onModelStart()
      callbacks.onTextChunk("still top-level")
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageGuid: undefined,
        text: "still top-level",
      }),
    )
  })

  it("limits surfaced active lanes to the five most recent unique lanes", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "plain text without lane metadata" },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD-1 | default outbound target for this turn: current_lane]\nfirst thread",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\nnewest top-level",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD-2 | default outbound target for this turn: current_lane]\nsecond thread",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD-3 | default outbound target for this turn: current_lane]\nthird thread",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD-4 | default outbound target for this turn: current_lane]\nfourth thread",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD-5 | default outbound target for this turn: current_lane]\nfifth thread",
        },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD-5 | default outbound target for this turn: current_lane]\nduplicate fifth thread",
        },
      ],
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[recent active lanes]\n- thread:THREAD-OLD-5: duplicate fifth thread\n- thread:THREAD-OLD-4: fourth thread\n- thread:THREAD-OLD-3: third thread\n- thread:THREAD-OLD-2: second thread\n- top_level: newest top-level\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("lets the turn route coding feedback and the final reply into a specific active thread", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-OLD | default outbound target for this turn: current_lane]\nold thread topic",
        },
      ],
    })
    let selectionMessage = ""
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks, _channel, _signal, options) => {
      selectionMessage = options.toolContext.bluebubblesReplyTarget.setSelection({
        target: "thread",
        threadOriginatorGuid: "THREAD-OLD",
      })
      await options.toolContext.codingFeedback.send("codex update for old thread")
      callbacks.onModelStart()
      callbacks.onTextChunk("done")
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replyToMessageGuid: "THREAD-OLD",
        text: "codex update for old thread",
      }),
    )
    expect(mocks.sendText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replyToMessageGuid: "THREAD-OLD",
        text: "done",
      }),
    )
    expect(selectionMessage).toBe("bluebubbles reply target override: thread:THREAD-OLD")
  })

  it("logs cleanup errors but still handles the turn on the shared chat trunk", async () => {
    const dir = makeTempDir()
    const trunk = path.join(dir, "chat_any;-;ari@mendelow.me.json")
    writeFile(trunk)
    mocks.sessionPath.mockReturnValueOnce(trunk)
    const cleanupModule = await import("../../senses/bluebubbles-session-cleanup")
    vi.spyOn(cleanupModule, "findObsoleteBlueBubblesThreadSessions").mockImplementation(() => {
      throw new Error("cleanup boom")
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.loadSession).toHaveBeenCalledWith(trunk)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_thread_lane_cleanup_error",
        meta: expect.objectContaining({
          sessionPath: trunk,
          reason: "cleanup boom",
        }),
      }),
    )
  })

  it("captures string-thrown cleanup failures explicitly too", async () => {
    const dir = makeTempDir()
    const trunk = path.join(dir, "chat_any;-;ari@mendelow.me.json")
    writeFile(trunk)
    mocks.sessionPath.mockReturnValueOnce(trunk)
    const cleanupModule = await import("../../senses/bluebubbles-session-cleanup")
    vi.spyOn(cleanupModule, "findObsoleteBlueBubblesThreadSessions").mockImplementation(() => {
      throw "cleanup string"
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.loadSession).toHaveBeenCalledWith(trunk)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_thread_lane_cleanup_error",
        meta: expect.objectContaining({
          sessionPath: trunk,
          reason: "cleanup string",
        }),
      }),
    )
  })

  it("surfaces only concrete tool activity messages for a tool-heavy turn", async () => {
    mocks.sendText
      .mockResolvedValueOnce({ messageGuid: "tool-guid" })
      .mockResolvedValueOnce({ messageGuid: "tool-done-guid" })
      .mockResolvedValueOnce({ messageGuid: "final-guid" })
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      callbacks.onToolStart("read_file", { path: "notes.txt" })
      callbacks.onToolEnd("read_file", "ok", true)
      callbacks.onTextChunk("got it")
      return {
        content: "got it",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "running read_file (notes.txt)...",
      }),
    )
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "\u2713 read_file (ok)",
      }),
    )
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "got it",
      }),
    )
    expect(mocks.editMessage).not.toHaveBeenCalled()
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
    expect(mocks.setTyping.mock.invocationCallOrder[1]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[2])
  })

  it("uses typing only for the first phase of a short turn and sends only the final reply visibly", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.sendText).toHaveBeenCalledTimes(1)
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "got it",
      }),
    )
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
  })

  it("routes coding feedback messages back to the requesting bluebubbles chat/thread", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages, _callbacks, _channel, _signal, options) => {
      await options.toolContext.codingFeedback.send("codex coding-001 completed: hi")
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "codex coding-001 completed: hi",
      }),
    )
  })

  it("routes coding feedback for mutations without forcing a reply target", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages, _callbacks, _channel, _signal, options) => {
      await options.toolContext.codingFeedback.send("codex coding-002 completed: hi")
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(reactionPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: undefined,
        text: "codex coding-002 completed: hi",
      }),
    )
  })

  it("surfaces string-thrown activity transport failures explicitly", async () => {
    mocks.sendText
      .mockRejectedValueOnce("status send failure")
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      callbacks.onToolStart("read_file", { path: "notes.txt" })
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_activity_error",
        meta: expect.objectContaining({
          operation: "status_update",
          reason: "status send failure",
        }),
      }),
    )
  })

  it("surfaces Error-thrown activity transport failures explicitly too", async () => {
    mocks.sendText
      .mockRejectedValueOnce(new Error("status send error object"))
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      callbacks.onToolStart("read_file", { path: "notes.txt" })
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_activity_error",
        meta: expect.objectContaining({
          operation: "status_update",
          reason: "status send error object",
        }),
      }),
    )
  })

  it("uses group chat identity rather than sender handle instability for group sessions", async () => {
    mocks.resolveContext.mockResolvedValueOnce({
      friend: {
        id: "group-uuid",
        name: "Consciousness TBD",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "bluebubbles",
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    expect(mocks.resolverCtor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "imessage-handle",
        externalId: "group:any;+;35820e69c97c459992d29a334f412979",
        displayName: "Consciousness TBD",
        channel: "bluebubbles",
      }),
    )
    expect(mocks.sessionPath).toHaveBeenCalledWith(
      "group-uuid",
      "bluebubbles",
      "chat:any;+;35820e69c97c459992d29a334f412979",
    )
    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "ari@mendelow.me: [conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 3E02B90F-D374-4381-BDD2-3572D3EB1195 | default outbound target for this turn: current_lane]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nyay!",
        }),
      ]),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({
          chatGuid: "any;+;35820e69c97c459992d29a334f412979",
          displayName: "Consciousness TBD",
        }),
      }),
    )
  })

  it("runs notifyable mutations but returns explicit non-agent handling for read-only state changes", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")

    const runtimeDeps = {
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any

    const reactionResult = await bluebubbles.handleBlueBubblesEvent(reactionPayload, runtimeDeps)
    const runAgentCallCount = mocks.runAgent.mock.calls.length
    const readResult = await bluebubbles.handleBlueBubblesEvent(readPayload, runtimeDeps)

    expect(reactionResult).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: true,
        kind: "mutation",
      }),
    )
    expect(runAgentCallCount).toBe(1)
    expect(readResult).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: false,
        reason: "mutation_state_only",
      }),
    )
    expect(mocks.recordMutation).toHaveBeenNthCalledWith(
      1,
      "testagent",
      expect.objectContaining({
        mutationType: "reaction",
        messageGuid: "BA2CFB68-52D2-4D8F-8A33-394C37035347",
      }),
    )
    expect(mocks.recordMutation).toHaveBeenNthCalledWith(
      2,
      "testagent",
      expect.objectContaining({
        mutationType: "read",
        messageGuid: "174D57C8-5985-4528-8539-E4DBD777FE59",
      }),
    )
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenCalledWith(expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }))
  })

  it("keeps edit and unsend mutations notifyable while treating delivery as state-only", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")

    const runtimeDeps = {
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any

    const editResult = await bluebubbles.handleBlueBubblesEvent(editPayload, runtimeDeps)
    const unsendResult = await bluebubbles.handleBlueBubblesEvent(unsendPayload, runtimeDeps)
    const deliveryResult = await bluebubbles.handleBlueBubblesEvent(deliveryPayload, runtimeDeps)

    expect(editResult).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: true,
        kind: "mutation",
      }),
    )
    expect(unsendResult).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: true,
        kind: "mutation",
      }),
    )
    expect(deliveryResult).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: false,
        reason: "mutation_state_only",
      }),
    )
    expect(mocks.recordMutation).toHaveBeenNthCalledWith(
      1,
      "testagent",
      expect.objectContaining({
        mutationType: "edit",
        messageGuid: "4A4F2A85-21AD-4AC6-98A8-34B8F4D07AA9",
      }),
    )
    expect(mocks.recordMutation).toHaveBeenNthCalledWith(
      2,
      "testagent",
      expect.objectContaining({
        mutationType: "unsend",
        messageGuid: "A9C0AB3C-858A-42BC-9951-66A5C9B1B2B8",
      }),
    )
    expect(mocks.recordMutation).toHaveBeenNthCalledWith(
      3,
      "testagent",
      expect.objectContaining({
        mutationType: "delivery",
        messageGuid: "D4CF9CC0-C1B5-4CF0-9397-E29FE23BAE51",
      }),
    )
    expect(mocks.runAgent).toHaveBeenCalledTimes(2)
    expect(mocks.markChatRead).toHaveBeenCalledTimes(2)
    expect(mocks.markChatRead).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }))
    expect(mocks.markChatRead).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }))
  })

  it("returns explicit from-me handling without invoking the agent loop", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(fromMePayload)

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: false,
        reason: "from_me",
      }),
    )
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.markChatRead).not.toHaveBeenCalled()
  })

  it("stops typing even when the agent turn throws before a final answer is sent", async () => {
    mocks.sendText
      .mockResolvedValueOnce({ messageGuid: "error-guid" })
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      callbacks.onError(new Error("turn blew up"), "terminal")
      throw new Error("turn blew up")
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await expect(bluebubbles.handleBlueBubblesEvent(dmThreadPayload)).rejects.toThrow("turn blew up")

    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.sendText).toHaveBeenCalledTimes(1)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        text: "Error: turn blew up",
      }),
    )
    expect(mocks.editMessage).not.toHaveBeenCalled()
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
  })

  it("can still run a turn when only chat identifier routing is present", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(identifierOnlyPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({
          chatGuid: undefined,
          chatIdentifier: "+1 (973) 508-0289",
        }),
      }),
    )
  })

  it("reuses existing session state and allows callback lifecycle hooks to no-op safely", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [{ role: "system", content: "existing prompt" }],
    })
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any, _channel: any, _signal: any, options: any) => {
      callbacks.onModelStart()
      callbacks.onModelStreamStart()
      callbacks.onReasoningChunk("thinking")
      callbacks.onToolStart("query_session", {})
      callbacks.onToolEnd("query_session", "done", true)
      callbacks.onError(new Error("temporary"), "transient")
      callbacks.onError(new Error("fatal"), "terminal")
      callbacks.onTextChunk("discard me")
      callbacks.onClearText()
      await options.toolContext.signin("graph")
      return {
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          reasoning_tokens: 0,
          total_tokens: 4,
        },
      }
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.buildSystem).not.toHaveBeenCalled()
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "running query_session...",
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "\u2713 query_session (done)",
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Error: temporary",
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Error: fatal",
      }),
    )
    expect(mocks.postTurn).toHaveBeenCalledTimes(1)
  })

  it("formats group mutations with sender-forward phrasing before handing them to the agent", async () => {
    mocks.resolveContext.mockResolvedValueOnce({
      friend: {
        id: "group-uuid",
        name: "Consciousness TBD",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "bluebubbles",
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupReactionPayload)

    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "ari@mendelow.me reacted with love" }),
      ]),
    )
  })

  it("appends explicit repair-failure fallback to the agent-visible inbound text", async () => {
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "repair-failed-msg",
      timestamp: 9,
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
      },
      text: "",
      textForAgent: "[audio attachment: Audio Message.mp3]",
      attachments: [{ guid: "audio-guid", mimeType: "audio/mp3", transferName: "Audio Message.mp3" }],
      hasPayloadData: false,
      requiresRepair: false,
      repairNotice: "BlueBubbles repair failed: network down",
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload, {
      recordMutation: mocks.recordMutation,
    } as any)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("BlueBubbles repair failed: network down"),
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("passes hydrated BlueBubbles media through to the agent as structured user content", async () => {
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "hydrated-image-msg",
      timestamp: 10,
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
      },
      text: "",
      textForAgent: "[image attachment: IMG_5045.heic.jpeg (600x800)]",
      attachments: [{ guid: "image-guid", mimeType: "image/jpeg", transferName: "IMG_5045.heic.jpeg", width: 600, height: 800 }],
      hasPayloadData: false,
      requiresRepair: false,
      inputPartsForAgent: [
        {
          type: "image_url",
          image_url: {
            url: "data:image/jpeg;base64,aGVsbG8=",
            detail: "auto",
          },
        },
      ],
    })

    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\n[image attachment: IMG_5045.heic.jpeg (600x800)]",
            },
            {
              type: "image_url",
              image_url: {
                url: "data:image/jpeg;base64,aGVsbG8=",
                detail: "auto",
              },
            },
          ],
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("marks handled inbound chats as read after a successful turn", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.markChatRead).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "any;-;ari@mendelow.me",
      }),
    )
  })

  it("emits a warning instead of failing the turn when mark-read transport throws", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    mocks.markChatRead.mockRejectedValueOnce(new Error("read transport down"))

    await expect(bluebubbles.handleBlueBubblesEvent(dmThreadPayload)).resolves.toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: true,
      }),
    )

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_mark_read_error",
        meta: expect.objectContaining({
          chatGuid: "any;-;ari@mendelow.me",
          reason: "read transport down",
        }),
      }),
    )
  })

  it("captures string-thrown mark-read failures explicitly too", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    mocks.markChatRead.mockRejectedValueOnce("read transport string failure")

    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_mark_read_error",
        meta: expect.objectContaining({
          reason: "read transport string failure",
        }),
      }),
    )
  })

  it("uses null chatGuid in mark-read warnings when only identifier routing is available", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    mocks.markChatRead.mockRejectedValueOnce(new Error("identifier read failure"))

    await bluebubbles.handleBlueBubblesEvent(identifierOnlyPayload)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_mark_read_error",
        meta: expect.objectContaining({
          chatGuid: null,
          reason: "identifier read failure",
        }),
      }),
    )
  })

  it("emits an explicit nerves error when mutation sidecar recording fails", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    mocks.recordMutation.mockImplementationOnce(() => {
      throw new Error("disk full")
    })

    await bluebubbles.handleBlueBubblesEvent(readPayload, {
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "senses.bluebubbles_mutation_log_error",
        meta: expect.objectContaining({
          messageGuid: "174D57C8-5985-4528-8539-E4DBD777FE59",
          mutationType: "read",
          reason: "disk full",
        }),
      }),
    )
  })

  it("captures string-throw mutation log failures explicitly too", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    mocks.recordMutation.mockImplementationOnce(() => {
      throw "disk offline"
    })

    await bluebubbles.handleBlueBubblesEvent(readPayload, {
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "senses.bluebubbles_mutation_log_error",
        meta: expect.objectContaining({
          reason: "disk offline",
        }),
      }),
    )
  })

  it("covers friend-identity fallbacks for group identifiers, sender fallback, and unknown DM names", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")

    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "group-ident-fallback",
      timestamp: 1,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "sender-a",
        rawId: "sender-a",
        displayName: "Sender A",
      },
      chat: {
        chatIdentifier: "group-ident-only",
        isGroup: true,
        sessionKey: "chat_identifier:group-ident-only",
        sendTarget: { kind: "chat_identifier", value: "group-ident-only" },
      },
      text: "hello",
      textForAgent: "hello",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "group-sender-fallback",
      timestamp: 2,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "sender-only",
        rawId: "sender-only",
        displayName: "Sender Only",
      },
      chat: {
        isGroup: true,
        sessionKey: "chat_identifier:unknown",
        sendTarget: { kind: "chat_identifier", value: "unknown" },
      },
      text: "hello again",
      textForAgent: "hello again",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "dm-raw-fallback",
      timestamp: 3,
      fromMe: false,
      sender: {
        provider: "imessage-handle",
        externalId: "",
        rawId: "raw-dm-id",
        displayName: "",
      },
      chat: {
        chatIdentifier: "raw-dm-id",
        isGroup: false,
        sessionKey: "chat_identifier:raw-dm-id",
        sendTarget: { kind: "chat_identifier", value: "raw-dm-id" },
      },
      text: "dm fallback",
      textForAgent: "dm fallback",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.resolverCtor).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        externalId: "group:group-ident-only",
        displayName: "Unknown Group",
      }),
    )
    expect(mocks.resolverCtor).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        externalId: "group:sender-only",
        displayName: "Unknown Group",
      }),
    )
    expect(mocks.resolverCtor).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({
        externalId: "raw-dm-id",
        displayName: "Unknown",
      }),
    )
  })

  it("accepts valid webhook posts and rejects incorrect webhook passwords", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const unauthorizedReq = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=wrong-token",
      dmThreadPayload,
    )
    const unauthorizedRes = createMockResponse()
    await handler(unauthorizedReq as any, unauthorizedRes.res as any)
    await unauthorizedRes.done

    expect(unauthorizedRes.res.statusCode).toBe(401)
    expect(mocks.runAgent).not.toHaveBeenCalled()

    const authorizedReq = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      dmThreadPayload,
    )
    const authorizedRes = createMockResponse()
    await handler(authorizedReq as any, authorizedRes.res as any)
    await authorizedRes.done

    expect(authorizedRes.res.statusCode).toBe(200)
    expect(authorizedRes.getHeader("content-type")).toContain("application/json")
    expect(authorizedRes.getBody()).toContain("\"handled\":true")
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
  })

  it("returns explicit webhook errors for missing routes, methods, bad json, and runtime failures", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const notFoundReq = createMockRequest("POST", "/wrong-path", dmThreadPayload)
    const notFoundRes = createMockResponse()
    await handler(notFoundReq as any, notFoundRes.res as any)
    await notFoundRes.done
    expect(notFoundRes.res.statusCode).toBe(404)

    const methodReq = createMockRequest("GET", "/bluebubbles-webhook?password=secret-token")
    const methodRes = createMockResponse()
    await handler(methodReq as any, methodRes.res as any)
    await methodRes.done
    expect(methodRes.res.statusCode).toBe(405)

    const defaultUrlReq = createMockRequest("POST", "/ignored", dmThreadPayload)
    ;(defaultUrlReq as any).url = undefined
    const defaultUrlRes = createMockResponse()
    await handler(defaultUrlReq as any, defaultUrlRes.res as any)
    await defaultUrlRes.done
    expect(defaultUrlRes.res.statusCode).toBe(404)

    const badJsonReq = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", "not json")
    const badJsonRes = createMockResponse()
    await handler(badJsonReq as any, badJsonRes.res as any)
    await badJsonRes.done
    expect(badJsonRes.res.statusCode).toBe(400)

    const brokenStreamReq = {
      method: "POST",
      url: "/bluebubbles-webhook?password=secret-token",
      async *[Symbol.asyncIterator]() {
        throw "stream broke"
      },
    }
    const brokenStreamRes = createMockResponse()
    await handler(brokenStreamReq as any, brokenStreamRes.res as any)
    await brokenStreamRes.done
    expect(brokenStreamRes.res.statusCode).toBe(400)

    mocks.repairEvent.mockRejectedValueOnce(new Error("repair blew up"))
    const boomReq = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", dmThreadPayload)
    const boomRes = createMockResponse()
    await handler(boomReq as any, boomRes.res as any)
    await boomRes.done
    expect(boomRes.res.statusCode).toBe(500)
    expect(boomRes.getBody()).toContain("repair blew up")

    mocks.repairEvent.mockRejectedValueOnce("repair string blew up")
    const stringBoomReq = createMockRequest("POST", "/bluebubbles-webhook", dmThreadPayload)
    const stringBoomRes = createMockResponse()
    await handler(stringBoomReq as any, stringBoomRes.res as any)
    await stringBoomRes.done
    expect(stringBoomRes.res.statusCode).toBe(500)
    expect(stringBoomRes.getBody()).toContain("repair string blew up")
  })

  it("starts an HTTP server on the configured BlueBubbles port", async () => {
    const bluebubbles = await import("../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()

    expect(mocks.createServer).toHaveBeenCalledTimes(1)
    expect(mocks.listen).toHaveBeenCalledWith(18790, expect.any(Function))
  })
})
