import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  buildSystem: vi.fn().mockResolvedValue({ stable: "system prompt", volatile: "" }),
  createSummarize: vi.fn(() => vi.fn()),
  sessionPath: vi.fn().mockReturnValue("/tmp/bluebubbles-session.json"),
  getBlueBubblesConfig: vi.fn().mockReturnValue({
    serverUrl: "http://bluebubbles.local",
    password: "secret-token",
    accountId: "default",
    ownHandles: [],
  }),
  getBlueBubblesChannelConfig: vi.fn().mockReturnValue({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  }),
  getAgentName: vi.fn().mockReturnValue("testagent"),
  getAgentRoot: vi.fn().mockReturnValue("/mock/agent/root"),
  loadSession: vi.fn().mockReturnValue(null),
  postTurnTrim: vi.fn().mockReturnValue({ currentMessages: [], trimmedMessages: [], currentIngressTimes: [], maxTokens: 128000, contextMargin: 0 }),
  deferPostTurnPersist: vi.fn().mockResolvedValue([]),
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
  initializeSemanticCutover: vi.fn(),
  writeSemanticCapture: vi.fn(),
  acquireSemanticClaim: vi.fn(),
  releaseSemanticClaim: vi.fn(),
  writeSemanticHandled: vi.fn(),
  allocateSemanticCoordinate: vi.fn(),
  listPendingSemanticCaptures: vi.fn(),
  semanticCaptures: new Map<string, any>(),
  semanticHandled: new Map<string, any>(),
  semanticClaims: new Map<string, { lease: any; released: Promise<void>; resolve: () => void }>(),
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
  recoverRuntimeCwd: vi.fn(() => "/repo/root"),
  lastStoreInstance: null as any,
}))

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-runtime-cleanup-"))
  tempDirs.push(dir)
  return dir
}

function createDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function waitFor(predicate: () => boolean, attempts = 400): Promise<void> {
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

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
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
  flattenSystemPrompt: (sp: any) => [sp?.stable, sp?.volatile].filter(Boolean).join("\n\n"),
}))

vi.mock("../../../heart/config", () => ({
  sessionPath: (...args: any[]) => mocks.sessionPath(...args),
  getBlueBubblesConfig: (...args: any[]) => mocks.getBlueBubblesConfig(...args),
  getBlueBubblesChannelConfig: (...args: any[]) => mocks.getBlueBubblesChannelConfig(...args),
  sanitizeKey: (value: string) => value.replace(/[^a-zA-Z0-9;+.-]+/g, "_"),
}))

vi.mock("../../../mind/context", () => ({
  loadSession: (...args: any[]) => mocks.loadSession(...args),
  postTurnTrim: (...args: any[]) => mocks.postTurnTrim(...args),
  deferPostTurnPersist: (...args: any[]) => mocks.deferPostTurnPersist(...args),
  deleteSession: vi.fn(),
}))

// Friends now lives in the @ouro.bot/friends package (a single barrel module).
// The previously separate tokens/store-file/resolver/channel mocks merge into one
// package mock that spreads the real barrel and overrides the four used symbols.
vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    accumulateFriendTokens: (...args: any[]) => mocks.accumulateFriendTokens(...args),
    getChannelCapabilities: (...args: any[]) => mocks.getChannelCapabilities(...args),
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
    FriendResolver: vi.fn(function (this: any, store: unknown, params: unknown) {
      mocks.resolverCtor(store, params)
      this.resolve = (...args: any[]) => mocks.resolveContext(...args)
    }),
  }
})

vi.mock("../../../heart/identity", () => ({
  getAgentName: mocks.getAgentName,
  getAgentRoot: mocks.getAgentRoot,
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
    phrases: {
      thinking: ["thinking"],
      tool: ["tool"],
      followup: ["followup"],
    },
  })),
}))

