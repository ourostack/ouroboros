import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "stream"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

const mockRunSenseTurn = vi.fn()

vi.mock("../../../senses/shared-turn", async () => {
  const actual = await vi.importActual<typeof import("../../../senses/shared-turn")>("../../../senses/shared-turn")
  return {
    ...actual,
    runSenseTurn: (...args: any[]) => mockRunSenseTurn(...args),
  }
})

const mockResolveSessionId = vi.fn().mockReturnValue("session-write-test")

vi.mock("../../../heart/daemon/session-id-resolver", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/daemon/session-id-resolver")>("../../../heart/daemon/session-id-resolver")
  return {
    ...actual,
    resolveSessionId: (...args: any[]) => mockResolveSessionId(...args),
  }
})

vi.mock("../../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../../mind/pending")>("../../../mind/pending")
  return {
    ...actual,
    drainPending: vi.fn().mockReturnValue([]),
    getPendingDir: vi.fn().mockReturnValue("/tmp/pending/mcp"),
  }
})

const mockSendDaemonCommand = vi.fn()

vi.mock("../../../heart/daemon/socket-client", () => ({
  sendDaemonCommand: (...args: any[]) => mockSendDaemonCommand(...args),
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

describe("MCP write tools routing", () => {
  let stdin: PassThrough
  let stdout: PassThrough

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunSenseTurn.mockResolvedValue({
      response: "task accepted and working on it",
      ponderDeferred: false,
    })
    mockSendDaemonCommand.mockResolvedValue({ ok: true, message: "sent" })
    stdin = new PassThrough()
    stdout = new PassThrough()
    emitNervesEvent({
      component: "daemon",
      event: "daemon.mcp_write_tools_test_start",
      message: "write tools test starting",
      meta: {},
    })
  })

  afterEach(() => {
    stdin.destroy()
    stdout.destroy()
  })

  describe("delegate", () => {
    it("delegate calls runSenseTurn for a full conversation turn", async () => {
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
        params: {
          name: "delegate",
          arguments: { task: "build the widget", context: "it should be blue" },
        },
      })

      await new Promise((r) => setTimeout(r, 200))
      const output = await outputPromise
      server.stop()

      expect(mockRunSenseTurn).toHaveBeenCalledTimes(1)
      const call = mockRunSenseTurn.mock.calls[0][0]
      expect(call.channel).toBe("mcp")
      expect(call.userMessage).toContain("build the widget")
      expect(call.userMessage).toContain("it should be blue")
    })

    it("delegate returns agent response", async () => {
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
        params: {
          name: "delegate",
          arguments: { task: "build the widget" },
        },
      })

      await new Promise((r) => setTimeout(r, 200))
      const output = await outputPromise
      server.stop()

      const response = parseResponse(output)
      expect(response.result.content[0].text).toBe("task accepted and working on it")
    })
  })

  describe("report_progress", () => {
    it("report_progress sends daemon command and returns immediately", async () => {
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
        params: {
          name: "report_progress",
          arguments: { summary: "halfway done" },
        },
      })

      await new Promise((r) => setTimeout(r, 200))
      const output = await outputPromise
      server.stop()

      // report_* should NOT call runSenseTurn
      expect(mockRunSenseTurn).not.toHaveBeenCalled()
      // Should return a response (via agent-service fallback)
      const response = parseResponse(output)
      expect(response.result.content[0].text).toBeDefined()
    })
  })

  describe("report_blocker", () => {
    it("report_blocker returns without calling runSenseTurn", async () => {
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
        params: {
          name: "report_blocker",
          arguments: { blocker: "waiting on API key" },
        },
      })

      await new Promise((r) => setTimeout(r, 200))
      const output = await outputPromise
      server.stop()

      expect(mockRunSenseTurn).not.toHaveBeenCalled()
      const response = parseResponse(output)
      expect(response.result.isError).toBeFalsy()
    })
  })

  describe("report_complete", () => {
    it("report_complete returns without calling runSenseTurn", async () => {
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
        params: {
          name: "report_complete",
          arguments: { summary: "widget built" },
        },
      })

      await new Promise((r) => setTimeout(r, 200))
      const output = await outputPromise
      server.stop()

      expect(mockRunSenseTurn).not.toHaveBeenCalled()
      const response = parseResponse(output)
      expect(response.result.isError).toBeFalsy()
    })
  })
})
