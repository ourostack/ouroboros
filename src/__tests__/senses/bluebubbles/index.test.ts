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
  getAgentName: vi.fn().mockReturnValue("testagent"),
  getAgentRoot: vi.fn().mockReturnValue("/mock/agent/root"),
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
  checkHealth: vi.fn().mockResolvedValue(undefined),
  listRecentMessages: vi.fn().mockResolvedValue([]),
  repairEvent: vi.fn(async (event: unknown) => event),
  getMessageText: vi.fn(async () => null),
  recordMutation: vi.fn(),
  createServer: vi.fn(),
  listen: vi.fn((_: number, cb?: () => void) => cb?.()),
  handleInboundTurn: vi.fn(),
  getChannelCapabilities: vi.fn(),
  getPendingDir: vi.fn(),
  drainPending: vi.fn(),
  drainDeferredReturns: vi.fn(),
  enforceTrustGate: vi.fn(),
  findByExternalId: vi.fn().mockResolvedValue(null),
  listAll: vi.fn().mockResolvedValue([]),
  lastStoreInstance: null as any,
}))

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-runtime-cleanup-"))
  tempDirs.push(dir)
  return dir
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("timed out waiting for predicate")
}

function createClosableServer(): { server: any; close: () => void } {
  let closeHandler: (() => void) | undefined
  const server = {
    listen: vi.fn((_: number, cb?: () => void) => cb?.()),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeHandler = cb
      return server
    }),
    close: vi.fn(),
  }

  return {
    server,
    close: () => closeHandler?.(),
  }
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "{}")
}