vi.mock("../../../heart/runtime-cwd", () => ({
  recoverRuntimeCwd: (...args: any[]) => mocks.recoverRuntimeCwd(...args),
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

vi.mock("../../../senses/bluebubbles/semantic-receipts", async () => {
  const actual = await vi.importActual<typeof import("../../../senses/bluebubbles/semantic-receipts")>(
    "../../../senses/bluebubbles/semantic-receipts",
  )
  return {
    ...actual,
    initializeBlueBubblesSemanticCutover: (...args: any[]) => mocks.initializeSemanticCutover(...args),
    writeBlueBubblesSemanticCapture: (...args: any[]) => mocks.writeSemanticCapture(...args),
    acquireBlueBubblesSemanticClaim: (...args: any[]) => mocks.acquireSemanticClaim(...args),
    releaseBlueBubblesSemanticClaim: (...args: any[]) => mocks.releaseSemanticClaim(...args),
    writeBlueBubblesSemanticHandled: (...args: any[]) => mocks.writeSemanticHandled(...args),
    allocateBlueBubblesReactionCoordinate: (...args: any[]) => mocks.allocateSemanticCoordinate(...args),
    listPendingBlueBubblesSemanticCaptures: (...args: any[]) => mocks.listPendingSemanticCaptures(...args),
  }
})

vi.mock("node:http", () => ({
  createServer: (...args: any[]) => mocks.createServer(...args),
}))

vi.mock("../../../senses/pipeline", () => ({
  handleInboundTurn: (...args: any[]) => mocks.handleInboundTurn(...args),
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
      observed: true,
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

const groupOrientationPayload = {
  type: "new-message",
  data: {
    guid: "SYNTHETIC-GROUP-ORIENTATION-MESSAGE",
    text: "please end the report",
    handle: {
      address: "ari@example.test",
      service: "iMessage",
    },
    attachments: [],
    dateCreated: 1772947800000,
    isFromMe: false,
    chats: [
      {
        guid: "any;+;synthetic-orientation-group",
        style: 43,
        chatIdentifier: "synthetic-orientation-group",
        displayName: "Synthetic Orientation Group",
        participants: [
          { address: "ari@example.test" },
          { address: "rachel@example.test" },
        ],
      },
    ],
  },
}

async function makeStoredSemanticCapture(
  payload: unknown = dmTopLevelPayload,
  options: {
    capturedAt?: string
    targetAuthorship?: "agent" | "non_agent_unknown" | null
  } = {},
) {
  const { normalizeBlueBubblesEvent } = await import("../../../senses/bluebubbles/model")
  const { buildBlueBubblesSemanticCapture } = await import("../../../senses/bluebubbles/semantic-receipts")
  const normalized = normalizeBlueBubblesEvent(payload)
  const capture = buildBlueBubblesSemanticCapture({
    cutover: {
      schemaVersion: 1,
      providerNamespace: "11111111-1111-4111-8111-111111111111",
      effectiveAt: "2026-07-30T00:00:00.000Z",
    },
    capturedAt: options.capturedAt ?? "2026-07-30T18:00:00.000Z",
    event: normalized,
    targetAuthorship: options.targetAuthorship ?? null,
    coordinateGeneration: normalized.kind === "mutation" && normalized.mutationType === "reaction"
      ? 0
      : undefined,
  })
  expect(capture).not.toBeNull()
  return capture!
}

async function queueStoredSemanticCapture(
  payload: unknown = dmTopLevelPayload,
  options: {
    capturedAt?: string
    targetAuthorship?: "agent" | "non_agent_unknown" | null
  } = {},
) {
  const capture = await makeStoredSemanticCapture(payload, options)
  mocks.semanticCaptures.set(capture.keyHash, capture)
  return capture
}

async function makeStoredSemanticCaptureFromEvent(
  event: ReturnType<typeof makeCatchUpMessage>,
  options: { capturedAt?: string } = {},
) {
  const { buildBlueBubblesSemanticCapture } = await import("../../../senses/bluebubbles/semantic-receipts")
  const capture = buildBlueBubblesSemanticCapture({
    cutover: {
      schemaVersion: 1,
      providerNamespace: "11111111-1111-4111-8111-111111111111",
      effectiveAt: "2026-07-30T00:00:00.000Z",
    },
    capturedAt: options.capturedAt ?? "2026-07-30T18:00:00.000Z",
    event: {
      ...event,
      sender: { ...event.sender, observed: true },
    },
    targetAuthorship: null,
  })
  expect(capture).not.toBeNull()
  return capture!
}

async function queueStoredSemanticCaptureFromEvent(
  event: ReturnType<typeof makeCatchUpMessage>,
  options: { capturedAt?: string } = {},
) {
  const capture = await makeStoredSemanticCaptureFromEvent(event, options)
  mocks.semanticCaptures.set(capture.keyHash, capture)
  return capture
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
      outcome: "settled",
      completion: { answer: "got it", intent: "complete" },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 0,
        total_tokens: 15,
      },
    }
  })
  mocks.buildSystem.mockReset().mockResolvedValue({ stable: "system prompt", volatile: "" })
  mocks.sessionPath.mockReset().mockReturnValue("/tmp/bluebubbles-session.json")
  mocks.getBlueBubblesConfig.mockReset().mockReturnValue({
    serverUrl: "http://bluebubbles.local",
    password: "secret-token",
    accountId: "default",
    ownHandles: [],
  })
  mocks.getBlueBubblesChannelConfig.mockReset().mockReturnValue({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  })
  mocks.getAgentName.mockReset().mockReturnValue("testagent")
  mocks.getAgentRoot.mockReset().mockReturnValue("/mock/agent/root")
  mocks.loadSession.mockReset().mockReturnValue(null)
  mocks.postTurnTrim.mockReset().mockReturnValue({ currentMessages: [], trimmedMessages: [], currentIngressTimes: [], maxTokens: 128000, contextMargin: 0 })
  mocks.deferPostTurnPersist.mockReset().mockResolvedValue([])
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
  mocks.recoverRuntimeCwd.mockReset().mockReturnValue("/repo/root")
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
    let pipelineOpts = {
      ...input.runAgentOptions,
      toolContext: {
        signin: async () => undefined,
        ...existingToolContext,
        context: resolvedContext,
        friendStore: input.friendStore,
      },
    }
    const preparedOptions = await input.prepareRunAgentOptions?.({
      messages: msgs,
      currentUserMessages: input.messages,
      resolvedContext,
      runAgentOptions: pipelineOpts,
    })
    if (preparedOptions) {
      pipelineOpts = {
        ...pipelineOpts,
        ...preparedOptions,
        toolContext: {
          ...pipelineOpts.toolContext,
          ...preparedOptions.toolContext,
        },
      }
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
  mocks.initializeSemanticCutover.mockReset().mockReturnValue({
    schemaVersion: 1,
    providerNamespace: "11111111-1111-4111-8111-111111111111",
    effectiveAt: "2026-07-30T00:00:00.000Z",
  })
  mocks.semanticCaptures.clear()
  mocks.semanticHandled.clear()
  mocks.semanticClaims.clear()
  mocks.writeSemanticCapture.mockReset().mockImplementation((_agentName: string, capture: any) => {
    if (mocks.semanticCaptures.has(capture.keyHash)) return "semantic_capture_duplicate"
    mocks.semanticCaptures.set(capture.keyHash, capture)
    return "semantic_capture_published"
  })
  mocks.acquireSemanticClaim.mockReset().mockImplementation(async (
    _agentName: string,
    identity: { canonicalKey: string; keyHash: string },
  ) => {
    const inFlight = mocks.semanticClaims.get(identity.keyHash)
    if (inFlight) await inFlight.released
    const handled = mocks.semanticHandled.get(identity.keyHash)
    if (handled) return { status: "already_handled", record: handled }
    const lease = {
      status: "acquired",
      record: {
        schemaVersion: 1,
        canonicalKey: identity.canonicalKey,
        keyHash: identity.keyHash,
        owner: {
          operationId: `semantic-handle:${identity.keyHash}`,
          pid: 4242,
          bootIdentity: "test-boot",
          processStartedAt: "test-process",
          acquiredAt: "2026-07-30T18:00:00.000Z",
        },
      },
    }
    let resolve!: () => void
    const released = new Promise<void>((done) => {
      resolve = done
    })
    mocks.semanticClaims.set(identity.keyHash, { lease, released, resolve })
    return lease
  })
  mocks.releaseSemanticClaim.mockReset().mockImplementation((_agentName: string, lease: any) => {
    const keyHash = lease?.record?.keyHash
    const claim = mocks.semanticClaims.get(keyHash)
    if (!claim || claim.lease !== lease) return false
    mocks.semanticClaims.delete(keyHash)
    claim.resolve()
    return true
  })
  mocks.writeSemanticHandled.mockReset().mockImplementation((_agentName: string, record: any) => {
    if (mocks.semanticHandled.has(record.keyHash)) return "semantic_handled_duplicate"
    mocks.semanticHandled.set(record.keyHash, record)
    return "semantic_handled_published"
  })
  mocks.allocateSemanticCoordinate.mockReset().mockImplementation(async (
    _agentName: string,
    input: { coordinateKey: string; coordinateHash: string; canonicalAction: "add" | "remove" },
  ) => ({
    schemaVersion: 1,
    coordinateKey: input.coordinateKey,
    coordinateHash: input.coordinateHash,
    generation: 0,
    lastAction: input.canonicalAction,
    updatedAt: "2026-07-30T18:00:00.000Z",
  }))
  mocks.listPendingSemanticCaptures.mockReset().mockImplementation(() => (
    [...mocks.semanticCaptures.values()].filter((capture) => !mocks.semanticHandled.has(capture.keyHash))
  ))
  mocks.listen.mockReset().mockImplementation((_: number, cb?: () => void) => cb?.())
  mocks.createServer.mockReset().mockImplementation((handler: unknown) => ({
    listen: mocks.listen,
    close: vi.fn(),
    handler,
  }))
}

function firstRunAgentMessages(): any[] {
  return mocks.runAgent.mock.calls[0]?.[0] ?? []
}

function firstRunAgentOptions(): any {
  return mocks.runAgent.mock.calls[0]?.[4]
}

function lastUserMessageContent(): unknown {
  const messages = firstRunAgentMessages()
  return [...messages].reverse().find((message) => message.role === "user")?.content
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

function createMockResponse(onEnd?: () => void) {
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
      onEnd?.()
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
          content: "threaded reply",
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
    expect(mocks.postTurnTrim).toHaveBeenCalledTimes(1)
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

    const userContent = lastUserMessageContent()
    expect(userContent).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      replyingToText: "This is the original message being replied to",
    })
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
    expect(mocks.postTurnTrim).toHaveBeenCalledTimes(1)
  })

  it("keeps group observe tool turns silent even when the engine emits observe callbacks", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onToolStart("observe", { reason: "not for me" })
      callbacks.onToolEnd("observe", "not for me", true)
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
    await bluebubbles.handleBlueBubblesEvent(groupThreadPayload)

    expect(mocks.markChatRead).not.toHaveBeenCalled()
    expect(mocks.setTyping).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
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

  it("separates threaded inbound metadata into the orientation frame", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(lastUserMessageContent()).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame).toMatchObject({
      channel: "bluebubbles",
      currentUserSpeech: ["threaded reply"],
      source: {
        kind: "bluebubbles",
        lane: "thread",
        threadId: "54D4109C-7170-41A1-8161-F6F8C863CC0D",
        defaultReplyTarget: "current_lane",
      },
    })
  })

  it("separates top-level inbound metadata into the orientation frame", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(lastUserMessageContent()).toBe("top-level follow-up")
    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      kind: "bluebubbles",
      lane: "top_level",
      defaultReplyTarget: "top_level",
    })
  })

  it("keeps the observed group actor distinct from membership-only participants and tools receive only the capture locator", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(groupOrientationPayload)

    const capture = mocks.writeSemanticCapture.mock.calls[0]?.[1]
    expect(capture).toBeDefined()
    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      kind: "bluebubbles",
      authority: "presentation_only",
      conversationKind: "group",
      event: {
        provider: "bluebubbles",
        kind: "message",
        sourceEventType: "new-message",
        fromMe: false,
      },
      actor: {
        role: "observed_actor",
        provider: "imessage-handle",
        externalId: "ari@example.test",
      },
      participants: [
        {
          role: "group_participant_only",
          provider: "imessage-handle",
          externalId: "rachel@example.test",
        },
      ],
    })
    expect(firstRunAgentOptions().orientationFrame.source.participants).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "ari@example.test" }),
      ]),
    )

    const ingressEvidence = firstRunAgentOptions().toolContext.currentIngressEvidence
    expect(ingressEvidence).toEqual({
      schemaVersion: 1,
      provider: "bluebubbles",
      captureKeyHash: capture.keyHash,
    })
    expect(Object.keys(ingressEvidence)).toEqual([
      "schemaVersion",
      "provider",
      "captureKeyHash",
    ])
    expect(firstRunAgentOptions().toolContext.agentRoot).toBe("/mock/agent/root")
    expect(ingressEvidence).not.toHaveProperty("actor")
    expect(ingressEvidence).not.toHaveProperty("request")
    expect(ingressEvidence).not.toHaveProperty("participants")
  })

  it("does not let transport repair replace the captured actor or from-me observation", async () => {
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      fromMe: true,
      sender: {
        ...event.sender,
        externalId: "rachel@example.test",
        rawId: "rachel@example.test",
        displayName: "Rachel",
      },
    }))
    const bluebubbles = await import("../../../senses/bluebubbles")

    await bluebubbles.handleBlueBubblesEvent(groupOrientationPayload)

    expect(firstRunAgentOptions().orientationFrame).toMatchObject({
      currentUserSpeech: ["ari@example.test: please end the report"],
      source: {
        event: { fromMe: false },
        actor: {
          role: "observed_actor",
          externalId: "ari@example.test",
        },
        participants: [{
          role: "group_participant_only",
          externalId: "rachel@example.test",
        }],
      },
    })
  })

  it("keeps ordinary edit orientation grounded in captured group membership and target provenance after repair", async () => {
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      targetMessageGuid: "FORGED-REPAIR-TARGET",
      chat: {
        ...event.chat,
        isGroup: false,
      },
    }))
    const bluebubbles = await import("../../../senses/bluebubbles")

    await bluebubbles.handleBlueBubblesEvent({
      ...groupOrientationPayload,
      type: "updated-message",
      data: {
        ...groupOrientationPayload.data,
        guid: "SYNTHETIC-GROUP-ORIENTATION-EDIT",
        text: "please end the edited report",
        dateEdited: 1772947805000,
      },
    })

    const source = firstRunAgentOptions().orientationFrame.source
    expect.soft(source).toMatchObject({
      conversationKind: "group",
      actor: {
        role: "observed_actor",
        externalId: "ari@example.test",
      },
      participants: [{
        role: "group_participant_only",
        externalId: "rachel@example.test",
      }],
    })
    expect(source.participants).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "ari@example.test" }),
      ]),
    )
    expect.soft(source).not.toHaveProperty("target")
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

    expect(lastUserMessageContent()).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toEqual([
      { key: "top_level", label: "top_level", snippet: "recent top-level topic" },
      { key: "thread:THREAD-OLD", label: "thread:THREAD-OLD", snippet: "old thread topic" },
    ])
    expect(firstRunAgentOptions().orientationFrame.source.routingHint).toContain("bluebubbles_set_reply_target")
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

    expect(lastUserMessageContent()).toBe("top-level follow-up")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toEqual([
      { key: "thread:THREAD-MEDIA", label: "thread:THREAD-MEDIA", snippet: "media thread topic" },
    ])
    expect(firstRunAgentOptions().orientationFrame.source.routingHint).toContain("bluebubbles_set_reply_target")
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

    expect(lastUserMessageContent()).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toEqual([
      { key: "top_level", label: "top_level", snippet: "actual top-level body" },
    ])
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

    expect(lastUserMessageContent()).toBe("top-level follow-up")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toEqual([
      { key: "thread:THREAD-META", label: "thread:THREAD-META", snippet: "actual threaded body" },
    ])
    expect(firstRunAgentOptions().orientationFrame.source.routingHint).toContain("bluebubbles_set_reply_target")
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

    expect(lastUserMessageContent()).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toEqual([
      { key: "top_level", label: "top_level", snippet: "(no recent text)" },
    ])
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

    expect(lastUserMessageContent()).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toBeUndefined()
    expect(firstRunAgentOptions().orientationFrame.source.routingHint).toContain("bluebubbles_set_reply_target")
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

    expect(lastUserMessageContent()).toBe("threaded reply")
    expect(firstRunAgentOptions().orientationFrame.source.recentLanes).toEqual([
      { key: "thread:THREAD-OLD-5", label: "thread:THREAD-OLD-5", snippet: "duplicate fifth thread" },
      { key: "thread:THREAD-OLD-4", label: "thread:THREAD-OLD-4", snippet: "fourth thread" },
      { key: "thread:THREAD-OLD-3", label: "thread:THREAD-OLD-3", snippet: "third thread" },
      { key: "thread:THREAD-OLD-2", label: "thread:THREAD-OLD-2", snippet: "second thread" },
      { key: "top_level", label: "top_level", snippet: "newest top-level" },
    ])
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

  it("keeps tool activity private for a tool-heavy turn and sends only the final reply", async () => {
    mocks.sendText
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
    expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
      text: "reading notes.txt...",
    }))
    expect(mocks.sendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: "C4B2E437-A373-43F6-9740-9CD84E5893A0",
        text: "got it",
      }),
    )
    expect(mocks.editMessage).not.toHaveBeenCalled()
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
  })

  it("suppresses raw browser MCP tool progress in BlueBubbles", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      callbacks.onToolStart("browser_navigate", { url: "https://www.sbb.ch/en" })
      callbacks.onToolEnd("browser_navigate", "ok", true)
      callbacks.onToolStart("browser_snapshot", { depth: "3" })
      callbacks.onToolEnd("browser_snapshot", "ok", true)
      callbacks.onToolStart("browser_click", { element: "Reject cookies" })
      callbacks.onToolEnd("browser_click", "ok", true)
      callbacks.onToolStart("browser_type", { element: "From", text: "Basel SBB" })
      callbacks.onToolEnd("browser_type", "ok", true)
      callbacks.onToolStart("browser_wait_for", { time: "2" })
      callbacks.onToolEnd("browser_wait_for", "ok", true)
      callbacks.onTextChunk("I found the best train.")
      return {
        content: "I found the best train.",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    const sentTexts = mocks.sendText.mock.calls.map((call: any[]) => call[0]?.text)
    expect(sentTexts).toEqual(["I found the best train."])
    expect(sentTexts.join("\n")).not.toMatch(/browser_(navigate|snapshot|click|type|wait_for)/)
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

  it("routes coding feedback for notifyable edits without forcing a reply target", async () => {
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
    await bluebubbles.handleBlueBubblesEvent(editPayload)

    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }),
        replyToMessageGuid: undefined,
        text: "codex coding-002 completed: hi",
      }),
    )
  })

  it("surfaces string-thrown watchdog status transport failures explicitly", async () => {
    vi.useFakeTimers()
    mocks.sendText
      .mockRejectedValueOnce("status send failure")
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(75_000)
      await flushAsyncWork()
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    try {
      await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
    } finally {
      vi.useRealTimers()
    }

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

  it("surfaces Error-thrown watchdog status transport failures explicitly too", async () => {
    vi.useFakeTimers()
    mocks.sendText
      .mockRejectedValueOnce(new Error("status send error object"))
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(75_000)
      await flushAsyncWork()
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    try {
      await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
    } finally {
      vi.useRealTimers()
    }

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

  it("bounds stuck watchdog status transport before the live turn timeout", async () => {
    vi.useFakeTimers()
    mocks.sendText.mockImplementationOnce(() => new Promise(() => undefined))
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      await vi.advanceTimersByTimeAsync(75_000)
      await flushAsyncWork()
      await vi.advanceTimersByTimeAsync(20_000)
      await flushAsyncWork()
      callbacks.onTextChunk("done")
      return {
        content: "done",
        toolCalls: [],
        outputItems: [],
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    try {
      await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
    } finally {
      vi.useRealTimers()
    }

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_activity_error",
        meta: expect.objectContaining({
          operation: "send_status",
          reason: "bluebubbles send_status activity timed out after 20000ms",
        }),
      }),
    )
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "done" }))
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

  it("times out stuck live webhook turns, tells the chat, and leaves the captured message recoverable", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.handleInboundTurn.mockImplementationOnce(() => new Promise(() => undefined))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handling = bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
      .then(() => null, (error: unknown) => error)
    for (let attempt = 0; attempt < 10 && mocks.handleInboundTurn.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    await expect(handling).resolves.toEqual(expect.objectContaining({
      message: "bluebubbles recovery turn timed out after 120000ms",
    }))

    expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("live iMessage turn timed out"),
    }))
    const { hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", dmThreadPayload.data.guid)).toBe(false)

    const recovery = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()
    expect(recovery).toEqual(expect.objectContaining({ recovered: 1, failed: 0 }))
  })

  it("releases the live webhook lane when timeout cleanup transport hangs", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.setTyping.mockImplementation(() => new Promise(() => undefined))
    mocks.handleInboundTurn.mockImplementationOnce((input: any) => {
      input.callbacks.onModelStart()
      return new Promise(() => undefined)
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handling = bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
      .then(() => null, (error: unknown) => error)
    for (let attempt = 0; attempt < 10 && mocks.handleInboundTurn.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(handling).resolves.toEqual(expect.objectContaining({
      message: "bluebubbles recovery turn timed out after 120000ms",
    }))

    const { snapshotBlueBubblesActiveTurns } = await import("../../../senses/bluebubbles/active-turns")
    expect(snapshotBlueBubblesActiveTurns("testagent", 1)).toEqual(expect.objectContaining({
      activeTurnCount: 0,
      stalledTurnCount: 0,
    }))
    expect(bluebubbles.isBlueBubblesMessageInFlight("chat:any;-;ari@mendelow.me", dmThreadPayload.data.guid)).toBe(false)
    expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("live iMessage turn timed out"),
    }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_activity_cleanup_timeout",
      meta: expect.objectContaining({ operation: "finish" }),
    }))
  })

  it("times out the full live turn when final iMessage delivery hangs after the model returns", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.sendText.mockImplementation(() => new Promise(() => undefined))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handling = bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
      .then(() => null, (error: unknown) => error)
    for (let attempt = 0; attempt < 10 && mocks.sendText.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(mocks.sendText).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    await expect(handling).resolves.toEqual(expect.objectContaining({
      message: "bluebubbles recovery turn timed out after 120000ms",
    }))

    const { snapshotBlueBubblesActiveTurns } = await import("../../../senses/bluebubbles/active-turns")
    expect(snapshotBlueBubblesActiveTurns("testagent", 1)).toEqual(expect.objectContaining({
      activeTurnCount: 0,
      stalledTurnCount: 0,
    }))
    expect(bluebubbles.isBlueBubblesMessageInFlight("chat:any;-;ari@mendelow.me", dmThreadPayload.data.guid)).toBe(false)
    const { hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", dmThreadPayload.data.guid)).toBe(false)
  })

  it("suppresses notifyable edit turns that resolve after the timeout", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const lateTurn = createDeferred<any>()
    mocks.handleInboundTurn.mockImplementationOnce(() => lateTurn.promise)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handling = bluebubbles.handleBlueBubblesEvent(editPayload)
      .then(() => null, (error: unknown) => error)
    for (let attempt = 0; attempt < 10 && mocks.handleInboundTurn.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    await expect(handling).resolves.toEqual(expect.objectContaining({
      message: "bluebubbles recovery turn timed out after 120000ms",
    }))

    lateTurn.resolve({
      resolvedContext: defaultFriendContext,
      gateResult: { allowed: true },
      usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      sessionPath: "/tmp/bluebubbles-session.json",
      messages: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    await flushAsyncWork()

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_timed_out_turn_suppressed",
      meta: expect.objectContaining({
        messageGuid: editPayload.data.guid,
        source: "webhook",
      }),
    }))
  })

  it("logs notifyable edit turns that reject after the timeout", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const lateTurn = createDeferred<any>()
    mocks.handleInboundTurn.mockImplementationOnce(() => lateTurn.promise)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handling = bluebubbles.handleBlueBubblesEvent(editPayload)
      .then(() => null, (error: unknown) => error)
    for (let attempt = 0; attempt < 10 && mocks.handleInboundTurn.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    await expect(handling).resolves.toEqual(expect.objectContaining({
      message: "bluebubbles recovery turn timed out after 120000ms",
    }))

    lateTurn.reject(new Error("late pipeline failure"))
    await vi.advanceTimersByTimeAsync(0)
    await flushAsyncWork()

    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_recovery_error",
      meta: expect.objectContaining({
        messageGuid: editPayload.data.guid,
        reason: "late pipeline failure",
        source: "webhook",
      }),
    }))
  })

  it("suppresses successful final sends that resolve after the timeout", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const lateSend = createDeferred<{ messageGuid: string }>()
    mocks.sendText.mockImplementationOnce(() => lateSend.promise)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handling = bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
      .then(() => null, (error: unknown) => error)
    for (let attempt = 0; attempt < 10 && mocks.sendText.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(mocks.sendText).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(120_000)
    await expect(handling).resolves.toEqual(expect.objectContaining({
      message: "bluebubbles recovery turn timed out after 120000ms",
    }))

    lateSend.resolve({ messageGuid: "late-sent-guid" })
    await vi.advanceTimersByTimeAsync(0)
    await flushAsyncWork()

    const { hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", dmThreadPayload.data.guid)).toBe(false)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_timed_out_turn_suppressed",
      meta: expect.objectContaining({
        messageGuid: dmThreadPayload.data.guid,
        source: "webhook",
      }),
    }))
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

  it("treats group chat tool progress as reply commitment without sending tool-status text", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      expect(mocks.markChatRead).not.toHaveBeenCalled()
      expect(mocks.setTyping).not.toHaveBeenCalled()

      callbacks.onToolStart("query_session", {})
      await flushAsyncWork()
      await flushAsyncWork()

      expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
        text: "checking session history...",
      }))
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

    expect(toolStatusCall).toBeFalsy()
    expect(finalReplyCall).toBeTruthy()
    expect(mocks.markChatRead.mock.invocationCallOrder[0]).toBeLessThan(finalReplyCall[0].chat ? mocks.sendText.mock.invocationCallOrder[mocks.sendText.mock.calls.indexOf(finalReplyCall)] : Number.MAX_SAFE_INTEGER)
    expect(mocks.setTyping.mock.invocationCallOrder[0]).toBeLessThan(finalReplyCall[0].chat ? mocks.sendText.mock.invocationCallOrder[mocks.sendText.mock.calls.indexOf(finalReplyCall)] : Number.MAX_SAFE_INTEGER)
  })

  it("does not re-enable typing for suppressed tool status messages", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onToolStart("query_session", {})
      await flushAsyncWork()
      await flushAsyncWork()

      const typingTrueCalls = mocks.setTyping.mock.calls.filter(
        (call: any[]) => call[1] === true,
      )
      expect(typingTrueCalls).toHaveLength(1)
      expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
        text: "checking session history...",
      }))

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
    expect(lastUserMessageContent()).toBe("ari@mendelow.me: yay!")
    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      lane: "thread",
      threadId: "3E02B90F-D374-4381-BDD2-3572D3EB1195",
      defaultReplyTarget: "current_lane",
    })
    expect(mocks.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat: expect.objectContaining({
          chatGuid: "any;+;35820e69c97c459992d29a334f412979",
          displayName: "Consciousness TBD",
        }),
      }),
    )
  })

  it("runs notifyable edits but returns explicit non-agent handling for read-only state changes", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")

    const runtimeDeps = {
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any

    const editResult = await bluebubbles.handleBlueBubblesEvent(editPayload, runtimeDeps)
    const runAgentCallCount = mocks.runAgent.mock.calls.length
    const readResult = await bluebubbles.handleBlueBubblesEvent(readPayload, runtimeDeps)

    expect(editResult).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: true,
        kind: "mutation",
      }),
    )
    expect(runAgentCallCount).toBe(1)
    const editInput = mocks.handleInboundTurn.mock.calls[0][0]
    expect(editInput.continuityIngressTexts).toEqual([])
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
        mutationType: "edit",
        messageGuid: "4A4F2A85-21AD-4AC6-98A8-34B8F4D07AA9",
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

  it("carries mutation repair notices in the orientation frame", async () => {
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      repairNotice: "BlueBubbles mutation repair failed: stale reaction target",
    }))

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(editPayload, {
      recordMutation: mocks.recordMutation,
    } as any)

    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      lane: "mutation",
      repairNotice: "BlueBubbles mutation repair failed: stale reaction target",
    })
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
    expect(bluebubbles.getDiscoveredOwnHandles()).toEqual([])
  })

  it("discovers own handles from group-chat from-me echoes only", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent({
      ...groupThreadPayload,
      data: {
        ...groupThreadPayload.data,
        guid: "GROUP-FROM-ME-DISCOVERY",
        isFromMe: true,
        handle: { address: "+1 (415) 555-0000" },
      },
    })

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        notifiedAgent: false,
        reason: "from_me",
      }),
    )
    expect(bluebubbles.getDiscoveredOwnHandles()).toEqual(["+14155550000"])
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("filters group echoes whose sender matches an agent-owned handle (isFromMe missing/false)", async () => {
    // Reproduces "Slugger talking to himself" — BlueBubbles re-broadcasts the
    // agent's own group-chat outbound message back through the webhook with
    // isFromMe:false, and without a fallback identity check the agent ingests
    // it as inbound and replies to itself.
    mocks.getBlueBubblesConfig.mockReturnValueOnce({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["+14155550000"],
    })

    const groupEchoPayload = {
      ...groupThreadPayload,
      data: {
        ...groupThreadPayload.data,
        guid: "ECHO-GROUP-AAAA-BBBB-CCCC",
        isFromMe: false, // <-- the bug: BB lost the flag on echo
        handle: { address: "+1 (415) 555-0000" }, // sender is the agent itself, just normalized differently
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(groupEchoPayload)

    expect(result).toEqual(
      expect.objectContaining({ handled: true, notifiedAgent: false, reason: "from_me" }),
    )
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("does not filter a real DM when stale ownHandles contains the friend's handle", async () => {
    mocks.getBlueBubblesConfig.mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["ari@mendelow.me"],
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)

    expect(result).toEqual(expect.objectContaining({ handled: true, notifiedAgent: true }))
    expect(result.reason).not.toBe("from_me")
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalled()
  })

  it("does not filter a group message when stale ownHandles contains a known non-self friend", async () => {
    mocks.getBlueBubblesConfig.mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["ari@mendelow.me"],
    })
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      id: "ari-friend-id",
      name: "Ari",
      kind: "human",
      externalIds: [{ provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-04-28T19:51:15.766Z" }],
    })

    const payload = {
      ...groupThreadPayload,
      data: {
        ...groupThreadPayload.data,
        guid: "GROUP-KNOWN-FRIEND-NOT-SELF",
        isFromMe: false,
        handle: { address: "ari@mendelow.me" },
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(payload)

    expect(result).toEqual(expect.objectContaining({ handled: true, notifiedAgent: true }))
    expect(result.reason).not.toBe("from_me")
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_self_handle_bypassed_known_friend",
      meta: expect.objectContaining({ senderExternalId: "ari@mendelow.me", friendId: "ari-friend-id" }),
    }))
  })

  it("does not filter a group message when stale ownHandles contains a known non-self agent", async () => {
    mocks.getAgentName.mockReturnValue("slugger")
    mocks.getBlueBubblesConfig.mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["other-agent@ouro.bot"],
    })
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      id: "other-agent-id",
      name: "Other Agent",
      kind: "agent",
      agentMeta: { bundleName: "other-agent", familiarity: 1, sharedMissions: [], outcomes: [] },
      externalIds: [{ provider: "imessage-handle", externalId: "other-agent@ouro.bot", linkedAt: "2026-04-28T19:51:15.766Z" }],
    })

    const payload = {
      ...groupThreadPayload,
      data: {
        ...groupThreadPayload.data,
        guid: "GROUP-KNOWN-AGENT-NOT-SELF",
        isFromMe: false,
        handle: { address: "other-agent@ouro.bot" },
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(payload)

    expect(result).toEqual(expect.objectContaining({ handled: true, notifiedAgent: true }))
    expect(result.reason).not.toBe("from_me")
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_self_handle_bypassed_known_friend",
      meta: expect.objectContaining({ senderExternalId: "other-agent@ouro.bot", friendId: "other-agent-id" }),
    }))
  })

  it("still filters a group echo when the matching friend record is the agent itself", async () => {
    mocks.getAgentName.mockReturnValue("slugger")
    mocks.getBlueBubblesConfig.mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["slugger@ouro.bot"],
    })
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      id: "slugger-self-id",
      name: "Runtime Self",
      kind: "agent",
      agentMeta: { bundleName: "slugger", familiarity: 1, sharedMissions: [], outcomes: [] },
      externalIds: [{ provider: "imessage-handle", externalId: "slugger@ouro.bot", linkedAt: "2026-04-28T19:51:15.766Z" }],
    })

    const payload = {
      ...groupThreadPayload,
      data: {
        ...groupThreadPayload.data,
        guid: "GROUP-SELF-FRIEND-STILL-FILTERED",
        isFromMe: false,
        handle: { address: "slugger@ouro.bot" },
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(payload)

    expect(result).toEqual(expect.objectContaining({ handled: true, notifiedAgent: false, reason: "from_me" }))
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
  })

  it("keeps filtering likely group self-echoes when known-friend lookup throws", async () => {
    mocks.getBlueBubblesConfig.mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["slugger@ouro.bot"],
    })
    mocks.findByExternalId.mockRejectedValueOnce(new Error("friend store unavailable"))

    const payload = {
      ...groupThreadPayload,
      data: {
        ...groupThreadPayload.data,
        guid: "GROUP-FRIEND-LOOKUP-FAILED-FILTER",
        isFromMe: false,
        handle: { address: "slugger@ouro.bot" },
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(payload)

    expect(result).toEqual(expect.objectContaining({ handled: true, notifiedAgent: false, reason: "from_me" }))
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
  })

  it("does NOT filter when the sender is a real friend whose handle is unrelated to the agent's own handles", async () => {
    mocks.getBlueBubblesConfig.mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret-token",
      accountId: "default",
      ownHandles: ["+14155550000"],
    })

    // dmThreadPayload's sender is ari@mendelow.me — should still flow through
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmThreadPayload)
    expect(result.reason).not.toBe("from_me")
  })

  it("stops typing even when the agent turn throws before a final answer is sent", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages, callbacks) => {
      callbacks.onModelStart()
      callbacks.onError(new Error("turn blew up"), "terminal")
      throw new Error("turn blew up")
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await expect(bluebubbles.handleBlueBubblesEvent(dmThreadPayload)).rejects.toThrow("turn blew up")

    expect(mocks.setTyping).toHaveBeenNthCalledWith(1, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), true)
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.editMessage).not.toHaveBeenCalled()
    expect(mocks.setTyping).toHaveBeenNthCalledWith(2, expect.objectContaining({ chatGuid: "any;-;ari@mendelow.me" }), false)
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

  it("blocks internal meta final text when only chat identifier routing is present", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk("[surfaced from inner dialog] heartbeat check-in")
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(identifierOnlyPayload)

    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_meta_blocked",
        meta: expect.objectContaining({
          site: "flush",
          chatGuid: null,
        }),
      }),
    )
  })

  it("blocks internal meta speak flushes when only chat identifier routing is present", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk("<think>private scratch</think>")
      await callbacks.flushNow()
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(identifierOnlyPayload)

    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_meta_blocked",
        meta: expect.objectContaining({
          site: "flushNow",
          chatGuid: null,
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
      await callbacks.finish()
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
    expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
      text: "checking session history...",
    }))
    expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
      text: "\u2717 temporary",
    }))
    expect(mocks.sendText).not.toHaveBeenCalledWith(expect.objectContaining({
      text: "\u2717 fatal",
    }))
    expect(mocks.postTurnTrim).toHaveBeenCalledTimes(1)
  })

  it("formats group edits with sender-forward phrasing before handing them to the agent", async () => {
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
    await bluebubbles.handleBlueBubblesEvent({
      ...editPayload,
      data: {
        ...editPayload.data,
        handle: { address: "casey@example.test", service: "iMessage" },
        chats: groupReactionPayload.data.chats,
      },
    })

    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "casey@example.test edited message: edited version",
        }),
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

    expect(lastUserMessageContent()).toBe("[audio attachment: Audio Message.mp3]")
    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      repairNotice: "BlueBubbles repair failed: network down",
    })
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

    expect(lastUserMessageContent()).toEqual([
      {
        type: "text",
        text: "[image attachment: IMG_5045.heic.jpeg (600x800)]",
      },
      {
        type: "image_url",
        image_url: {
          url: "data:image/jpeg;base64,aGVsbG8=",
          detail: "auto",
        },
      },
    ])
    expect(firstRunAgentOptions().orientationFrame.source).toMatchObject({
      lane: "top_level",
      defaultReplyTarget: "top_level",
    })
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

  it("covers friend-identity fallbacks for group identifiers, sender fallback, and observed DM identity", async () => {
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
    await bluebubbles.handleBlueBubblesEvent({
      ...dmThreadPayload,
      data: {
        ...dmThreadPayload.data,
        guid: "group-ident-input",
        handle: { address: "sender-a", service: "iMessage" },
      },
    })

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
    await bluebubbles.handleBlueBubblesEvent({
      ...dmThreadPayload,
      data: {
        ...dmThreadPayload.data,
        guid: "group-sender-input",
        handle: { address: "sender-only", service: "iMessage" },
      },
    })

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
    await bluebubbles.handleBlueBubblesEvent({
      ...dmThreadPayload,
      data: {
        ...dmThreadPayload.data,
        guid: "dm-raw-input",
        handle: { id: "raw-dm-id" },
      },
    })

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
        displayName: "raw-dm-id",
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
    expect(authorizedRes.getBody()).toContain("\"queued\":true")
    await waitFor(() => mocks.runAgent.mock.calls.length === 1)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
  })

  it("durably captures valid webhook messages and responds before slow turn handling completes", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const deferred = createDeferred()
    mocks.runAgent.mockImplementationOnce(() => deferred.promise)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      dmThreadPayload,
    )
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(res.getBody()).toContain("\"queued\":true")
    const { listRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(listRecordedBlueBubblesInbound("testagent")).toEqual([
      expect.objectContaining({
        messageGuid: expect.any(String),
        source: "webhook",
      }),
    ])
    expect(mocks.runAgent).toHaveBeenCalledTimes(0)

    await waitFor(() => mocks.runAgent.mock.calls.length === 1)
    deferred.resolve(undefined)
    await flushAsyncWork()
  })

  it("acks from-me webhook messages without capturing inbound sidecars", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", fromMePayload)
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(res.getBody()).toContain("\"kind\":\"message\"")
    expect(res.getBody()).toContain("\"queued\":true")
    const { listRecordedBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    expect(listRecordedBlueBubblesInbound("testagent")).toEqual([])
    await waitFor(() => mocks.emitNervesEvent.mock.calls.some(
      (call: unknown[]) => (call[0] as { event?: string })?.event === "senses.bluebubbles_from_me_ignored",
    ))
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("durably records webhook mutations before acknowledging", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler({
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any)

    const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", readPayload)
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(res.getBody()).toContain("\"kind\":\"mutation\"")
    expect(res.getBody()).toContain("\"queued\":true")
    expect(mocks.recordMutation).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        kind: "mutation",
        mutationType: "read",
        messageGuid: "174D57C8-5985-4528-8539-E4DBD777FE59",
      }),
    )
    await flushAsyncWork()
  })

  it("keeps webhook mutation ACKs durable when sidecar recording fails", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    mocks.recordMutation.mockImplementationOnce(() => {
      throw new Error("webhook mutation disk full")
    })
    const handler = bluebubbles.createBlueBubblesWebhookHandler({
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any)

    const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", readPayload)
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(res.getBody()).toContain("\"queued\":true")
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "senses.bluebubbles_mutation_log_error",
        meta: expect.objectContaining({
          messageGuid: "174D57C8-5985-4528-8539-E4DBD777FE59",
          mutationType: "read",
          reason: "webhook mutation disk full",
        }),
      }),
    )
    await flushAsyncWork()
  })

  it("records string-thrown webhook mutation sidecar failures", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    mocks.recordMutation.mockImplementationOnce(() => {
      throw "webhook mutation disk offline"
    })
    const handler = bluebubbles.createBlueBubblesWebhookHandler({
      getAgentName: () => "testagent",
      recordMutation: mocks.recordMutation,
    } as any)

    const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", readPayload)
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "senses.bluebubbles_mutation_log_error",
        meta: expect.objectContaining({
          reason: "webhook mutation disk offline",
        }),
      }),
    )
    await flushAsyncWork()
  })

  it("logs asynchronous webhook processing failures after durable ACK", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    mocks.repairEvent.mockRejectedValueOnce(new Error("async repair blew up"))
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", dmThreadPayload)
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    await waitFor(() => mocks.emitNervesEvent.mock.calls.some(
      (call: unknown[]) => (call[0] as { event?: string; meta?: { reason?: string } })?.event === "senses.bluebubbles_webhook_async_error"
        && (call[0] as { meta?: { reason?: string } }).meta?.reason === "async repair blew up",
    ))
  })

  it("logs string-thrown asynchronous webhook processing failures after durable ACK", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    mocks.repairEvent.mockRejectedValueOnce("async repair string blew up")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", dmThreadPayload)
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    await waitFor(() => mocks.emitNervesEvent.mock.calls.some(
      (call: unknown[]) => (call[0] as { event?: string; meta?: { reason?: string } })?.event === "senses.bluebubbles_webhook_async_error"
        && (call[0] as { meta?: { reason?: string } }).meta?.reason === "async repair string blew up",
    ))
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

    const malformedPayloadReq = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      {
        type: "new-message",
        data: {
          text: "missing guid",
        },
      },
    )
    const malformedPayloadRes = createMockResponse()
    await handler(malformedPayloadReq as any, malformedPayloadRes.res as any)
    await malformedPayloadRes.done
    expect(malformedPayloadRes.res.statusCode).toBe(500)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        event: "senses.bluebubbles_webhook_error",
        meta: expect.objectContaining({
          reason: "BlueBubbles payload is missing data.guid",
        }),
      }),
    )

    mocks.repairEvent.mockRejectedValueOnce(new Error("repair blew up"))
    const boomReq = createMockRequest("POST", "/bluebubbles-webhook?password=secret-token", dmThreadPayload)
    const boomRes = createMockResponse()
    await handler(boomReq as any, boomRes.res as any)
    await boomRes.done
    expect(boomRes.res.statusCode).toBe(200)
    expect(boomRes.getBody()).toContain("\"queued\":true")
    await waitFor(() => mocks.emitNervesEvent.mock.calls.some(
      (call: unknown[]) => (call[0] as { event?: string; meta?: { reason?: string } })?.event === "senses.bluebubbles_webhook_async_error"
        && (call[0] as { meta?: { reason?: string } }).meta?.reason === "repair blew up",
    ))

    mocks.repairEvent.mockRejectedValueOnce("repair string blew up")
    const stringBoomReq = createMockRequest("POST", "/bluebubbles-webhook", dmThreadPayload)
    const stringBoomRes = createMockResponse()
    await handler(stringBoomReq as any, stringBoomRes.res as any)
    await stringBoomRes.done
    expect(stringBoomRes.res.statusCode).toBe(200)
    expect(stringBoomRes.getBody()).toContain("\"queued\":true")
    await waitFor(() => mocks.emitNervesEvent.mock.calls.some(
      (call: unknown[]) => (call[0] as { event?: string; meta?: { reason?: string } })?.event === "senses.bluebubbles_webhook_async_error"
        && (call[0] as { meta?: { reason?: string } }).meta?.reason === "repair string blew up",
    ))
  })

  it("publishes the semantic capture before acknowledging a valid webhook", async () => {
    const order: string[] = []
    mocks.writeSemanticCapture.mockImplementationOnce(() => {
      order.push("capture")
      return "semantic_capture_published"
    })
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()
    const payload = {
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        handle: { address: "casey@example.test", service: "iMessage" },
      },
    }
    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      payload,
    )
    const res = createMockResponse(() => order.push("ack"))

    await handler(req as any, res.res as any)
    await res.done
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushAsyncWork()

    expect(order.slice(0, 2)).toEqual(["capture", "ack"])
    expect(res.res.statusCode).toBe(200)
    expect(mocks.writeSemanticCapture).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        schemaVersion: 1,
        event: expect.objectContaining({
          kind: "message",
          eventGuid: "b20d4e2b-2e6e-48b5-95cd-6e24a368e4a7",
          actor: expect.objectContaining({ externalId: "casey@example.test" }),
        }),
      }),
    )
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
  })

  it("returns the exact retryable response and starts no work when semantic capture fails", async () => {
    mocks.writeSemanticCapture.mockImplementationOnce(() => {
      throw new Error("semantic_capture_failed")
    })
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()
    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      dmTopLevelPayload,
    )
    const res = createMockResponse()

    await handler(req as any, res.res as any)
    await res.done
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushAsyncWork()

    expect(res.res.statusCode).toBe(503)
    expect(res.getHeader("content-type")).toBe("application/json")
    expect(res.getBody()).toBe('{"ok":false,"error":"semantic_capture_failed"}')
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()
  })

  it("returns the exact retryable response for a mutation identity collision", async () => {
    mocks.writeSemanticCapture.mockReturnValueOnce("semantic_identity_collision")
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()
    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      reactionPayload,
    )
    const res = createMockResponse()

    await handler(req as any, res.res as any)
    await res.done
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flushAsyncWork()

    expect(res.res.statusCode).toBe(503)
    expect(res.getHeader("content-type")).toBe("application/json")
    expect(res.getBody()).toBe('{"ok":false,"error":"semantic_capture_failed"}')
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.recordMutation).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()
  })

  it("claims a durable semantic capture before repair and writes handled before release", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const order: string[] = []
    let publishedCapture: { canonicalKey: string; keyHash: string } | null = null
    mocks.writeSemanticCapture.mockImplementationOnce((_agentName: string, capture: any) => {
      order.push("capture")
      publishedCapture = capture
      return "semantic_capture_published"
    })
    const defaultAcquire = mocks.acquireSemanticClaim.getMockImplementation()!
    let acquiredLease: unknown
    mocks.acquireSemanticClaim.mockImplementationOnce(async (...args: any[]) => {
      order.push("claim")
      acquiredLease = await defaultAcquire(...args)
      return acquiredLease
    })
    mocks.repairEvent.mockImplementationOnce(async (event: unknown) => {
      order.push("repair")
      return event
    })
    const defaultHandle = mocks.handleInboundTurn.getMockImplementation()!
    mocks.handleInboundTurn.mockImplementationOnce(async (...args: any[]) => {
      order.push("handle")
      return defaultHandle(...args)
    })
    mocks.writeSemanticHandled.mockImplementationOnce(() => {
      order.push("handled")
      return "semantic_handled_published"
    })
    mocks.releaseSemanticClaim.mockImplementationOnce(() => {
      order.push("release")
      return true
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(order).toEqual(["capture", "claim", "repair", "handle", "handled", "release"])
    expect(publishedCapture).not.toBeNull()
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledWith("testagent", {
      canonicalKey: publishedCapture!.canonicalKey,
      keyHash: publishedCapture!.keyHash,
    })
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        schemaVersion: 1,
        canonicalKey: publishedCapture!.canonicalKey,
        keyHash: publishedCapture!.keyHash,
        outcome: "message_completed",
        detailCode: null,
      }),
    )
    expect(mocks.releaseSemanticClaim).toHaveBeenCalledWith("testagent", acquiredLease)
  })

  it("leaves a timed-out semantic claim pending without repair or handling", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    let publishedCapture: { canonicalKey: string; keyHash: string } | null = null
    mocks.writeSemanticCapture.mockImplementationOnce((_agentName: string, capture: any) => {
      publishedCapture = capture
      return "semantic_capture_published"
    })
    mocks.acquireSemanticClaim.mockResolvedValueOnce({
      status: "timeout",
      code: "semantic_claim_timeout",
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result).toEqual({
      handled: false,
      notifiedAgent: false,
      kind: "message",
      reason: "semantic_claim_timeout",
    })
    expect(publishedCapture).not.toBeNull()
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledWith("testagent", {
      canonicalKey: publishedCapture!.canonicalKey,
      keyHash: publishedCapture!.keyHash,
    })
    expect(mocks.writeSemanticCapture).toHaveBeenCalledTimes(1)
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()
    expect(mocks.releaseSemanticClaim).not.toHaveBeenCalled()
  })

  it("recovers after restart when the webhook process stops after capture and before claim", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const capture = await makeStoredSemanticCapture()
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()
    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      dmTopLevelPayload,
    )
    const res = createMockResponse()

    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(mocks.writeSemanticCapture).toHaveBeenCalledTimes(1)
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    vi.clearAllTimers()
    vi.useRealTimers()

    mocks.listPendingSemanticCaptures.mockReturnValue([capture])
    vi.resetModules()
    const restarted = await import("../../../senses/bluebubbles")
    const result = await restarted.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0 })
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledTimes(1)
    expect(mocks.repairEvent).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
  })

  it("reaps an unreleased claim after process death and recovers exactly once across fresh runtimes", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const capture = await makeStoredSemanticCapture()
    mocks.listPendingSemanticCaptures.mockReturnValue([capture])
    const defaultAcquire = mocks.acquireSemanticClaim.getMockImplementation()!
    let handledRecord: any = null
    mocks.acquireSemanticClaim.mockImplementation(async (...args: any[]) => (
      handledRecord
        ? { status: "already_handled", record: handledRecord }
        : defaultAcquire(...args)
    ))
    mocks.writeSemanticHandled.mockImplementation((_agentName: string, record: any) => {
      handledRecord = record
      return "semantic_handled_published"
    })
    mocks.repairEvent.mockRejectedValueOnce(new Error("worker crashed after claim"))
    mocks.releaseSemanticClaim.mockImplementationOnce(() => {
      throw new Error("process terminated before claim release")
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await expect(bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload))
      .rejects.toThrow("process terminated before claim release")
    expect(mocks.releaseSemanticClaim).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()

    // The real store reaps this lease from PID/boot/process-start evidence.
    // Clearing only the mock's process-local view models the fresh runtime.
    mocks.semanticClaims.clear()
    vi.resetModules()
    const restarted = await import("../../../senses/bluebubbles")
    const recovered = await restarted.recoverCapturedBlueBubblesInboundMessages()

    vi.resetModules()
    const restartedAgain = await import("../../../senses/bluebubbles")
    const duplicate = await restartedAgain.recoverCapturedBlueBubblesInboundMessages()

    expect(recovered).toEqual({ recovered: 1, skipped: 0, failed: 0 })
    expect(duplicate).toEqual({ recovered: 0, skipped: 1, failed: 0 })
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledTimes(3)
    expect(mocks.repairEvent).toHaveBeenCalledTimes(2)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
    expect(mocks.releaseSemanticClaim).toHaveBeenCalledTimes(2)
  })

  it("collapses repeated new/new/updated reaction aliases onto one handled semantic turn", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const handledKeys = new Set<string>()
    const leases = new Map<string, unknown>()
    mocks.acquireSemanticClaim.mockImplementation(async (
      _agentName: string,
      identity: { canonicalKey: string; keyHash: string },
    ) => {
      if (handledKeys.has(identity.keyHash)) {
        return {
          status: "already_handled",
          record: expect.objectContaining({ keyHash: identity.keyHash }),
        }
      }
      const lease = {
        status: "acquired",
        record: {
          schemaVersion: 1,
          canonicalKey: identity.canonicalKey,
          keyHash: identity.keyHash,
          owner: {
            operationId: `semantic-handle:${identity.keyHash}`,
            pid: 4242,
            bootIdentity: "test-boot",
            processStartedAt: "test-process",
            acquiredAt: "2026-07-30T18:00:00.000Z",
          },
        },
      }
      leases.set(identity.keyHash, lease)
      return lease
    })
    mocks.writeSemanticHandled.mockImplementation((
      _agentName: string,
      record: { keyHash: string },
    ) => {
      handledKeys.add(record.keyHash)
      return "semantic_handled_published"
    })
    const updatedAlias = { ...reactionPayload, type: "updated-message" }

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(reactionPayload)
    await bluebubbles.handleBlueBubblesEvent(reactionPayload)
    await bluebubbles.handleBlueBubblesEvent(updatedAlias)

    const captures = mocks.writeSemanticCapture.mock.calls.map((call: unknown[]) => call[1] as {
      canonicalKey: string
      keyHash: string
    })
    expect(new Set(captures.map((capture) => capture.keyHash)).size).toBe(1)
    expect(mocks.writeSemanticCapture).toHaveBeenCalledTimes(3)
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledTimes(3)
    const capturedIdentity = {
      canonicalKey: captures[0]!.canonicalKey,
      keyHash: captures[0]!.keyHash,
    }
    expect(mocks.acquireSemanticClaim.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      capturedIdentity,
      capturedIdentity,
      capturedIdentity,
    ])
    expect(leases.size).toBe(1)
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        ...capturedIdentity,
        outcome: "capture_only_positive",
      }),
    )
  })

  it("keeps pre-v1 inbound and group mutation rows audit-only without synthesizing an actor", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const { normalizeBlueBubblesEvent } = await import("../../../senses/bluebubbles/model")
    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesInbound(
      "testagent",
      normalizeBlueBubblesEvent(groupThreadPayload) as any,
      "webhook",
    )
    recordBlueBubblesMutation("testagent", normalizeBlueBubblesEvent({
      ...readPayload,
      data: {
        ...readPayload.data,
        chats: groupThreadPayload.data.chats,
      },
    }) as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const captured = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()
    const mutations = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(captured.recovered).toBe(0)
    expect(mutations.recovered).toBe(0)
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_legacy_recovery_blocked",
      meta: expect.objectContaining({
        schemaVersion: 0,
        actorPresent: false,
        reason: "legacy_or_actorless",
      }),
    }))
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
          chatGuid: "any;-;casey@example.test",
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

  it("returns an explicit ignored result for guidless BlueBubbles state events", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent({
      type: "chat-read-status-changed",
      data: {
        chatGuid: "any;-;ari@mendelow.me",
      },
    })

    expect(result).toEqual({
      handled: true,
      notifiedAgent: false,
      reason: "ignored",
    })
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_event_skipped",
        meta: expect.objectContaining({
          eventType: "chat-read-status-changed",
        }),
      }),
    )
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

  it("repairs and handles a captured v1 message once during recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const capture = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "missed-message-guid",
        text: "you there?",
      },
    })
    mocks.listPendingSemanticCaptures.mockReturnValue([capture])
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
    const first = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(first).toEqual(expect.objectContaining({ recovered: 1, failed: 0 }))
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

  it("keeps pre-v1 backlog mutations audit-only instead of hydrating them", async () => {
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

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, pending: 0, failed: 0 }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_legacy_recovery_blocked",
        meta: expect.objectContaining({ actorPresent: false }),
      }),
    )
  })

  it("does not invoke repair for a broken pre-v1 backlog row", async () => {
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

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, pending: 0, failed: 0 }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_legacy_recovery_blocked",
        meta: expect.objectContaining({ actorPresent: false }),
      }),
    )
  })

  it("does not start timeout-prone turns for pre-v1 backlog rows", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "read",
      messageGuid: "mutation-timeout-guid",
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
      textForAgent: "message marked as read",
      requiresRepair: false,
    })
    mocks.repairEvent.mockResolvedValueOnce(makeCatchUpMessage({
      messageGuid: "mutation-timeout-guid",
      textForAgent: "mutation timeout should stay pending",
    }))
    mocks.handleInboundTurn.mockImplementationOnce(() => new Promise(() => undefined))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const recovery = bluebubbles.recoverMissedBlueBubblesMessages()
    for (let attempt = 0; attempt < 10 && mocks.handleInboundTurn.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }

    await vi.advanceTimersByTimeAsync(600_000)
    const result = await recovery

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, pending: 0, failed: 0 }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    const { getBlueBubblesProcessedLogPath, hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", "mutation-timeout-guid")).toBe(false)
    const processedLogPath = getBlueBubblesProcessedLogPath("testagent", "chat:any;-;ari@mendelow.me")
    const processedLog = fs.existsSync(processedLogPath) ? fs.readFileSync(processedLogPath, "utf-8") : ""
    expect(processedLog).not.toContain("\"messageGuid\":\"mutation-timeout-guid\"")
    const queued = await bluebubbles.recoverQueuedBlueBubblesMessages()
    expect(queued).toEqual(expect.objectContaining({ recovered: 0, failed: 0, pendingRecoveryCount: 0 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_legacy_recovery_blocked",
      meta: expect.objectContaining({ actorPresent: false }),
    }))
  })

  it("does not expose pre-v1 rows to alternate-realm timeout errors", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "read",
      messageGuid: "mutation-named-timeout-guid",
      timestamp: Date.parse("2026-03-11T18:17:45.000Z"),
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
    mocks.repairEvent.mockResolvedValueOnce(makeCatchUpMessage({
      messageGuid: "mutation-named-timeout-guid",
      textForAgent: "named timeout should stay pending",
    }))
    const timeoutError = new Error("bluebubbles recovery turn timed out after 600000ms")
    timeoutError.name = "BlueBubblesRecoveryTurnTimeoutError"
    mocks.handleInboundTurn.mockRejectedValueOnce(timeoutError)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, pending: 0, failed: 0 }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    const { getBlueBubblesProcessedLogPath, hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", "mutation-named-timeout-guid")).toBe(false)
    const processedLogPath = getBlueBubblesProcessedLogPath("testagent", "chat:any;-;ari@mendelow.me")
    const processedLog = fs.existsSync(processedLogPath) ? fs.readFileSync(processedLogPath, "utf-8") : ""
    expect(processedLog).not.toContain("\"messageGuid\":\"mutation-named-timeout-guid\"")
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_legacy_recovery_blocked",
      meta: expect.objectContaining({ actorPresent: false }),
    }))
  })

  it("does not emit a backlog recovery completion event when no recovery candidates exist", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual({ recovered: 0, skipped: 0, pending: 0, failed: 0 })
    expect(mocks.emitNervesEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_recovery_complete",
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
    const tempAgentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(tempAgentRoot)
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

  it("skips catch-up messages that are outgoing, too old, or already semantically handled", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const now = Date.now()

    const alreadyHandled = await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "already-recorded-guid",
      timestamp: now - 1_000,
    }))
    mocks.semanticHandled.set(alreadyHandled.keyHash, {
      schemaVersion: 1,
      canonicalKey: alreadyHandled.canonicalKey,
      keyHash: alreadyHandled.keyHash,
      handledAt: new Date(now).toISOString(),
      outcome: "message_completed",
      detailCode: null,
    })

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

  it("does not let a captured-but-unhandled semantic record suppress catch-up recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const now = Date.now()

    await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "captured-only-guid",
      timestamp: now - 1_000,
      textForAgent: "this was captured but never handled",
    }))

    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "captured-only-guid",
        timestamp: now - 1_000,
        textForAgent: "this was captured but never handled",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "ok",
      detail: "upstream reachable",
      lastCheckedAt: new Date(now).toISOString(),
      pendingRecoveryCount: 0,
    })

    expect(result).toEqual(expect.objectContaining({
      inspected: 1,
      recovered: 1,
      skipped: 0,
      failed: 0,
      lastRecoveredMessageGuid: "captured-only-guid",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
  })

  it("does not double-queue semantic captures when runtime sync is only discovering work", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const now = Date.now()

    await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "captured-runtime-queued-guid",
      timestamp: now - 1_000,
      textForAgent: "already queued for recovery",
    }))

    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "captured-runtime-queued-guid",
        timestamp: now - 1_000,
        textForAgent: "already queued for recovery",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "ok",
      detail: "upstream reachable",
      lastCheckedAt: new Date(now).toISOString(),
      pendingRecoveryCount: 1,
    }, { processTurns: false })

    expect(result).toEqual(expect.objectContaining({
      inspected: 1,
      recovered: 0,
      skipped: 1,
      failed: 0,
    }))
    expect(result.queued).toBeUndefined()
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
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

  it("keeps timed-out upstream catch-up turns pending after repair succeeds", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const candidate = makeCatchUpMessage({
      messageGuid: "catchup-timeout-guid",
      textForAgent: "catch-up timeout should stay pending",
    })
    mocks.listRecentMessages.mockResolvedValueOnce([candidate])
    mocks.repairEvent.mockResolvedValueOnce(candidate)
    const lateTurn = createDeferred<any>()
    mocks.handleInboundTurn.mockImplementationOnce(() => lateTurn.promise)

    const bluebubbles = await import("../../../senses/bluebubbles")
    const recovery = bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "down",
      pendingRecoveryCount: 0,
    })
    for (let attempt = 0; attempt < 10 && mocks.handleInboundTurn.mock.calls.length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }

    await vi.advanceTimersByTimeAsync(600_000)
    const result = await recovery

    expect(result).toEqual(expect.objectContaining({ inspected: 1, recovered: 0, skipped: 0, failed: 1 }))
    const { getBlueBubblesProcessedLogPath, hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", "catchup-timeout-guid")).toBe(false)
    const processedLogPath = getBlueBubblesProcessedLogPath("testagent", "chat:any;-;ari@mendelow.me")
    const processedLog = fs.existsSync(processedLogPath) ? fs.readFileSync(processedLogPath, "utf-8") : ""
    expect(processedLog).not.toContain("\"messageGuid\":\"catchup-timeout-guid\"")
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_catchup_error",
      meta: expect.objectContaining({
        messageGuid: "catchup-timeout-guid",
        reason: "bluebubbles recovery turn timed out after 600000ms",
      }),
    }))
    lateTurn.reject("late catch-up turn exploded")
    await flushAsyncWork()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_recovery_error",
      meta: expect.objectContaining({
        messageGuid: "catchup-timeout-guid",
        source: "upstream-catchup",
        reason: "late catch-up turn exploded",
      }),
    }))
  })

  it("keeps identifier-only pre-v1 backlog candidates audit-only instead of inventing routing or sender metadata", async () => {
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

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverMissedBlueBubblesMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, pending: 0, failed: 0 }))
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_legacy_recovery_blocked",
      meta: expect.objectContaining({ actorPresent: false }),
    }))
  })

  it("still recovers v1 semantic messages when the repaired agent text is empty and the session cannot dedupe by content", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "empty-fragment-guid",
        text: "",
        dateCreated: Date.parse("2026-03-11T18:17:29.000Z"),
      },
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
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 1, skipped: 0, failed: 0 }))
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
    await vi.advanceTimersByTimeAsync(1)
    await flushAsyncWork()
    expect(fs.existsSync(runtimePath)).toBe(true)
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

  it("surfaces stalled live turns in runtime state detail", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const { beginBlueBubblesActiveTurn } = await import("../../../senses/bluebubbles/active-turns")
    beginBlueBubblesActiveTurn("testagent", makeCatchUpMessage({ messageGuid: "runtime-stalled-guid" }))
    const activeTurnDir = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "active-turns")
    const activeTurnPath = path.join(activeTurnDir, fs.readdirSync(activeTurnDir)[0])
    const entry = JSON.parse(fs.readFileSync(activeTurnPath, "utf-8"))
    fs.writeFileSync(
      activeTurnPath,
      JSON.stringify({ ...entry, startedAt: new Date(Date.now() - 120_000).toISOString() }, null, 2) + "\n",
      "utf-8",
    )

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("live turn appears stalled"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "iMessage live turn appears stalled; 1 active turn(s) older than 90000ms",
        activeTurnCount: 1,
        stalledTurnCount: 1,
      }),
    )
    closableServer.close()
  })

  it("surfaces active live turns in runtime state before they reach the stall threshold", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const { beginBlueBubblesActiveTurn } = await import("../../../senses/bluebubbles/active-turns")
    beginBlueBubblesActiveTurn("testagent", makeCatchUpMessage({ messageGuid: "runtime-active-guid" }))

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("live turn(s) active"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable; 1 live turn(s) active",
        activeTurnCount: 1,
        stalledTurnCount: 0,
      }),
    )
    closableServer.close()
  })

  it("counts only unhandled v1 semantic captures as pending recovery during runtime sync", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "captured-runtime-pending-guid",
      textForAgent: "captured runtime pending",
    }))
    const handled = await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "captured-runtime-processed-guid",
      textForAgent: "captured runtime processed",
    }))
    mocks.semanticHandled.set(handled.keyHash, {
      schemaVersion: 1,
      canonicalKey: handled.canonicalKey,
      keyHash: handled.keyHash,
      handledAt: "2026-07-30T18:01:00.000Z",
      outcome: "message_completed",
      detailCode: null,
    })

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("recovery item"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable but iMessage is not caught up; 1 recovery item(s) queued",
        pendingRecoveryCount: 1,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("does not promote old captured inbound sidecars into pending or handled authority when the session advanced", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const staleCaptured = makeCatchUpMessage({
      messageGuid: "captured-superseded-guid",
      timestamp: Date.parse("2026-04-24T23:20:14.289Z"),
      textForAgent: "captured message from a stale recovery window",
    })
    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    recordBlueBubblesInbound("testagent", staleCaptured, "webhook")
    const { sanitizeKey } = await import("../../../heart/config")

    const sessionFilePath = path.join(
      tempAgentRoot,
      "state",
      "sessions",
      "friend-uuid",
      "bluebubbles",
      `${sanitizeKey(staleCaptured.chat.sessionKey)}.json`,
    )
    fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true })
    fs.writeFileSync(sessionFilePath, "{}\n", "utf-8")
    mocks.loadSession.mockImplementation((filePath: string) => {
      if (filePath !== sessionFilePath) return null
      return {
        messages: [],
        events: [
          {
            role: "assistant",
            time: { recordedAt: "2026-04-24T23:30:14.289Z" },
          },
        ],
      } as any
    })

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail === "upstream reachable")
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    const { hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", staleCaptured.chat.sessionKey, staleCaptured.messageGuid)).toBe(false)
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).not.toHaveBeenCalled()
  })

  it("does not expose old captured inbound sidecars as pending when the matching session file vanishes", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const pendingCaptured = makeCatchUpMessage({
      messageGuid: "captured-vanished-session-guid",
      timestamp: Date.parse("2026-04-24T23:20:14.289Z"),
      textForAgent: "captured message with a racy session scan",
    })
    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    recordBlueBubblesInbound("testagent", pendingCaptured, "webhook")
    const { sanitizeKey } = await import("../../../heart/config")

    const sessionFilePath = path.join(
      tempAgentRoot,
      "state",
      "sessions",
      "friend-uuid",
      "bluebubbles",
      `${sanitizeKey(pendingCaptured.chat.sessionKey)}.json`,
    )
    fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true })
    fs.symlinkSync(path.join(tempAgentRoot, "missing-session.json"), sessionFilePath)

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
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("does not expose actorless pre-v1 sidecars as pending when session activity is inconclusive", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const baseMessage = makeCatchUpMessage({
      messageGuid: "captured-unproven-base-guid",
      timestamp: Date.parse("2026-04-24T23:20:14.289Z"),
      textForAgent: "captured message without superseding proof",
    })
    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", baseMessage.chat.sessionKey)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      [
        {
          recordedAt: "2026-04-24T23:20:14.289Z",
          messageGuid: "",
          chatGuid: baseMessage.chat.chatGuid,
          chatIdentifier: baseMessage.chat.chatIdentifier,
          sessionKey: baseMessage.chat.sessionKey,
          textForAgent: "blank guid should remain pending",
          source: "webhook",
        },
        {
          recordedAt: "not-a-date",
          messageGuid: "captured-invalid-recorded-at-guid",
          chatGuid: baseMessage.chat.chatGuid,
          chatIdentifier: baseMessage.chat.chatIdentifier,
          sessionKey: baseMessage.chat.sessionKey,
          textForAgent: "invalid recordedAt should remain pending",
          source: "webhook",
        },
        {
          recordedAt: "2026-04-24T23:20:14.289Z",
          messageGuid: "captured-null-session-guid",
          chatGuid: baseMessage.chat.chatGuid,
          chatIdentifier: baseMessage.chat.chatIdentifier,
          sessionKey: baseMessage.chat.sessionKey,
          textForAgent: "missing session payload should remain pending",
          source: "webhook",
        },
        {
          recordedAt: "2026-04-24T23:20:14.289Z",
          messageGuid: "captured-old-session-activity-guid",
          chatGuid: baseMessage.chat.chatGuid,
          chatIdentifier: baseMessage.chat.chatIdentifier,
          sessionKey: baseMessage.chat.sessionKey,
          textForAgent: "old session activity should remain pending",
          source: "webhook",
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf-8",
    )
    const { sanitizeKey } = await import("../../../heart/config")
    const nullSessionPath = path.join(
      tempAgentRoot,
      "state",
      "sessions",
      "friend-null",
      "bluebubbles",
      `${sanitizeKey(baseMessage.chat.sessionKey)}.json`,
    )
    const oldActivitySessionPath = path.join(
      tempAgentRoot,
      "state",
      "sessions",
      "friend-old-activity",
      "bluebubbles",
      `${sanitizeKey(baseMessage.chat.sessionKey)}.json`,
    )
    fs.mkdirSync(path.dirname(nullSessionPath), { recursive: true })
    fs.mkdirSync(path.dirname(oldActivitySessionPath), { recursive: true })
    fs.writeFileSync(nullSessionPath, "{}\n", "utf-8")
    fs.writeFileSync(oldActivitySessionPath, "{}\n", "utf-8")
    mocks.loadSession.mockImplementation((filePath: string) => {
      if (filePath === nullSessionPath) return null
      if (filePath !== oldActivitySessionPath) return null
      return {
        messages: [],
        events: [
          {
            role: "system",
            time: { recordedAt: "2026-04-24T23:30:14.289Z" },
          },
          {
            role: "assistant",
          },
          {
            role: "assistant",
            time: { recordedAt: "not-a-date" },
          },
          {
            role: "assistant",
            time: { recordedAt: "2026-04-24T23:10:14.289Z" },
          },
        ],
      } as any
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
      }),
    )
    expect(mocks.emitNervesEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_recovery_skip",
        meta: expect.objectContaining({ dedupeReason: "session_superseded" }),
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("keeps overlapping pre-v1 capture and mutation sidecars out of the pending semantic count", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const shared = makeCatchUpMessage({
      messageGuid: "shared-captured-mutation-pending-guid",
      textForAgent: "shared pending recovery should count once",
    })
    const { recordBlueBubblesInbound } = await import("../../../senses/bluebubbles/inbound-log")
    const { recordBlueBubblesMutation } = await import("../../../senses/bluebubbles/mutation-log")
    recordBlueBubblesInbound("testagent", shared, "webhook")
    recordBlueBubblesMutation("testagent", {
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: shared.messageGuid,
      timestamp: shared.timestamp + 1,
      fromMe: false,
      sender: shared.sender,
      chat: shared.chat,
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
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("does not count semantically handled captures as pending regardless of repaired routing", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const handledInbound = await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "repaired-captured-guid",
      textForAgent: "already recovered captured message",
    }))
    const handledMutation = await queueStoredSemanticCaptureFromEvent(makeCatchUpMessage({
      messageGuid: "repaired-mutation-guid",
      textForAgent: "already recovered mutation message",
    }))
    for (const capture of [handledInbound, handledMutation]) {
      mocks.semanticHandled.set(capture.keyHash, {
        schemaVersion: 1,
        canonicalKey: capture.canonicalKey,
        keyHash: capture.keyHash,
        handledAt: "2026-07-30T18:01:00.000Z",
        outcome: "message_completed",
        detailCode: null,
      })
    }

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail === "upstream reachable")
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("keeps runtime healthy when catch-up discovery fails without pending recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    mocks.listRecentMessages.mockRejectedValueOnce("catch-up listing failed")

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
        detail: "1 message(s) unrecoverable this cycle; upstream ok",
        pendingRecoveryCount: 0,
      }),
    )
  })

  it("writes runtime error state when the BlueBubbles upstream health probe fails before backlog recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "unhealthy-message-guid", text: "pending while unhealthy" },
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

  it("settles a trust-gated message with a semantic handled receipt after its audit sidecar", async () => {
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
    const { hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", "B20D4E2B-2E6E-48B5-95CD-6E24A368E4A7")).toBe(true)
    const capture = mocks.writeSemanticCapture.mock.calls[0]?.[1]
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ keyHash: capture.keyHash, outcome: "message_observed" }),
    )
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
    const capture = mocks.writeSemanticCapture.mock.calls[0]?.[1]
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ keyHash: capture.keyHash, outcome: "edit_capture_only" }),
    )
  })

  it("does not let a legacy processed sidecar suppress a newly captured v1 semantic message", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { recordProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    recordProcessedBlueBubblesMessage("testagent", {
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
    }, "webhook", "turn-complete")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: true,
      kind: "message",
    }))
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
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
  it("skips repairEvent entirely when an updated-message semantic identity is already handled (no duplicate VLM describe)", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await makeStoredSemanticCapture(editPayload)
    mocks.semanticCaptures.set(capture.keyHash, capture)
    mocks.semanticHandled.set(capture.keyHash, {
      schemaVersion: 1,
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      handledAt: "2026-07-30T18:01:00.000Z",
      outcome: "edit_capture_only",
      detailCode: null,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(editPayload)

    expect(mocks.acquireSemanticClaim).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ canonicalKey: capture.canonicalKey, keyHash: capture.keyHash }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
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
    expect(mocks.writeSemanticCapture).toHaveBeenCalledTimes(2)
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledTimes(2)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
  })

  it("does not repair the same webhook message guid twice when duplicate deliveries race before hydrate finishes", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const releaseRepair = createDeferred<void>()
    let repairCount = 0
    mocks.repairEvent.mockImplementation(async (event: unknown) => {
      repairCount += 1
      if (repairCount === 1) {
        await releaseRepair.promise
      }
      return event
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const first = bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)
    await waitFor(() => repairCount === 1)

    const second = bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)
    await flushAsyncWork()

    expect(repairCount).toBe(1)
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()

    releaseRepair.resolve()
    const results = await Promise.all([first, second])

    expect(repairCount).toBe(1)
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(results.some((result) => result.reason === "already_processed")).toBe(true)
    expect(mocks.writeSemanticCapture).toHaveBeenCalledTimes(2)
    expect(mocks.acquireSemanticClaim).toHaveBeenCalledTimes(2)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
  })

  it("does not let a legacy processed row appearing during repair become semantic authority", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { normalizeBlueBubblesEvent } = await import("../../../senses/bluebubbles/model")
    const normalized = normalizeBlueBubblesEvent(dmTopLevelPayload)
    const { recordProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")

    mocks.repairEvent.mockImplementationOnce(async (event: unknown) => {
      recordProcessedBlueBubblesMessage("testagent", normalized, "webhook", "turn-complete")
      return event
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: true,
      kind: "message",
    }))
    expect(mocks.handleInboundTurn).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
    expect(mocks.releaseSemanticClaim).toHaveBeenCalledTimes(1)
  })

  it("recovers captured-but-unhandled v1 semantic messages", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const capture = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "captured-recovery-guid",
        text: "captured recovery",
      },
    })
    mocks.listPendingSemanticCaptures.mockReturnValue([capture])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0 })
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ keyHash: capture.keyHash, outcome: "message_completed" }),
    )
  })

  it("runs queued captured recovery shortly after startup without running inside runtime sync", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "delayed-captured-recovery-guid",
        text: "delayed captured recovery",
        dateCreated: Date.parse("2026-04-24T23:20:14.289Z"),
      },
    })

    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await flushAsyncWork()

    expect(mocks.repairEvent).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.semanticHandled.get(capture.keyHash)).toEqual(expect.objectContaining({
      keyHash: capture.keyHash,
      outcome: "message_completed",
    }))

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable",
        pendingRecoveryCount: 0,
      }),
    )
    closableServer.close()
  })

  it("keeps guidless pre-v1 captured sidecars audit-only instead of fabricating event identity", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", "chat:any;-;ari@mendelow.me")
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      `${JSON.stringify({
        recordedAt: "2026-04-24T23:20:14.289Z",
        messageGuid: "   ",
        chatGuid: "any;-;ari@mendelow.me",
        chatIdentifier: "ari@mendelow.me",
        sessionKey: "chat:any;-;ari@mendelow.me",
        textForAgent: "captured recovery without a guid",
        source: "webhook",
      })}\n`,
      "utf-8",
    )
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 1, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_legacy_recovery_blocked",
      meta: expect.objectContaining({ actorPresent: false }),
    }))
  })

  it("replays multiple v1 semantic captures in captured timestamp order", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const newer = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "captured-newer-guid",
        text: "newer captured message",
      },
    }, { capturedAt: "2026-07-30T18:01:00.000Z" })
    const older = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "captured-older-guid",
        text: "older captured message",
      },
    }, { capturedAt: "2026-07-30T18:00:00.000Z" })
    mocks.listPendingSemanticCaptures.mockReturnValue([newer, older])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 2, skipped: 0, failed: 0 })
    expect(mocks.repairEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      messageGuid: "captured-older-guid",
    }))
    expect(mocks.repairEvent.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      messageGuid: "captured-newer-guid",
    }))
  })

  it("settles duplicate v1 capture rows by semantic identity before repairing the remaining unique entry", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const duplicate = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-duplicate-guid", text: "first copy" },
    })
    const unique = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-unique-guid", text: "unique copy" },
    })
    mocks.listPendingSemanticCaptures.mockReturnValue([duplicate, duplicate, unique])

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 2, skipped: 1, failed: 0 })
    expect(mocks.repairEvent).toHaveBeenCalledTimes(2)
    expect(mocks.repairEvent.mock.calls.map((call) => call[0]?.messageGuid)).toEqual([
      "captured-duplicate-guid",
      "captured-unique-guid",
    ])
  })

  it("keeps session-key-only pre-v1 captures audit-only instead of reconstructing chat metadata", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", "chat:any;+;ari@mendelow.me")
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          recordedAt: "2026-04-24T23:24:15.289Z",
          messageGuid: "captured-chat-identifier-guid",
          sessionKey: "chat_identifier_ari@mendelow.me",
          textForAgent: "identifier fallback",
          source: "webhook",
        }),
        JSON.stringify({
          recordedAt: "not-a-timestamp",
          messageGuid: "captured-group-fallback-guid",
          sessionKey: "chat_any;+;ari@mendelow.me",
          textForAgent: "group fallback",
          source: "webhook",
        }),
      ].join("\n") + "\n",
      "utf-8",
    )
    mocks.repairEvent.mockImplementation(async (event: any) => ({
      kind: "message",
      eventType: "new-message",
      messageGuid: event.messageGuid,
      timestamp: event.timestamp,
      fromMe: false,
      sender: event.sender,
      chat: event.chat,
      text: event.textForAgent,
      textForAgent: event.textForAgent,
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    }))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 2, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
  })

  it("keeps opaque-session pre-v1 captures audit-only instead of fabricating unknown actors", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", "mystery-session")
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      `${JSON.stringify({
        recordedAt: "still-not-a-timestamp",
        messageGuid: "captured-unknown-session-guid",
        sessionKey: "mystery-session",
        textForAgent: "unknown session fallback",
        source: "webhook",
      })}\n`,
      "utf-8",
    )
    mocks.repairEvent.mockImplementation(async (event: any) => ({
      kind: "message",
      eventType: "new-message",
      messageGuid: event.messageGuid,
      timestamp: event.timestamp,
      fromMe: false,
      sender: event.sender,
      chat: event.chat,
      text: event.textForAgent,
      textForAgent: event.textForAgent,
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    }))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 1, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
  })

  it("keeps invalid-timestamp pre-v1 captures audit-only without attempting recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { getBlueBubblesInboundLogPath } = await import("../../../senses/bluebubbles/inbound-log")
    const logPath = getBlueBubblesInboundLogPath("testagent", "chat:any;-;ari@mendelow.me")
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          recordedAt: "still-not-a-date",
          messageGuid: "captured-invalid-order-first",
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          sessionKey: "chat:any;-;ari@mendelow.me",
          textForAgent: "first invalid timestamp",
          source: "webhook",
        }),
        JSON.stringify({
          recordedAt: "also-not-a-date",
          messageGuid: "captured-invalid-order-second",
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          sessionKey: "chat:any;-;ari@mendelow.me",
          textForAgent: "second invalid timestamp",
          source: "webhook",
        }),
      ].join("\n") + "\n",
      "utf-8",
    )
    mocks.repairEvent.mockImplementation(async (event: any) => ({
      kind: "message",
      eventType: "new-message",
      messageGuid: event.messageGuid,
      timestamp: event.timestamp,
      fromMe: false,
      sender: event.sender,
      chat: event.chat,
      text: event.textForAgent,
      textForAgent: event.textForAgent,
      attachments: [],
      hasPayloadData: false,
      requiresRepair: false,
    }))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 2, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
  })

  it("skips v1 semantic captures that are already handled before recovery starts", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-preprocessed-guid", text: "already handled" },
    })
    mocks.listPendingSemanticCaptures.mockReturnValue([capture])
    mocks.semanticHandled.set(capture.keyHash, {
      schemaVersion: 1,
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      handledAt: "2026-07-30T18:01:00.000Z",
      outcome: "message_completed",
      detailCode: null,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 1, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("settles a v1 message capture when repair resolves it to an audit-only event", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-mutation-guid", text: "turns into mutation" },
    })
    mocks.repairEvent.mockResolvedValueOnce({
      kind: "mutation",
      eventType: "updated-message",
      mutationType: "delivery",
      messageGuid: "captured-mutation-guid",
      timestamp: Date.parse("2026-04-24T23:21:00.289Z"),
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
      textForAgent: "delivery receipt",
      requiresRepair: false,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 1, failed: 0 })
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ keyHash: capture.keyHash, outcome: "delivery_audit_only" }),
    )
  })

  it("treats an already-handled semantic claim race as skipped before repair", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-race-guid", text: "captured race" },
    })
    mocks.listPendingSemanticCaptures.mockReturnValue([capture])
    mocks.acquireSemanticClaim.mockResolvedValueOnce({
      status: "already_handled",
      record: {
        schemaVersion: 1,
        canonicalKey: capture.canonicalKey,
        keyHash: capture.keyHash,
        handledAt: "2026-07-30T18:01:00.000Z",
        outcome: "message_completed",
        detailCode: null,
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 1, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("records captured inbound recovery failures instead of silently dropping them", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-failure-guid", text: "captured failure" },
    })
    mocks.repairEvent.mockRejectedValueOnce("capture recovery string failure")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 0, failed: 1 })
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_capture_recovery_error",
        meta: expect.objectContaining({
          messageGuid: "captured-failure-guid",
          reason: "capture recovery string failure",
        }),
      }),
    )
  })

  it("aborts captured inbound recovery turns that exceed the recovery timeout without marking them processed", async () => {
    vi.useFakeTimers()
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-timeout-guid", text: "captured timeout" },
    })
    mocks.handleInboundTurn.mockImplementationOnce(() => new Promise(() => undefined))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const recovery = bluebubbles.recoverCapturedBlueBubblesInboundMessages()
    const timeoutTurnCalls = () => mocks.handleInboundTurn.mock.calls
      .filter((call) => JSON.stringify(call[0]?.messages ?? []).includes("captured timeout"))
    for (let attempt = 0; attempt < 10 && timeoutTurnCalls().length === 0; attempt++) {
      await vi.advanceTimersByTimeAsync(0)
      await flushAsyncWork()
    }
    expect(timeoutTurnCalls()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(599_999)
    await flushAsyncWork()
    expect(mocks.emitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_turn_timeout",
    }))

    await vi.advanceTimersByTimeAsync(1)
    const result = await recovery

    expect(result).toEqual({ recovered: 0, skipped: 0, failed: 1 })
    expect(timeoutTurnCalls()[0]?.[0]?.signal.aborted).toBe(true)
    expect(mocks.semanticHandled.has(capture.keyHash)).toBe(false)
    const { getBlueBubblesProcessedLogPath, hasProcessedBlueBubblesMessage } = await import("../../../senses/bluebubbles/processed-log")
    expect(hasProcessedBlueBubblesMessage("testagent", "chat:any;-;ari@mendelow.me", "captured-timeout-guid")).toBe(false)
    const processedLogPath = getBlueBubblesProcessedLogPath("testagent", "chat:any;-;ari@mendelow.me")
    const processedLog = fs.existsSync(processedLogPath) ? fs.readFileSync(processedLogPath, "utf-8") : ""
    expect(processedLog).not.toContain("\"messageGuid\":\"captured-timeout-guid\"")
    const queued = await bluebubbles.recoverQueuedBlueBubblesMessages()
    expect(queued).toEqual(expect.objectContaining({ recovered: 1, failed: 0, pendingRecoveryCount: 0 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_turn_timeout",
        meta: expect.objectContaining({
          messageGuid: "captured-timeout-guid",
          source: "webhook",
          timeoutMs: 600_000,
        }),
      }),
    )
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_capture_recovery_error",
        meta: expect.objectContaining({
          messageGuid: "captured-timeout-guid",
          reason: "bluebubbles recovery turn timed out after 600000ms",
        }),
      }),
    )
  })

  it("writes healthy queued recovery runtime state after a successful drain", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "queued-health-ok-guid",
        text: "queued recovery should update runtime state",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverQueuedBlueBubblesMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0, pendingRecoveryCount: 0 })
    const { readBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    expect(readBlueBubblesRuntimeState("testagent")).toEqual(expect.objectContaining({
      upstreamStatus: "ok",
      detail: "upstream reachable",
      pendingRecoveryCount: 0,
      failedRecoveryCount: 0,
      lastRecoveredAt: expect.any(String),
    }))
  })

  it("preserves the previous recovery timestamp when queued recovery still has pending work", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    writeBlueBubblesRuntimeState("testagent", {
      upstreamStatus: "error",
      detail: "previous outage",
      pendingRecoveryCount: 1,
      lastRecoveredAt: "2026-04-24T22:00:00.000Z",
    })
    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "queued-still-pending-guid", text: "first pending" },
    })
    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "queued-still-pending-guid-2", text: "second pending" },
    }, { capturedAt: "2026-07-30T18:01:00.000Z" })
    mocks.acquireSemanticClaim.mockResolvedValue({
      status: "timeout",
      code: "semantic_claim_timeout",
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverQueuedBlueBubblesMessages()

    expect(result).toEqual({ recovered: 0, skipped: 0, failed: 0, pendingRecoveryCount: 2 })
    expect(readBlueBubblesRuntimeState("testagent")).toEqual(expect.objectContaining({
      upstreamStatus: "ok",
      detail: "upstream reachable but iMessage is not caught up; 2 recovery item(s) queued",
      pendingRecoveryCount: 2,
      failedRecoveryCount: 0,
      lastRecoveredAt: "2026-04-24T22:00:00.000Z",
      oldestPendingRecoveryAt: expect.any(String),
      oldestPendingRecoveryAgeMs: expect.any(Number),
    }))
  })

  it("does not rerun queued recovery for an already-handled semantic capture", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const capture = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "already-repaired-queued-guid",
        text: "already recovered under canonical identity",
      },
    })
    mocks.semanticCaptures.set(capture.keyHash, capture)
    mocks.semanticHandled.set(capture.keyHash, {
      schemaVersion: 1,
      canonicalKey: capture.canonicalKey,
      keyHash: capture.keyHash,
      handledAt: "2026-07-30T18:01:00.000Z",
      outcome: "message_completed",
      detailCode: null,
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverQueuedBlueBubblesMessages()

    expect(result).toEqual({ recovered: 0, skipped: 0, failed: 0, pendingRecoveryCount: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("keeps queued recovery runtime state truthful when the final upstream health check fails", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "queued-health-error-guid", text: "queued health error" },
    })
    mocks.checkHealth.mockRejectedValueOnce(new Error("upstream folded after recovery"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverQueuedBlueBubblesMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0, pendingRecoveryCount: 0 })
    const { readBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    expect(readBlueBubblesRuntimeState("testagent")).toEqual(expect.objectContaining({
      upstreamStatus: "error",
      detail: "upstream folded after recovery",
      pendingRecoveryCount: 0,
      failedRecoveryCount: 0,
    }))
  })

  it("preserves the previous recovery timestamp when final health fails before recovery succeeds", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    const { readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    writeBlueBubblesRuntimeState("testagent", {
      upstreamStatus: "error",
      detail: "previous outage",
      pendingRecoveryCount: 1,
      lastRecoveredAt: "2026-04-24T21:00:00.000Z",
    })
    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "queued-error-still-pending-guid",
        text: "still pending after health failure",
      },
    })
    mocks.acquireSemanticClaim.mockResolvedValue({
      status: "timeout",
      code: "semantic_claim_timeout",
    })
    mocks.checkHealth.mockRejectedValueOnce("upstream string failure after pending recovery")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverQueuedBlueBubblesMessages()

    expect(result).toEqual({ recovered: 0, skipped: 0, failed: 0, pendingRecoveryCount: 1 })
    expect(readBlueBubblesRuntimeState("testagent")).toEqual(expect.objectContaining({
      upstreamStatus: "error",
      detail: "upstream string failure after pending recovery",
      pendingRecoveryCount: 1,
      failedRecoveryCount: 0,
      lastRecoveredAt: "2026-04-24T21:00:00.000Z",
    }))
  })

  it("stringifies Error objects during captured inbound recovery failures", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "captured-error-guid", text: "captured error" },
    })
    mocks.repairEvent.mockRejectedValueOnce(new Error("capture recovery exploded"))

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 0, failed: 1 })
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_capture_recovery_error",
        meta: expect.objectContaining({
          messageGuid: "captured-error-guid",
          reason: "capture recovery exploded",
        }),
      }),
    )
  })

  it("repairs runtime cwd before replaying captured inbound recovery", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "captured-deleted-cwd-guid",
        text: "captured after cwd vanished",
      },
    })

    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0 })
    expect(mocks.recoverRuntimeCwd).toHaveBeenCalled()
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

  it("settles a v1 recovery capture when the session already contains the message text", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    mocks.loadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "you already saw this" },
      ],
    })

    const capture = await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "session-already-has-message",
        text: "you already saw this",
      },
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
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, failed: 0 }))
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ keyHash: capture.keyHash, outcome: "message_observed" }),
    )
  })

  it("records pending recovery backlog even when the BlueBubbles upstream is reachable", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "pending-runtime-sync", text: "pending runtime sync" },
    })
    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("recovery item"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable but iMessage is not caught up; 1 recovery item(s) queued",
        pendingRecoveryCount: 1,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("marks runtime healthy immediately while startup recovery is still running", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "slow-recovery-runtime-sync", text: "slow recovery" },
    })
    const listRecentMessages = createDeferred<any[]>()
    mocks.listRecentMessages.mockReturnValueOnce(listRecentMessages.promise)

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
        detail: "upstream reachable; recovery pass running",
        pendingRecoveryCount: 1,
      }),
    )
    listRecentMessages.resolve([])
    await flushAsyncWork()
    closableServer.close()
  })

  it("keeps runtime sync from hydrating backlog messages in the live HTTP worker", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "failed-runtime-sync", text: "failed runtime sync" },
    })
    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("recovery item"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable but iMessage is not caught up; 1 recovery item(s) queued",
        pendingRecoveryCount: 1,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("reports backlog recovery as queued during runtime sync instead of running the agent turn inline", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "recovered-runtime-sync", text: "queued runtime sync" },
    })
    const closableServer = createClosableServer()
    mocks.createServer.mockReturnValue(closableServer.server as any)

    const bluebubbles = await import("../../../senses/bluebubbles")
    bluebubbles.startBlueBubblesApp()
    await flushAsyncWork()
    closableServer.close()

    const runtimePath = path.join(tempAgentRoot, "state", "senses", "bluebubbles", "runtime.json")
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("recovery item"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable but iMessage is not caught up; 1 recovery item(s) queued",
        pendingRecoveryCount: 1,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("queues upstream catch-up during runtime sync without running the recovered turn inline", async () => {
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
    await waitFor(() => fs.existsSync(runtimePath)
      && JSON.parse(fs.readFileSync(runtimePath, "utf-8")).detail.includes("recovery item"))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf-8"))).toEqual(
      expect.objectContaining({
        upstreamStatus: "ok",
        detail: "upstream reachable but iMessage is not caught up; 1 recovery item(s) queued",
        pendingRecoveryCount: 1,
      }),
    )
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()

    expect(mocks.writeSemanticCapture).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        schemaVersion: 1,
        event: expect.objectContaining({ eventGuid: "runtime-catchup-guid" }),
      }),
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

  it("stringifies non-Error v1 semantic recovery failures in nerves metadata", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "string-recovery-failure", text: "string failure" },
    })
    mocks.repairEvent.mockRejectedValueOnce("string repair failure")

    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual(expect.objectContaining({ failed: 1 }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.bluebubbles_capture_recovery_error",
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
    expect(mocks.listRecentMessages).not.toHaveBeenCalled()
  })

  it("injects same-chat BlueBubbles history as ephemeral model context after trust passes", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    mocks.listRecentMessages.mockResolvedValueOnce([
      {
        ...makeCatchUpMessage({
          messageGuid: "same-guid-different-session",
          timestamp: dmTopLevelPayload.data.dateCreated - 4_000,
          textForAgent: "same chat guid despite a repaired session key",
        }),
        chat: {
          chatGuid: "any;-;ari@mendelow.me",
          chatIdentifier: "ari@mendelow.me",
          isGroup: false,
          sessionKey: "chat:repaired-session-key",
          sendTarget: { kind: "chat_guid" as const, value: "any;-;ari@mendelow.me" },
          participantHandles: [],
        },
      },
      makeCatchUpMessage({
        messageGuid: "script-report-guid",
        timestamp: dmTopLevelPayload.data.dateCreated - 3_000,
        fromMe: true,
        textForAgent: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
      }),
      makeCatchUpMessage({
        messageGuid: "ari-context-guid",
        timestamp: dmTopLevelPayload.data.dateCreated - 2_000,
        textForAgent: "slugger see the past messages in this chat lol you're missing context",
      }),
      makeCatchUpMessage({
        messageGuid: dmTopLevelPayload.data.guid,
        timestamp: dmTopLevelPayload.data.dateCreated,
        textForAgent: dmTopLevelPayload.data.text,
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    expect(mocks.listRecentMessages).toHaveBeenCalledWith({
      chatGuid: "any;-;ari@mendelow.me",
      beforeTimestamp: dmTopLevelPayload.data.dateCreated,
      limit: 40,
      offset: 0,
    })
    const modelMessages = firstRunAgentMessages()
    const contextIndex = modelMessages.findIndex((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("Untrusted bluebubbles context"))
    const userIndex = modelMessages.findIndex((message) =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes("top-level follow-up"))
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(userIndex).toBeGreaterThan(contextIndex)
    expect(modelMessages[contextIndex].content).toContain("RSVP Update -- Wedding")
    expect(modelMessages[contextIndex].content).toContain("slugger see the past messages")
    expect(modelMessages[contextIndex].content).toContain("same chat guid despite a repaired session key")
    expect(modelMessages[contextIndex].content).not.toContain("secret-token")

    const durableMessages = mocks.postTurnTrim.mock.calls[0]?.[0] ?? []
    expect(JSON.stringify(durableMessages)).not.toContain("Untrusted bluebubbles context")
    expect(JSON.stringify(durableMessages)).not.toContain("RSVP Update -- Wedding")
  })

  it("passes precomputed same-chat context packet ids to the shared pipeline options", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "script-report-guid",
        timestamp: dmTopLevelPayload.data.dateCreated - 3_000,
        fromMe: true,
        textForAgent: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    const { readSenseContextLedger } = await import("../../../senses/context-packet-ledger")
    const rows = readSenseContextLedger(agentRoot, "bluebubbles")
    expect(rows).toHaveLength(1)
    expect(firstRunAgentOptions().contextPacketIds).toEqual([rows[0].packetId])
  })

  it("builds same-chat context when the pipeline prepare hook does not provide known messages", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    mocks.handleInboundTurn.mockImplementationOnce(async (input: any) => {
      const preparedOptions = await input.prepareRunAgentOptions?.({
        currentUserMessages: input.messages,
        resolvedContext: defaultFriendContext,
        runAgentOptions: {},
      })
      return {
        resolvedContext: defaultFriendContext,
        gateResult: { allowed: true },
        usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 },
        sessionPath: "/tmp/session.json",
        messages: preparedOptions?.messages ?? [],
      }
    })
    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "script-report-guid",
        timestamp: dmTopLevelPayload.data.dateCreated - 3_000,
        fromMe: true,
        textForAgent: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    const { readSenseContextLedger } = await import("../../../senses/context-packet-ledger")
    const rows = readSenseContextLedger(agentRoot, "bluebubbles")
    expect(rows).toHaveLength(1)
    expect(mocks.handleInboundTurn.mock.results[0]).toBeDefined()
  })

  it("does not inject same-chat history already present in the provider session", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    mocks.loadSession.mockReturnValueOnce({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
        },
      ],
    })
    mocks.listRecentMessages.mockResolvedValueOnce([
      makeCatchUpMessage({
        messageGuid: "script-report-guid",
        timestamp: dmTopLevelPayload.data.dateCreated - 3_000,
        fromMe: true,
        textForAgent: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
      }),
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    const modelMessages = firstRunAgentMessages()
    expect(modelMessages.some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("Untrusted bluebubbles context")
    )).toBe(false)
    const { readSenseContextLedger } = await import("../../../senses/context-packet-ledger")
    expect(readSenseContextLedger(agentRoot, "bluebubbles")).toEqual([])
  })

  it("builds same-chat context for identifier-only chats with fallback message fields", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    const anchorTime = Date.parse("2026-03-07T22:00:00.000Z")
    const payload = {
      ...identifierOnlyPayload,
      data: {
        ...identifierOnlyPayload.data,
        guid: "IDENTIFIER-CONTEXT-ANCHOR",
        text: "identifier-only anchor",
        dateCreated: anchorTime,
      },
    }
    mocks.listRecentMessages.mockResolvedValueOnce([
      {
        kind: "message" as const,
        eventType: "new-message",
        messageGuid: "identifier-history-raw-sender",
        timestamp: anchorTime - 1_000,
        fromMe: false,
        sender: {
          provider: "imessage-handle" as const,
          externalId: "",
          rawId: "+1 (973) 508-0289",
          displayName: "",
        },
        chat: {
          chatIdentifier: "+1 (973) 508-0289",
          isGroup: false,
          sessionKey: "chat_identifier:+1_(973)_508-0289",
          sendTarget: { kind: "chat_identifier" as const, value: "+1 (973) 508-0289" },
          participantHandles: [],
        },
        text: "fallback body from raw sender",
        textForAgent: "",
        attachments: [],
        hasPayloadData: false,
        requiresRepair: false,
      },
      {
        kind: "message" as const,
        eventType: "new-message",
        messageGuid: "identifier-history-unknown-sender",
        timestamp: anchorTime - 500,
        fromMe: false,
        sender: {
          provider: "imessage-handle" as const,
          externalId: "",
          rawId: "",
          displayName: "",
        },
        chat: {
          chatIdentifier: "+1 (973) 508-0289",
          isGroup: false,
          sessionKey: "chat_identifier:+1_(973)_508-0289",
          sendTarget: { kind: "chat_identifier" as const, value: "+1 (973) 508-0289" },
          participantHandles: [],
        },
        text: "fallback body from unknown sender",
        textForAgent: "",
        attachments: [],
        hasPayloadData: false,
        requiresRepair: false,
      },
    ])

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(payload)

    expect(mocks.listRecentMessages).toHaveBeenCalledWith({
      chatIdentifier: "+1 (973) 508-0289",
      beforeTimestamp: anchorTime,
      limit: 40,
      offset: 0,
    })
    const contextMessage = firstRunAgentMessages().find((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("Untrusted bluebubbles context"))
    expect(contextMessage?.content).toContain("fallback body from raw sender")
    expect(contextMessage?.content).toContain("fallback body from unknown sender")
  })

  it("continues without same-chat context when the BlueBubbles client has no history API", async () => {
    const customClient = {
      sendText: (...args: any[]) => mocks.sendText(...args),
      editMessage: (...args: any[]) => mocks.editMessage(...args),
      setTyping: (...args: any[]) => mocks.setTyping(...args),
      markChatRead: (...args: any[]) => mocks.markChatRead(...args),
      checkHealth: (...args: any[]) => mocks.checkHealth(...args),
      repairEvent: (...args: any[]) => mocks.repairEvent(...args),
      getMessageText: (...args: any[]) => mocks.getMessageText(...args),
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload, {
      createClient: () => customClient as any,
    })

    expect(mocks.listRecentMessages).not.toHaveBeenCalled()
    expect(firstRunAgentMessages().some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("Untrusted bluebubbles context")
    )).toBe(false)
  })

  it("uses the latest same-chat packet from the private ledger when live history fetch fails", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    const { buildSenseContextPacket } = await import("../../../senses/context-packets")
    const { writeSenseContextPacket } = await import("../../../senses/context-packet-ledger")
    const chatKeyHash = sha256Hex("any;-;ari@mendelow.me")
    const packet = buildSenseContextPacket({
      agent: "testagent",
      sense: "bluebubbles",
      sessionKey: "chat:any;-;ari@mendelow.me",
      chatKeyHash,
      anchorMessageGuid: "previous-anchor",
      anchorTimestamp: "2026-03-07T22:00:00.000Z",
      windowBeforeMessages: 40,
      windowBeforeMs: 48 * 60 * 60 * 1000,
      messages: [{
        timestamp: "2026-03-07T21:59:00.000Z",
        authorLabel: "Slugger",
        body: "RSVP Update -- Wedding\n149 attending / 123 declined / 1 pending",
        sourceRef: {
          sense: "bluebubbles",
          adapter: "bluebubbles-api-v1",
          service: "imessage",
          chatGuid: "any;-;ari@mendelow.me",
          chatGuidHash: chatKeyHash,
          messageGuid: "previous-script-guid",
          senderExternalIdHash: sha256Hex("slugger@example.com"),
          observedAt: "2026-03-07T21:59:00.000Z",
        },
      }],
    })
    writeSenseContextPacket(agentRoot, packet, { now: "2026-03-07T22:00:00.000Z" })
    mocks.listRecentMessages.mockRejectedValueOnce(new Error("BlueBubbles query unavailable"))

    const payload = {
      ...dmTopLevelPayload,
      data: {
        ...dmTopLevelPayload.data,
        guid: "2E75385B-C73E-490B-B432-6845F2565D56",
        dateCreated: Date.parse("2026-03-07T22:05:00.000Z"),
      },
    }
    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(payload)

    const contextMessage = firstRunAgentMessages().find((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("Untrusted bluebubbles context"))
    expect(contextMessage?.content).toContain("RSVP Update -- Wedding")
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_context_packet_error",
    }))
  })

  it("continues without same-chat context when live history fetch fails and no fallback packet exists", async () => {
    const agentRoot = makeTempDir()
    mocks.getAgentRoot.mockReturnValue(agentRoot)
    mocks.listRecentMessages.mockRejectedValueOnce("context fail")

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)

    const modelMessages = firstRunAgentMessages()
    expect(modelMessages.some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("Untrusted bluebubbles context")
    )).toBe(false)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_context_packet_error",
      meta: expect.objectContaining({
        messageGuid: dmTopLevelPayload.data.guid,
        reason: "context fail",
      }),
    }))
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

  it("drops buffered callback text once outbound delivery is closed", async () => {
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk("this should be discarded")
      callbacks.cancelOutbound("turn_timeout")
      callbacks.onModelStart()
      callbacks.onToolStart("query_session", {})
      await callbacks.flushNow()
      callbacks.onTextChunk("this should also be discarded")
      await callbacks.flush()
      return {
        usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
      }
    })

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(identifierOnlyPayload)

    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_outbound_closed",
      meta: expect.objectContaining({ chatGuid: null, reason: "turn_timeout" }),
    }))
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

  it("skips pending messages that contain internal content", async () => {
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
      content: "heartbeat check-in: same state, nothing new",
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
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("drops pending messages whose content carries internal meta markers and deletes the file", async () => {
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
      content: "[surfaced from inner dialog] this should not be retried",
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
    expect(fs.existsSync(filePath)).toBe(false)
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_meta_blocked",
        meta: expect.objectContaining({ site: "drain" }),
      }),
    )
  })

  it("blocks pending messages with reasoning <think> tags but still sends sibling normal pending messages", async () => {
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn(),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
      hasAnyFriends: vi.fn(),
      listAll: vi.fn(),
    }

    const blockedPath = writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "<think>private reasoning leaked</think>",
      timestamp: Date.now() - 1000,
    })

    // Sleep briefly so file ordering by timestamp is stable
    const allowedPath = writePendingFile("friend-uuid-1", "session", {
      from: "testagent",
      friendId: "friend-uuid-1",
      channel: "bluebubbles",
      content: "hey friend, just checking in",
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
    expect(result.sent).toBe(1)
    expect(fs.existsSync(blockedPath)).toBe(false)
    expect(fs.existsSync(allowedPath)).toBe(false)
    expect(mocks.sendText).toHaveBeenCalledTimes(1)
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "hey friend, just checking in",
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

  it("blocks proactive send when text contains internal content (heartbeat check-in)", async () => {
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
      text: "heartbeat check-in: same state, nothing new",
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

    expect(result).toEqual({ delivered: false, reason: "internal_content_blocked" })
    expect(mocks.sendText).not.toHaveBeenCalled()
  })

  it("blocks proactive send before friend lookup when text contains internal meta markers", async () => {
    const friendStoreGet = vi.fn().mockResolvedValue(makeFriend())
    const friendStore = {
      get: friendStoreGet,
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
      text: "[surfaced from inner dialog] surfaced reflection that should not leak",
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

    expect(result).toEqual({ delivered: false, reason: "blocked_meta_content" })
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(friendStoreGet).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "senses.bluebubbles_meta_blocked",
        meta: expect.objectContaining({ site: "proactive" }),
      }),
    )
  })

  it("allows proactive send for normal prose mentioning private-runtime concepts in plain text", async () => {
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
      text: "hey, just thinking of you",
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
      text: "hey, just thinking of you",
    }))
  })
})

