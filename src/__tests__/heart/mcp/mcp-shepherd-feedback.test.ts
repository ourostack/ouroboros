import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createMcpServer, type McpServer } from "../../../heart/mcp/mcp-server"

const runtime = vi.hoisted(() => ({
  send: vi.fn(),
  origin: vi.fn(async () => ({ tty: "/dev/ttys042" })),
}))
vi.mock("../../../heart/daemon/socket-client", () => ({ sendDaemonCommand: runtime.send }))
vi.mock("../../../heart/daemon/session-id-resolver", () => ({ resolveSessionId: () => "native-conversation" }))
vi.mock("../../../senses/shepherd/feedback-source", () => ({ resolveFeedbackOrigin: runtime.origin }))
const servers: McpServer[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(); vi.clearAllMocks() })

function bridge() {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: Array<{ id: number; result: { tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; content: Array<{ text: string }>; isError: boolean } }> = []
  output.on("data", bytes => { for (const line of String(bytes).trim().split("\n")) frames.push(JSON.parse(line)) })
  const server = createMcpServer({ agent: "orchid-runtime", friendId: "owner", socketPath: "/disposable.sock", stdin: input, stdout: output })
  servers.push(server)
  server.start()
  return {
    frames,
    request(id: number, method: string, params?: Record<string, unknown>) {
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n")
    },
  }
}

describe("native MCP feedback route", () => {
  it("advertises feedback without allowing a model to select a source, actor, agent or Teams recipient", async () => {
    const connection = bridge()
    connection.request(1, "tools/list")
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    const tool = connection.frames[0]!.result.tools?.find(tool => tool.name === "shepherd_feedback")
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["request_id", "feedback", "context"])
    expect(connection.frames[0]!.result.tools?.some(tool => tool.name === "shepherd_feedback_status")).toBe(true)
  })

  it("binds the actual native origin and returns the real small daemon receipt rather than another model turn", async () => {
    const receipt = "Orchid One: feedback received. I'll follow up in Teams."
    runtime.send.mockImplementation(async (_socket, command) => {
      expect(command).toEqual({ kind: "agent.shepherdFeedback", agent: "orchid-runtime", friendId: "owner",
        origin: { tty: "/dev/ttys042" }, submission: { requestId: "11111111-1111-4111-8111-111111111111",
          feedback: "You should have caught this.", context: "The task is not finished." } })
      return { ok: true, message: receipt, data: { id: "feedback:11111111-1111-4111-8111-111111111111", receipt, state: "pending" } }
    })
    const connection = bridge()
    connection.request(1, "tools/call", { name: "shepherd_feedback", arguments: { request_id: "11111111-1111-4111-8111-111111111111",
      feedback: "You should have caught this.", context: "The task is not finished." } })
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    expect(connection.frames[0]!.result).toMatchObject({ isError: false, content: [{ type: "text", text: receipt }] })
  })

  it("refuses model-selected routing and malformed IDs before inspecting or submitting anything", async () => {
    const connection = bridge()
    connection.request(1, "tools/call", { name: "shepherd_feedback", arguments: { request_id: "bad", feedback: "feedback" } })
    connection.request(2, "tools/call", { name: "shepherd_feedback", arguments: {
      request_id: "11111111-1111-4111-8111-111111111111", feedback: "feedback", session: "other-terminal",
    } })
    await vi.waitFor(() => expect(connection.frames).toHaveLength(2))
    expect(connection.frames.every(frame => frame.result.isError)).toBe(true)
    expect(runtime.origin).not.toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it("does not retry a submission with uncertain acknowledgement and keeps the original ID in its error", async () => {
    runtime.send.mockRejectedValue(new Error("socket closed after submit"))
    const connection = bridge()
    connection.request(1, "tools/call", { name: "shepherd_feedback", arguments: {
      request_id: "11111111-1111-4111-8111-111111111111", feedback: "feedback",
    } })
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    expect(connection.frames[0]!.result.isError).toBe(true)
    expect(connection.frames[0]!.result.content[0]!.text).toContain("11111111-1111-4111-8111-111111111111")
    expect(runtime.send).toHaveBeenCalledTimes(1)
  })

  it("checks only the same actor's stored request status without requiring a still-live source TTY", async () => {
    runtime.send.mockImplementation(async (_socket, command) => {
      expect(command).toEqual({ kind: "agent.shepherdFeedbackStatus", agent: "orchid-runtime", friendId: "owner",
        requestId: "11111111-1111-4111-8111-111111111111" })
      return { ok: true, data: { id: "feedback:11111111-1111-4111-8111-111111111111", review: "complete", delivery: "sent" } }
    })
    const connection = bridge()
    connection.request(1, "tools/call", { name: "shepherd_feedback_status", arguments: { request_id: "11111111-1111-4111-8111-111111111111" } })
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    expect(connection.frames[0]!.result.isError).toBe(false)
    expect(connection.frames[0]!.result.content[0]!.text).toContain('"delivery":"sent"')
    expect(runtime.origin).not.toHaveBeenCalled()
  })

  it("keeps transport credentials out of the native model's error result", async () => {
    runtime.send.mockRejectedValue(new Error("failed token=abc123secret"))
    const connection = bridge()
    connection.request(1, "tools/call", { name: "shepherd_feedback", arguments: {
      request_id: "11111111-1111-4111-8111-111111111111", feedback: "feedback",
    } })
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    expect(connection.frames[0]!.result.isError).toBe(true)
    expect(connection.frames[0]!.result.content[0]!.text).not.toContain("abc123secret")
  })
})
