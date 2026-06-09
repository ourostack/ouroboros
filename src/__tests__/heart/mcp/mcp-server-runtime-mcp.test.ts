import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PassThrough } from "stream"
import * as fs from "fs"

/**
 * Bridge-side wiring for runtime Workbench MCP injection.
 *
 * `createMcpServer({ runtimeMcp })` (the `mcp-serve` bridge process) must stamp
 * the resolved runtime MCP config onto EVERY `agent.senseTurn` command it emits
 * to the daemon. The bridge does not run the agent turn — it forwards the
 * override on the wire so the daemon can merge it per-turn.
 */

const mockSendDaemonCommand = vi.fn()

vi.mock("../../../heart/daemon/session-id-resolver", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/daemon/session-id-resolver")>(
    "../../../heart/daemon/session-id-resolver",
  )
  return { ...actual, resolveSessionId: () => "session-runtime-mcp" }
})

vi.mock("../../../mind/pending", async () => {
  const actual = await vi.importActual<typeof import("../../../mind/pending")>("../../../mind/pending")
  return { ...actual, drainPending: () => [], getPendingDir: vi.fn().mockReturnValue("/tmp/pending") }
})

vi.mock("../../../heart/daemon/socket-client", () => ({
  sendDaemonCommand: (...args: any[]) => mockSendDaemonCommand(...args),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

function writeJsonRpc(stream: PassThrough, msg: Record<string, unknown>): void {
  const body = JSON.stringify(msg)
  stream.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

const RUNTIME_MCP = {
  ouro_workbench: { command: "/Apps/OuroWorkbenchMCP", args: [] as string[] },
}

describe("createMcpServer runtimeMcp wiring", () => {
  let stdin: PassThrough
  let stdout: PassThrough

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.readdirSync).mockReturnValue([])
    vi.mocked(fs.readFileSync).mockReturnValue("")
    stdin = new PassThrough()
    stdout = new PassThrough()
    mockSendDaemonCommand.mockResolvedValue({
      ok: true,
      message: "ok",
      data: { ponderDeferred: false },
    })
  })

  afterEach(() => {
    stdin.destroy()
    stdout.destroy()
  })

  it("stamps runtimeMcp onto the emitted agent.senseTurn command", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "boss",
      friendId: "friend-1",
      socketPath: "/tmp/test.sock",
      stdin,
      stdout,
      runtimeMcp: RUNTIME_MCP,
    })
    server.start()

    writeJsonRpc(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_message", arguments: { message: "hi" } },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()

    expect(mockSendDaemonCommand).toHaveBeenCalledWith(
      "/tmp/test.sock",
      expect.objectContaining({
        kind: "agent.senseTurn",
        agent: "boss",
        runtimeMcp: RUNTIME_MCP,
      }),
    )
  })

  it("omits runtimeMcp from the senseTurn command when not provided", async () => {
    const { createMcpServer } = await import("../../../heart/mcp/mcp-server")
    const server = createMcpServer({
      agent: "boss",
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
      params: { name: "send_message", arguments: { message: "hi" } },
    })

    await new Promise((r) => setTimeout(r, 200))
    server.stop()

    const sent = mockSendDaemonCommand.mock.calls[0]?.[1]
    expect(sent).toBeTruthy()
    expect(sent.kind).toBe("agent.senseTurn")
    expect("runtimeMcp" in sent).toBe(false)
  })
})