describe("BlueBubbles semantic lifecycle coverage", () => {
  beforeEach(() => {
    vi.resetModules()
    resetMocks()
    mocks.getAgentRoot.mockReturnValue(makeTempDir())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("allocates missing-time reaction coordinates and captures resolved agent authorship", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const getMessageDetails = vi.fn().mockResolvedValue({ text: "the prior reply", fromMe: true })
    const client = {
      sendText: mocks.sendText,
      editMessage: mocks.editMessage,
      setTyping: mocks.setTyping,
      markChatRead: mocks.markChatRead,
      checkHealth: mocks.checkHealth,
      listRecentMessages: mocks.listRecentMessages,
      repairEvent: mocks.repairEvent,
      getMessageText: mocks.getMessageText,
      getMessageDetails,
    }
    const payload = {
      ...reactionPayload,
      data: {
        ...reactionPayload.data,
        guid: "REACTION-WITHOUT-EFFECTIVE-TIME",
        dateCreated: undefined,
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    await bluebubbles.handleBlueBubblesEvent(payload, {
      createClient: () => client as any,
    })

    expect(getMessageDetails).toHaveBeenCalledWith("CB4EB152-A678-4F0E-8075-1AB09B5496F8")
    expect(mocks.allocateSemanticCoordinate).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ canonicalAction: "add" }),
    )
    expect(mocks.writeSemanticCapture).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({
        event: expect.objectContaining({
          targetAuthorship: "agent",
          effectiveAt: null,
        }),
      }),
    )
  })

  it("keeps missing-target coordinate candidates audit-only without allocating", async () => {
    const payload = {
      ...reactionPayload,
      data: {
        ...reactionPayload.data,
        guid: "REACTION-WITHOUT-TARGET-OR-EFFECTIVE-TIME",
        associatedMessageGuid: undefined,
        dateCreated: undefined,
      },
    }
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.handleBlueBubblesEvent(payload)).resolves.toEqual({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
      reason: "ignored",
    })
    expect(mocks.allocateSemanticCoordinate).not.toHaveBeenCalled()
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
  })

  it("keeps actorless current ingress audit-only in direct and webhook handling", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const actorlessPayload = {
      type: "new-message",
      data: {
        guid: "ACTORLESS-CURRENT-INGRESS",
        text: "routing metadata is not an actor",
        dateCreated: Date.now(),
        isFromMe: false,
        chats: [{ guid: "chat-guid-only", style: 45 }],
      },
    }

    const bluebubbles = await import("../../../senses/bluebubbles")
    await expect(bluebubbles.handleBlueBubblesEvent(actorlessPayload)).resolves.toEqual({
      handled: true,
      notifiedAgent: false,
      kind: "message",
      reason: "ignored",
    })

    const handler = bluebubbles.createBlueBubblesWebhookHandler()
    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      actorlessPayload,
    )
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    expect(JSON.parse(res.getBody())).toEqual({
      handled: true,
      notifiedAgent: false,
      kind: "message",
      queued: false,
      reason: "ignored",
    })
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it("returns the retryable webhook contract for non-Error semantic capture failures", async () => {
    mocks.writeSemanticCapture.mockImplementationOnce(() => {
      throw "capture disk unavailable"
    })
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()
    const req = createMockRequest(
      "POST",
      "/bluebubbles-webhook?password=secret-token",
      dmTopLevelPayload,
    )
    const res = createMockResponse()

    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(503)
    expect(res.getHeader("content-type")).toBe("application/json")
    expect(res.getBody()).toBe('{"ok":false,"error":"semantic_capture_failed"}')
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_webhook_error",
      meta: expect.objectContaining({ reason: "capture disk unavailable" }),
    }))
  })

  it("fails closed and releases ownership when handled publication collides", async () => {
    mocks.writeSemanticHandled.mockReturnValueOnce("semantic_handled_collision")
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload))
      .rejects.toThrow("semantic_handled_collision")

    expect(mocks.releaseSemanticClaim).toHaveBeenCalledTimes(1)
  })

  it("keeps actorless catch-up audit-only and leaves claim timeouts pending", async () => {
    const tempAgentRoot = makeTempDir()
    const { getAgentRoot } = await import("../../../heart/identity")
    vi.mocked(getAgentRoot).mockReturnValue(tempAgentRoot)
    const actorless = makeCatchUpMessage({
      messageGuid: "CATCHUP-ACTORLESS",
      timestamp: Date.now(),
    })
    actorless.sender.observed = false
    mocks.listRecentMessages.mockResolvedValueOnce([actorless])
    const previousState = {
      upstreamStatus: "error" as const,
      detail: "previous outage",
      lastCheckedAt: new Date().toISOString(),
      pendingRecoveryCount: 0,
    }
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.catchUpMissedBlueBubblesMessages({}, previousState)).resolves.toEqual({
      inspected: 1,
      recovered: 0,
      skipped: 1,
      failed: 0,
    })
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()

    mocks.listRecentMessages.mockResolvedValueOnce([makeCatchUpMessage({
      messageGuid: "CATCHUP-CLAIM-TIMEOUT",
      timestamp: Date.now(),
    })])
    mocks.acquireSemanticClaim.mockResolvedValueOnce({
      status: "timeout",
      code: "semantic_claim_timeout",
    })

    await expect(bluebubbles.catchUpMissedBlueBubblesMessages({}, previousState)).resolves.toEqual({
      inspected: 1,
      recovered: 0,
      skipped: 0,
      failed: 0,
    })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
  })

  it("skips pre-cutover semantic captures before claim acquisition", async () => {
    const capture = await makeStoredSemanticCapture(dmTopLevelPayload, {
      capturedAt: "2026-07-29T23:59:59.999Z",
    })
    mocks.listPendingSemanticCaptures.mockReturnValueOnce([capture])
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.recoverCapturedBlueBubblesInboundMessages()).resolves.toEqual({
      recovered: 0,
      skipped: 1,
      failed: 0,
    })
    expect(mocks.acquireSemanticClaim).not.toHaveBeenCalled()
  })

  it("keeps incomplete routing pending when repair cannot restore coordinates", async () => {
    const missingSessionBase = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "CAPTURE-MISSING-SESSION" },
    })
    const missingChatBase = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "CAPTURE-MISSING-CHAT" },
    })
    const missingGuidBase = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "CAPTURE-MISSING-EVENT-GUID" },
    })
    const opaqueSessionBase = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "CAPTURE-OPAQUE-SESSION" },
    })
    mocks.listPendingSemanticCaptures.mockReturnValueOnce([
      {
        ...missingSessionBase,
        event: { ...missingSessionBase.event, sessionKey: null },
      },
      {
        ...missingChatBase,
        event: { ...missingChatBase.event, chatGuid: null, chatIdentifier: null },
      },
      {
        ...missingGuidBase,
        event: { ...missingGuidBase.event, eventGuid: null },
      },
      {
        ...opaqueSessionBase,
        event: {
          ...opaqueSessionBase.event,
          sessionKey: "opaque-session",
          chatGuid: null,
          chatIdentifier: null,
        },
      },
    ])
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.recoverCapturedBlueBubblesInboundMessages()).resolves.toEqual({
      recovered: 0,
      skipped: 0,
      failed: 4,
    })
    expect(mocks.repairEvent).toHaveBeenCalledTimes(1)
    expect(mocks.repairEvent).toHaveBeenCalledWith(expect.objectContaining({
      messageGuid: "capture-missing-chat",
      requiresRepair: true,
    }))
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_capture_recovery_error",
      meta: expect.objectContaining({ reason: "semantic_capture_routing_invalid" }),
    }))
  })

  it("settles read and delivery captures without allowing repair to promote them into model work", async () => {
    const read = await makeStoredSemanticCapture({
      ...readPayload,
      data: { ...readPayload.data, guid: "AUDIT-READ-CANNOT-PROMOTE" },
    })
    const delivery = await makeStoredSemanticCapture({
      ...deliveryPayload,
      data: { ...deliveryPayload.data, guid: "AUDIT-DELIVERY-CANNOT-PROMOTE" },
    })
    mocks.listPendingSemanticCaptures.mockReturnValueOnce([read, delivery])
    mocks.repairEvent.mockImplementation(async (event: any) => ({
      ...makeCatchUpMessage({
        messageGuid: event.messageGuid,
        text: "repair tried to promote audit state into a message",
      }),
      requiresRepair: false,
    }))
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 0, skipped: 2, failed: 0 })
    expect(mocks.repairEvent).not.toHaveBeenCalled()
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled.mock.calls.map((call: unknown[]) => call[1].outcome)).toEqual([
      "read_audit_only",
      "delivery_audit_only",
    ])
  })

  it("repairs a captured unknown route by message guid before starting recovered work", async () => {
    const capture = await makeStoredSemanticCapture({
      type: "new-message",
      data: {
        guid: "RECOVERABLE-UNKNOWN-ROUTE",
        text: "recover me by immutable guid",
        handle: { address: "casey@example.test", service: "iMessage" },
        attachments: [],
        dateCreated: 1772946889999,
        isFromMe: false,
        chats: [{}],
      },
    })
    expect(capture.event).toEqual(expect.objectContaining({
      eventGuid: "recoverable-unknown-route",
      sessionKey: "chat_identifier:unknown",
      chatGuid: null,
      chatIdentifier: null,
    }))
    mocks.listPendingSemanticCaptures.mockReturnValueOnce([capture])
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      chat: {
        ...makeCatchUpMessage().chat,
        sessionKey: "chat:any;-;casey@example.test",
      },
      requiresRepair: false,
    }))
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0 })
    expect(mocks.repairEvent).toHaveBeenCalledWith(expect.objectContaining({
      messageGuid: "recoverable-unknown-route",
      chat: expect.objectContaining({
        sessionKey: "chat_identifier:unknown",
        chatGuid: undefined,
        chatIdentifier: undefined,
        sendTarget: { kind: "chat_identifier", value: "unknown" },
      }),
      requiresRepair: true,
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "message_completed" }),
    )
  })

  it("re-resolves the target when trusted feedback recovers without an in-memory target", async () => {
    const capture = await makeStoredSemanticCapture({
      ...reactionPayload,
      data: {
        ...reactionPayload.data,
        guid: "RECOVERED-TRUSTED-FEEDBACK",
        associatedMessageType: "dislike",
      },
    }, { targetAuthorship: "agent" })
    mocks.listPendingSemanticCaptures.mockReturnValueOnce([capture])
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.getMessageText.mockResolvedValueOnce("the recovered agent reply")
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 1, skipped: 0, failed: 0 })
    expect(mocks.getMessageText).toHaveBeenCalledWith("CB4EB152-A678-4F0E-8075-1AB09B5496F8")
    expect(mocks.runAgent.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: 'disliked a message: "the recovered agent reply"',
      }),
    ]))
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_settled" }),
    )
  })

  it("reconstructs every semantic event kind and nullable routing field before handling", async () => {
    const nullTextMessageBase = await makeStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "RECOVERED-NULL-TEXT-MESSAGE" },
    })
    const reactionBase = await makeStoredSemanticCapture({
      ...reactionPayload,
      data: { ...reactionPayload.data, guid: "RECOVERED-REACTION" },
    }, { targetAuthorship: "agent" })
    const observedReaction = await makeStoredSemanticCapture({
      ...reactionPayload,
      data: { ...reactionPayload.data, guid: "RECOVERED-OBSERVED-REACTION" },
    }, { targetAuthorship: "agent" })
    const identifierEditBase = await makeStoredSemanticCapture({
      ...editPayload,
      data: { ...editPayload.data, guid: "RECOVERED-IDENTIFIER-EDIT", revision: "revision-1" },
    })
    const nullTextEditBase = await makeStoredSemanticCapture({
      ...editPayload,
      data: { ...editPayload.data, guid: "RECOVERED-NULL-TEXT-EDIT" },
    })
    const unsend = await makeStoredSemanticCapture({
      ...unsendPayload,
      data: { ...unsendPayload.data, guid: "RECOVERED-UNSEND" },
    })
    const read = await makeStoredSemanticCapture({
      ...readPayload,
      data: { ...readPayload.data, guid: "RECOVERED-READ" },
    })
    const delivery = await makeStoredSemanticCapture({
      ...deliveryPayload,
      data: { ...deliveryPayload.data, guid: "RECOVERED-DELIVERY" },
    })
    const nullTextMessage = {
      ...nullTextMessageBase,
      event: { ...nullTextMessageBase.event, text: null, textSha256: null },
    }
    const reaction = {
      ...reactionBase,
      event: {
        ...reactionBase.event,
        actor: { ...reactionBase.event.actor, displayName: null },
        rawTransportValue: null,
      },
    }
    const identifierEdit = {
      ...identifierEditBase,
      event: {
        ...identifierEditBase.event,
        actor: {
          ...identifierEditBase.event.actor,
          externalId: "casey@example.test",
          displayName: "casey@example.test",
        },
        sessionKey: "chat_identifier:casey@example.test",
        chatGuid: null,
        chatIdentifier: "casey@example.test",
        participants: [
          { provider: "imessage-handle" as const, externalId: "casey@example.test", displayName: null },
          { provider: "imessage-handle" as const, externalId: "morgan@example.test", displayName: null },
        ],
      },
    }
    const nullTextEdit = {
      ...nullTextEditBase,
      event: {
        ...nullTextEditBase.event,
        text: null,
        textSha256: null,
        contentSha256: null,
      },
    }
    mocks.listPendingSemanticCaptures.mockReturnValueOnce([
      nullTextMessage,
      reaction,
      observedReaction,
      identifierEdit,
      nullTextEdit,
      unsend,
      read,
      delivery,
    ])
    mocks.repairEvent.mockImplementation(async (event: any) => (
      event.messageGuid === "recovered-observed-reaction"
        ? { ...event, shouldNotifyAgent: false }
        : event
    ))
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.recoverCapturedBlueBubblesInboundMessages()

    expect(result).toEqual({ recovered: 4, skipped: 4, failed: 0 })
    expect(mocks.writeSemanticHandled.mock.calls.map((call: unknown[]) => call[1].outcome)).toEqual([
      "message_completed",
      "capture_only_positive",
      "capture_only_positive",
      "edit_capture_only",
      "edit_capture_only",
      "unsend_capture_only",
      "read_audit_only",
      "delivery_audit_only",
    ])
    expect(mocks.repairEvent).toHaveBeenCalledWith(expect.objectContaining({
      messageGuid: "recovered-identifier-edit",
      chat: expect.objectContaining({
        chatGuid: undefined,
        chatIdentifier: "casey@example.test",
        isGroup: true,
        participantHandles: ["casey@example.test", "morgan@example.test"],
      }),
      sender: expect.objectContaining({ displayName: "casey@example.test" }),
      revision: "revision-1",
    }))
    expect(mocks.repairEvent).toHaveBeenCalledWith(expect.objectContaining({
      messageGuid: "recovered-null-text-edit",
      textForAgent: "edited a message",
    }))
  })

  it("uses safe timestamp fallbacks and treats lookalike timeout errors as ordinary failures", async () => {
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      timestamp: Number.NaN,
    }))
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.handleBlueBubblesEvent(dmTopLevelPayload)).resolves.toEqual(
      expect.objectContaining({ handled: true, notifiedAgent: true }),
    )

    await queueStoredSemanticCapture({
      ...dmTopLevelPayload,
      data: { ...dmTopLevelPayload.data, guid: "LOOKALIKE-TIMEOUT-CAPTURE" },
    })
    const lookalike = new Error("not the canonical timeout message")
    lookalike.name = "BlueBubblesRecoveryTurnTimeoutError"
    mocks.handleInboundTurn.mockRejectedValueOnce(lookalike)

    await expect(bluebubbles.recoverCapturedBlueBubblesInboundMessages()).resolves.toEqual({
      recovered: 0,
      skipped: 1,
      failed: 1,
    })
  })

  it("uses the current instant when a catch-up event has a non-finite timestamp", async () => {
    mocks.listRecentMessages.mockResolvedValueOnce([makeCatchUpMessage({
      messageGuid: "CATCHUP-NON-FINITE-TIMESTAMP",
      timestamp: Number.NaN,
    })])
    const bluebubbles = await import("../../../senses/bluebubbles")

    await expect(bluebubbles.catchUpMissedBlueBubblesMessages({}, {
      upstreamStatus: "error",
      detail: "previous outage",
      lastCheckedAt: new Date().toISOString(),
      pendingRecoveryCount: 0,
    })).resolves.toEqual(expect.objectContaining({
      inspected: 1,
      recovered: 1,
      skipped: 0,
      failed: 0,
      lastRecoveredMessageGuid: "CATCHUP-NON-FINITE-TIMESTAMP",
    }))
  })
})

