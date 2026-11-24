import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { annotationsOf, type Action } from "../../../../tools/ouro-actions/ouro-actions.mts"
import {
  _setSenseTurnCommandTimeoutMs,
  _setSenseTurnRetryDelays,
  createMcpServer,
  getToolSchemas,
  mcpAnnotationsOf,
  serverErrors,
  SENSE_TURN_COMMAND_TIMEOUT_MS,
  SENSE_TURN_RETRY_DELAYS_MS,
  type McpServer,
} from "../../../heart/mcp/mcp-server"

const runtime = vi.hoisted(() => ({
  send: vi.fn(),
  status: vi.fn(),
  drain: vi.fn((): Array<{ content: string }> => []),
}))
vi.mock("../../../heart/daemon/socket-client", () => ({ sendDaemonCommand: runtime.send }))
vi.mock("../../../heart/daemon/session-id-resolver", () => ({ resolveSessionId: () => "ax-cards-session" }))
vi.mock("../../../senses/shepherd/feedback-source", () => ({ resolveFeedbackOrigin: async () => ({ tty: "/dev/ttys001" }) }))
vi.mock("../../../mind/pending", () => ({ getPendingDir: () => "/tmp/ax-cards-pending", drainPending: runtime.drain }))
vi.mock("../../../heart/daemon/agent-service", () => ({
  handleAgentStatus: runtime.status,
  handleAgentCatchup: runtime.status,
  handleAgentGetContext: runtime.status,
  handleAgentSearchFacts: runtime.status,
  handleAgentGetTask: runtime.status,
}))

interface Frame {
  id: number | null
  result?: { tools?: Array<Record<string, unknown>>; content: Array<{ text: string }>; isError: boolean; protocolVersion?: string }
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

const servers: McpServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  vi.clearAllMocks()
  _setSenseTurnRetryDelays(SENSE_TURN_RETRY_DELAYS_MS)
  _setSenseTurnCommandTimeoutMs(SENSE_TURN_COMMAND_TIMEOUT_MS)
})

