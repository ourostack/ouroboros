import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"

const identityState = vi.hoisted(() => ({ agentRoot: "" }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, accessSync: vi.fn(actual.accessSync) }
})

vi.mock("../../heart/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/identity")>()
  return { ...actual, getAgentRoot: () => identityState.agentRoot }
})

import { getAttachment, readRecentAttachments } from "../../heart/attachments/store"
import { minimalImages, pngBytes } from "../fixtures/minimal-images"

const tempDirs: string[] = []
const realAccessSync = vi.mocked(fs.accessSync).getMockImplementation()!

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-attachments-"))
  tempDirs.push(dir)
  identityState.agentRoot = dir
  return dir
}

afterEach(() => {
  vi.mocked(fs.accessSync).mockReset().mockImplementation(realAccessSync)
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

class FakeFrontendClient {
  requests: Array<{ method: string; params: any }> = []
  listener: ((event: any) => void) | null = null
  closeListener: ((error?: Error) => void) | null = null
  close = vi.fn()
  loadResult: any = { events: [], lastSequence: 0, hasMore: false, degraded: false, incompleteTurnIds: [] }
  failMethod: string | null = null
  failure: unknown = null
  promptCapabilities: any = { image: true }

  async request(method: string, params: any): Promise<any> {
    this.requests.push({ method, params })
    if (method === this.failMethod) throw this.failure
    if (method === "session.load") return this.loadResult
    if (method === "agent.prompt-capabilities") return this.promptCapabilities
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

let sessionRequestId = 1000

async function newSession(input: PassThrough, messages: any[]): Promise<string> {
  const id = sessionRequestId += 1
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } })}\n`)
  return (await waitFor(messages, (message) => message.id === id)).result.sessionId
}

describe("Ouro ACP server", () => {
  it.each(["initialize", "capability resolution", "ingress"])("requires ACP-local decoder availability at %s even when the daemon supports images", async (boundary) => {
    const agentRoot = makeAgentRoot()
    const daemonDirectory = path.resolve("/opt/local/bin")
    const decoder = path.join(daemonDirectory, process.platform === "win32" ? "magick.exe" : "magick")
    const guiPath = [path.resolve("/usr/bin"), path.resolve("/bin")].join(path.delimiter)
    vi.mocked(fs.accessSync).mockImplementation((candidate, mode) => {
      if (String(candidate) === decoder) return
      if (path.basename(String(candidate)) === path.basename(decoder)) throw Object.assign(new Error("decoder not found"), { code: "ENOENT" })
      return realAccessSync(candidate, mode)
    })
    const { imageValidationAvailable } = await import("../../heart/attachments/image-normalize")
    vi.stubEnv("PATH", daemonDirectory)
    const daemonCapability = { image: imageValidationAvailable() }
    expect(daemonCapability.image).toBe(true)
    const { input, client, server, messages } = await setup()
    client.promptCapabilities = daemonCapability
    try {
      if (boundary === "initialize") vi.stubEnv("PATH", guiPath)
      if (boundary === "capability resolution") {
        const request = client.request.bind(client)
        client.request = async (method, params) => {
          const reply = await request(method, params)
          if (method === "agent.prompt-capabilities") vi.stubEnv("PATH", guiPath)
          return reply
        }
      }
      input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
      const initialized = await waitFor(messages, (message) => message.id === 1)
      expect(initialized.result.agentCapabilities.promptCapabilities.image).toBe(boundary === "ingress")
      const sessionId = await newSession(input, messages)
      vi.stubEnv("PATH", guiPath)
      expect(imageValidationAvailable()).toBe(false)
      expect(client.promptCapabilities.image).toBe(true)
      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "session/prompt",
        params: { sessionId, prompt: [
          { type: "text", text: "do not silently send this without its image" },
          { type: "image", mimeType: "image/png", data: pngBytes().toString("base64") },
        ] },
      })}\n`)
      expect(await waitFor(messages, (message) => message.id === 3)).toMatchObject({
        error: { code: -32602, message: expect.stringContaining("decoder") },
      })
      expect(client.requests.some((request) => request.method.startsWith("turn.start"))).toBe(false)
      expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)

      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "ordinary text still works" }] },
      })}\n`)
      const started = await waitFor(client.requests, (request) => request.method === "turn.start")
      expect(started.params).toMatchObject({ message: "ordinary text still works", attachmentIds: [] })
      client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: started.params.turnId })
      expect((await waitFor(messages, (message) => message.id === 4)).result.stopReason).toBe("end_turn")
    } finally {
      server.stop()
    }
  })

  it("withholds images on unavailable model capability while keeping text turns usable", async () => {
    const { input, client, server, messages } = await setup()
    client.failMethod = "agent.prompt-capabilities"
    client.failure = new Error("capability unavailable")
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    expect((await waitFor(messages, (message) => message.id === 1)).result.agentCapabilities.promptCapabilities.image).toBe(false)
    const sessionId = await newSession(input, messages)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello" }] } })}\n`)
    const started = await waitFor(client.requests, (request) => request.method === "turn.start")
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: started.params.turnId })
    expect((await waitFor(messages, (message) => message.id === 3)).result.stopReason).toBe("end_turn")
    server.stop()
  })

  it.each([{}, { image: false }, { image: "true" }, null])("requires positive daemon model capability before advertising images: %j", async (capabilities) => {
    const { input, client, server, messages } = await setup()
    client.promptCapabilities = capabilities
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    const initialized = await waitFor(messages, (message) => message.id === 1)
    server.stop()
    expect(initialized.result.agentCapabilities.promptCapabilities.image).toBe(false)
  })

  it("revalidates daemon model capability before storing an image prompt", async () => {
    const agentRoot = makeAgentRoot()
    const { input, client, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    expect((await waitFor(messages, (message) => message.id === 1)).result.agentCapabilities.promptCapabilities.image).toBe(true)
    const sessionId = await newSession(input, messages)
    client.promptCapabilities = { image: false }
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }] },
    })}\n`)
    await vi.waitFor(() => expect(messages.some((message) => message.id === 3) || client.requests.some((request) => request.method === "turn.start")).toBe(true))
    const started = client.requests.find((request) => request.method === "turn.start")
    if (started) client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: started.params.turnId })
    const reply = await waitFor(messages, (message) => message.id === 3)
    server.stop()
    expect(reply.error?.message).toMatch(/model.*image/)
    expect(reply.error?.message).toContain("decoder")
    expect(started).toBeUndefined()
    expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
  })

  it.each([false, true])("rolls back only new uploads after a confirmed busy-session rejection (reused=%s)", async (reuse) => {
    const agentRoot = makeAgentRoot()
    const { ingestInlinePromptImages } = await import("../../heart/attachments/inline-image")
    const existing = reuse ? ingestInlinePromptImages("boss", [{ data: pngBytes("existing").toString("base64"), mimeType: "image/png" }]) : []
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const { SocketFrontendClient } = await import("../../heart/frontend-socket-client")
    const service = new FrontendSessionService({ getProviderRuntime: async () => ({ model: "gpt-5.4" }) as never, runner: async () => ({
      response: "ok", turnOutcome: "settled", ponderDeferred: false, deliveries: [], deliveryFailures: [],
    }) })
    const frontend = await startFrontendSocketServer({ socketPath: path.join(agentRoot, "frontend.sock"), service })
    const { input, server, messages } = await setup({ createFrontendClient: async () => new SocketFrontendClient(frontend.socketPath) })
    const sessionId = await newSession(input, messages)
    const occupied = service.prepareTurn({
      turnId: "occupied", agent: "boss", friendId: "local-ari", channel: "mcp", sessionKey: sessionId, message: "busy",
    })
    try {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "session/prompt",
        params: { sessionId, prompt: [...(reuse ? ["existing"] : []), "new"].map((label) => ({
          type: "image", mimeType: "image/png", data: pngBytes(label).toString("base64"),
        })) },
      })}\n`)
      expect((await waitFor(messages, (message) => message.id === 3)).error.message).toContain("active turn")
      expect(readRecentAttachments("boss", agentRoot).map((record) => record.id)).toEqual(existing.map((record) => record.id))
      for (const record of existing) expect(fs.readFileSync(record.sourceData.path)).toEqual(pngBytes("existing"))
      const inline = path.join(agentRoot, "state", "attachments", "inline")
      const images = fs.existsSync(inline) ? fs.readdirSync(inline, { recursive: true }).filter((file) => String(file).endsWith(".png")) : []
      expect(images).toHaveLength(existing.length)
    } finally {
      await service.runPreparedTurn(occupied)
      server.stop()
      await frontend.stop()
    }
  })

  it("cancels before admission without submitting a turn or retaining uploads", async () => {
    const agentRoot = makeAgentRoot()
    const { input, client, server, messages } = await setup()
    const sessionId = await newSession(input, messages)
    input.write([
      { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }] } },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } },
    ].map((frame) => JSON.stringify(frame)).join("\n") + "\n")
    await vi.waitFor(() => expect(messages.some((message) => message.id === 3) || client.requests.some((request) => request.method === "turn.start")).toBe(true))
    const started = client.requests.find((request) => request.method === "turn.start")
    if (started) client.emit({ event: "turn.cancelled", sessionKey: sessionId, turnId: started.params.turnId })
    expect((await waitFor(messages, (message) => message.id === 3)).result).toEqual({ stopReason: "cancelled" })
    server.stop()
    expect(started).toBeUndefined()
    expect(readRecentAttachments("boss", agentRoot)).toEqual([])
  })

  it("retains uploads when admission is uncertain after a transport failure", async () => {
    const agentRoot = makeAgentRoot()
    const { input, client, server, messages } = await setup()
    const sessionId = await newSession(input, messages)
    client.failMethod = "turn.start"
    client.failure = new Error("frontend socket closed")
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "session/prompt",
      params: { sessionId, prompt: [{ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") }] },
    })}\n`)
    expect((await waitFor(messages, (message) => message.id === 3)).error.message).toBe("frontend socket closed")
    server.stop()
    const records = readRecentAttachments("boss", agentRoot)
    expect(records).toHaveLength(1)
    expect(fs.readFileSync((records[0]!.sourceData as any).path)).toEqual(pngBytes())
  })

  it("initializes, creates a session, streams a turn, and returns end_turn", async () => {
    const runtimeMcpServers = {
      ouro_workbench: { command: "/Applications/OuroWorkbenchMCP", args: [] },
    }
    const { input, client, server, messages } = await setup({ runtimeMcpServers })
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    expect(await waitFor(messages, (message) => message.id === 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
        },
      },
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
    expect(started.params.attachmentIds).toEqual([])
  })

  it("advertises image prompt capability during initialization", async () => {
    const { input, server, messages } = await setup()
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')

    expect(await waitFor(messages, (message) => message.id === 1)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
        },
      },
    })
    server.stop()
  })

  it("withholds image prompt capability and rejects image content in observe-only mode", async () => {
    makeAgentRoot()
    const { input, client, server, messages } = await setup({ disableTools: true })
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')

    expect((await waitFor(messages, (message) => message.id === 1)).result).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false },
      },
    })

    const sessionId = await newSession(input, messages)
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "image", data: "QQ==", mimeType: "image/png" }] },
    })}\n`)

    expect(await waitFor(messages, (message) => message.id === 3)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32602, message: "image prompt content is unavailable in observe-only mode" },
    })
    expect(client.requests.some((request) => request.method.startsWith("turn.start"))).toBe(false)
    server.stop()
  })

  it("accepts image-only and text+image prompts as canonical attachment turns", async () => {
    const agentRoot = makeAgentRoot()
    const { input, client, server, messages } = await setup()
    const sessionId = await newSession(input, messages)
    const png = pngBytes("acp-image-only").toString("base64")

    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "image", data: png, mimeType: "image/png", name: "screenshot.png" }] },
    })}\n`)
    const imageOnly = await waitFor(client.requests, (request) => request.method === "turn.start")

    expect(imageOnly.params.message).toContain("[attachments]")
    expect(imageOnly.params.message).toContain("| image | screenshot.png | image/png |")
    expect(imageOnly.params.attachmentIds).toEqual([expect.stringMatching(/^attachment:cli-local-file:/)])
    expect(imageOnly.params.requireImageSupport).toBe(true)
    expect(JSON.stringify(imageOnly.params)).not.toContain(png)
    expect(fs.readFileSync(
      (getAttachment("boss", imageOnly.params.attachmentIds[0], agentRoot) as any).sourceData.path,
    )).toEqual(pngBytes("acp-image-only"))
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: imageOnly.params.turnId })
    await waitFor(messages, (message) => message.id === 3)

    const second = minimalImages["image/jpeg"].toString("base64")
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          { type: "text", text: "what is " },
          { type: "text", text: "this?" },
          { type: "image", data: second, mimeType: "image/jpeg" },
        ],
      },
    })}\n`)
    const withText = await waitFor(
      client.requests,
      (request) => request.method === "turn.start" && request.params.turnId !== imageOnly.params.turnId,
    )

    expect(withText.params.message.startsWith("what is this?\n\n[attachments]")).toBe(true)
    expect(withText.params.attachmentIds).toHaveLength(1)
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: withText.params.turnId })
    await waitFor(messages, (message) => message.id === 4)
    server.stop()
  })

  it("collapses duplicate prompt images into one scoped attachment", async () => {
    makeAgentRoot()
    const { input, client, server, messages } = await setup()
    const sessionId = await newSession(input, messages)
    const data = pngBytes("acp-duplicate").toString("base64")

    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          { type: "image", data, mimeType: "image/png", name: "a.png" },
          { type: "image", data, mimeType: "image/png", name: "b.png" },
        ],
      },
    })}\n`)
    const started = await waitFor(client.requests, (request) => request.method === "turn.start")

    expect(started.params.attachmentIds).toHaveLength(1)
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: started.params.turnId })
    await waitFor(messages, (message) => message.id === 3)
    server.stop()
  })

  it("rejects malformed, unknown, and invalid image content without starting a turn", async () => {
    const agentRoot = makeAgentRoot()
    const { input, client, server, messages } = await setup()
    const sessionId = await newSession(input, messages)
    const cases: Array<[number, unknown, string]> = [
      [10, "not-an-array", "prompt must be an array"],
      [11, [null], "prompt content block must be an object"],
      [12, [["text"]], "prompt content block must be an object"],
      [13, [{ type: "text" }], "text content block must include text"],
      [14, [{ type: "audio", data: "AAAA" }], "unsupported prompt content block: audio"],
      [15, [{}], "unsupported prompt content block: missing type"],
      [16, [{ type: "image", mimeType: "image/png" }], "image content block must include data and mimeType"],
      [17, [{ type: "image", data: "QQ==", mimeType: "image/tiff" }], "unsupported image mime type: image/tiff"],
      [18, [{ type: "image", data: "not base64!!", mimeType: "image/png" }], "image data must be strict base64"],
      [19, [{ type: "image", data: "", mimeType: "image/png" }], "image data must not be empty"],
      [20, [{ type: "text", text: "  " }], "prompt must contain text"],
      [
        21,
        Array.from({ length: 5 }, (_unused, index) => ({
          type: "image",
          data: pngBytes(`too-many-${index}`).toString("base64"),
          mimeType: "image/png",
        })),
        "prompt supports at most 4 images",
      ],
    ]

    for (const [id, prompt, message] of cases) {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt } })}\n`)
      expect(await waitFor(messages, (candidate) => candidate.id === id)).toEqual({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message },
      })
    }

    expect(client.requests.some((request) => request.method === "turn.start")).toBe(false)
    expect(readRecentAttachments("boss", agentRoot)).toEqual([])
    server.stop()
  })

  it.each([
    ["invalid base64", { type: "image", mimeType: "image/png", data: "not base64!" }],
    ["incomplete image", { type: "image", mimeType: "image/png", data: pngBytes().subarray(0, 24).toString("base64") }],
    ["malformed text", { type: "text" }],
  ])("validates the complete ACP prompt before storage or admission: %s", async (_label, invalid) => {
    const agentRoot = makeAgentRoot()
    const { input, client, server, messages } = await setup()
    try {
      const sessionId = await newSession(input, messages)
      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "session/prompt",
        params: { sessionId, prompt: [
          { type: "image", mimeType: "image/png", data: pngBytes().toString("base64") },
          invalid,
        ] },
      })}\n`)
      expect((await waitFor(messages, (message) => message.id === 1)).error?.code).toBe(-32602)
      expect(client.requests.some((request) => request.method === "turn.start")).toBe(false)
      expect(fs.existsSync(path.join(agentRoot, "state", "attachments"))).toBe(false)
    } finally {
      server.stop()
    }
  })

  it("replays an attachment-bearing user turn as reference text without image bytes", async () => {
    makeAgentRoot()
    const { input, client, server, messages } = await setup()
    const data = pngBytes("acp-replayed-image").toString("base64")
    const sessionId = await newSession(input, messages)

    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "read it" }, { type: "image", data, mimeType: "image/png", name: "note.png" }] },
    })}\n`)
    const started = await waitFor(client.requests, (request) => request.method === "turn.start")
    client.emit({ event: "turn.completed", sessionKey: sessionId, turnId: started.params.turnId })
    await waitFor(messages, (message) => message.id === 3)

    client.loadResult = {
      events: [{
        type: "user_message",
        data: { text: started.params.message, attachmentIds: started.params.attachmentIds },
        turnId: started.params.turnId,
      }],
      lastSequence: 1,
      hasMore: false,
      degraded: false,
      incompleteTurnIds: [],
    }
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/load", params: { sessionId: "replayed-session", cwd: "/tmp", mcpServers: [] } })}\n`)
    await waitFor(messages, (message) => message.id === 4)

    const replayed = messages.filter((message) => message.method === "session/update")
      .filter((message) => message.params.sessionId === "replayed-session")
    expect(replayed).toHaveLength(1)
    expect(replayed[0].params.update.content.text).toContain(started.params.attachmentIds[0])
    expect(JSON.stringify(replayed)).not.toContain(data)
    server.stop()
  })

  it("marks observe-only prompts as tool-free frontend turns", async () => {
    const { input, client, server, messages } = await setup({ disableTools: true })
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    await waitFor(messages, (message) => message.id === 1)
    input.write('{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}\n')
    const created = await waitFor(messages, (message) => message.id === 2)
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: created.result.sessionId, prompt: [{ type: "text", text: "observe" }] },
    })}\n`)
    const started = await waitFor(client.requests, (request) => request.method === "turn.start.observe-only")
    expect(started.params.runtimeMcpServers).toBeUndefined()
    client.emit({ event: "turn.completed", sessionKey: created.result.sessionId, turnId: started.params.turnId })
    await waitFor(messages, (message) => message.id === 3)
    server.stop()
  })

  it("does not load durable Ouro sessions in observe-only mode", async () => {
    const { input, client, server, messages } = await setup({ disableTools: true })
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n')
    await waitFor(messages, (message) => message.id === 1)
    input.write('{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"existing-session","cwd":"/tmp","mcpServers":[]}}\n')

    expect(await waitFor(messages, (message) => message.id === 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "session/load is unavailable in observe-only mode" },
    })
    expect(client.requests.some((request) => request.method === "session.load")).toBe(false)
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
    expect(messages.find((message) => message.id === 7)?.error).toEqual({ code: -32602, message: "image content block must include data and mimeType" })
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

  it("separates client-fixable rejections from storage faults and hostile throws", async () => {
    const cases: Array<[number, unknown, number, string]> = [
      [3, () => { throw new Error("attachment catalog is read-only") }, -32603, "attachment catalog is read-only"],
      [4, () => { throw "hostile ingestion failure" }, -32603, "hostile ingestion failure"],
    ]

    for (const [id, thrower, code, message] of cases) {
      vi.resetModules()
      vi.doMock("../../heart/attachments/inline-image", () => ({
        InlinePromptImageRejection: class extends Error {},
        prepareInlinePromptImages: thrower,
      }))
      try {
        makeAgentRoot()
        const { input, client, server, messages } = await setup()
        const sessionId = await newSession(input, messages)
        input.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "image", data: pngBytes().toString("base64"), mimeType: "image/png" }] },
        })}\n`)

        expect(await waitFor(messages, (candidate) => candidate.id === id)).toEqual({
          jsonrpc: "2.0",
          id,
          error: { code, message },
        })
        expect(client.requests.some((request) => request.method === "turn.start")).toBe(false)
        server.stop()
      } finally {
        vi.doUnmock("../../heart/attachments/inline-image")
        vi.resetModules()
      }
    }
  })
})
