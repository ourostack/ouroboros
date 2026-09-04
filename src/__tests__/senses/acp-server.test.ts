import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

class FakeFrontendClient {
  requests: Array<{ method: string; params: any }> = []
  listener: ((event: any) => void) | null = null
  closeListener: ((error?: Error) => void) | null = null
  close = vi.fn()
  loadResult: any = { events: [], lastSequence: 0, hasMore: false, degraded: false, incompleteTurnIds: [] }
  failMethod: string | null = null
  failure: unknown = null

  async request(method: string, params: any): Promise<any> {
    this.requests.push({ method, params })
    if (method === this.failMethod) throw this.failure
    if (method === "session.load") return this.loadResult
    if (method === "turn.cancel") return { cancelled: true }
    return { accepted: true }
  }

  onEvent(listener: (event: any) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListener = listener
    return () => { this.closeListener = null }
  }

  emit(event: any): void {
    this.listener?.(event)
  }

  disconnect(error?: Error): void {
    this.closeListener?.(error)
  }
}

function collect(output: PassThrough) {
  const messages: any[] = []
  let buffer = ""
  output.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) messages.push(JSON.parse(line))
    }
  })
  return messages
}

async function waitFor(messages: any[], predicate: (message: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = messages.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("ACP message did not arrive")
}

async function setup(overrides: Record<string, unknown> = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const client = new FakeFrontendClient()
  const { createAcpServer } = await import("../../senses/acp-server")
  const server = createAcpServer({
    agent: "boss",
    friendId: "local-ari",
    frontendSocketPath: "/tmp/frontend.sock",
    stdin: input,
    stdout: output,
    createFrontendClient: async () => client,
    ...overrides,
  })
  server.start()
  return { input, output, client, server, messages: collect(output) }
}

describe("Ouro ACP server", () => {
  it("initializes, creates a session, streams a turn, and returns end_turn", async () => {
    const runtimeMcpServers = {
      ouro_workbench: { command: "/Applications/OuroWorkbenchMCP", args: [] },
    }
    const { input, client, server, messages } = await setup({ runtimeMcpServers })
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    expect(await waitFor(messages, (message) => message.id === 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    })

    input.write('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}\n')
    const created = await waitFor(messages, (message) => message.id === 2)
    expect(created.result.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.result.friendId).toBe("local-ari")
    expect(client.requests.at(-1)).toEqual({
      method: "session.subscribe",
      params: { sessionKey: created.result.sessionId },
    })

    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "hello " }, { type: "text", text: "boss" }],
      },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")
    const started = client.requests.find((request) => request.method === "turn.start")!
    expect(started.params).toMatchObject({
      agent: "boss",
      friendId: "local-ari",
      channel: "mcp",
      sessionKey: created.result.sessionId,
      message: "hello boss",
      runtimeMcpServers,
    })
    client.emit({ event: "text.delta", sessionKey: created.result.sessionId, turnId: started.params.turnId, text: "Hi" })
    client.emit({ event: "reasoning.delta", sessionKey: created.result.sessionId, turnId: started.params.turnId, text: "Think" })
    client.emit({ event: "tool.started", sessionKey: created.result.sessionId, turnId: started.params.turnId, name: "read_file", args: { path: "/tmp/a" } })
    client.emit({ event: "tool.completed", sessionKey: created.result.sessionId, turnId: started.params.turnId, name: "read_file", summary: "ok", success: true })
    client.emit({
      event: "structured.output",
      sessionKey: created.result.sessionId,
      turnId: started.params.turnId,
      output: { kind: "ordered_list", items: [{ text: "First" }] },
    })
    client.emit({ event: "turn.completed", sessionKey: created.result.sessionId, turnId: started.params.turnId })

    expect(await waitFor(messages, (message) => message.id === 3)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { stopReason: "end_turn" },
    })
    expect(messages.filter((message) => message.method === "session/update").map((message) => message.params.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
    ])
    server.stop()
  })

  it("loads and replays an existing Ouro session without creating a replacement", async () => {
    const { input, client, server, messages } = await setup()
    client.loadResult = {
      events: [
        { type: "user_message", data: { text: "question" }, turnId: "turn-1" },
        { type: "assistant_delivery", data: { text: "answer" }, turnId: "turn-1" },
        { type: "tool_started", data: { name: "read_file", args: {} }, turnId: "turn-1" },
        { type: "tool_completed", data: { name: "read_file", summary: "ok", success: true }, turnId: "turn-1" },
        { type: "tool_started", data: {}, turnId: "turn-2" },
        { type: "tool_completed", data: { success: false }, turnId: "turn-2" },
        { type: "structured_output", data: { output: { items: [{}, { text: " " }, { text: "Valid" }] } }, turnId: "turn-2" },
        { type: "structured_output", data: {}, turnId: "turn-2" },
        { type: "user_message", data: {}, turnId: "turn-2" },
        { type: "assistant_delivery", data: {}, turnId: "turn-2" },
        { type: "ignored", turnId: "turn-2" },
      ],
      lastSequence: 11,
      hasMore: false,
      degraded: false,
      incompleteTurnIds: [],
    }
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"existing-session","cwd":"/tmp","mcpServers":[]}}\n')

    expect(await waitFor(messages, (message) => message.id === 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    })
    expect(client.requests.filter((request) => request.method === "session.load" || request.method === "session.subscribe")).toEqual([
      {
        method: "session.load",
        params: { agent: "boss", friendId: "local-ari", sessionKey: "existing-session", afterSequence: 0 },
      },
      { method: "session.subscribe", params: { sessionKey: "existing-session" } },
    ])
    expect(messages.filter((message) => message.method === "session/update").map((message) => message.params.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "plan",
      "plan",
    ])
    expect(client.requests.some((request) => request.method === "turn.start")).toBe(false)
    server.stop()
  })

  it("adopts a safe client-owned session id and rejects invalid or duplicate ids", async () => {
    const { input, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"sessionId":"boss-session"}}\n')
    expect(await waitFor(messages, (message) => message.id === 1)).toMatchObject({
      result: { sessionId: "boss-session", friendId: "local-ari" },
    })
    input.write('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"sessionId":"../unsafe"}}\n')
    input.write('{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"sessionId":"boss-session"}}\n')
    expect((await waitFor(messages, (message) => message.id === 2)).error).toMatchObject({
      code: -32602,
      message: "sessionId must be a safe identifier",
    })
    expect((await waitFor(messages, (message) => message.id === 3)).error).toMatchObject({
      code: -32002,
      message: "session already exists: boss-session",
    })
    server.stop()
  })

  it("reissues an in-memory pending permission after session load", async () => {
    const { input, client, server, messages } = await setup()
    client.loadResult = {
      events: [{ type: "turn_started", data: {}, turnId: "turn-1" }],
      lastSequence: 1,
      hasMore: false,
      degraded: false,
      incompleteTurnIds: ["turn-1"],
      pendingPermissions: [{
        requestId: "approval-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        title: "Approve shell",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      }, {
        requestId: 7,
        turnId: "turn-1",
      }, {
        requestId: "approval-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        title: "Approve shell",
        options: [],
      }],
    }
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"existing-session"}}\n')

    await waitFor(messages, (message) => message.id === 1)
    const permission = await waitFor(messages, (message) => message.method === "session/request_permission")
    expect(permission.params).toMatchObject({
      sessionId: "existing-session",
      toolCall: { toolCallId: "call-1", title: "Approve shell" },
    })
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "permission.resolve")
    expect(client.requests.at(-1)).toEqual({
      method: "permission.resolve",
      params: { requestId: "approval-1", optionId: "reject-once" },
    })
    server.stop()
  })

  it("rejects a missing session instead of silently starting another", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"missing","cwd":"/tmp","mcpServers":[]}}\n')

    expect(await waitFor(messages, (message) => message.id === 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "session not found" },
    })
    expect(client.requests.some((request) => request.method === "turn.start")).toBe(false)
    server.stop()
  })

  it("cancels the active prompt and returns a cancelled stop reason", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "wait" }] },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")
    const turnId = client.requests.find((request) => request.method === "turn.start")!.params.turnId
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })}\n`)

    await waitFor(client.requests, (request) => request.method === "turn.cancel")
    expect(client.requests.at(-1)).toEqual({ method: "turn.cancel", params: { turnId } })
    client.emit({ event: "turn.cancelled", sessionKey: sessionId, turnId })
    expect(await waitFor(messages, (message) => message.id === 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "cancelled" },
    })
    server.stop()
  })

  it("bridges one correlated Ouro permission request and client response", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "restart it" }] },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")
    const turnId = client.requests.find((request) => request.method === "turn.start")!.params.turnId
    client.emit({
      event: "permission.requested",
      sessionKey: sessionId,
      turnId,
      requestId: "approval-1",
      toolCallId: "call-1",
      title: "Approve unraid_restart_container",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    })

    const reverse = await waitFor(messages, (message) => message.method === "session/request_permission")
    expect(reverse).toMatchObject({
      jsonrpc: "2.0",
      id: expect.stringMatching(/^ouro:/),
      params: {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "Approve unraid_restart_container" },
      },
    })
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: reverse.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    })}\n`)

    await waitFor(client.requests, (request) => request.method === "permission.resolve")
    expect(client.requests.at(-1)).toEqual({
      method: "permission.resolve",
      params: { requestId: "approval-1", optionId: "allow-once" },
    })
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId })
    await expect(waitFor(messages, (message) => message.id === 2)).resolves.toMatchObject({
      result: { stopReason: "end_turn" },
    })
    server.stop()
  })

  it("rejects an active prompt when the frontend provider disconnects", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "wait" }] },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")

    client.disconnect(new Error("frontend provider exited"))

    expect((await waitFor(messages, (message) => message.id === 2)).error).toEqual({
      code: -32000,
      message: "frontend provider exited",
    })
    server.stop()
  })

  it("defaults a provider disconnect without an error", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "wait" }] },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")

    client.disconnect()

    expect((await waitFor(messages, (message) => message.id === 2)).error).toEqual({
      code: -32000,
      message: "frontend provider disconnected",
    })
    server.stop()
  })

  it("validates reverse responses and cancels malformed permission outcomes", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    client.emit({ event: "permission.requested", sessionKey: sessionId, turnId: "none", requestId: "ignored" })
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "restart it" }] },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")
    const turnId = client.requests.find((request) => request.method === "turn.start")!.params.turnId
    client.emit({ event: "permission.requested", sessionKey: sessionId, turnId, requestId: 7 })
    client.emit({ event: "permission.requested", sessionKey: sessionId, turnId, requestId: "" })
    client.emit({ event: "permission.requested", sessionKey: sessionId, turnId: "wrong", requestId: "ignored" })
    client.emit({ event: "permission.requested", sessionKey: sessionId, turnId, requestId: "approval-2" })

    const reverse = await waitFor(messages, (message) =>
      message.method === "session/request_permission" && message.params.toolCall.toolCallId === "approval-2")
    expect(reverse.params).toEqual({
      sessionId,
      toolCall: { toolCallId: "approval-2", title: "Permission requested" },
      options: [],
    })

    input.write('{"jsonrpc":"2.0","id":7,"result":{}}\n')
    input.write('{"jsonrpc":"2.0","id":"ouro:missing","result":{}}\n')
    input.write(`${JSON.stringify({ jsonrpc: "1.0", id: reverse.id, result: {} })}\n`)
    await waitFor(messages, (message) => message.id === 7)
    await waitFor(messages, (message) => message.id === "ouro:missing")
    await waitFor(messages, (message) => message.id === reverse.id && message.error)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: reverse.id, error: { code: -32000, message: "cancel" } })}\n`)

    await waitFor(client.requests, (request) =>
      request.method === "permission.resolve" && request.params.requestId === "approval-2")
    expect(client.requests.at(-1)).toEqual({
      method: "permission.resolve",
      params: { requestId: "approval-2", optionId: "cancelled" },
    })
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId })
    await waitFor(messages, (message) => message.id === 2)
    server.stop()
  })

  it("returns typed protocol errors and cleans its frontend client", async () => {
    const { input, client, server, messages } = await setup()
    input.write("not-json\n")
    input.write('{"jsonrpc":"1.0","id":1,"method":"initialize","params":{}}\n')
    input.write('{"jsonrpc":"2.0","id":2,"method":"unknown","params":{}}\n')
    input.write('{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"missing","prompt":[]}}\n')
    input.write('{"jsonrpc":"2.0","id":4,"method":"session/new","params":{}}\n')

    await waitFor(messages, (message) => message.id === 4)
    expect(messages.slice(0, 4)).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "jsonrpc must be 2.0" } },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "method not found: unknown" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32001, message: "unknown session: missing" } },
    ])

    server.stop()
    expect(client.close).toHaveBeenCalledOnce()
  })

  it("rejects invalid versions, params, prompts, and overlapping turns", async () => {
    const { input, client, server, messages } = await setup()
    server.start()
    input.write("\n")
    input.write('{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":1}}\n')
    input.write('{"jsonrpc":"1.0","method":"initialize","params":{}}\n')
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}\n')
    input.write('{"jsonrpc":"2.0","method":"session/new","params":{}}\n')
    input.write('{"jsonrpc":"2.0","method":"session/load","params":{}}\n')
    input.write('{"jsonrpc":"2.0","method":"session/prompt","params":{}}\n')
    input.write('{"jsonrpc":"2.0","id":2,"method":7,"params":{}}\n')
    input.write('{"jsonrpc":"2.0","id":3,"method":"session/new","params":[]}\n')
    input.write('{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"missing","prompt":"text"}}\n')
    input.write('{"jsonrpc":"2.0","id":5,"method":"session/new"}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 5)).result.sessionId
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId, prompt: [] } })}\n`)
    await waitFor(messages, (message) => message.id === 6)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId, prompt: [{ type: "image" }] } })}\n`)
    await waitFor(messages, (message) => message.id === 7)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "session/prompt", params: { sessionId, prompt: "text" } })}\n`)
    await waitFor(messages, (message) => message.id === 10)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "first" }] } })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "second" }] } })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "no-active" } })}\n`)

    await waitFor(messages, (message) => message.id === 9)
    expect(messages.find((message) => message.id === 1)?.error).toEqual({ code: -32602, message: "protocolVersion must be 1" })
    expect(messages.find((message) => message.id === 2)?.error).toEqual({ code: -32602, message: "method must be a non-empty string" })
    expect(messages.find((message) => message.id === 3)?.error).toEqual({ code: -32602, message: "params must be an object" })
    expect(messages.find((message) => message.id === 4)?.error).toEqual({ code: -32001, message: "unknown session: missing" })
    expect(messages.find((message) => message.id === 6)?.error).toEqual({ code: -32602, message: "prompt must contain text" })
    expect(messages.find((message) => message.id === 7)?.error).toEqual({ code: -32602, message: "prompt must contain text" })
    expect(messages.find((message) => message.id === 10)?.error).toEqual({ code: -32602, message: "prompt must be an array" })
    expect(messages.find((message) => message.id === 9)?.error).toEqual({ code: -32002, message: "session already has an active prompt" })

    const active = client.requests.find((request) => request.method === "turn.start")!
    client.emit({ event: "ignored", sessionKey: 7, turnId: 7 })
    client.emit({ event: "ignored", sessionKey: sessionId, turnId: 7 })
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: "other" })
    client.emit({ event: "text.delta", sessionKey: "unknown", turnId: active.params.turnId, text: "ignored" })
    client.emit({ event: "text.delta", sessionKey: sessionId, turnId: active.params.turnId })
    client.emit({ event: "reasoning.delta", sessionKey: sessionId, turnId: active.params.turnId })
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: active.params.turnId })
    await waitFor(messages, (message) => message.id === 8)
    server.stop()
    server.stop()
  })

  it("returns terminal frontend failures and hostile dependency errors", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "fail" }] } })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")
    const turnId = client.requests.find((request) => request.method === "turn.start")!.params.turnId
    client.emit({ event: "turn.failed", sessionKey: sessionId, turnId })
    expect((await waitFor(messages, (message) => message.id === 2)).error).toEqual({
      code: -32000,
      message: "frontend turn failed",
    })

    client.failMethod = "session.load"
    client.failure = "hostile dependency"
    input.write('{"jsonrpc":"2.0","id":3,"method":"session/load","params":{"sessionId":"existing"}}\n')
    expect((await waitFor(messages, (message) => message.id === 3)).error).toEqual({
      code: -32000,
      message: "hostile dependency",
    })
    server.stop()
  })

  it("stops cleanly before creating a frontend client", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new FakeFrontendClient()
    const { createAcpServer } = await import("../../senses/acp-server")
    const server = createAcpServer({
      agent: "boss",
      friendId: "local-ari",
      frontendSocketPath: "/tmp/frontend.sock",
      stdin: input,
      stdout: output,
      createFrontendClient: async () => client,
    })

    server.stop()
    server.start()
    server.stop()
    server.stop()
    expect(client.close).not.toHaveBeenCalled()
  })

  it("rejects an active prompt when the ACP server stops", async () => {
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}\n')
    const sessionId = (await waitFor(messages, (message) => message.id === 1)).result.sessionId
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "wait" }] },
    })}\n`)
    await waitFor(client.requests, (request) => request.method === "turn.start")

    server.stop()

    expect((await waitFor(messages, (message) => message.id === 2)).error).toEqual({
      code: -32000,
      message: "ACP server stopped",
    })
  })
})
