import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "stream"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

const mockSendDaemonCommand = vi.fn()

const mockResolveSessionId = vi.fn().mockReturnValue("session-abc-123")

vi.mock("../../../heart/daemon/session-id-resolver", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/daemon/session-id-resolver")>("../../../heart/daemon/session-id-resolver")
  return {
    ...actual,
    resolveSessionId: (...args: any[]) => mockResolveSessionId(...args),
  }
})

const mockDrainPending = vi.fn().mockReturnValue([])

vi.mock("../../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../../mind/pending")>("../../../mind/pending")
  return {
    ...actual,
    drainPending: (...args: any[]) => mockDrainPending(...args),
    getPendingDir: vi.fn().mockReturnValue("/tmp/pending"),
  }
})

// Mock socket client — send_message now routes through daemon socket
vi.mock("../../../heart/daemon/socket-client", () => ({
  sendDaemonCommand: (...args: any[]) => mockSendDaemonCommand(...args),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

// Mock agent-service (for existing tools like ask, status)
vi.mock("../../../heart/daemon/agent-service", () => ({
  handleAgentStatus: vi.fn(async () => ({ ok: true, message: "Status" })),
  handleAgentAsk: vi.fn(async () => ({ ok: true, message: "Answer" })),
  handleAgentCatchup: vi.fn(async () => ({ ok: true, message: "Catchup" })),
  handleAgentDelegate: vi.fn(async () => ({ ok: true, message: "Delegated" })),
  handleAgentGetContext: vi.fn(async () => ({ ok: true, message: "Context" })),
  handleAgentSearchMemory: vi.fn(async () => ({ ok: true, message: "Memory" })),
  handleAgentGetTask: vi.fn(async () => ({ ok: true, message: "Tasks" })),
  handleAgentCheckScope: vi.fn(async () => ({ ok: true, message: "In scope" })),
  handleAgentRequestDecision: vi.fn(async () => ({ ok: true, message: "Decision" })),
  handleAgentCheckGuidance: vi.fn(async () => ({ ok: true, message: "Guidance" })),
  handleAgentReportProgress: vi.fn(async () => ({ ok: true, message: "Recorded" })),
  handleAgentReportBlocker: vi.fn(async () => ({ ok: true, message: "Recorded" })),
  handleAgentReportComplete: vi.fn(async () => ({ ok: true, message: "Recorded" })),
}))

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// ── Helpers ────────────────────────────────────────────────────

function writeJsonRpc(stream: PassThrough, msg: Record<string, unknown>): void {
  const body = JSON.stringify(msg)
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
  stream.write(header + body)
}

function collectOutput(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    stream.on("data", (chunk) => { data += chunk.toString() })
    setTimeout(() => resolve(data), 300)
  })
}

function parseResponse(output: string): any {
  // Extract body from Content-Length framing
  const match = output.match(/Content-Length:\s*\d+\r\n\r\n(.*)/)
  if (!match) return null
  // Could be multiple responses; get the last one for the tools/call
  const parts = output.split("Content-Length:")
  const lastPart = parts[parts.length - 1]
  const bodyMatch = lastPart.match(/\d+\r\n\r\n(.*)/)
  if (!bodyMatch) return null
  return JSON.parse(bodyMatch[1])
}

// ── Tests ──────────────────────────────────────────────────────

describe("MCP send_message tool", () => {
  let stdin: PassThrough
  let stdout: PassThrough

  beforeEach(() => {
    vi.clearAllMocks()
    stdin = new PassThrough()
    stdout = new PassThrough()
    mockSendDaemonCommand.mockResolvedValue({
      ok: true,
      message: "hello from the agent",
      data: { ponderDeferred: false },
    })
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_send_message_test_start",
      message: "send_message test starting",
      meta: {},
    })
  })

  afterEach(() => {
    stdin.destroy()
    stdout.destroy()
  })

  it("send_message tool is listed in tools/list", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })

    await new Promise((r) => setTimeout(r, 100))
    const output = await outputPromise
    server.stop()

    const response = parseResponse(output)
    expect(response.result.tools.some((t: any) => t.name === "send_message")).toBe(true)
  })

  it("send_message routes through daemon socket and returns response text", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "hello agent" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    const output = await outputPromise
    server.stop()

    expect(mockSendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/test.sock",
      expect.objectContaining({
        kind: "agent.senseTurn",
        agent: "test-agent",
        channel: "mcp",
        friendId: "friend-1",
        message: "hello agent",
      }),
    )

    const response = parseResponse(output)
    expect(response.result.content[0].text).toBe("hello from the agent")
    expect(response.result.isError).toBeFalsy()
  })

  it("send_message passes through the daemon response without synthesizing a deferral", async () => {
    mockSendDaemonCommand.mockResolvedValue({
      ok: true,
      message: "i queued the deeper harness work and kept going on the live task.",
      data: { ponderDeferred: false },
    })

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "think deeply about life" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    const output = await outputPromise
    server.stop()

    const response = parseResponse(output)
    expect(response.result.content[0].text).toContain("queued the deeper harness work")
  })

  it("send_message uses resolved session ID", async () => {
    mockResolveSessionId.mockReturnValue("claude-session-456")

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "hello" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    await outputPromise
    server.stop()

    expect(mockSendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/test.sock",
      expect.objectContaining({
        kind: "agent.senseTurn",
        sessionKey: "claude-session-456",
      }),
    )
  })

  it("send_message handles daemon command errors gracefully", async () => {
    mockSendDaemonCommand.mockRejectedValue(new Error("agent exploded"))

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "hello" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    const output = await outputPromise
    server.stop()

    const response = parseResponse(output)
    expect(response.result.content[0].text).toContain("agent exploded")
    expect(response.result.isError).toBe(true)
  })

  it("multi-turn: session key is consistent across calls", async () => {
    mockResolveSessionId.mockReturnValue("persistent-session")

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    server.start()

    // Send first message
    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_message", arguments: { message: "turn 1" } },
    })
    await new Promise((r) => setTimeout(r, 150))

    // Send second message
    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "send_message", arguments: { message: "turn 2" } },
    })
    await new Promise((r) => setTimeout(r, 150))

    server.stop()

    expect(mockSendDaemonCommand).toHaveBeenCalledTimes(2)
    // Both calls should use the same session key
    const call1 = mockSendDaemonCommand.mock.calls[0][1]
    const call2 = mockSendDaemonCommand.mock.calls[1][1]
    expect(call1.sessionKey).toBe("persistent-session")
    expect(call2.sessionKey).toBe("persistent-session")
  })

  it("check_response tool is listed in tools/list", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })

    await new Promise((r) => setTimeout(r, 100))
    const output = await outputPromise
    server.stop()

    const response = parseResponse(output)
    expect(response.result.tools.some((t: any) => t.name === "check_response")).toBe(true)
  })

  it("retries send_message on transient daemon errors", async () => {
    // Use fast delays for testing
    const { _setSenseTurnRetryDelays } = await import("../../../heart/mcp/mcp-server")
    _setSenseTurnRetryDelays([10, 10, 10])

    // First call: ECONNREFUSED (daemon restarting), second call: success
    mockSendDaemonCommand
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED /tmp/ouroboros-daemon.sock"))
      .mockResolvedValueOnce({
        ok: true,
        message: "recovered after retry",
        data: { ponderDeferred: false },
      })

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "hello after restart" },
      },
    })

    await new Promise((r) => setTimeout(r, 500))
    const output = await outputPromise
    server.stop()
    _setSenseTurnRetryDelays([1000, 2000, 4000])

    expect(mockSendDaemonCommand).toHaveBeenCalledTimes(2)
    const response = parseResponse(output)
    expect(response.result.content[0].text).toBe("recovered after retry")
    expect(response.result.isError).toBeFalsy()
  })

  it("gives up after max retries on persistent daemon failure", async () => {
    const { _setSenseTurnRetryDelays } = await import("../../../heart/mcp/mcp-server")
    _setSenseTurnRetryDelays([10, 10, 10])

    mockSendDaemonCommand
      .mockRejectedValue(new Error("connect ECONNREFUSED /tmp/ouroboros-daemon.sock"))

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "this will fail" },
      },
    })

    await new Promise((r) => setTimeout(r, 500))
    const output = await outputPromise
    server.stop()
    _setSenseTurnRetryDelays([1000, 2000, 4000])

    // 1 initial + 3 retries = 4 total attempts
    expect(mockSendDaemonCommand.mock.calls.length).toBeGreaterThanOrEqual(4)

    const response = parseResponse(output)
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain("daemon is not running")
  })
})
