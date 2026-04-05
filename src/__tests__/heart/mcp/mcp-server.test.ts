import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "stream"
import { emitNervesEvent } from "../../../nerves/runtime"

// Mock the socket client
const mockSendDaemonCommand = vi.fn()
vi.mock("../../../heart/daemon/socket-client", () => ({
  sendDaemonCommand: (...args: any[]) => mockSendDaemonCommand(...args),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

// Mock agent-service
vi.mock("../../../heart/daemon/agent-service", () => ({
  handleAgentStatus: vi.fn(async () => ({ ok: true, message: "Agent test-agent status", data: { agent: "test-agent", status: "active" } })),
  handleAgentAsk: vi.fn(async () => ({ ok: true, message: "Test response" })),
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

// Mock session-id-resolver
vi.mock("../../../heart/daemon/session-id-resolver", () => ({
  resolveSessionId: vi.fn(() => "test-session-id"),
}))

// Mock pending
vi.mock("../../../mind/pending", () => ({
  getPendingDir: vi.fn(() => "/tmp/pending"),
  drainPending: vi.fn(() => []),
}))

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import * as fs from "fs"
import { handleAgentStatus } from "../../../heart/daemon/agent-service"

describe("MCP server protocol layer", () => {
  let stdin: PassThrough
  let stdout: PassThrough

  beforeEach(() => {
    mockSendDaemonCommand.mockReset()
    mockSendDaemonCommand.mockResolvedValue({
      ok: true,
      message: "daemon response",
      data: { ponderDeferred: false },
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    stdin = new PassThrough()
    stdout = new PassThrough()
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_start",
      message: "mcp server test starting",
      meta: {},
    })
  })

  afterEach(() => {
    stdin.destroy()
    stdout.destroy()
  })

  function collectOutput(stream: PassThrough): Promise<string> {
    return new Promise((resolve) => {
      let data = ""
      stream.on("data", (chunk) => { data += chunk.toString() })
      stream.on("end", () => resolve(data))
      // Also resolve after a short timeout in case stream doesn't end
      setTimeout(() => resolve(data), 200)
    })
  }

  function writeJsonRpc(stream: PassThrough, msg: Record<string, unknown>): void {
    const body = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    stream.write(header + body)
  }

  it("exports createMcpServer function", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    expect(typeof createMcpServer).toBe("function")
  })

  it("responds to initialize with protocol version and capabilities", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    })

    // Give time for processing
    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    // Parse the JSON-RPC response from the output
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.result.protocolVersion).toBe("2024-11-05")
    expect(response.result.serverInfo.name).toBe("ouro-mcp-server")
    expect(response.result.capabilities.tools).toBeDefined()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "initialize test complete",
      meta: {},
    })
  })

  it("handles initialized notification without error", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    server.start()

    // Send initialized notification (no id = notification)
    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      method: "initialized",
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    // No crash = success for notifications
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "initialized notification test complete",
      meta: {},
    })
  })

  it("responds to tools/list with tool schemas", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(2)
    expect(response.result.tools).toBeDefined()
    expect(Array.isArray(response.result.tools)).toBe(true)

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "tools/list test complete",
      meta: {},
    })
  })

  it("responds to tools/call by forwarding to daemon", async () => {

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "status",
        arguments: {},
      },
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(3)
    expect(response.result.content).toBeDefined()
    expect(Array.isArray(response.result.content)).toBe(true)
    expect(response.result.content[0].type).toBe("text")

    // Tool calls go through agent-service directly, not daemon socket
    const { handleAgentStatus } = await import("../../../heart/daemon/agent-service")
    expect(handleAgentStatus).toHaveBeenCalled()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "tools/call test complete",
      meta: {},
    })
  })

  it("returns error for unknown tool name during tools/call", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "nonexistent_tool",
        arguments: {},
      },
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(4)
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain("Unknown tool")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "unknown tool error test complete",
      meta: {},
    })
  })

  it("stores agent name and friend id from options", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "my-agent",
      friendId: "friend-123",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    expect(server.agent).toBe("my-agent")
    expect(server.friendId).toBe("friend-123")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "options test complete",
      meta: {},
    })
  })

  it("returns JSON-RPC error for unknown methods", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 5,
      method: "unknown/method",
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(5)
    expect(response.error).toBeDefined()
    expect(response.error.code).toBe(-32601) // Method not found

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "unknown method test complete",
      meta: {},
    })
  })

  it("initializes successfully even without daemon socket (standalone mode)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/nonexistent.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(1)
    expect(response.result).toBeDefined()
    expect(response.result.protocolVersion).toBe("2024-11-05")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "daemon not running initialize test complete",
      meta: {},
    })
  })

  it("skips invalid Content-Length headers gracefully", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    // Send a header with "Content-Length:" present but no valid digits after it.
    // This triggers the invalid-header branch in tryParseContentLength (lines 97-98).
    // Then follow with a valid Content-Length message.
    localStdin.write("Content-Length: abc\r\n\r\n")
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    })
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    localStdin.write(header + body)

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    // The response uses Content-Length framing; extract JSON after the last header
    const lastHeaderEnd = output.lastIndexOf("\r\n\r\n")
    expect(lastHeaderEnd).not.toBe(-1)
    const jsonPart = output.slice(lastHeaderEnd + 4)
    const response = JSON.parse(jsonPart)
    expect(response.id).toBe(99)
    expect(response.result.protocolVersion).toBe("2024-11-05")

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "invalid header skip test complete",
      meta: {},
    })
  })

  it("returns JSON-RPC parse error for malformed JSON body", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    // Send a Content-Length message with invalid JSON body
    const badBody = "not valid json{{"
    const header = `Content-Length: ${Buffer.byteLength(badBody)}\r\n\r\n`
    stdin.write(header + badBody)

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.error).toBeDefined()
    expect(response.error.code).toBe(-32700)
    expect(response.error.message).toBe("Parse error")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "parse error test complete",
      meta: {},
    })
  })

  it("returns service error when agent-service handler throws", async () => {
    // Make handleAgentStatus throw for the next call
    vi.mocked(handleAgentStatus).mockRejectedValueOnce(new Error("disk read failed"))

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    writeJsonRpc(localStdin, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "status",
        arguments: {},
      },
    })

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(10)
    // The catch block sets response = { ok: false, error: "Service error: ..." }
    // text is built from response.message ?? response.summary ?? JSON.stringify(response.data ?? { ok: response.ok })
    // Since .message and .summary are undefined, text = JSON.stringify({ ok: false })
    expect(response.result.isError).toBe(true)

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "service error test complete",
      meta: {},
    })
  })

  it("ignores duplicate start() calls", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    server.start()
    server.start() // second call should be a no-op
    server.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "duplicate start test complete",
      meta: {},
    })
  })

  it("ignores duplicate stop() calls", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    server.start()
    server.stop()
    server.stop() // second call should be a no-op

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "duplicate stop test complete",
      meta: {},
    })
  })

  it("ignores stop() when never started", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    server.stop() // never started, should be a no-op

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "stop without start test complete",
      meta: {},
    })
  })

  it("skips blank lines in newline-delimited mode", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    // Send blank lines followed by a valid newline-delimited JSON message
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 55,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex", version: "1.0" },
      },
    })
    localStdin.write("\n\n" + body + "\n")

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(55)
    expect(response.result.protocolVersion).toBe("2024-11-05")

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "blank line skip test complete",
      meta: {},
    })
  })

  it("handles newline-delimited JSON (Codex compatibility)", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
    })

    const outputPromise = collectOutput(stdout)
    server.start()

    // Send newline-delimited (no Content-Length header)
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "codex", version: "1.0" },
      },
    })
    stdin.write(body + "\n")

    await new Promise((r) => setTimeout(r, 100))
    server.stop()
    stdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(42)
    expect(response.result.protocolVersion).toBe("2024-11-05")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "newline-delimited test complete",
      meta: {},
    })
  })

  it("returns error when delegate tool throws", async () => {
    mockSendDaemonCommand.mockRejectedValueOnce(new Error("delegate pipeline failed"))

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    writeJsonRpc(localStdin, {
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: {
        name: "delegate",
        arguments: { task: "test task" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(60)
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain("delegate pipeline failed")

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "delegate error test complete",
      meta: {},
    })
  })

  it("returns response from send_message tool", async () => {
    mockSendDaemonCommand.mockResolvedValueOnce({ ok: true, message: "hello from agent", data: { ponderDeferred: false } })

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    writeJsonRpc(localStdin, {
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "hello agent" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(61)
    expect(response.result.isError).toBe(false)
    expect(response.result.content[0].text).toContain("hello from agent")

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "send_message test complete",
      meta: {},
    })
  })

  it("returns error when send_message throws", async () => {
    mockSendDaemonCommand.mockRejectedValueOnce(new Error("pipeline broke"))

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    writeJsonRpc(localStdin, {
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { message: "hello" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(62)
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain("pipeline broke")

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "send_message error test complete",
      meta: {},
    })
  })

  it("handles check_response tool with pending messages", async () => {
    const { drainPending } = await import("../../../mind/pending")
    vi.mocked(drainPending).mockReturnValueOnce([
      { content: "pending message 1", source: "inner-dialog", timestamp: "2026-03-27T00:00:00Z" },
      { content: "pending message 2", source: "inner-dialog", timestamp: "2026-03-27T00:01:00Z" },
    ] as any)

    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const localStdin = new PassThrough()
    const localStdout = new PassThrough()
    const server = createMcpServer({
      agent: "test-agent",
      friendId: "test-friend",
      socketPath: "/tmp/test.sock",
      stdin: localStdin,
      stdout: localStdout,
    })

    const outputPromise = collectOutput(localStdout)
    server.start()

    writeJsonRpc(localStdin, {
      jsonrpc: "2.0",
      id: 63,
      method: "tools/call",
      params: {
        name: "check_response",
        arguments: {},
      },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()
    localStdin.end()

    const output = await outputPromise
    const match = output.match(/\{.*\}/s)
    expect(match).not.toBeNull()
    const response = JSON.parse(match![0])
    expect(response.id).toBe(63)
    expect(response.result.isError).toBe(false)
    expect(response.result.content[0].text).toContain("pending message 1")

    localStdin.destroy()
    localStdout.destroy()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_server_test_end",
      message: "check_response pending test complete",
      meta: {},
    })
  })
})
