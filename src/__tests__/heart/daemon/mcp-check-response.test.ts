import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "stream"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

const mockResolveSessionId = vi.fn().mockReturnValue("session-check-test")

vi.mock("../../../heart/daemon/session-id-resolver", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/daemon/session-id-resolver")>("../../../heart/daemon/session-id-resolver")
  return {
    ...actual,
    resolveSessionId: (...args: any[]) => mockResolveSessionId(...args),
  }
})

const mockDrainPending = vi.fn()
const mockGetPendingDir = vi.fn().mockReturnValue("/tmp/pending/mcp")

vi.mock("../../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../../mind/pending")>("../../../mind/pending")
  return {
    ...actual,
    drainPending: (...args: any[]) => mockDrainPending(...args),
    getPendingDir: (...args: any[]) => mockGetPendingDir(...args),
  }
})

vi.mock("../../../heart/daemon/socket-client", () => ({
  sendDaemonCommand: vi.fn(),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

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
  const parts = output.split("Content-Length:")
  const lastPart = parts[parts.length - 1]
  const bodyMatch = lastPart.match(/\d+\r\n\r\n(.*)/)
  if (!bodyMatch) return null
  return JSON.parse(bodyMatch[1])
}

// ── Tests ──────────────────────────────────────────────────────

describe("MCP check_response tool", () => {
  let stdin: PassThrough
  let stdout: PassThrough

  beforeEach(() => {
    vi.clearAllMocks()
    mockDrainPending.mockReturnValue([])
    stdin = new PassThrough()
    stdout = new PassThrough()
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_check_response_test_start",
      message: "check_response test starting",
      meta: {},
    })
  })

  afterEach(() => {
    stdin.destroy()
    stdout.destroy()
  })

  it("returns 'no pending messages' when queue is empty", async () => {
    const { createMcpServer } = await import("../../../heart/daemon/mcp-server")
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
      params: { name: "check_response", arguments: {} },
    })

    await new Promise((r) => setTimeout(r, 200))
    const output = await outputPromise
    server.stop()

    const response = parseResponse(output)
    expect(response.result.content[0].text).toBe("no pending messages")
    expect(response.result.isError).toBeFalsy()
  })

  it("returns pending messages when queue has content", async () => {
    mockDrainPending.mockReturnValue([
      { from: "agent", content: "I thought of something", timestamp: Date.now() },
      { from: "agent", content: "Also this", timestamp: Date.now() },
    ])

    const { createMcpServer } = await import("../../../heart/daemon/mcp-server")
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
      params: { name: "check_response", arguments: {} },
    })

    await new Promise((r) => setTimeout(r, 200))
    const output = await outputPromise
    server.stop()

    const response = parseResponse(output)
    expect(response.result.content[0].text).toContain("I thought of something")
    expect(response.result.content[0].text).toContain("Also this")
    expect(response.result.isError).toBeFalsy()
  })

  it("uses correct pending dir path for mcp channel", async () => {
    const { createMcpServer } = await import("../../../heart/daemon/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "check_response", arguments: {} },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()

    // Should call getPendingDir with agent, friendId, "mcp", sessionId
    expect(mockGetPendingDir).toHaveBeenCalledWith("test-agent", "friend-1", "mcp", "session-check-test")
    // And then drainPending with the returned dir
    expect(mockDrainPending).toHaveBeenCalledWith("/tmp/pending/mcp")
  })

  it("check_response is non-blocking (returns immediately)", async () => {
    const { createMcpServer } = await import("../../../heart/daemon/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const start = Date.now()
    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "check_response", arguments: {} },
    })

    await new Promise((r) => setTimeout(r, 200))
    await outputPromise
    server.stop()
    const elapsed = Date.now() - start

    // Should complete quickly (within timeout buffer), not wait for agent turn
    expect(elapsed).toBeLessThan(1000)
    // check_response reads pending dir directly, no daemon senseTurn call
    const { sendDaemonCommand } = await import("../../../heart/daemon/socket-client")
    expect(sendDaemonCommand).not.toHaveBeenCalled()
  })
})
