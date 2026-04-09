import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Readable } from "node:stream"

const mocks = vi.hoisted(() => ({
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
  emitNervesEvent: vi.fn(),
  createServer: vi.fn(),
  listen: vi.fn((_: number, cb?: () => void) => cb?.()),
}))

vi.mock("../../../heart/core", () => ({
  runAgent: vi.fn(),
  createSummarize: vi.fn(() => vi.fn()),
}))

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../../mind/prompt", () => ({
  buildSystem: vi.fn().mockResolvedValue("system prompt"),
}))

vi.mock("../../../heart/config", () => ({
  sessionPath: vi.fn().mockReturnValue("/tmp/bb-session.json"),
  getBlueBubblesConfig: (...args: any[]) => mocks.getBlueBubblesConfig(...args),
  getBlueBubblesChannelConfig: (...args: any[]) => mocks.getBlueBubblesChannelConfig(...args),
  sanitizeKey: (value: string) => value.replace(/[^a-zA-Z0-9;+.-]+/g, "_"),
}))

vi.mock("../../../mind/context", () => ({
  loadSession: vi.fn().mockReturnValue(null),
  postTurn: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock("../../../mind/friends/tokens", () => ({
  accumulateFriendTokens: vi.fn(),
}))

vi.mock("../../../mind/friends/store-file", () => ({
  FileFriendStore: vi.fn(function (this: any) {
    this.get = vi.fn()
    this.put = vi.fn()
    this.listAll = vi.fn().mockResolvedValue([])
    this.findByExternalId = vi.fn().mockResolvedValue(null)
  }),
}))

vi.mock("../../../mind/friends/resolver", () => ({
  FriendResolver: vi.fn(function (this: any) {
    this.resolve = vi.fn()
  }),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn().mockReturnValue("testagent"),
  getAgentRoot: vi.fn().mockReturnValue("/mock/agent/root"),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  resetAgentConfigCache: vi.fn(),
  loadAgentConfig: vi.fn(() => ({
    humanFacing: { provider: "anthropic", model: "test" },
    agentFacing: { provider: "anthropic", model: "test" },
  })),
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mocks.emitNervesEvent(...args),
}))

vi.mock("../../../senses/bluebubbles/client", () => ({
  createBlueBubblesClient: vi.fn(() => ({
    sendText: vi.fn().mockResolvedValue({ messageGuid: "sent-guid" }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    markChatRead: vi.fn().mockResolvedValue(undefined),
    checkHealth: vi.fn().mockResolvedValue(undefined),
    repairEvent: vi.fn(async (event: unknown) => event),
    getMessageText: vi.fn(async () => null),
    recordMutation: vi.fn(),
  })),
}))

vi.mock("node:http", () => ({
  createServer: (...args: any[]) => mocks.createServer(...args),
}))

vi.mock("../../../senses/pipeline", () => ({
  handleInboundTurn: vi.fn(),
}))

vi.mock("../../../mind/friends/channel", () => ({
  getChannelCapabilities: vi.fn(),
}))

vi.mock("../../../mind/pending", () => ({
  getPendingDir: vi.fn(),
  drainPending: vi.fn(),
  drainDeferredReturns: vi.fn(),
}))

vi.mock("../../../senses/trust-gate", () => ({
  enforceTrustGate: vi.fn(),
}))

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

describe("BlueBubbles /health endpoint", () => {
  beforeEach(() => {
    vi.resetModules()
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
    mocks.emitNervesEvent.mockReset()
    mocks.listen.mockReset().mockImplementation((_: number, cb?: () => void) => cb?.())
    mocks.createServer.mockReset().mockImplementation((handler: unknown) => ({
      listen: mocks.listen,
      close: vi.fn(),
      handler,
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("GET /health returns 200 with status ok and uptime as a non-negative number", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("GET", "/health")
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    const parsed = JSON.parse(res.getBody())
    expect(parsed.status).toBe("ok")
    expect(typeof parsed.uptime).toBe("number")
    expect(parsed.uptime).toBeGreaterThanOrEqual(0)
  })

  it("HEAD /health returns 200 with empty body", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("HEAD", "/health")
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    const parsed = JSON.parse(res.getBody())
    expect(parsed.status).toBe("ok")
    expect(typeof parsed.uptime).toBe("number")
  })

  it("POST /health returns 405 Method not allowed", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("POST", "/health")
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(405)
    const parsed = JSON.parse(res.getBody())
    expect(parsed.error).toBe("Method not allowed")
  })

  it("PUT /health returns 405 Method not allowed", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    const req = createMockRequest("PUT", "/health")
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(405)
    const parsed = JSON.parse(res.getBody())
    expect(parsed.error).toBe("Method not allowed")
  })

  it("/health does not check webhook password (no auth required)", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    // No password param in the URL -- should still succeed
    const req = createMockRequest("GET", "/health")
    const res = createMockResponse()
    await handler(req as any, res.res as any)
    await res.done

    expect(res.res.statusCode).toBe(200)
    const parsed = JSON.parse(res.getBody())
    expect(parsed.status).toBe("ok")
  })

  it("existing webhook path behavior is unchanged (regression)", async () => {
    const bluebubbles = await import("../../../senses/bluebubbles")
    const handler = bluebubbles.createBlueBubblesWebhookHandler()

    // GET to the webhook path should return 405 (not a health check)
    const getReq = createMockRequest("GET", "/bluebubbles-webhook?password=secret-token")
    const getRes = createMockResponse()
    await handler(getReq as any, getRes.res as any)
    await getRes.done
    expect(getRes.res.statusCode).toBe(405)

    // POST to unknown path should return 404
    const notFoundReq = createMockRequest("POST", "/unknown-path")
    const notFoundRes = createMockResponse()
    await handler(notFoundReq as any, notFoundRes.res as any)
    await notFoundRes.done
    expect(notFoundRes.res.statusCode).toBe(404)
  })
})