function bridge() {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: Frame[] = []
  output.on("data", (bytes) => { for (const line of String(bytes).trim().split("\n")) frames.push(JSON.parse(line)) })
  // A UUID friend id skips the bundle lookup.
  const server = createMcpServer({ agent: "ax-agent", friendId: "11111111-2222-4333-8444-555555555555", socketPath: "/disposable.sock", stdin: input, stdout: output })
  servers.push(server)
  server.start()
  return {
    frames,
    request(id: number, method: string, params?: Record<string, unknown>) {
      input.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n")
    },
  }
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Frame> {
  const connection = bridge()
  connection.request(1, "tools/call", { name, arguments: args })
  await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
  return connection.frames[0]!
}

const cardOf = (name: string) => getToolSchemas().find((s) => s.name === name)!.ax
const errorOf = (name: string, code: string) => cardOf(name).errors.find((e) => e.code === code)!

/** The isError text an agent reads: the card's `means`, any detail, then the card's fix. */
function expectCardError(frame: Frame, tool: string, code: string, detail?: string) {
  const card = errorOf(tool, code)
  expect(card, `${tool} has a ${code} card`).toBeDefined()
  expect(frame.result?.isError).toBe(true)
  const text = frame.result!.content[0]!.text
  expect(text.startsWith(`[${code}] ${card.means}`)).toBe(true)
  expect(text.endsWith(`Fix: ${card.fix}`)).toBe(true)
  if (detail) expect(text).toContain(detail)
}

describe("mcp-serve's Ouro AX cards", () => {
  it("gives every tool a card with its own id, a when line, an effect and error cards", () => {
    const schemas = getToolSchemas()
    expect(schemas).toHaveLength(23)
    for (const schema of schemas) {
      expect(schema.ax.id).toBe(`mcp:${schema.name}`)
      // The hand-written tools are the ouro-agent group; the generated mailbox tools carry their own group.
      expect(schema.ax.group).toBe(schema.name.startsWith("mailbox_") ? "mailbox" : "ouro-agent")
      expect(schema.ax.when).not.toMatch(/[\r\n]/)
      expect(schema.ax.when.length).toBeGreaterThanOrEqual(6)
      expect(schema.ax.when.length).toBeLessThanOrEqual(200)
      expect(["read", "write"]).toContain(schema.ax.effect)
      expect(schema.ax.errors.length).toBeGreaterThan(0)
      for (const error of schema.ax.errors) {
        expect(error.code).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
        expect(error.means).not.toBe(error.fix)
      }
    }
  })

  it("serves annotations equal to ouro-actions' annotationsOf for each card", () => {
    for (const schema of getToolSchemas()) {
      const action = { consent: schema.ax.effect, destructive: schema.ax.destructive, idempotent: schema.ax.idempotent } as unknown as Action
      // The one difference: a card that runs an agent turn says `openWorld`, because the turn can reach outside this server.
      const expected = { ...annotationsOf(action), ...(schema.ax.openWorld ? { openWorldHint: true } : {}) }
      expect(mcpAnnotationsOf(schema.ax), schema.name).toEqual(expected)
    }
    for (const name of ["send_message", "ask", "delegate", "check_scope", "request_decision", "check_guidance", "report_progress", "report_blocker", "report_complete"]) {
      expect(mcpAnnotationsOf(cardOf(name)), name).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true })
    }
    expect(mcpAnnotationsOf(cardOf("status"))).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    expect(mcpAnnotationsOf(cardOf("check_response")).readOnlyHint).toBe(false)
    expect(mcpAnnotationsOf(cardOf("shepherd_feedback")).idempotentHint).toBe(true)
    expect(mcpAnnotationsOf({ ...cardOf("send_message"), effect: "consequential", destructive: true })).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
  })

  it("lists each tool as the MCP schema names it: the when line first, annotations, and no card", async () => {
    const connection = bridge()
    connection.request(1, "tools/list")
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    const tools = connection.frames[0]!.result!.tools!
    expect(tools.map((t) => t.name)).toEqual(getToolSchemas().map((s) => s.name))
    for (const schema of getToolSchemas()) {
      const tool = tools.find((t) => t.name === schema.name)!
      expect(Object.keys(tool).sort()).toEqual(["annotations", "description", "inputSchema", "name"])
      expect(tool.description).toBe(`${schema.ax.when} ${schema.description}`)
      expect(tool.annotations).toEqual(mcpAnnotationsOf(schema.ax))
      expect(tool.inputSchema).toEqual(schema.inputSchema)
    }
  })

  it("declares the server-level unknown-door card", () => {
    expect(serverErrors.map((e) => e.code)).toEqual(["unknown-door"])
  })
})