describe("BlueBubbles reaction capture-only policy", () => {
  beforeEach(() => {
    vi.resetModules()
    resetMocks()
    mocks.getAgentRoot.mockReturnValue(makeTempDir())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function policyReactionPayload(raw: string, fromMe = false): unknown {
    return {
      ...reactionPayload,
      data: {
        ...reactionPayload.data,
        guid: `POLICY-${raw.replace(/[^a-z0-9]/gi, "-").toUpperCase()}`,
        associatedMessageType: raw,
        handle: { address: "casey@example.test", service: "iMessage" },
        isFromMe: fromMe,
      },
    }
  }

  function policyClient(targetFromMe: boolean) {
    return {
      sendText: mocks.sendText,
      editMessage: mocks.editMessage,
      setTyping: mocks.setTyping,
      markChatRead: mocks.markChatRead,
      checkHealth: mocks.checkHealth,
      listRecentMessages: mocks.listRecentMessages,
      repairEvent: mocks.repairEvent,
      getMessageText: mocks.getMessageText,
      getMessageDetails: vi.fn().mockResolvedValue({
        text: "agent-authored target",
        fromMe: targetFromMe,
      }),
    }
  }

  async function expectCaptureOnly(input: {
    raw: string
    outcome: string
    fromMe?: boolean
    targetFromMe?: boolean
    expectTrustLookup?: boolean
    payload?: unknown
    expectedActorExternalId?: string
  }): Promise<void> {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    const bluebubbles = await import("../../../senses/bluebubbles")
    const result = await bluebubbles.handleBlueBubblesEvent(
      input.payload ?? policyReactionPayload(input.raw, input.fromMe),
      input.targetFromMe === undefined
        ? {}
        : { createClient: () => policyClient(input.targetFromMe!) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
    }))
    expect(mocks.writeSemanticHandled).toHaveBeenCalledTimes(1)
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: input.outcome }),
    )
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.sessionPath).not.toHaveBeenCalled()
    expect(mocks.buildSystem).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.setTyping).not.toHaveBeenCalled()
    expect(mocks.markChatRead).not.toHaveBeenCalled()
    expect(mocks.resolveContext).not.toHaveBeenCalled()
    expect(mocks.getPendingDir).not.toHaveBeenCalled()
    expect(mocks.drainPending).not.toHaveBeenCalled()
    expect(mocks.drainDeferredReturns).not.toHaveBeenCalled()
    expect(mocks.postTurnTrim).not.toHaveBeenCalled()
    expect(mocks.deferPostTurnPersist).not.toHaveBeenCalled()
    expect(mocks.accumulateFriendTokens).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()

    const runtimeEvents = new Set([
      "senses.bluebubbles_status_batcher_created",
      "senses.bluebubbles_turn_start",
      "senses.bluebubbles_stream_start",
      "senses.bluebubbles_tool_start",
      "senses.bluebubbles_tool_end",
      "senses.bluebubbles_turn_timeout",
      "senses.bluebubbles_turn_end",
      "senses.bluebubbles_turn_error",
      "senses.bluebubbles_activity_error",
      "bluebubbles.duplicate_outward_suppressed",
    ])
    expect(mocks.emitNervesEvent.mock.calls.some(
      ([event]) => runtimeEvents.has(event.event),
    )).toBe(false)

    const { snapshotBlueBubblesActiveTurns } = await import("../../../senses/bluebubbles/active-turns")
    expect(snapshotBlueBubblesActiveTurns("testagent", 1)).toEqual({
      activeTurnCount: 0,
      stalledTurnCount: 0,
      oldestActiveTurnStartedAt: undefined,
      oldestActiveTurnAgeMs: undefined,
    })
    if (input.expectTrustLookup) {
      expect(mocks.findByExternalId).toHaveBeenCalledTimes(1)
      expect(mocks.findByExternalId).toHaveBeenCalledWith(
        "imessage-handle",
        input.expectedActorExternalId ?? "casey@example.test",
      )
    } else {
      expect(mocks.findByExternalId).not.toHaveBeenCalled()
    }
  }

  it.each([
    ["2002", "feedback"],
    ["-love", "removal"],
    ["love", "positive"],
    ["custom", "custom"],
    ["sticker", "unknown"],
  ])("gives self-authorship precedence over the %s %s route", async (raw) => {
    await expectCaptureOnly({
      raw,
      fromMe: true,
      targetFromMe: true,
      outcome: "ignored_self",
    })
  })

  it.each([
    "-love", "3000",
    "-like", "3001",
    "-dislike", "3002",
    "-laugh", "3003",
    "-emphasize", "3004",
    "-question", "3005",
    "-custom", "3006",
  ])("captures removal alias %s without starting runtime work", async (raw) => {
    await expectCaptureOnly({ raw, outcome: "capture_only_removal" })
  })

  it.each([
    "love", "2000",
    "like", "2001",
    "laugh", "2003",
    "emphasize", "2004",
  ])("captures positive alias %s without starting runtime work", async (raw) => {
    await expectCaptureOnly({ raw, outcome: "capture_only_positive" })
  })

  it.each(["custom", "2006"])(
    "captures custom alias %s without exposing it to a model turn",
    async (raw) => {
      await expectCaptureOnly({ raw, outcome: "capture_only_custom" })
      expect(mocks.writeSemanticCapture).toHaveBeenCalledWith(
        "testagent",
        expect.objectContaining({
          event: expect.objectContaining({
            canonicalValue: "custom",
            rawTransportValue: raw,
          }),
        }),
      )
    },
  )

  it.each(["sticker", "4000"])(
    "captures unknown alias %s without starting runtime work",
    async (raw) => {
      await expectCaptureOnly({ raw, outcome: "capture_only_unknown" })
    },
  )

  it.each([
    ["dislike", "unresolved", undefined],
    ["2002", "explicitly non-agent", false],
    ["question", "unresolved", undefined],
    ["2005", "explicitly non-agent", false],
  ] as const)(
    "captures feedback alias %s when target authorship is %s",
    async (raw, _label, targetFromMe) => {
      await expectCaptureOnly({
        raw,
        outcome: "capture_only_target_not_agent",
        ...(targetFromMe === undefined ? {} : { targetFromMe }),
      })
    },
  )

  it.each(["dislike", "2002", "question", "2005"])(
    "captures feedback alias %s when the observed actor is untrusted",
    async (raw) => {
      mocks.findByExternalId.mockResolvedValueOnce(null)
      await expectCaptureOnly({
        raw,
        outcome: "capture_only_untrusted_actor",
        targetFromMe: true,
        expectTrustLookup: true,
      })
    },
  )

  it.each([
    ["dislike", "acquaintance"],
    ["question", "stranger"],
  ] as const)(
    "captures %s feedback when direct lookup finds an actor with %s trust",
    async (raw, trustLevel) => {
      mocks.findByExternalId.mockResolvedValueOnce({
        ...defaultFriendContext.friend,
        trustLevel,
      })
      await expectCaptureOnly({
        raw,
        outcome: "capture_only_untrusted_actor",
        targetFromMe: true,
        expectTrustLookup: true,
      })
    },
  )

  it.each([
    new Error("friend store unavailable"),
    "friend store unavailable",
  ])("fails closed when the direct actor lookup rejects with %s", async (failure) => {
    mocks.findByExternalId.mockRejectedValueOnce(failure)
    await expectCaptureOnly({
      raw: "dislike",
      outcome: "capture_only_untrusted_actor",
      targetFromMe: true,
      expectTrustLookup: true,
    })
  })

  it("does not elevate an untrusted group actor through a trusted participant", async () => {
    const payload = policyReactionPayload("question") as typeof reactionPayload
    const groupPayload = {
      ...payload,
      data: {
        ...payload.data,
        guid: "POLICY-GROUP-PARTICIPANT-NOT-ACTOR",
        handle: {
          address: "untrusted-actor@example.com",
          service: "iMessage",
        },
        chats: [{
          guid: "any;+;synthetic-policy-group",
          style: 43,
          chatIdentifier: "synthetic-policy-group",
          displayName: "Synthetic Group",
          participants: [
            { address: "untrusted-actor@example.com" },
            { address: "trusted-participant@example.com" },
          ],
        }],
      },
    }
    mocks.findByExternalId.mockResolvedValueOnce(null)
    mocks.listAll.mockResolvedValueOnce([{
      ...defaultFriendContext.friend,
      id: "trusted-participant",
      trustLevel: "family",
      externalIds: [{ provider: "imessage-handle", externalId: "trusted-participant@example.com" }],
    }])

    await expectCaptureOnly({
      raw: "question",
      payload: groupPayload,
      outcome: "capture_only_untrusted_actor",
      targetFromMe: true,
      expectTrustLookup: true,
      expectedActorExternalId: "untrusted-actor@example.com",
    })
    expect(mocks.listAll).not.toHaveBeenCalled()
  })

  it("classifies trusted agent-targeted feedback after direct actor lookup", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk("thanks for the feedback")
      return {
        outcome: "settled",
        completion: { answer: "thanks for the feedback", intent: "complete" },
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_tokens: 0,
          total_tokens: 15,
        },
      }
    })
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("dislike"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: true,
      kind: "mutation",
    }))
    expect(mocks.findByExternalId).toHaveBeenCalledWith("imessage-handle", "casey@example.test")
    expect(firstRunAgentOptions()).toEqual(expect.objectContaining({
      isReactionSignal: true,
      restrictedReactionFeedback: true,
      orientationFrame: expect.objectContaining({ speechKind: "reaction" }),
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.sessionPath).not.toHaveBeenCalled()
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(mocks.getPendingDir).not.toHaveBeenCalled()
    expect(mocks.drainPending).not.toHaveBeenCalled()
    expect(mocks.drainDeferredReturns).not.toHaveBeenCalled()
    expect(mocks.postTurnTrim).not.toHaveBeenCalled()
    expect(mocks.deferPostTurnPersist).not.toHaveBeenCalled()
    expect(mocks.accumulateFriendTokens).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(mocks.markChatRead).not.toHaveBeenCalled()
    expect(mocks.setTyping).not.toHaveBeenCalled()
    expect(mocks.sendText).toHaveBeenCalledTimes(1)
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "thanks for the feedback",
    }))
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_settled" }),
    )
  })

  it("presents a trusted group reaction as Ari's reaction with Rachel only a participant and an agent-authored target", async () => {
    const payload = policyReactionPayload("question") as typeof reactionPayload
    const groupPayload = {
      ...payload,
      data: {
        ...payload.data,
        guid: "SYNTHETIC-GROUP-ORIENTATION-REACTION",
        handle: {
          address: "ari@example.test",
          service: "iMessage",
        },
        chats: [{
          guid: "any;+;synthetic-orientation-group",
          style: 43,
          chatIdentifier: "synthetic-orientation-group",
          displayName: "Synthetic Orientation Group",
          participants: [
            { address: "ari@example.test" },
            { address: "rachel@example.test" },
          ],
        }],
      },
    }
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      name: "Ari",
      trustLevel: "friend",
    })
    const bluebubbles = await import("../../../senses/bluebubbles")

    await bluebubbles.handleBlueBubblesEvent(
      groupPayload,
      { createClient: () => policyClient(true) as any },
    )

    const capture = mocks.writeSemanticCapture.mock.calls[0]?.[1]
    const options = firstRunAgentOptions()
    expect(options.orientationFrame).toMatchObject({
      speechKind: "reaction",
      source: {
        authority: "presentation_only",
        conversationKind: "group",
        event: {
          provider: "bluebubbles",
          kind: "reaction",
          sourceEventType: "new-message",
          fromMe: false,
        },
        actor: {
          role: "observed_actor",
          provider: "imessage-handle",
          externalId: "ari@example.test",
        },
        participants: [
          {
            role: "group_participant_only",
            provider: "imessage-handle",
            externalId: "rachel@example.test",
          },
        ],
        target: {
          messageGuid: "cb4eb152-a678-4f0e-8075-1ab09b5496f8",
          authorship: "agent",
        },
      },
    })
    expect(options.orientationFrame.source.participants).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "ari@example.test" }),
      ]),
    )
    expect(options.toolContext.currentIngressEvidence).toEqual({
      schemaVersion: 1,
      provider: "bluebubbles",
      captureKeyHash: capture.keyHash,
    })
  })

  it("records restricted provider failure without persistence, status, mutation, or a second inference", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    const providerError = new Error("provider unavailable")
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "family",
    })
    mocks.runAgent.mockResolvedValueOnce({
      outcome: "errored",
      error: providerError,
      errorClassification: "server-error",
    })
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("question"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
      reason: "restricted_feedback_failed",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(firstRunAgentOptions()).toEqual(expect.objectContaining({
      restrictedReactionFeedback: true,
    }))
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.sessionPath).not.toHaveBeenCalled()
    expect(mocks.loadSession).not.toHaveBeenCalled()
    expect(mocks.getPendingDir).not.toHaveBeenCalled()
    expect(mocks.drainPending).not.toHaveBeenCalled()
    expect(mocks.drainDeferredReturns).not.toHaveBeenCalled()
    expect(mocks.postTurnTrim).not.toHaveBeenCalled()
    expect(mocks.deferPostTurnPersist).not.toHaveBeenCalled()
    expect(mocks.accumulateFriendTokens).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(mocks.markChatRead).not.toHaveBeenCalled()
    expect(mocks.setTyping).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_failed" }),
    )
  })

  it("records a trusted restricted-inference observe as restricted_feedback_observed", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onToolStart("observe", { reason: "no reply needed" })
      callbacks.onToolEnd("observe", "reason=no reply needed", true)
      return { outcome: "observed" }
    })
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("dislike"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
      reason: "restricted_feedback_observed",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.postTurnTrim).not.toHaveBeenCalled()
    expect(mocks.deferPostTurnPersist).not.toHaveBeenCalled()
    expect(mocks.accumulateFriendTokens).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(mocks.markChatRead).not.toHaveBeenCalled()
    expect(mocks.setTyping).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_observed" }),
    )
  })

  it("records a delivered blocked settle as restricted_feedback_settled", async () => {
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "family",
    })
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk("I cannot resolve that safely.")
      return {
        outcome: "blocked",
        completion: { answer: "I cannot resolve that safely.", intent: "blocked" },
      }
    })
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("question"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: true,
      reason: "restricted_feedback_settled",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.sendText).toHaveBeenCalledWith(expect.objectContaining({
      text: "I cannot resolve that safely.",
    }))
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_settled" }),
    )
  })

  it("fails a restricted reaction closed when runAgent throws a non-Error", async () => {
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.runAgent.mockRejectedValueOnce("provider exploded")
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("dislike"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      reason: "restricted_feedback_failed",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_turn_error",
      meta: expect.objectContaining({ reason: "provider exploded" }),
    }))
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_failed" }),
    )
  })

  it("times out a stuck restricted inference without status, persistence, or delivery", async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval")
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.runAgent.mockReturnValueOnce(new Promise(() => undefined))
    const bluebubbles = await import("../../../senses/bluebubbles")

    const pending = bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("question"),
      { createClient: () => policyClient(true) as any },
    )
    for (let index = 0; index < 20 && mocks.runAgent.mock.calls.length === 0; index++) {
      await Promise.resolve()
    }
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const result = await pending

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      reason: "restricted_feedback_failed",
    }))
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.postTurnTrim).not.toHaveBeenCalled()
    expect(mocks.deferPostTurnPersist).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_failed" }),
    )
  })

  it("still runs exactly one restricted inference when repair makes trusted feedback non-notifyable", async () => {
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "family",
    })
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      shouldNotifyAgent: false,
    }))
    mocks.runAgent.mockResolvedValueOnce({ outcome: "observed" })
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("question"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
      reason: "restricted_feedback_observed",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    expect(firstRunAgentOptions()).toEqual(expect.objectContaining({
      restrictedReactionFeedback: true,
    }))
    expect(mocks.handleInboundTurn).not.toHaveBeenCalled()
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_observed" }),
    )
  })

  it("keeps captured reaction semantics when repair promotes the transport payload to a message", async () => {
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.repairEvent.mockImplementationOnce(async (event: any) => ({
      ...event,
      kind: "message",
      text: "repaired transport text",
      textForAgent: "repaired transport text",
      attachments: [],
      hasPayloadData: false,
      shouldNotifyAgent: true,
    }))
    mocks.runAgent.mockResolvedValueOnce({ outcome: "observed" })
    const bluebubbles = await import("../../../senses/bluebubbles")

    const result = await bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("question"),
      { createClient: () => policyClient(true) as any },
    )

    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      kind: "mutation",
      reason: "restricted_feedback_observed",
    }))
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    const [messages] = mocks.runAgent.mock.calls[0]
    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("questioned your message"),
      }),
    ])
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_observed" }),
    )
  })

  it("aborts restricted final delivery at the same deadline and records failure without a late send", async () => {
    vi.useFakeTimers()
    mocks.findByExternalId.mockResolvedValueOnce({
      ...defaultFriendContext.friend,
      trustLevel: "friend",
    })
    mocks.runAgent.mockImplementationOnce(async (_messages: any, callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk("deadline-bound reply")
      return {
        outcome: "settled",
        completion: { answer: "deadline-bound reply", intent: "complete" },
      }
    })
    let delivered = false
    let deliverySignal: AbortSignal | undefined
    mocks.sendText.mockImplementationOnce((params: any) => new Promise((resolve, reject) => {
      deliverySignal = params.signal
      const delayedDelivery = setTimeout(() => {
        delivered = true
        resolve({ messageGuid: "too-late" })
      }, (2 * 60_000) + 1_000)
      params.signal?.addEventListener("abort", () => {
        clearTimeout(delayedDelivery)
        reject(params.signal.reason)
      }, { once: true })
    }))
    const bluebubbles = await import("../../../senses/bluebubbles")

    const pending = bluebubbles.handleBlueBubblesEvent(
      policyReactionPayload("dislike"),
      { createClient: () => policyClient(true) as any },
    )
    for (let index = 0; index < 20 && mocks.sendText.mock.calls.length === 0; index++) {
      await Promise.resolve()
    }
    expect(mocks.sendText).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync((2 * 60_000) + 1_000)
    const result = await pending

    expect(deliverySignal).toBeInstanceOf(AbortSignal)
    expect(deliverySignal?.aborted).toBe(true)
    expect(delivered).toBe(false)
    expect(result).toEqual(expect.objectContaining({
      handled: true,
      notifiedAgent: false,
      reason: "restricted_feedback_failed",
    }))
    expect(mocks.writeSemanticHandled).toHaveBeenCalledWith(
      "testagent",
      expect.objectContaining({ outcome: "restricted_feedback_failed" }),
    )
  })
})

