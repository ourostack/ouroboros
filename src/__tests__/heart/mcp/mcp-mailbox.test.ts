import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "stream"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

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
  handleAgentSearchFacts: vi.fn(async () => ({ ok: true, message: "Notes" })),
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

async function call(method: string, params: Record<string, unknown>): Promise<any> {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
  const server = createMcpServer({ agent: "test-agent", friendId: "friend-1", socketPath: "/tmp/test.sock", stdin, stdout })
  const outputPromise = collectOutput(stdout)
  server.start()
  writeJsonRpc(stdin, { jsonrpc: "2.0", id: 1, method, params })
  const output = await outputPromise
  server.stop()
  stdin.destroy()
  stdout.destroy()
  return parseResponse(output)
}

describe("MCP mailbox tools, served from the generated mcp.json", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    emitNervesEvent({ component: "daemon", event: "daemon.mcp_mailbox_test_start", message: "mailbox mcp test starting", meta: {} })
  })

  it("lists mailbox_list with the generated schema and the annotations its card gives", async () => {
    const response = await call("tools/list", {})
    const tool = response.result.tools.find((t: { name: string }) => t.name === "mailbox_list")
    const generated = (await import("../../../../actions/generated/mailbox/mcp.json")).tools[0]
    expect(tool.inputSchema).toEqual(generated.inputSchema)
    expect(tool.annotations).toEqual({ ...generated.annotations, idempotentHint: true })
    expect(tool.description).toContain(generated.description)
    expect(mockSendDaemonCommand).not.toHaveBeenCalled()
  })

  it("serves every tool the generated mcp.json lists, each once, so a new action can't go unserved", async () => {
    const { getToolSchemas } = await import("../../../heart/mcp/mcp-server")
    const served = getToolSchemas().map((schema) => schema.name)
    for (const tool of (await import("../../../../actions/generated/mailbox/mcp.json")).tools) {
      expect(served.filter((name) => name === tool.name)).toEqual([tool.name])
    }
  })

  it("runs mailbox_list without the daemon and returns the empty pile as structured content", async () => {
    const response = await call("tools/call", { name: "mailbox_list", arguments: {} })
    expect(response.result.isError).toBe(false)
    expect(response.result.structuredContent).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(JSON.parse(response.result.content[0].text)).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(mockSendDaemonCommand).not.toHaveBeenCalled()
  })

  it("answers a failure inside the action as a JSON-RPC internal error, never as bad input", async () => {
    const doors = await import("../../../heart/letters/doors")
    const spy = vi.spyOn(doors, "runMailboxAction").mockImplementation(() => { throw new Error("disk gone") })
    const response = await call("tools/call", { name: "mailbox_list", arguments: {} })
    spy.mockRestore()
    expect(response.result).toBeUndefined()
    expect(response.error).toEqual({ code: -32603, message: "mailbox_list failed: disk gone" })
  })

  it("refuses an input mailbox_list doesn't take with its card's code", async () => {
    const response = await call("tools/call", { name: "mailbox_list", arguments: { all: true } })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/^\[unknown-input\] /)
    expect(response.result.content[0].text).toContain("doesn't take all")
  })
})