describe("an unknown tool", () => {
  it("is a JSON-RPC -32602 error naming the nearest tool, not a tool result", async () => {
    const frame = await call("sendmessage")
    expect(frame.result).toBeUndefined()
    expect(frame.error?.code).toBe(-32602)
    expect(frame.error?.message).toBe('Unknown tool "sendmessage". Did you mean "send_message"? tools/list has all 23.')
    expect(frame.error?.data).toEqual({ code: "unknown-door", tool: "sendmessage", nearest: "send_message", candidates: ["send_message"], means: serverErrors[0]!.means, fix: serverErrors[0]!.fix })
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it("finds the nearest name by spelling, part of a name, or a host's server prefix", async () => {
    expect((await call("get_tasks")).error?.data?.nearest).toBe("get_task")
    expect((await call("feedback_status")).error?.data?.nearest).toBe("shepherd_feedback_status")
    expect((await call("mcp__slugger__ask")).error?.data?.nearest).toBe("ask")
    expect((await call("blocker")).error?.data?.nearest).toBe("report_blocker")
    expect((await call("complete")).error?.data?.nearest).toBe("report_complete")
    expect((await call("search")).error?.data?.nearest).toBe("search_facts")
    expect((await call("send_message_now")).error?.data?.nearest).toBe("send_message")
    expect((await call("please_send_message_to_the_agent")).error?.data?.nearest).toBe("send_message")
    expect((await call("check_shepherd_feedback_status_now")).error?.data?.nearest).toBe("shepherd_feedback_status")
  })

  it("lists every tool a partial name matches, rather than guessing one", async () => {
    const frame = await call("report")
    expect(frame.error?.data).toMatchObject({ nearest: null, candidates: ["report_progress", "report_blocker", "report_complete"] })
    expect(frame.error?.message).toBe('Unknown tool "report". Did you mean one of "report_progress", "report_blocker", "report_complete"? tools/list has all 23.')
    expect((await call("feedback")).error?.data?.candidates).toEqual(["shepherd_feedback", "shepherd_feedback_status"])
  })

  it("suggests nothing when no tool is close, rather than a wrong one", async () => {
    for (const name of ["help", "x", "weather"]) {
      const frame = await call(name)
      expect(frame.error?.data?.nearest, name).toBeNull()
      expect(frame.error?.message).toBe(`Unknown tool "${name}". No tool has a name close to it; tools/list has all 23.`)
    }
  })

  it("answers a call with no tool name the same way, with nothing to suggest", async () => {
    const connection = bridge()
    connection.request(1, "tools/call", {})
    await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
    const frame = connection.frames[0]!
    expect(frame.error?.code).toBe(-32602)
    expect(frame.error?.message).toBe("tools/call needs params.name, the tool to call. tools/list has all 23.")
    expect(frame.error?.data).toMatchObject({ code: "unknown-door", tool: null, nearest: null, candidates: [] })
  })
})

describe("isError results carry the card's text and fix", () => {
  const required: Array<[string, string]> = [
    ["send_message", "message"], ["ask", "question"], ["delegate", "task"], ["check_scope", "item"],
    ["request_decision", "topic"], ["check_guidance", "topic"], ["report_progress", "summary"],
    ["report_blocker", "blocker"], ["report_complete", "summary"], ["search_facts", "query"],
  ]

  it.each(required)("%s with no %s refuses without running anything, naming the argument", async (tool, arg) => {
    const frame = await call(tool, { [arg]: "  " })
    expectCardError(frame, tool, `missing-${arg}`)
    expect(frame.result!.content[0]!.text).toContain(arg)
    expect(runtime.send).not.toHaveBeenCalled()
    expect(runtime.status).not.toHaveBeenCalled()
  })

  it("a conversation tool says when the daemon isn't running", async () => {
    _setSenseTurnRetryDelays([0, 0, 0])
    runtime.send.mockRejectedValue(new Error("connect ECONNREFUSED /disposable.sock"))
    expectCardError(await call("delegate", { task: "ship it" }), "delegate", "daemon-not-running")
  })

  it("a conversation tool that times out says to check for a late reply before calling again", async () => {
    _setSenseTurnCommandTimeoutMs(5)
    runtime.send.mockReturnValue(new Promise(() => undefined))
    const frame = await call("ask", { question: "what now?" })
    expectCardError(frame, "ask", "turn-timed-out")
    expect(errorOf("ask", "turn-timed-out").fix).toContain("send_message")
    expect(errorOf("ask", "turn-timed-out").fix).not.toContain("check_response")
  })

  it("a turn the agent reports as failed carries its reason", async () => {
    runtime.send.mockResolvedValue({ ok: false, message: "provider anthropic is unreachable" })
    expectCardError(await call("send_message", { message: "hi" }), "send_message", "turn-failed", "provider anthropic is unreachable")
  })

  it("a turn that fails another way carries the error", async () => {
    runtime.send.mockRejectedValue(new Error("socket hung up"))
    expectCardError(await call("check_scope", { item: "a new flag" }), "check_scope", "turn-failed", "socket hung up")
  })

  it("a read tool that can't read the agent says so", async () => {
    runtime.status.mockRejectedValue(new Error("EACCES: permission denied"))
    expectCardError(await call("status"), "status", "agent-unreadable", "EACCES: permission denied")
  })

  it("a read the agent service refuses carries its reason", async () => {
    runtime.status.mockResolvedValue({ ok: false, error: "no such agent" })
    expectCardError(await call("get_task"), "get_task", "agent-unreadable", "no such agent")
  })

  it("a read answers with the service's message, else its summary, else its data", async () => {
    runtime.status.mockResolvedValueOnce({ ok: true, message: "up" })
    expect((await call("status")).result?.content[0]!.text).toBe("up")
    runtime.status.mockResolvedValueOnce({ ok: true, summary: "two sessions" })
    expect((await call("catchup")).result?.content[0]!.text).toBe("two sessions")
    runtime.status.mockResolvedValueOnce({ ok: true, data: { facts: 3 } })
    expect((await call("search_facts", { query: "x" })).result?.content[0]!.text).toBe('{"facts":3}')
    runtime.status.mockResolvedValueOnce({ ok: true })
    expect((await call("get_task")).result?.content[0]!.text).toBe('{"ok":true}')
  })

  it("check_response says when the pending folder can't be read", async () => {
    runtime.drain.mockImplementationOnce(() => { throw new Error("EIO: i/o error") })
    expectCardError(await call("check_response"), "check_response", "pending-unreadable", "EIO: i/o error")
  })

  const id = "11111111-1111-4111-8111-111111111111"
  it("shepherd_feedback refuses a bad request_id or an extra argument", async () => {
    expectCardError(await call("shepherd_feedback", { request_id: "bad", feedback: "x" }), "shepherd_feedback", "invalid-feedback-request", "(invalid)")
    expectCardError(await call("shepherd_feedback", { request_id: id, feedback: "x", session: "other" }), "shepherd_feedback", "invalid-feedback-request")
  })

  it("shepherd_feedback refuses feedback that is empty or too large", async () => {
    expectCardError(await call("shepherd_feedback", { request_id: id, feedback: " " }), "shepherd_feedback", "feedback-size")
    expectCardError(await call("shepherd_feedback", { request_id: id, feedback: "x".repeat(2001) }), "shepherd_feedback", "feedback-size")
  })

  it("shepherd_feedback with no confirmed receipt says to check status under the same id", async () => {
    runtime.send.mockRejectedValue(new Error("socket closed after submit"))
    const frame = await call("shepherd_feedback", { request_id: id, feedback: "You missed this." })
    expectCardError(frame, "shepherd_feedback", "feedback-unconfirmed", id)
    expect(errorOf("shepherd_feedback", "feedback-unconfirmed").fix).toContain("shepherd_feedback_status")
  })

  it("shepherd_feedback_status refuses a bad request_id and says when it can't confirm", async () => {
    expectCardError(await call("shepherd_feedback_status", { request_id: "bad" }), "shepherd_feedback_status", "invalid-status-request")
    runtime.send.mockResolvedValue({ ok: false, error: "no such request" })
    expectCardError(await call("shepherd_feedback_status", { request_id: id }), "shepherd_feedback_status", "status-unconfirmed", "no such request")
  })
})

describe("initialize", () => {
  it.each([["2025-11-25", "2025-11-25"], ["2025-06-18", "2025-06-18"], ["2024-11-05", "2024-11-05"], ["2099-01-01", "2025-11-25"], [undefined, "2025-11-25"]])(
    "answers a request for %s with %s", async (requested, answered) => {
      const connection = bridge()
      connection.request(1, "initialize", requested ? { protocolVersion: requested } : undefined)
      await vi.waitFor(() => expect(connection.frames).toHaveLength(1))
      expect(connection.frames[0]!.result!.protocolVersion).toBe(answered)
    })
})