// ── Reaction target resolution (Unit 4) ───────────────────────────────────
describe("BlueBubbles adapter - reaction target resolution", () => {
  it("resolveReactionTarget: prefers the authorship-carrying lookup", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const getMessageDetails = vi.fn().mockResolvedValue({ text: "great idea!", fromMe: true })
    const getMessageText = vi.fn()

    const target = await bb.resolveReactionTarget({ getMessageDetails, getMessageText } as any, "target-1")

    expect(target).toEqual({ guid: "target-1", text: "great idea!", fromMe: true })
    expect(getMessageText).not.toHaveBeenCalled()
  })

  it("resolveReactionTarget: reports unknown text and authorship when the lookup returns nothing", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const getMessageDetails = vi.fn().mockResolvedValue(null)

    const target = await bb.resolveReactionTarget(
      { getMessageDetails, getMessageText: vi.fn() } as any,
      "target-2",
    )

    expect(target).toEqual({ guid: "target-2", text: null, fromMe: null })
  })

  it("resolveReactionTarget: swallows lookup rejections instead of failing the turn", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const getMessageDetails = vi.fn().mockRejectedValue(new Error("bb offline"))

    const target = await bb.resolveReactionTarget(
      { getMessageDetails, getMessageText: vi.fn() } as any,
      "target-3",
    )

    expect(target).toEqual({ guid: "target-3", text: null, fromMe: null })
  })

  it("resolveReactionTarget: falls back to text-only clients without authorship", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const getMessageText = vi.fn().mockResolvedValue("legacy client text")

    const target = await bb.resolveReactionTarget({ getMessageText } as any, "target-4")

    expect(target).toEqual({ guid: "target-4", text: "legacy client text", fromMe: null })
  })

  it("resolveReactionTarget: text-only fallback tolerates rejection", async () => {
    vi.resetModules()
    const bb = await import("../../../senses/bluebubbles")
    const getMessageText = vi.fn().mockRejectedValue(new Error("timeout"))

    const target = await bb.resolveReactionTarget({ getMessageText } as any, "target-5")

    expect(target).toEqual({ guid: "target-5", text: null, fromMe: null })
  })
})

