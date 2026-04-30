import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter, PassThrough } from "node:stream"

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}))

import { spawn } from "child_process"
import type { ChildProcess } from "child_process"

interface MockProcess extends EventEmitter {
  _stdout: PassThrough
  _stderr: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  stdin: { writable: boolean; write: ReturnType<typeof vi.fn> }
  pid: number
  killed: boolean
  kill: ReturnType<typeof vi.fn>
  stdinWrites: string[]
}

function createMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess
  proc._stdout = new PassThrough()
  proc._stderr = new PassThrough()
  proc.stdout = proc._stdout
  proc.stderr = proc._stderr
  proc.stdinWrites = []
  proc.stdin = {
    writable: true,
    write: vi.fn((data: string) => {
      proc.stdinWrites.push(data)
    }),
  }
  proc.pid = 12345
  proc.killed = false
  proc.kill = vi.fn(() => {
    proc.killed = true
    proc.emit("close", 0)
    return true
  })
  return proc
}

function sendResponse(proc: MockProcess, response: Record<string, unknown>): void {
  proc._stdout.write(JSON.stringify(response) + "\n")
}

/** Get the last JSON-RPC request written to stdin */
function lastStdinRequest(proc: MockProcess): Record<string, unknown> {
  const writes = proc.stdinWrites
  const lastWrite = writes[writes.length - 1]
  return JSON.parse(lastWrite) as Record<string, unknown>
}

/** Get all JSON-RPC requests written to stdin as parsed objects */
function allStdinRequests(proc: MockProcess): Array<Record<string, unknown>> {
  return proc.stdinWrites.map(w => JSON.parse(w) as Record<string, unknown>)
}

async function connectClient(McpClient: typeof import("../../repertoire/mcp-client").McpClient, proc: MockProcess, config?: Record<string, unknown>) {
  const client = new McpClient(config ?? { command: "server" })
  const connectPromise = client.connect()
  await tick()

  const initReq = lastStdinRequest(proc)
  sendResponse(proc, {
    jsonrpc: "2.0",
    id: initReq.id,
    result: {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "test", version: "1.0" },
      capabilities: { tools: {} },
    },
  })
  await connectPromise
  return client
}