vi.mock("../../../heart/core", () => ({
  runAgent: (...args: any[]) => mocks.runAgent(...args),
  createSummarize: () => mocks.createSummarize(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mocks.buildSystem(...args),
}))

vi.mock("../../../heart/config", () => ({
  sessionPath: (...args: any[]) => mocks.sessionPath(...args),
  getBlueBubblesConfig: (...args: any[]) => mocks.getBlueBubblesConfig(...args),
  getBlueBubblesChannelConfig: (...args: any[]) => mocks.getBlueBubblesChannelConfig(...args),
  sanitizeKey: (value: string) => value.replace(/[^a-zA-Z0-9;+.-]+/g, "_"),
}))

vi.mock("../../../mind/context", () => ({
  loadSession: (...args: any[]) => mocks.loadSession(...args),
  postTurn: (...args: any[]) => mocks.postTurn(...args),
  deleteSession: vi.fn(),
}))

vi.mock("../../../mind/friends/tokens", () => ({
  accumulateFriendTokens: (...args: any[]) => mocks.accumulateFriendTokens(...args),
}))

vi.mock("../../../mind/friends/store-file", () => ({
  FileFriendStore: vi.fn(function (this: any, root: string) {
    mocks.storeCtor(root)
    mocks.lastStoreInstance = this
    this.get = vi.fn()
    this.put = vi.fn()
    this.delete = vi.fn()
    this.findByExternalId = (...args: any[]) => mocks.findByExternalId(...args)
    this.hasAnyFriends = vi.fn().mockResolvedValue(true)
    Object.defineProperty(this, "listAll", {
      get: () => mocks.listAll ? (...args: any[]) => mocks.listAll(...args) : undefined,
      configurable: true,
    })
  }),
}))

vi.mock("../../../mind/friends/resolver", () => ({
  FriendResolver: vi.fn(function (this: any, store: unknown, params: unknown) {
    mocks.resolverCtor(store, params)
    this.resolve = (...args: any[]) => mocks.resolveContext(...args)
  }),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: mocks.getAgentName,
  getAgentRoot: mocks.getAgentRoot,
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

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mocks.emitNervesEvent(...args),
}))

vi.mock("../../../senses/bluebubbles/client", () => ({
  createBlueBubblesClient: vi.fn(() => ({
    sendText: (...args: any[]) => mocks.sendText(...args),
    editMessage: (...args: any[]) => mocks.editMessage(...args),
    setTyping: (...args: any[]) => mocks.setTyping(...args),
    markChatRead: (...args: any[]) => mocks.markChatRead(...args),
    checkHealth: (...args: any[]) => mocks.checkHealth(...args),
    listRecentMessages: (...args: any[]) => mocks.listRecentMessages(...args),
    repairEvent: (...args: any[]) => mocks.repairEvent(...args),
    getMessageText: (...args: any[]) => mocks.getMessageText(...args),
  })),
}))

vi.mock("node:http", () => ({
  createServer: (...args: any[]) => mocks.createServer(...args),
}))

vi.mock("../../../senses/pipeline", () => ({
  handleInboundTurn: (...args: any[]) => mocks.handleInboundTurn(...args),
}))

vi.mock("../../../mind/friends/channel", () => ({
  getChannelCapabilities: (...args: any[]) => mocks.getChannelCapabilities(...args),
}))

vi.mock("../../../mind/pending", () => ({
  getPendingDir: (...args: any[]) => mocks.getPendingDir(...args),
  drainPending: (...args: any[]) => mocks.drainPending(...args),
  drainDeferredReturns: (...args: any[]) => mocks.drainDeferredReturns(...args),
}))

vi.mock("../../../senses/trust-gate", () => ({
  enforceTrustGate: (...args: any[]) => mocks.enforceTrustGate(...args),
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

function makeCatchUpMessage(overrides: Partial<{
  messageGuid: string
  timestamp: number
  fromMe: boolean
  text: string
  textForAgent: string
}> = {}) {
  const text = overrides.text ?? overrides.textForAgent ?? "missed while bluebubbles was offline"
  return {
    kind: "message" as const,
    eventType: "new-message",
    messageGuid: overrides.messageGuid ?? "catchup-guid",
    timestamp: overrides.timestamp ?? Date.now(),
    fromMe: overrides.fromMe ?? false,
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
    text,
    textForAgent: overrides.textForAgent ?? text,
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
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

const groupWithParticipantsPayload = {
  type: "new-message",
  data: {
    guid: "F39A15DA-FC59-412A-BACC-B5EEDBA414EB",
    text: "hello from group",
    handle: {
      address: "acquaintance@example.com",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772947700000,
    isFromMe: false,
    chats: [
      {
        guid: "any;+;groupchat123",
        style: 43,
        chatIdentifier: "groupchat123",
        displayName: "Family Group",
        participants: [
          { address: "acquaintance@example.com" },
          { address: "familymember@example.com" },
          { address: "other@example.com" },
        ],
      },
    ],
  },
}

const defaultFriendContext = {
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
    senseType: "open",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
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
  mocks.getAgentName.mockReset().mockReturnValue("testagent")
  mocks.getAgentRoot.mockReset().mockReturnValue("/mock/agent/root")
  mocks.loadSession.mockReset().mockReturnValue(null)
  mocks.postTurn.mockReset()
  mocks.accumulateFriendTokens.mockReset()
  mocks.resolveContext.mockReset().mockResolvedValue(defaultFriendContext)
  mocks.getChannelCapabilities.mockReset().mockReturnValue({
    channel: "bluebubbles",
    senseType: "open",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  })
  mocks.getPendingDir.mockReset().mockReturnValue("/tmp/pending/friend-uuid/bluebubbles/session")
  mocks.drainPending.mockReset().mockReturnValue([])
  mocks.drainDeferredReturns.mockReset().mockReturnValue([])
  mocks.enforceTrustGate.mockReset().mockReturnValue({ allowed: true })
  mocks.findByExternalId.mockReset().mockResolvedValue(null)
  mocks.listAll.mockReset().mockResolvedValue([])
  mocks.lastStoreInstance = null
  // handleInboundTurn: by default, simulate a successful pipeline run that calls
  // the injected runAgent (which triggers BB callbacks for text buffering/flush).
  // Mirrors the real pipeline: resolves friend, builds toolContext with context/friendStore,
  // calls injected runAgent, postTurn, and accumulateFriendTokens.
  mocks.handleInboundTurn.mockReset().mockImplementation(async (input: any) => {
    const resolvedContext = await input.friendResolver.resolve()
    const sessionMessages = await input.sessionLoader.loadOrCreate()
    const msgs = sessionMessages.messages
    for (const m of input.messages) msgs.push(m)
    // Mirror pipeline: merge context and friendStore into runAgentOptions.toolContext
    const existingToolContext = input.runAgentOptions?.toolContext
    const pipelineOpts = {
      ...input.runAgentOptions,
      toolContext: {
        signin: async () => undefined,
        ...existingToolContext,
        context: resolvedContext,
        friendStore: input.friendStore,
      },
    }
    const result = await input.runAgent(msgs, input.callbacks, input.channel, input.signal, pipelineOpts)
    input.postTurn(msgs, sessionMessages.sessionPath, result.usage)
    await input.accumulateFriendTokens(input.friendStore, resolvedContext.friend.id, result.usage)
    return {
      resolvedContext,
      gateResult: { allowed: true },
      usage: result.usage,
      sessionPath: sessionMessages.sessionPath,
      messages: msgs,
    }
  })
  mocks.resolverCtor.mockReset()
  mocks.storeCtor.mockReset()
  mocks.emitNervesEvent.mockReset()
  mocks.sendText.mockReset().mockResolvedValue({ messageGuid: "sent-guid" })
  mocks.editMessage.mockReset().mockResolvedValue(undefined)
  mocks.setTyping.mockReset().mockResolvedValue(undefined)
  mocks.markChatRead.mockReset().mockResolvedValue(undefined)
  mocks.checkHealth.mockReset().mockResolvedValue(undefined)
  mocks.listRecentMessages.mockReset().mockResolvedValue([])
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
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handles DM threaded messages on the shared chat trunk and preserves the threaded send target", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.sessionPath).toHaveBeenCalledWith(
      "friend-uuid",
      "bluebubbles",
      "chat:any;-;ari@mendelow.me",
    )
    expect(mocks.buildSystem).toHaveBeenCalledWith(
      "bluebubbles",
      {},
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
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
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

  it("includes replied-to text in inbound content when getMessageText returns text", async () => {
    mocks.getMessageText.mockResolvedValueOnce("This is the original message being replied to")

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    // The inbound message should contain the replied-to text
    const turnInput = mocks.handleInboundTurn.mock.calls[0][0]
    const userMsg = turnInput.messages[0]
    const userContent = typeof userMsg.content === "string" ? userMsg.content : userMsg.content.find((p: any) => p.type === "text")?.text ?? ""
    expect(userContent).toContain('replying to: "This is the original message being replied to"')
  })

  it("keeps group observe turns model-visible while leaving typing off", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      return {
        outcome: "observed",
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          reasoning_tokens: 0,
          total_tokens: 11,
        },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: true,
        kind: "message",
      }),
    )
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).not.toHaveBeenCalled()
    expect(mocks.setTyping).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.postTurn).toHaveBeenCalledTimes(1)
  })

  it("routes top-level and threaded DM turns into the same persisted chat trunk", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")

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
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("prefixes top-level inbound turns with chat-trunk metadata", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[recent active lanes]\n- top_level: recent top-level topic\n- thread:THREAD-OLD: old thread topic\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

  it("skips nested recent-lane metadata when summarizing historical top-level text", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\n[recent active lanes]\n- thread:THREAD-OLDER: older thread topic\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nactual top-level body",
        },
      ],
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[recent active lanes]\n- top_level: actual top-level body\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("skips routing-control metadata when summarizing historical thread text", async () => {
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: THREAD-META | default outbound target for this turn: current_lane]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nactual threaded body",
        },
      ],
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: top_level | default outbound target for this turn: top_level]\n[recent active lanes]\n- thread:THREAD-META: actual threaded body\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\ntop-level follow-up",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[recent active lanes]\n- top_level: (no recent text)\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content:
            "[conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 54D4109C-7170-41A1-8161-F6F8C863CC0D | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[recent active lanes]\n- thread:THREAD-OLD-5: duplicate fifth thread\n- thread:THREAD-OLD-4: fourth thread\n- thread:THREAD-OLD-3: third thread\n- thread:THREAD-OLD-2: second thread\n- top_level: newest top-level\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nthreaded reply",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const cleanupModule = await import("../../../senses/bluebubbles/session-cleanup")
    vi.spyOn(cleanupModule, "findObsoleteBlueBubblesThreadSessions").mockImplementation(() => {
      throw new Error("cleanup boom")
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const cleanupModule = await import("../../../senses/bluebubbles/session-cleanup")
    vi.spyOn(cleanupModule, "findObsoleteBlueBubblesThreadSessions").mockImplementation(() => {
      throw "cleanup string"
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }))
    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.markChatRead.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
    // Default mode: only tool START description + final response (no tool END)
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "reading notes.txt...",
      }),
    )
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "got it",
      }),
    )
    expect(mocks.editMessage).not.toHaveBeenCalled()
    // After status sendText, typing is re-enabled; then stopped before final text
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.setTyping).toHaveBeenNthCalledWith(3, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
  })

  it("uses typing only for the first phase of a short turn and sends only the final reply visibly", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }))
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
    expect(mocks.markChatRead.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_activity_error",
        meta: expect.objectContaining({
          operation: "send_status",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_activity_error",
        meta: expect.objectContaining({
          operation: "send_status",
          reason: "status send error object",
        }),
      }),
    )
  })

  it("still attempts mark-read when typing-start transport fails and surfaces the activity warning", async () => {
    mocks.setTyping.mockRejectedValueOnce(new Error("typing transport down"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "any;-;ari@mendelow.me",
      }),
    )
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_activity_error",
        meta: expect.objectContaining({
          operation: "typing_start",
          reason: "typing transport down",
        }),
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "got it",
      }),
    )
  })

  it("starts group chat typing only after the agent commits to replying", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      expect(mocks.markChatRead).not.toHaveBeenCalled()
      expect(mocks.setTyping).not.toHaveBeenCalled()
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenCalledWith(
      expect.objectContaining({ chatGuid: "any;+;35820e69c97c459992d29a334f412979" }),
    )
    expect(mocks.setTyping).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ chatGuid: "any;+;35820e69c97c459992d29a334f412979" }),
      true,
    )
    expect(mocks.markChatRead.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
  })

  it("treats group chat tool progress as reply commitment before final text", async () => {
    vi.useFakeTimers()
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      expect(mocks.markChatRead).not.toHaveBeenCalled()
      expect(mocks.setTyping).not.toHaveBeenCalled()

      callbacks.onToolStart("query_session", {})
      // Advance past status batcher debounce window (500ms)
      vi.advanceTimersByTime(500)
      await flushAsyncWork()
      await flushAsyncWork()

      expect(mocks.sendText).toHaveBeenCalledWith(
        expect.objectContaining({
          chat: expect.objectContaining({ chatGuid: "any;+;35820e69c97c459992d29a334f412979" }),
          text: "checking session history...",
        }),
      )
      expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
      expect(mocks.setTyping).toHaveBeenCalledWith(
        expect.objectContaining({ chatGuid: "any;+;35820e69c97c459992d29a334f412979" }),
        true,
      )

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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    const toolStatusCall = mocks.sendText.mock.calls.find((call: any[]) => call[0]?.text === "checking session history...")
    const finalReplyCall = mocks.sendText.mock.calls.find((call: any[]) => call[0]?.text === "got it")

    expect(toolStatusCall).toBeTruthy()
    expect(finalReplyCall).toBeTruthy()
    expect(mocks.markChatRead.mock.invocationCallOrder[0]).toBeLessThan(finalReplyCall[0].chat ? mocks.sendText.mock.invocationCallOrder[mocks.sendText.mock.calls.indexOf(finalReplyCall)] : Number.MAX_SAFE_INTEGER)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(finalReplyCall[0].chat ? mocks.sendText.mock.invocationCallOrder[mocks.sendText.mock.calls.indexOf(finalReplyCall)] : Number.MAX_SAFE_INTEGER)
    vi.useRealTimers()
  })

  it("re-enables typing indicator after each status message", async () => {
    vi.useFakeTimers()
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onToolStart("query_session", {})
      // Advance past status batcher debounce window
      vi.advanceTimersByTime(500)
      await flushAsyncWork()
      await flushAsyncWork()

      // After the status sendText, setTyping(true) should be called again
      // First setTyping(true) is from startTypingNow, second is after sendStatus
      const typingTrueCalls = mocks.setTyping.mock.calls.filter(
        (call: any[]) => call[1] === true,
      )
      expect(typingTrueCalls.length).toBeGreaterThanOrEqual(2)

      // Verify the second setTyping(true) happened after the status sendText
      const statusSendOrder = mocks.sendText.mock.invocationCallOrder[0]
      const secondTypingOrder = mocks.setTyping.mock.invocationCallOrder[
        mocks.setTyping.mock.calls.findIndex(
          (call: any[], idx: number) => idx > 0 && call[1] === true,
        )
      ]
      expect(secondTypingOrder).toBeGreaterThan(statusSendOrder)

      callbacks.onTextChunk("done")
      return {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 0,
          total_tokens: 15,
        },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)
    vi.useRealTimers()
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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
            "ari@mendelow.me: [conversation scope: existing chat trunk | current inbound lane: thread | current thread id: 3E02B90F-D374-4381-BDD2-3572D3EB1195 | default outbound target for this turn: current_lane]\n[if you need more context about what was being discussed, use query_session to search your session history, or recall to check your memory.]\n[routing control: use bluebubbles_set_reply_target with target=top_level to widen back out, or target=thread plus a listed thread id to route into a specific active thread]\nyay!",
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
    const bluebubbles = await import("../../../senses/bluebubbles")

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
    const reactionInput = mocks.handleInboundTurn.mock.calls[0][0]
    expect(reactionInput.continuityIngressTexts).toEqual([])
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
    const bluebubbles = await import("../../../senses/bluebubbles")

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
    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await expect(bluebubbles.handleBlueBubblesEvent(dmThreadPayload)).rejects.toThrow("turn blew up")

    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.sendText).toHaveBeenCalledTimes(1)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "\u2717 turn blew up",
      }),
    )
    expect(mocks.editMessage).not.toHaveBeenCalled()
    // After error status sendText, typing is re-enabled; then stopped by finish
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.setTyping).toHaveBeenNthCalledWith(3, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
  })

  it("can still run a turn when only chat identifier routing is present", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.buildSystem).not.toHaveBeenCalled()
    // Default mode: tool START sends description, tool END (success) is silent
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "checking session history...",
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "\u2717 temporary",
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "\u2717 fatal",
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

    const bluebubbles = await import("../../../senses/bluebubbles")
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

  it("marks handled inbound chats as read when typing starts for a successful turn", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(mocks.markChatRead).toHaveBeenCalledTimes(1)
    expect(mocks.markChatRead).toHaveBeenCalledWith(
      expect.objectContaining({
        chatGuid: "any;-;ari@mendelow.me",
      }),
    )
    expect(mocks.markChatRead.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
  })

  it("emits a warning instead of failing the turn when mark-read transport throws", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
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
    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(mocks.sendText.mock.invocationCallOrder[0])
  })

  it("captures string-thrown mark-read failures explicitly too", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const bluebubbles = await import("../../../senses/bluebubbles")

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
    const bluebubbles = await import("../../../senses/bluebubbles")
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
    const bluebubbles = await import("../../../senses/bluebubbles")
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

  it("treats known guidless BlueBubbles chat state events as ignorable webhook noise", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      {
        type: "chat-read-status-changed",
        data: {
          chatGuid: "any;-;ari@mendelow.me",
        },
      },
    )
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(res.getBody()).toContain("\"reason\":\"ignored\"")
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    const webhookErrors = mocks.emitNervesEvent.mock.calls.filter(
      (call: unknown[]) => (call[0] as { event?: string })?.event === "senses.bluebubbles_webhook_error",
    )
    expect(webhookErrors).toHaveLength(0)
  })

  it("rethrows unexpected normalization failures from handleBlueBubblesEvent", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(
      bluebubbles.handleBlueBubblesEvent({
        type: "new-message",
        data: {
          text: "missing guid",
        },
      }),
    ).rejects.toThrow("BlueBubbles payload is missing data.guid")
  })

  it("starts an HTTP server on the configured BlueBubbles port", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()

    expect(mocks.createServer).toHaveBeenCalledTimes(1)
    expect(mocks.listen).toHaveBeenCalledWith(18790, expect.any(Function))
  })

  it("replays unrecovered state-only mutations through the agent once the full message can be repaired", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "missed-message-guid",
      timestamp: Date.parse("2026-03-11T18:15:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "missed-message-guid",
      timestamp: Date.parse("2026-03-11T18:14:00.000Z"),
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
      text: "you there?",
      textForAgent: "you there?",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const first = await bluebubbles.recoverMissedBlueBubblesMessages()
    const second = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(first).toEqual(expect.objectContaining({ recovered: 1, pending: 0, failed: 0 }))
    expect(second).toEqual(expect.objectContaining({ recovered: 0, skipped: 1 }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("you there?"),
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("keeps unrepaired backlog mutations pending until BlueBubbles can hydrate a real message", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "pending-message-guid",
      timestamp: Date.parse("2026-03-11T18:16:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "pending-message-guid",
      timestamp: Date.parse("2026-03-11T18:16:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 0, pending: 1, failed: 0 }))
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_recovery_complete",
        meta: expect.objectContaining({ pending: 1 }),
      }),
    )
  })

  it("records backlog recovery failures without crashing the recovery pass", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "read",
      messageGuid: "broken-message-guid",
      timestamp: Date.parse("2026-03-11T18:17:00.000Z"),
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
    })
    mocks.repairEvent.mockRejectedValueOnce(new Error("repair exploded"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 0, pending: 0, failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_recovery_error",
        meta: expect.objectContaining({
          messageGuid: "broken-message-guid",
          reason: "repair exploded",
        }),
      }),
    )
  })

  it("catches up recent upstream messages after BlueBubbles recovers from an outage", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "upstream-missed-guid",
        timestamp: Date.now() - 60_000,
        textForAgent: "did this arrive while bluebubbles was down?",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "Cannot reach BlueBubbles",
      lastCheckedAt: new Date().toISOString(),
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({
      inspected: 1,
      recovered: 1,
      skipped: 0,
      failed: 0,
      lastRecoveredMessageGuid: "upstream-missed-guid",
    }))
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("did this arrive while bluebubbles was down?"),
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )

    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", "chat:any;-;ari@mendelow.me")
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n")
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(expect.objectContaining({
      messageGuid: "upstream-missed-guid",
      source: "upstream-catchup",
    }))
  })

  it("continues paginating catch-up until the upstream backlog is drained", async () => {
    const now = Date.now()
    const firstPage = Array.from({ length: 50 }, (_, index) => makeCatchUpMessage({
      messageGuid: index < 2 ? "page-one-duplicate" : `page-one-from-me-${index}`,
      timestamp: now - index,
      fromMe: true,
    }))
    const recovered = makeCatchUpMessage({
      messageGuid: "page-two-inbound",
      timestamp: now - 1_000,
      textForAgent: "second page should still be drained",
    })
    mocks.listRecentMessages
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([recovered])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })

    expect(mocks.listRecentMessages).toHaveBeenNthCalledWith(1, { limit: 50, offset: 0 })
    expect(mocks.listRecentMessages).toHaveBeenNthCalledWith(2, { limit: 50, offset: 50 })
    expect(result).toEqual(expect.objectContaining({
      inspected: 50,
      recovered: 1,
      skipped: 49,
      failed: 0,
      lastRecoveredMessageGuid: "page-two-inbound",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("second page should still be drained"),
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("stops paginating catch-up once a full page reaches the catch-up cutoff", async () => {
    const now = Date.now()
    mocks.listRecentMessages.mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => makeCatchUpMessage({
      messageGuid: `old-page-${index}`,
      timestamp: now - 120_000 - index,
    })))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "ok",
      detail: "upstream reachable",
      lastCheckedAt: new Date(now).toISOString(),
      pendingRecoveryCount: 0,
    })

    expect(mocks.listRecentMessages).toHaveBeenCalledTimes(1)
    expect(result).toEqual(expect.objectContaining({
      inspected: 50,
      recovered: 0,
      skipped: 50,
      failed: 0,
    }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
  })

  it("marks catch-up unhealthy when the bounded page limit is reached before the cutoff", async () => {
    const now = Date.now()
    mocks.listRecentMessages.mockImplementation(async ({ offset = 0 } = {}) => Array.from({ length: 50 }, (_, index) =>
      makeCatchUpMessage({
        messageGuid: `limit-page-${offset}-${index}`,
        timestamp: now - index,
        fromMe: true,
      })))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "ok",
      detail: "upstream reachable",
      lastCheckedAt: new Date(now).toISOString(),
      pendingRecoveryCount: 0,
    })

    expect(mocks.listRecentMessages).toHaveBeenCalledTimes(20)
    expect(result).toEqual(expect.objectContaining({
      inspected: 1000,
      recovered: 0,
      skipped: 1000,
      failed: 1,
    }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "senses.bluebubbles_catchup_error",
      meta: expect.objectContaining({
        inspectedPages: 20,
        reason: "catch-up page limit reached before the outage window cutoff",
      }),
    }))
  })

  it("skips catch-up messages that are outgoing, too old, or already recorded", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const now = Date.now()

    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    recordBlueBubblesInbound("testagent", makeCatchUpMessage({
      messageGuid: "already-recorded-guid",
      timestamp: now - 1_000,
    }), "webhook")

    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({ messageGuid: "from-me-guid", timestamp: now - 1_000, fromMe: true }),
      makeCatchUpMessage({ messageGuid: "too-old-guid", timestamp: now - 120_000 }),
      makeCatchUpMessage({ messageGuid: "already-recorded-guid", timestamp: now - 1_000 }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "ok",
      detail: "upstream reachable",
      lastCheckedAt: new Date(now).toISOString(),
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({
      inspected: 3,
      recovered: 0,
      skipped: 3,
      failed: 0,
    }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
  })

  it("keeps catch-up candidates skipped when repair cannot produce an inbound message", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const candidate = makeCatchUpMessage({ messageGuid: "catchup-still-mutation" })
    mocks.listRecentMessages.mockResolvedValueOnce([candidate])
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "catchup-still-mutation",
      timestamp: candidate.timestamp,
      fromMe: false,
      sender: candidate.sender,
      chat: candidate.chat,
      shouldNotifyAgent: false,
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({ inspected: 1, recovered: 0, skipped: 1, failed: 0 }))
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("bootstraps catch-up messages into the inbound sidecar when the session already has the text", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.loadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "already handled upstream catchup" },
      ],
    })
    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "catchup-already-in-session",
        textForAgent: "already handled upstream catchup",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({ inspected: 1, recovered: 0, skipped: 1, failed: 0 }))
    expect(mocks.runAgent).not.toHaveBeenCalled()

    const { hasRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(hasRecordedBlueBubblesInbound("testagent", "chat:any;-;ari@mendelow.me", "catchup-already-in-session")).toBe(true)
  })

  it("records catch-up query failures without crashing the recovery pass", async () => {
    mocks.listRecentMessages.mockRejectedValueOnce(new Error("query exploded"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({ inspected: 0, recovered: 0, skipped: 0, failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "senses.bluebubbles_catchup_error",
      meta: expect.objectContaining({ reason: "query exploded" }),
    }))
  })

  it("skips catch-up cleanly for older injected clients without recent-message query support", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({
      createClient: () => ({
        checkHealth: vi.fn(),
        editMessage: vi.fn(),
        getMessageText: vi.fn(),
        markChatRead: vi.fn(),
        repairEvent: vi.fn(),
        sendText: vi.fn(),
        setTyping: vi.fn(),
      } as any),
    })

    expect(result).toEqual({ inspected: 0, recovered: 0, skipped: 0, failed: 0 })
  })

  it("falls back to the first catch-up window when previous runtime timestamp is invalid", async () => {
    mocks.listRecentMessages.mockResolvedValueOnce([])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "ok",
      detail: "upstream reachable",
      lastCheckedAt: "not-a-date",
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual({ inspected: 0, recovered: 0, skipped: 0, failed: 0 })
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_catchup_start",
      meta: expect.objectContaining({
        pageSize: 50,
        maxPages: 20,
      }),
    }))
  })

  it("keeps partial catch-up pages when a later query fails", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const now = Date.now()
    mocks.listRecentMessages
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => makeCatchUpMessage({
        messageGuid: `partial-query-${index}`,
        timestamp: now - index,
        fromMe: true,
      })))
      .mockRejectedValueOnce("query string exploded")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ inspected: 50, recovered: 0, skipped: 50, failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "senses.bluebubbles_catchup_error",
      meta: expect.objectContaining({
        offset: 50,
        reason: "query string exploded",
      }),
    }))
  })

  it("records per-message catch-up failures and continues the pass", async () => {
    const candidate = makeCatchUpMessage({ messageGuid: "catchup-message-fails" })
    mocks.listRecentMessages.mockResolvedValueOnce([candidate])
    mocks.repairEvent.mockRejectedValueOnce("repair string exploded")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({ inspected: 1, recovered: 0, skipped: 0, failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "senses.bluebubbles_catchup_error",
      meta: expect.objectContaining({
        messageGuid: "catchup-message-fails",
        reason: "repair string exploded",
      }),
    }))
  })

  it("records Error per-message catch-up failures with the Error message", async () => {
    const candidate = makeCatchUpMessage({ messageGuid: "catchup-message-error-fails" })
    mocks.listRecentMessages.mockResolvedValueOnce([candidate])
    mocks.repairEvent.mockRejectedValueOnce(new Error("repair error exploded"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({ inspected: 1, recovered: 0, skipped: 0, failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "senses.bluebubbles_catchup_error",
      meta: expect.objectContaining({
        messageGuid: "catchup-message-error-fails",
        reason: "repair error exploded",
      }),
    }))
  })

  it("recovers identifier-only backlog candidates by falling back to unknown routing metadata", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { getBlueBubblesMutationLogPath } = await import("../../../senses/bluebubbles/mutation-log")
    const mutationLogPath = getBlueBubblesMutationLogPath("testagent", "chat_identifier:missing-target")
    fs.mkdirSync(path.dirname(mutationLogPath), { recursive: true })
    fs.writeFileSync(
      mutationLogPath,
      JSON.stringify({
        recordedAt: "not-a-date",
        eventType: "updated-message",
        mutationType: "delivery",
        messageGuid: "fallback-routing-guid",
        targetMessageGuid: null,
        chatGuid: null,
        chatIdentifier: null,
        sessionKey: "chat_identifier:missing-target",
        shouldNotifyAgent: false,
        textForAgent: "message marked as delivered",
        fromMe: false,
      }) + "\n",
      "utf-8",
    )

    const beforeRecovery = Date.now()
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()
    const repairedEvent = mocks.repairEvent.mock.calls[0]?.[0]

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 0, pending: 1, failed: 0 }))
    expect(repairedEvent).toEqual(
      expect.objectContaining({
        kind: "mutation",
        messageGuid: "fallback-routing-guid",
        timestamp: expect.any(Number),
        sender: expect.objectContaining({
          externalId: "unknown",
          rawId: "unknown",
          displayName: "Unknown",
        }),
        chat: expect.objectContaining({
          chatGuid: undefined,
          chatIdentifier: undefined,
          sessionKey: "chat_identifier:missing-target",
          sendTarget: { kind: "chat_identifier", value: "unknown" },
        }),
      }),
    )
    expect(repairedEvent?.timestamp).toBeGreaterThanOrEqual(beforeRecovery)
  })

  it("still recovers messages when the repaired agent text is empty and the session cannot dedupe by content", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "empty-fragment-guid",
      timestamp: Date.parse("2026-03-11T18:17:30.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "empty-fragment-guid",
      timestamp: Date.parse("2026-03-11T18:17:29.000Z"),
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
      text: "",
      textForAgent: "",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 1, skipped: 0, pending: 0, failed: 0 }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
  })

  it("syncs BlueBubbles runtime state immediately, repeats on the interval, and stops after server close", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    expect(mocks.checkHealth).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
      }),
    )

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.checkHealth).toHaveBeenCalledTimes(2)

    closableServer.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.checkHealth).toHaveBeenCalledTimes(2)
  })

  it("writes runtime error state when the BlueBubbles upstream health probe fails before backlog recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "unhealthy-message-guid",
      timestamp: Date.parse("2026-03-11T18:18:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.checkHealth.mockRejectedValueOnce(new Error("upstream unreachable"))

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "error",
        detail: "upstream unreachable",
        pendingRecoveryCount: 1,
      }),
    )
  })

  it("records inbound sidecars when trust-gated message events are auto-replied instead of reaching the agent", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    mocks.handleInboundTurn.mockResolvedValueOnce({
      gateResult: {
        allowed: false,
        autoReply: "Please reach me in our group chat instead.",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result).toEqual({
      handled: true,
      notifiedAgent: false,
      kind: "message",
    })

    const { hasRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(hasRecordedBlueBubblesInbound("testagent", "chat:any;-;ari@mendelow.me", "B20D4E2B-2E6E-48B5-95CD-6E24A368E4A7")).toBe(true)
  })

  it("writes only one inbound sidecar entry per handled message turn", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    mocks.handleInboundTurn.mockResolvedValueOnce({
      gateResult: {
        allowed: true,
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result).toEqual({
      handled: true,
      notifiedAgent: true,
      kind: "message",
    })

    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", "chat:any;-;ari@mendelow.me")
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n")

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "{}")).toEqual(
      expect.objectContaining({
        messageGuid: "B20D4E2B-2E6E-48B5-95CD-6E24A368E4A7",
        source: "webhook",
      }),
    )
  })

  it("handles trust-gated mutation events without trying to record a message inbound sidecar", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    mocks.handleInboundTurn.mockResolvedValueOnce({
      gateResult: {
        allowed: false,
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(editPayload)

    expect(result).toEqual({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
    })

    const { hasRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(hasRecordedBlueBubblesInbound("testagent", "chat:any;-;ari@mendelow.me", "4A4F2A85-21AD-4AC6-98A8-34B8F4D07AA9")).toBe(false)
  })

  it("skips webhook delivery when the inbound sidecar already recorded the message guid", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    recordBlueBubblesInbound("testagent", {
      kind: "message",
      eventType: "new-message",
      messageGuid: "B20D4E2B-2E6E-48B5-95CD-6E24A368E4A7",
      timestamp: Date.parse("2026-03-11T18:19:00.000Z"),
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
      text: "top-level follow-up",
      textForAgent: "top-level follow-up",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    }, "webhook")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result).toEqual({
      handled: true,
      notifiedAgent: false,
      kind: "message",
      reason: "already_processed",
    })
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
  })

  // Regression guard for the double-VLM bug observed live on 2026-04-08T00:58Z:
  // BlueBubbles sent a `new-message` webhook for an image-bearing iMessage,
  // slugger ran the full repair → hydrate → VLM describe path, then ~3s later
  // BB sent an `updated-message` webhook for the SAME messageGuid (delivery/
  // read status update). The BB sense's `repairEvent` path promotes
  // updated-message events with recoverable content back to `message` kind,
  // which re-ran hydrateBlueBubblesAttachments and issued a SECOND VLM
  // describe call for the same 291KB attachment — ~14s extra latency and
  // double the MiniMax VLM token spend, for a turn that was going to be
  // deduped downstream anyway. See `handleBlueBubblesEvent` in index.ts for
  // the pre-repair dedup.
  it("skips repairEvent entirely when an updated-message arrives for an already-processed messageGuid (no duplicate VLM describe)", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    // Seed the inbound sidecar with the messageGuid as if the first
    // webhook already processed it fully.
    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    recordBlueBubblesInbound("testagent", {
      kind: "message",
      eventType: "new-message",
      messageGuid: editPayload.data.guid,
      timestamp: Date.parse("2026-04-08T00:58:15.745Z"),
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
      text: "wrong flight and you're forgetting how time zones work",
      textForAgent: "wrong flight and you're forgetting how time zones work",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    }, "webhook")

    // Sanity check: the record we just wrote must be readable via the
    // inbound-log helper. If this fails, the test isn't actually exercising
    // the dedup path — it's a setup error.
    const { hasRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(hasRecordedBlueBubblesInbound("testagent", "chat:any;-;ari@mendelow.me", editPayload.data.guid)).toBe(true)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(editPayload)

    // Verify the early dedup check fired by looking for its nerves event.
    // If this assertion fails, my pre-repair dedup isn't running.
    const dedupCalls = mocks.emitNervesEvent.mock.calls.filter(
      (call: unknown[]) => (call[0] as { event?: string })?.event === "senses.bluebubbles_repair_skipped_duplicate",
    )
    expect(dedupCalls.length).toBe(1)
    expect(result.handled).toBe(true)
  })

  it("does not run the same webhook message guid through the pipeline twice when deliveries race", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const releaseFirst = createDeferred<void>()
    let invocationCount = 0

    mocks.handleInboundTurn.mockImplementation(async () => {
      invocationCount += 1
      if (invocationCount === 1) {
        await releaseFirst.promise
      }
      return {
        gateResult: { allowed: true },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const first = bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)
    await waitFor(() => invocationCount === 1)

    const second = bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)
    await flushAsyncWork()

    expect(invocationCount).toBe(1)

    releaseFirst.resolve()
    const results = await Promise.all([first, second])

    expect(invocationCount).toBe(1)
    expect(results.some((result) => result.reason === "already_processed")).toBe(true)
  })

  it("serializes distinct same-chat webhook turns instead of running them in parallel", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const secondPayload = {
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "SECOND-TOP-LEVEL-GUID",
        text: "second top-level follow-up",
        dateCreated: dmTopLevelPayload.data.dateCreated + 1,
      },
    }

    const releaseFirst = createDeferred<void>()
    let inFlight = 0
    let maxConcurrent = 0
    let started = 0

    mocks.handleInboundTurn.mockImplementation(async () => {
      started += 1
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      try {
        if (started === 1) {
          await releaseFirst.promise
        }
        return {
          gateResult: { allowed: true },
        }
      } finally {
        inFlight -= 1
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const first = bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)
    await waitFor(() => started === 1)

    const second = bluebubbles.handleBlueBubblesEvent(secondPayload)
    await flushAsyncWork()

    expect(maxConcurrent).toBe(1)

    releaseFirst.resolve()
    await Promise.all([first, second])

    expect(maxConcurrent).toBe(1)
    expect(started).toBe(2)
  })

  it("bootstraps skipped recovery candidates into the inbound sidecar when the session already has the message text", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    mocks.loadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "you already saw this" },
      ],
    })

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "session-already-has-message",
      timestamp: Date.parse("2026-03-11T18:20:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "session-already-has-message",
      timestamp: Date.parse("2026-03-11T18:19:59.000Z"),
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
      text: "you already saw this",
      textForAgent: "you already saw this",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, pending: 0, failed: 0 }))
    expect(mocks.runAgent).not.toHaveBeenCalled()

    const { hasRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(hasRecordedBlueBubblesInbound("testagent", "chat:any;-;ari@mendelow.me", "session-already-has-message")).toBe(true)
  })

  it("marks runtime state as error when recovery still has pending backlog after a healthy probe", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "pending-runtime-sync",
      timestamp: Date.parse("2026-03-11T18:21:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "pending-runtime-sync",
      timestamp: Date.parse("2026-03-11T18:21:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "error",
        detail: "pending recovery: 1",
        pendingRecoveryCount: 1,
      }),
    )
  })

  it("records recovery failures in runtime state when a healthy upstream still cannot hydrate backlog messages", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "read",
      messageGuid: "failed-runtime-sync",
      timestamp: Date.parse("2026-03-11T18:22:00.000Z"),
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
    })
    mocks.repairEvent.mockRejectedValueOnce(new Error("still broken"))

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "error",
        detail: "recovery failures: 1",
        pendingRecoveryCount: 0,
      }),
    )
  })

  it("records recovered backlog progress in runtime state after a healthy repair pass", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "recovered-runtime-sync",
      timestamp: Date.parse("2026-03-11T18:23:00.000Z"),
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
      textForAgent: "message marked as delivered",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "recovered-runtime-sync",
      timestamp: Date.parse("2026-03-11T18:22:59.000Z"),
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
      text: "recovered backlog text",
      textForAgent: "recovered backlog text",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
        lastRecoveredAt: expect.any(String),
      }),
    )
  })

  it("records upstream catch-up progress in runtime state after a healthy probe", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "runtime-catchup-guid",
        timestamp: Date.now() - 60_000,
        textForAgent: "runtime catch-up should be visible",
      }),
    ])

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "caught up 1 missed message(s)",
        pendingRecoveryCount: 0,
        lastRecoveredAt: expect.any(String),
        lastRecoveredMessageGuid: "runtime-catchup-guid",
      }),
    )
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("runtime catch-up should be visible"),
        }),
      ]),
      expect.any(Object),
      "bluebubbles",
      expect.any(AbortSignal),
      expect.any(Object),
    )
  })

  it("stringifies non-Error runtime sync failures when the upstream health probe rejects with a bare value", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.checkHealth.mockRejectedValueOnce("bare upstream failure")

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "error",
        detail: "bare upstream failure",
      }),
    )
  })

  it("stringifies non-Error backlog recovery failures in nerves metadata", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "read",
      messageGuid: "string-recovery-failure",
      timestamp: Date.parse("2026-03-11T18:24:00.000Z"),
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
    })
    mocks.repairEvent.mockRejectedValueOnce("string repair failure")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_recovery_error",
        meta: expect.objectContaining({
          messageGuid: "string-recovery-failure",
          reason: "string repair failure",
        }),
      }),
    )
  })

  // ── Pipeline integration tests ───────────────────────────────────

  it("calls handleInboundTurn instead of inline lifecycle for DM messages", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.channel).toBe("bluebubbles")
    expect(input.capabilities).toEqual(expect.objectContaining({ senseType: "open", channel: "bluebubbles" }))
    expect(input.provider).toBe("imessage-handle")
    expect(input.externalId).toBe("ari@mendelow.me")
    expect(input.isGroupChat).toBe(false)
    expect(input.groupHasFamilyMember).toBe(false)
    expect(input.hasExistingGroupWithFamily).toBe(false)
    expect(typeof input.enforceTrustGate).toBe("function")
    expect(typeof input.drainPending).toBe("function")
    expect(typeof input.runAgent).toBe("function")
    expect(typeof input.postTurn).toBe("function")
    expect(typeof input.accumulateFriendTokens).toBe("function")
    expect(input.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("top-level follow-up"),
      }),
    ])
    expect(input.continuityIngressTexts).toEqual(["top-level follow-up"])
  })

  it("derives continuity ingress text from text input parts when textForAgent is empty", async () => {
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "text-parts-msg",
      timestamp: 11,
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
      textForAgent: "",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
      inputPartsForAgent: [
        { type: "text", text: "first line" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" } },
        { type: "text", text: "second line" },
      ],
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    const input = mocks.handleInboundTurn.mock.calls.at(-1)?.[0]
    expect(input.continuityIngressTexts).toEqual(["first line\nsecond line"])
  })

  it("passes no continuity ingress text when textForAgent and text parts are both empty", async () => {
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "empty-text-parts-msg",
      timestamp: 12,
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
      textForAgent: "   ",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
      inputPartsForAgent: [
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" } },
      ],
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    const input = mocks.handleInboundTurn.mock.calls.at(-1)?.[0]
    expect(input.continuityIngressTexts).toEqual([])
  })

  it("passes no continuity ingress text when textForAgent is empty and input parts are absent", async () => {
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "message",
      eventType: "new-message",
      messageGuid: "missing-text-parts-msg",
      timestamp: 13,
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
      textForAgent: "",
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    const input = mocks.handleInboundTurn.mock.calls.at(-1)?.[0]
    expect(input.continuityIngressTexts).toEqual([])
  })

  it("passes isGroupChat=true and group-level friend params for group messages", async () => {
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
      channel: defaultFriendContext.channel,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.isGroupChat).toBe(true)
    expect(input.externalId).toBe("ari@mendelow.me")
    expect(input.provider).toBe("imessage-handle")
  })

  it("sets groupHasFamilyMember=true when a group participant is a known family member", async () => {
    // Configure friend store to return a family member for one of the participants
    mocks.findByExternalId.mockImplementation(async (provider: string, externalId: string) => {
      if (provider === "imessage-handle" && externalId === "familymember@example.com") {
        return {
          id: "family-uuid",
          name: "FamilyMember",
          trustLevel: "family",
          externalIds: [{ provider: "imessage-handle", externalId: "familymember@example.com", linkedAt: "2026-01-01" }],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          schemaVersion: 1,
        }
      }
      return null
    })

    mocks.resolveContext.mockResolvedValueOnce({
      friend: {
        id: "group-uuid",
        name: "Family Group",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: defaultFriendContext.channel,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupWithParticipantsPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.isGroupChat).toBe(true)
    expect(input.groupHasFamilyMember).toBe(true)
  })

  it("sets groupHasFamilyMember=false when no group participant is family", async () => {
    // findByExternalId returns non-family or null for all participants
    mocks.findByExternalId.mockResolvedValue(null)

    mocks.resolveContext.mockResolvedValueOnce({
      friend: {
        id: "group-uuid",
        name: "Non-Family Group",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: defaultFriendContext.channel,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupWithParticipantsPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.isGroupChat).toBe(true)
    expect(input.groupHasFamilyMember).toBe(false)
  })

  it("does not yet bootstrap relevant group participants into acquaintance records with shared-group context", async () => {
    mocks.resolveContext.mockResolvedValueOnce({
      friend: {
        id: "group-uuid",
        name: "Project Group",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: defaultFriendContext.channel,
    })

    const liveGroupPayload = {
      ...groupWithParticipantsPayload,
      data: {
        ...groupWithParticipantsPayload.data,
        chats: [{
          ...groupWithParticipantsPayload.data.chats[0],
          guid: "any;+;project-group-123",
          chatIdentifier: "project-group-123",
          displayName: "Project Group",
          participants: [
            { address: "acquaintance@example.com" },
            { address: "new-person@example.com" },
            { address: "new-person@example.com" },
          ],
        }],
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(liveGroupPayload)

    const store = mocks.lastStoreInstance
    expect(store.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        trustLevel: "acquaintance",
        externalIds: expect.arrayContaining([
          expect.objectContaining({ externalId: "new-person@example.com" }),
          expect.objectContaining({ externalId: "group:any;+;project-group-123" }),
        ]),
      }),
    )
  })

  it("sets hasExistingGroupWithFamily=true for acquaintance 1:1 when they share a group with family", async () => {
    // The sender is an acquaintance with a group externalId
    const acquaintanceFriend = {
      id: "acq-uuid",
      name: "SomeAcquaintance",
      trustLevel: "acquaintance" as const,
      externalIds: [
        { provider: "imessage-handle" as const, externalId: "ari@mendelow.me", linkedAt: "2026-01-01" },
        { provider: "imessage-handle" as const, externalId: "group:shared-group-123", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    mocks.resolveContext.mockResolvedValueOnce({
      friend: acquaintanceFriend,
      channel: defaultFriendContext.channel,
    })

    // listAll returns friends including a family member that shares the same group externalId
    mocks.listAll.mockResolvedValueOnce([
      acquaintanceFriend,
      {
        id: "family-uuid",
        name: "FamilyMember",
        trustLevel: "family",
        externalIds: [
          { provider: "imessage-handle", externalId: "familymember@example.com", linkedAt: "2026-01-01" },
          { provider: "imessage-handle", externalId: "group:shared-group-123", linkedAt: "2026-01-01" },
        ],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.isGroupChat).toBe(false)
    expect(input.hasExistingGroupWithFamily).toBe(true)
  })

  it("sets hasExistingGroupWithFamily=false for acquaintance 1:1 when no shared group with family", async () => {
    const acquaintanceFriend = {
      id: "acq-uuid",
      name: "LonelyAcquaintance",
      trustLevel: "acquaintance" as const,
      externalIds: [
        { provider: "imessage-handle" as const, externalId: "ari@mendelow.me", linkedAt: "2026-01-01" },
        { provider: "imessage-handle" as const, externalId: "group:acq-only-group", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    mocks.resolveContext.mockResolvedValueOnce({
      friend: acquaintanceFriend,
      channel: defaultFriendContext.channel,
    })

    // Family member exists but NOT in the same group
    mocks.listAll.mockResolvedValueOnce([
      acquaintanceFriend,
      {
        id: "family-uuid",
        name: "FamilyMember",
        trustLevel: "family",
        externalIds: [
          { provider: "imessage-handle", externalId: "familymember@example.com", linkedAt: "2026-01-01" },
          { provider: "imessage-handle", externalId: "group:different-group", linkedAt: "2026-01-01" },
        ],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.isGroupChat).toBe(false)
    expect(input.hasExistingGroupWithFamily).toBe(false)
  })

  it("sets hasExistingGroupWithFamily=false for acquaintance with no group externalIds", async () => {
    const acquaintanceFriend = {
      id: "acq-no-groups",
      name: "NoGroupAcq",
      trustLevel: "acquaintance" as const,
      externalIds: [
        { provider: "imessage-handle" as const, externalId: "ari@mendelow.me", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    mocks.resolveContext.mockResolvedValueOnce({
      friend: acquaintanceFriend,
      channel: defaultFriendContext.channel,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.hasExistingGroupWithFamily).toBe(false)
    // listAll should NOT be called when acquaintance has no group externalIds
    expect(mocks.listAll).not.toHaveBeenCalled()
  })

  it("sets hasExistingGroupWithFamily=false for acquaintance with undefined externalIds", async () => {
    const acquaintanceFriend = {
      id: "acq-undef-eids",
      name: "NoExternalIds",
      trustLevel: "acquaintance" as const,
      externalIds: undefined as any,
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    mocks.resolveContext.mockResolvedValueOnce({
      friend: acquaintanceFriend,
      channel: defaultFriendContext.channel,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.hasExistingGroupWithFamily).toBe(false)
  })

  it("sets hasExistingGroupWithFamily=false when family member has undefined externalIds", async () => {
    const acquaintanceFriend = {
      id: "acq-uuid",
      name: "SomeAcquaintance",
      trustLevel: "acquaintance" as const,
      externalIds: [
        { provider: "imessage-handle" as const, externalId: "ari@mendelow.me", linkedAt: "2026-01-01" },
        { provider: "imessage-handle" as const, externalId: "group:shared-group", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    mocks.resolveContext.mockResolvedValueOnce({
      friend: acquaintanceFriend,
      channel: defaultFriendContext.channel,
    })

    // Family member has undefined externalIds
    mocks.listAll.mockResolvedValueOnce([
      acquaintanceFriend,
      {
        id: "family-uuid",
        name: "FamilyMember",
        trustLevel: "family",
        externalIds: undefined as any,
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.hasExistingGroupWithFamily).toBe(false)
  })

  it("sets hasExistingGroupWithFamily=false when store has no listAll method", async () => {
    const acquaintanceFriend = {
      id: "acq-no-listall",
      name: "AcqNoListAll",
      trustLevel: "acquaintance" as const,
      externalIds: [
        { provider: "imessage-handle" as const, externalId: "ari@mendelow.me", linkedAt: "2026-01-01" },
        { provider: "imessage-handle" as const, externalId: "group:some-group", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }

    mocks.resolveContext.mockResolvedValueOnce({
      friend: acquaintanceFriend,
      channel: defaultFriendContext.channel,
    })

    // Temporarily remove listAll from the mock to simulate a store without it
    const originalListAll = mocks.listAll
    mocks.listAll = undefined as any

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    mocks.listAll = originalListAll

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.hasExistingGroupWithFamily).toBe(false)
  })

  it("sets hasExistingGroupWithFamily=false for non-acquaintance (friend trust level)", async () => {
    // Friend trust level should skip the check entirely
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.hasExistingGroupWithFamily).toBe(false)
    // listAll should NOT have been called for non-acquaintance
    expect(mocks.listAll).not.toHaveBeenCalled()
  })

  it("sets groupHasFamilyMember=false for DM (not a group chat)", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.isGroupChat).toBe(false)
    expect(input.groupHasFamilyMember).toBe(false)
    // findByExternalId should NOT be called for DMs
    expect(mocks.findByExternalId).not.toHaveBeenCalled()
  })

  it("sends auto-reply via BB API when trust gate rejects with autoReply (stranger first contact)", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "stranger_first_reply",
        autoReply: "I'm sorry, I'm not allowed to talk to strangers",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result.handled).toBe(true)
    expect(result.notifiedAgent).toBe(false)
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I'm sorry, I'm not allowed to talk to strangers",
      }),
    )
  })

  it("does not send reply when trust gate silently drops (stranger subsequent contact)", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "stranger_silent_drop",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result.handled).toBe(true)
    expect(result.notifiedAgent).toBe(false)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("sends auto-reply via BB API when acquaintance is blocked in 1:1", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "acquaintance_1on1_no_group",
        autoReply: "Hey! Reach me in a group chat instead.",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result.handled).toBe(true)
    expect(result.notifiedAgent).toBe(false)
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hey! Reach me in a group chat instead.",
      }),
    )
  })

  it("sends contextual auto-reply when acquaintance has existing group with family", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "acquaintance_1on1_has_group",
        autoReply: "Hey! Reach me in our group chat instead.",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result.handled).toBe(true)
    expect(result.notifiedAgent).toBe(false)
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hey! Reach me in our group chat instead.",
      }),
    )
  })

  it("silently drops acquaintance group message without family present (no auto-reply)", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "acquaintance_group_no_family",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    expect(result.handled).toBe(true)
    expect(result.notifiedAgent).toBe(false)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("does not call runAgent when trust gate rejects", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "stranger_silent_drop",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    // runAgent should NOT have been called since handleInboundTurn mock returns rejection
    // (the mock doesn't call runAgent when we override it)
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("passes pendingDir to pipeline for per-turn pending drain", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(input.pendingDir).toEqual(expect.stringContaining("pending"))
    expect(typeof input.drainPending).toBe("function")
  })

  it("passes deferred-return drain to pipeline for friend-level completion routing", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    const input = mocks.handleInboundTurn.mock.calls[0][0]
    expect(typeof input.drainDeferredReturns).toBe("function")
    expect(input.drainDeferredReturns("friend-uuid")).toEqual([])
    expect(mocks.drainDeferredReturns).toHaveBeenCalledWith("testagent", "friend-uuid")
  })

  it("passes BB-specific toolContext (bluebubblesReplyTarget, codingFeedback) via runAgent wrapper", async () => {
    let capturedOptions: any = null
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any, _channel: any, _signal: any, options: any) => {
      capturedOptions = options
      callbacks.onModelStart()
      callbacks.onTextChunk("got it")
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(capturedOptions).not.toBeNull()
    expect(capturedOptions.toolContext).toBeDefined()
    expect(typeof capturedOptions.toolContext.bluebubblesReplyTarget?.setSelection).toBe("function")
    expect(typeof capturedOptions.toolContext.codingFeedback?.send).toBe("function")
    expect(typeof capturedOptions.toolContext.summarize).toBe("function")
    expect(typeof capturedOptions.toolContext.signin).toBe("function")
  })

  it("flushes callbacks after successful pipeline run and calls finish in finally block", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    // Verify flush sent the reply text
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "got it" }),
    )
    // Verify typing was stopped (finish called)
    expect(mocks.setTyping).toHaveBeenCalledWith(
      expect.anything(),
      false,
    )
  })

  it("calls finish but not flush when gate rejects", async () => {
    mocks.handleInboundTurn.mockResolvedValueOnce({
      resolvedContext: defaultFriendContext,
      gateResult: {
        allowed: false,
        reason: "stranger_silent_drop",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    // No sendText for agent reply (gate rejected, no agent turn)
    expect(mocks.sendText).not.toHaveBeenCalled()
    // runAgent not called
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })
})

describe("drainAndSendPendingBlueBubbles", () => {
  let pendingRoot: string

  function makeFriend(overrides: Partial<{
    id: string
    name: string
    trustLevel: string
    externalIds: Array<{ provider: string; externalId: string; linkedAt: string }>
  }> = {}): any {
    return {
      id: overrides.id ?? "friend-uuid-1",
      name: overrides.name ?? "Alice",
      trustLevel: overrides.trustLevel ?? "friend",
      externalIds: overrides.externalIds ?? [
        { provider: "imessage-handle", externalId: "alice@icloud.com", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }
  }

  function writePendingFile(friendId: string, key: string, content: Record<string, unknown>): string {
    const dir = path.join(pendingRoot, friendId, "bluebubbles", key)
    fs.mkdirSync(dir, { recursive: true })
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, JSON.stringify(content))
    return filePath
  }

  beforeEach(() => {
    vi.resetModules()
    pendingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pending-test-"))
    tempDirs.push(pendingRoot)
    mocks.sendText.mockReset().mockResolvedValue({ messageGuid: "proactive-sent-guid" })
    mocks.emitNervesEvent.mockReset()
  })

  it("sends a pending message to a friend via iMessage handle", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      key: "session",
      content: "hey Alice, wanted to share something!",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.sent).toBe(1)
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatIdentifier: "alice@icloud.com",
      }),
      text: "hey Alice, wanted to share something!",
    }))
  })

  it("deletes the pending file after successful send", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const filePath = writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "hello!",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("skips friends with trust level 'acquaintance'", async () => {
    const friend = makeFriend({ trustLevel: "acquaintance" })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const filePath = writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "should not be sent",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(result.sent).toBe(0)
    expect(mocks.sendText).not.toHaveBeenCalled()
    // Pending file should be deleted even when skipped (don't re-process)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("skips friends with trust level 'stranger'", async () => {
    const friend = makeFriend({ trustLevel: "stranger" })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "should not be sent",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("allows sending to friends with trust level 'family'", async () => {
    const friend = makeFriend({ trustLevel: "family" })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "hello family!",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.sent).toBe(1)
    expect(mocks.sendText).toHaveBeenCalled()
  })

  it("skips group chat external IDs (starting with 'group:')", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "imessage-handle", externalId: "group:chat123", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "should not go to group",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("skips friend with no iMessage handle and logs warning", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "aad", externalId: "aad-object-id", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "no imessage handle",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_proactive_no_handle",
      }),
    )
  })

  it("skips friend that cannot be found in the store", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-missing", "session", {
      from: "testagent",
      friendId: "friend-uuid-missing",
      channel: "bluebubbles",
      content: "unknown friend",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("handles sendText failure gracefully", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    mocks.sendText.mockRejectedValueOnce(new Error("network failure"))

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "this will fail to send",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)
  })

  it("returns zero counts when no pending directories exist", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-pending-empty-"))
    tempDirs.push(emptyRoot)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, emptyRoot)

    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("processes multiple pending messages across different friends", async () => {
    const alice = makeFriend({ id: "alice-uuid", name: "Alice" })
    const bob = makeFriend({
      id: "bob-uuid",
      name: "Bob",
      externalIds: [
        { provider: "imessage-handle", externalId: "bob@icloud.com", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockImplementation(async (id: string) => {
        if (id === "alice-uuid") return alice
        if (id === "bob-uuid") return bob
        return null
      }),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("alice-uuid", "session", {
      from: "testagent",
      friendId: "alice-uuid",
      channel: "bluebubbles",
      content: "hey Alice!",
      timestamp: Date.now(),
    })

    writePendingFile("bob-uuid", "session", {
      from: "testagent",
      friendId: "bob-uuid",
      channel: "bluebubbles",
      content: "hey Bob!",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.sent).toBe(2)
    expect(mocks.sendText).toHaveBeenCalledTimes(2)
  })

  it("handles non-existent pending root gracefully", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, "/nonexistent/pending/root")

    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("ignores non-bluebubbles channel directories", async () => {
    // Write a pending file under "teams" channel -- should be ignored by BB drain
    const teamsDir = path.join(pendingRoot, "friend-uuid-1", "teams", "session")
    fs.mkdirSync(teamsDir, { recursive: true })
    fs.writeFileSync(
      path.join(teamsDir, `${Date.now()}-abc.json`),
      JSON.stringify({ from: "testagent", content: "teams msg", timestamp: Date.now() }),
    )

    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.sent).toBe(0)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("uses default pending root from getAgentRoot when not provided", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    // Call without pendingRoot -- should use default from getAgentRoot (which is mocked to /mock/agent/root)
    // The default path /mock/agent/root/state/pending won't exist, so should return zeros
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result.sent).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("skips unreadable key directories gracefully", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    // Create a file where a directory is expected (key path)
    const bbDir = path.join(pendingRoot, "friend-uuid-1", "bluebubbles")
    fs.mkdirSync(bbDir, { recursive: true })
    fs.writeFileSync(path.join(bbDir, "not-a-directory"), "oops")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.sent).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("handles invalid JSON in pending file gracefully", async () => {
    const friendStore = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    // Write an invalid JSON file
    const dir = path.join(pendingRoot, "friend-uuid-1", "bluebubbles", "session")
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${Date.now()}-bad.json`)
    fs.writeFileSync(filePath, "not valid json {{{")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.failed).toBe(1)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("skips pending messages with non-string content field", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: 12345,
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("treats undefined trustLevel as disallowed", async () => {
    const friend = makeFriend({ trustLevel: undefined as any })
    // Ensure trustLevel is genuinely undefined
    delete (friend as any).trustLevel
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "trust undefined",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("handles non-Error thrown from sendText", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    mocks.sendText.mockRejectedValueOnce("string error thrown")

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "this will fail with string throw",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.failed).toBe(1)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_proactive_send_error",
        meta: expect.objectContaining({
          reason: "string error thrown",
        }),
      }),
    )
  })

  it("skips pending messages with empty content", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const filePath = writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "   ",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("handles friend store get() throwing an error", async () => {
    const friendStore = {
      get: vi.fn().mockRejectedValue(new Error("disk read error")),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "store will throw",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.skipped).toBe(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("picks the first non-group iMessage handle when friend has multiple externalIds", async () => {
    const friend = makeFriend({
      externalIds: [
        { provider: "aad", externalId: "aad-id", linkedAt: "2026-01-01" },
        { provider: "imessage-handle", externalId: "group:chat456", linkedAt: "2026-01-01" },
        { provider: "imessage-handle", externalId: "alice@icloud.com", linkedAt: "2026-01-01" },
      ],
    })
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "should use non-group handle",
      timestamp: Date.now(),
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.drainAndSendPendingBlueBubbles({
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    }, pendingRoot)

    expect(result.sent).toBe(1)
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatIdentifier: "alice@icloud.com",
      }),
    }))
  })
})

describe("sendProactiveBlueBubblesMessageToSession", () => {
  function makeFriend(overrides: Partial<{
    id: string
    name: string
    trustLevel: string
    externalIds: Array<{ provider: string; externalId: string; linkedAt: string }>
  }> = {}): any {
    return {
      id: overrides.id ?? "friend-uuid-1",
      name: overrides.name ?? "Alice",
      trustLevel: overrides.trustLevel ?? "friend",
      externalIds: overrides.externalIds ?? [
        { provider: "imessage-handle", externalId: "alice@icloud.com", linkedAt: "2026-01-01" },
      ],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }
  }

  beforeEach(() => {
    mocks.sendText.mockReset().mockResolvedValue({ messageGuid: "proactive-sent-guid" })
    mocks.emitNervesEvent.mockReset()
  })

  it("sends proactively to a specific BlueBubbles session key", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatGuid: "any;-;alice@icloud.com",
        chatIdentifier: "alice@icloud.com",
        sessionKey: "chat:any;-;alice@icloud.com",
      }),
      text: "surface this now",
    }))
  })

  it("sends proactively to a chat_identifier session key", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat_identifier:alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatIdentifier: "alice@icloud.com",
        sessionKey: "chat_identifier:alice@icloud.com",
      }),
      text: "surface this now",
    }))
  })

  it("falls back to the friend's iMessage handle when chat_identifier is blank", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat_identifier:   ",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatIdentifier: "alice@icloud.com",
      }),
    }))
  })

  it("can proactively send with a chat guid even when no handle is available", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({ externalIds: [] })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:opaque-guid",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatGuid: "opaque-guid",
        sessionKey: "chat:opaque-guid",
      }),
    }))
  })

  it("falls back to the friend's handle when a chat guid carries an empty identifier segment", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:any;-;   ",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatGuid: "any;-;",
        chatIdentifier: "alice@icloud.com",
      }),
    }))
  })

  it("skips proactive delivery when no routing target can be derived", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({ externalIds: [] })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "session",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "missing_target" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("skips proactive delivery when a chat session key has no guid payload", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:   ",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "missing_target" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("skips proactive delivery when the friend cannot be found", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "missing-friend",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "friend_not_found" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("skips proactive delivery when the friend store throws", async () => {
    const friendStore = {
      get: vi.fn().mockRejectedValue(new Error("store blew up")),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "missing-friend",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "friend_not_found" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("skips proactive delivery when trust level is not allowed", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({ trustLevel: "stranger" })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "trust_skip" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("allows explicit cross-chat delivery to a group session when the asking chat is trusted even if the target record is only acquaintance", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({
        id: "group-uuid",
        name: "Project Group",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-01-01" },
        ],
      })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "group-uuid",
      sessionKey: "chat:any;+;project-group-123",
      text: "tell the group the plan changed",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        trustLevel: "friend",
      },
    } as any, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatGuid: "any;+;project-group-123",
        sessionKey: "chat:any;+;project-group-123",
        isGroup: true,
      }),
      text: "tell the group the plan changed",
    }))
  })

  it("uses the persisted BlueBubbles session filename key when explicitly sending to an active group chat", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({
        id: "group-uuid",
        name: "Project Group",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-01-01" },
        ],
      })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "group-uuid",
      sessionKey: "chat_any;+;project-group-123",
      text: "tell the active group this came from a stored session key",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        trustLevel: "friend",
      },
    } as any, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatGuid: "any;+;project-group-123",
        chatIdentifier: "project-group-123",
        sessionKey: "chat_any;+;project-group-123",
        isGroup: true,
      }),
      text: "tell the active group this came from a stored session key",
    }))
  })

  it("normalizes persisted BlueBubbles chat_identifier session keys for explicit delivery", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({
        id: "friend-uuid-2",
        name: "Jordan",
        trustLevel: "friend",
        externalIds: [
          { provider: "imessage-handle", externalId: "jordan@icloud.com", linkedAt: "2026-01-01" },
        ],
      })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-2",
      sessionKey: "chat_identifier_jordan@icloud.com",
      text: "ping Jordan through the stored chat identifier",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        trustLevel: "friend",
      },
    } as any, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatIdentifier: "jordan@icloud.com",
        sessionKey: "chat_identifier_jordan@icloud.com",
        isGroup: false,
      }),
      text: "ping Jordan through the stored chat identifier",
    }))
  })

  it("falls back to the friend's iMessage handle when a persisted chat_identifier filename key is blank", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat_identifier_   ",
      text: "use the fallback handle from the friend record",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: true })
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({
        chatIdentifier: "alice@icloud.com",
        sessionKey: "chat_identifier_   ",
      }),
      text: "use the fallback handle from the friend record",
    }))
  })

  it("requires a trusted authorizing session for explicit cross-chat delivery into acquaintance chats", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend({
        id: "group-uuid",
        name: "Project Group",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-01-01" },
        ],
      })),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "group-uuid",
      sessionKey: "chat:any;+;project-group-123",
      text: "this should not send without a trusted asking chat",
      intent: "explicit_cross_chat",
    } as any, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "trust_skip" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("treats undefined trust level as disallowed for proactive delivery", async () => {
    const friend = makeFriend()
    delete friend.trustLevel
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "trust_skip" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("returns send_error when proactive BlueBubbles delivery fails", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    mocks.sendText.mockReset().mockRejectedValue(new Error("bb down"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "send_error" })
  })

  it("stringifies non-Error proactive BlueBubbles send failures", async () => {
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }
    mocks.sendText.mockReset().mockRejectedValue("bb string fail")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.sendProactiveBlueBubblesMessageToSession({
      friendId: "friend-uuid-1",
      sessionKey: "chat:any;-;alice@icloud.com",
      text: "surface this now",
    }, {
      createClient: () => ({
        sendText: mocks.sendText,
        editMessage: mocks.editMessage,
        setTyping: mocks.setTyping,
        markChatRead: mocks.markChatRead,
        checkHealth: mocks.checkHealth,
        repairEvent: mocks.repairEvent,
        getMessageText: mocks.getMessageText,
      }),
      createFriendStore: () => friendStore as any,
    })

    expect(result).toEqual({ delivered: false, reason: "send_error" })
  })
})

// ── Reaction enrichment (Unit 4) ──────────────────────────────────────────
describe("BlueBubbles adapter - reaction enrichment", () => {
  it("enrichReactionText: enriches with original message text (under 80 chars)", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const result = bb.enrichReactionText("reacted with love", "great idea!", 80)
    expect(result).toBe('reacted with love to: "great idea!"')
  })

  it("enrichReactionText: truncates text over 80 chars", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const longText = "a".repeat(81)
    const result = bb.enrichReactionText("reacted with love", longText, 80)
    expect(result).toBe(`reacted with love to: "${"a".repeat(77)}..."`)
  })

  it("enrichReactionText: 80 chars passes through untouched", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const exact = "a".repeat(80)
    const result = bb.enrichReactionText("reacted with love", exact, 80)
    expect(result).toBe(`reacted with love to: "${exact}"`)
  })

  it("enrichReactionText: null text returns bare text", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const result = bb.enrichReactionText("reacted with love", null, 80)
    expect(result).toBe("reacted with love")
  })

  it("enrichReactionText: empty string returns bare text", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const result = bb.enrichReactionText("reacted with love", "", 80)
    expect(result).toBe("reacted with love")
  })
})