describe("isAgentSelfHandle", () => {
  it("matches a phone number across +/space/paren formatting differences", async () => {
    const bb = await import("../../../senses/bluebubbles")
    expect(bb.isAgentSelfHandle("+1 (415) 555-0000", ["+14155550000"])).toBe(true)
    expect(bb.isAgentSelfHandle("4155550000", ["+14155550000"])).toBe(false) // missing country code = different number
    expect(bb.isAgentSelfHandle("+1-415-555-0000", ["14155550000"])).toBe(true)
  })

  it("matches an email handle case-insensitively", async () => {
    const bb = await import("../../../senses/bluebubbles")
    expect(bb.isAgentSelfHandle("Slugger@Ouro.Bot", ["slugger@ouro.bot"])).toBe(true)
    expect(bb.isAgentSelfHandle("notmine@ouro.bot", ["slugger@ouro.bot"])).toBe(false)
  })

  it("returns false for empty/missing inputs", async () => {
    const bb = await import("../../../senses/bluebubbles")
    expect(bb.isAgentSelfHandle("", ["+14155550000"])).toBe(false)
    expect(bb.isAgentSelfHandle("   ", ["+14155550000"])).toBe(false)
    expect(bb.isAgentSelfHandle(undefined, ["+14155550000"])).toBe(false)
    expect(bb.isAgentSelfHandle("+14155550000", [])).toBe(false)
  })

  it("returns false when the digit-extracted form of one side is empty/short and the raw forms differ", async () => {
    const bb = await import("../../../senses/bluebubbles")
    // Mismatched short numeric forms shouldn't match.
    expect(bb.isAgentSelfHandle("+1", ["+2"])).toBe(false)
  })

  it("treats whitespace-only entries in ownHandles as no-ops (defensive)", async () => {
    const bb = await import("../../../senses/bluebubbles")
    // getBlueBubblesConfig normally filters these out, but the helper itself
    // is robust to them.
    expect(bb.isAgentSelfHandle("slugger@ouro.bot", ["   ", "slugger@ouro.bot"])).toBe(true)
    expect(bb.isAgentSelfHandle("slugger@ouro.bot", ["   "])).toBe(false)
  })

  describe("recordDiscoveredOwnHandle", () => {
    it("captures a new handle and reports newly-added; second call with same normalized form is a no-op", async () => {
      const bb = await import("../../../senses/bluebubbles")
      bb.clearDiscoveredOwnHandles()
      expect(bb.recordDiscoveredOwnHandle("+1 (415) 555-0000")).toBe(true)
      expect(bb.getDiscoveredOwnHandles()).toEqual(["+1 (415) 555-0000"])
      expect(bb.recordDiscoveredOwnHandle("+14155550000")).toBe(false)
      expect(bb.recordDiscoveredOwnHandle("Slugger@Ouro.Bot")).toBe(true)
      expect(bb.getDiscoveredOwnHandles()).toEqual(["+1 (415) 555-0000", "Slugger@Ouro.Bot"])
    })

    it("rejects empty/whitespace inputs", async () => {
      const bb = await import("../../../senses/bluebubbles")
      bb.clearDiscoveredOwnHandles()
      expect(bb.recordDiscoveredOwnHandle("")).toBe(false)
      expect(bb.recordDiscoveredOwnHandle("   ")).toBe(false)
      expect(bb.recordDiscoveredOwnHandle(undefined)).toBe(false)
      expect(bb.getDiscoveredOwnHandles()).toEqual([])
    })

    it("isAgentSelfHandle uses discovered handles after recording — proves the auto-detection unblocks subsequent group echoes", async () => {
      const bb = await import("../../../senses/bluebubbles")
      bb.clearDiscoveredOwnHandles()
      bb.recordDiscoveredOwnHandle("+1 (415) 555-1111")
      const discovered = bb.getDiscoveredOwnHandles()
      expect(bb.isAgentSelfHandle("+14155551111", discovered)).toBe(true)
    })
  })

  it("falls through to substring/case match for non-phone non-email handles", async () => {
    const bb = await import("../../../senses/bluebubbles")
    expect(bb.isAgentSelfHandle("UID-ABC123", ["uid-abc123"])).toBe(true)
  })
})