async function tick(ms = 10) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe("McpClient", () => {
  let mockProc: MockProcess

  beforeEach(() => {
    vi.resetModules()
    mockProc = createMockProcess()
    vi.mocked(spawn).mockReturnValue(mockProc as unknown as ChildProcess)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function getMcpClient() {
    const mod = await import("../../repertoire/mcp-client")
    return mod
  }

  describe("connect (initialize handshake)", () => {
    it("spawns the process and completes initialize handshake", async () => {
      const { McpClient } = await getMcpClient()
      const client = new McpClient({ command: "my-server", args: ["--port", "3000"], env: { TOKEN: "abc" } })

      const connectPromise = client.connect()
      await tick()

      const request = lastStdinRequest(mockProc)
      expect(request.method).toBe("initialize")
      expect(request.jsonrpc).toBe("2.0")
      expect((request.params as Record<string, unknown>).protocolVersion).toBeDefined()
      expect((request.params as Record<string, unknown>).clientInfo).toBeDefined()

      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "test-server", version: "1.0" },
          capabilities: { tools: {} },
        },
      })

      await connectPromise

      // Verify an "initialized" notification was sent after init response
      const requests = allStdinRequests(mockProc)
      const initialized = requests.find(r => r.method === "initialized")
      expect(initialized).toBeDefined()

      expect(spawn).toHaveBeenCalledWith("my-server", ["--port", "3000"], expect.objectContaining({
        env: expect.objectContaining({ TOKEN: "abc" }),
        stdio: ["pipe", "pipe", "pipe"],
      }))
    })

    it("does not respawn when connect is called while already connected", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)
      const spawnCount = vi.mocked(spawn).mock.calls.length

      await client.connect()

      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCount)
    })
  })

  describe("listTools", () => {
    it("sends tools/list and returns tools (single page, no cursor)", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const listPromise = client.listTools()
      await tick()

      const listReq = lastStdinRequest(mockProc)
      expect(listReq.method).toBe("tools/list")

      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: listReq.id,
        result: {
          tools: [
            { name: "get_items", description: "Get work items", inputSchema: { type: "object" } },
            { name: "create_item", description: "Create item", inputSchema: { type: "object" } },
          ],
        },
      })

      const tools = await listPromise
      expect(tools).toEqual([
        { name: "get_items", description: "Get work items", inputSchema: { type: "object" } },
        { name: "create_item", description: "Create item", inputSchema: { type: "object" } },
      ])
    })

    it("handles pagination with cursor loop", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const listPromise = client.listTools()
      await tick()

      // First page with cursor
      const req1 = lastStdinRequest(mockProc)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: req1.id,
        result: {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
          nextCursor: "page2",
        },
      })

      await tick()

      // Second page without cursor
      const req2 = lastStdinRequest(mockProc)
      expect((req2.params as Record<string, unknown>).cursor).toBe("page2")
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: req2.id,
        result: {
          tools: [{ name: "tool2", description: "Tool 2", inputSchema: { type: "object" } }],
        },
      })

      const tools = await listPromise
      expect(tools).toHaveLength(2)
      expect(tools[0].name).toBe("tool1")
      expect(tools[1].name).toBe("tool2")
    })

    it("returns cached tools on subsequent calls", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const listPromise = client.listTools()
      await tick()
      const listReq = lastStdinRequest(mockProc)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: listReq.id,
        result: {
          tools: [{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }],
        },
      })
      await listPromise

      const writeCountBefore = mockProc.stdinWrites.length

      // Second call should return cached result without new request
      const cached = await client.listTools()
      expect(cached).toEqual([{ name: "tool1", description: "Tool 1", inputSchema: { type: "object" } }])
      expect(mockProc.stdinWrites.length).toBe(writeCountBefore)
    })

    it("refreshTools clears the cache and performs a live list request", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const firstList = client.listTools()
      await tick()
      const firstReq = lastStdinRequest(mockProc)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: firstReq.id,
        result: {
          tools: [{ name: "old", description: "Old", inputSchema: {} }],
        },
      })
      await firstList

      const refreshed = client.refreshTools()
      await tick()
      const refreshReq = lastStdinRequest(mockProc)
      expect(refreshReq.method).toBe("tools/list")
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: refreshReq.id,
        result: {
          tools: [{ name: "new", description: "New", inputSchema: {} }],
        },
      })

      await expect(refreshed).resolves.toEqual([{ name: "new", description: "New", inputSchema: {} }])
    })
  })

  describe("callTool", () => {
    it("sends tools/call and returns the result", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const callPromise = client.callTool("get_items", { query: "test" })
      await tick()

      const callReq = lastStdinRequest(mockProc)
      expect(callReq.method).toBe("tools/call")
      expect((callReq.params as Record<string, unknown>).name).toBe("get_items")
      expect((callReq.params as Record<string, unknown>).arguments).toEqual({ query: "test" })

      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: callReq.id,
        result: {
          content: [{ type: "text", text: "item1\nitem2" }],
        },
      })

      const result = await callPromise
      expect(result).toEqual({
        content: [{ type: "text", text: "item1\nitem2" }],
      })
    })

    it("enforces timeout on tools/call", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      // Use a very short timeout and never respond
      const callPromise = client.callTool("slow_tool", {}, 50)

      await expect(callPromise).rejects.toThrow(/timeout/i)
    })

    it("rejects immediately when the transport is not writable", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)
      mockProc.stdin.writable = false

      await expect(client.callTool("get_items", {})).rejects.toThrow(/not writable/i)
    })

    it("rejects non-writable transports without a pending timer", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)
      mockProc.stdin.writable = false

      await expect(client.callTool("get_items", {}, 0)).rejects.toThrow(/not writable/i)
    })

    it("handles successful calls without request timers", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const callPromise = client.callTool("untimed_tool", {}, 0)
      await tick()
      const callReq = lastStdinRequest(mockProc)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: callReq.id,
        result: {
          content: [{ type: "text", text: "untimed" }],
        },
      })

      await expect(callPromise).resolves.toEqual({
        content: [{ type: "text", text: "untimed" }],
      })
    })
  })

  describe("JSON-RPC error handling", () => {
    it("rejects with error when server returns JSON-RPC error", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const callPromise = client.callTool("bad_tool", {})
      await tick()

      const callReq = lastStdinRequest(mockProc)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: callReq.id,
        error: { code: -32601, message: "Method not found" },
      })

      await expect(callPromise).rejects.toThrow("Method not found")
    })
  })

  describe("process crash detection", () => {
    it("sets state to disconnected on process close", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      expect(client.isConnected()).toBe(true)

      // Simulate process crash (disable kill mock so close doesn't come from kill)
      mockProc.kill = vi.fn(() => true)
      mockProc.emit("close", 1)
      await tick()

      expect(client.isConnected()).toBe(false)
    })

    it("rejects pending requests when process crashes", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const callPromise = client.callTool("some_tool", {})
      await tick()

      // Crash the process without responding (override kill to not emit close again)
      mockProc.kill = vi.fn(() => true)
      mockProc.emit("close", 1)

      await expect(callPromise).rejects.toThrow(/close/i)
    })

    it("rejects untimed pending requests when process crashes", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const callPromise = client.callTool("some_tool", {}, 0)
      await tick()

      mockProc.kill = vi.fn(() => true)
      mockProc.emit("close", 1)

      await expect(callPromise).rejects.toThrow(/close/i)
    })
  })

  describe("shutdown", () => {
    it("kills the process gracefully", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      client.shutdown()

      expect(mockProc.kill).toHaveBeenCalled()
      expect(client.isConnected()).toBe(false)
    })
  })

  describe("invalid JSON handling", () => {
    it("ignores malformed JSON lines on stdout", async () => {
      const { McpClient } = await getMcpClient()
      const client = new McpClient({ command: "server" })

      const connectPromise = client.connect()
      await tick()

      // Send garbage first
      mockProc._stdout.write("not json at all\n")
      await tick()

      // Then send valid initialize response
      const initReq = lastStdinRequest(mockProc)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: initReq.id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "test", version: "1.0" },
          capabilities: { tools: {} },
        },
      })

      await connectPromise
      expect(client.isConnected()).toBe(true)
    })
  })

  describe("concurrent request ID matching", () => {
    it("routes responses to correct pending requests by ID", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      // Fire two concurrent requests
      const call1 = client.callTool("tool_a", { x: 1 })
      const call2 = client.callTool("tool_b", { y: 2 })
      await tick()

      // Find the two callTool requests (skip init + initialized)
      const requests = allStdinRequests(mockProc)
      const toolCallRequests = requests.filter(r => r.method === "tools/call")
      expect(toolCallRequests).toHaveLength(2)
      const req1 = toolCallRequests[0]
      const req2 = toolCallRequests[1]

      // Respond to second request first (out of order)
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: req2.id,
        result: { content: [{ type: "text", text: "result_b" }] },
      })
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: req1.id,
        result: { content: [{ type: "text", text: "result_a" }] },
      })

      const [result1, result2] = await Promise.all([call1, call2])
      expect(result1.content[0].text).toBe("result_a")
      expect(result2.content[0].text).toBe("result_b")
    })
  })

  describe("disconnected client", () => {
    it("rejects callTool when client is not connected", async () => {
      const { McpClient } = await getMcpClient()
      const client = new McpClient({ command: "server" })

      // Never connect, just try to call
      await expect(client.callTool("tool", {})).rejects.toThrow(/disconnect/i)
    })

    it("rejects listTools when client is not connected", async () => {
      const { McpClient } = await getMcpClient()
      const client = new McpClient({ command: "server" })

      await expect(client.listTools()).rejects.toThrow(/disconnect/i)
    })
  })

  describe("notification messages (no id)", () => {
    it("ignores JSON-RPC notifications from server", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      // Send a notification (no id field) — should be silently ignored
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progress: 50 },
      } as unknown as Record<string, unknown>)

      await tick()

      // Client should still be connected and functional
      expect(client.isConnected()).toBe(true)
    })

    it("ignores responses with unknown request IDs", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      // Send a response with an ID that was never requested
      sendResponse(mockProc, {
        jsonrpc: "2.0",
        id: 99999,
        result: { data: "orphaned" },
      })

      await tick()

      // Client should still be connected and functional
      expect(client.isConnected()).toBe(true)
    })
  })

  describe("onClose callback", () => {
    it("invokes onClose callback when process exits", async () => {
      const { McpClient } = await getMcpClient()
      const client = await connectClient(McpClient, mockProc)

      const onClose = vi.fn()
      client.onClose(onClose)

      // Override kill to not emit close
      mockProc.kill = vi.fn(() => true)
      mockProc.emit("close", 0)
      await tick()

      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe("error event on process error", () => {
    it("handles process error event", async () => {
      const { McpClient } = await getMcpClient()
      const client = new McpClient({ command: "nonexistent-binary" })

      const connectPromise = client.connect()
      await tick()

      // Simulate spawn error
      mockProc.emit("error", new Error("spawn ENOENT"))
      mockProc.emit("close", 1)

      await expect(connectPromise).rejects.toThrow(/ENOENT|disconnected|close/i)
    })
  })

  describe("transport error classification", () => {
    it("recognizes transport failures from Error and non-Error values", async () => {
      const { isMcpTransportError } = await getMcpClient()

      expect(isMcpTransportError(new Error("Transport closed"))).toBe(true)
      expect(isMcpTransportError("ECONNRESET from peer")).toBe(true)
      expect(isMcpTransportError(new Error("Method not found"))).toBe(false)
    })
  })
})
