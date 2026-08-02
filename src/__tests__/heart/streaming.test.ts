import { describe, it, expect, vi, beforeEach } from "vitest"
import * as nodeFs from "node:fs"
import * as path from "path"
import type { ChannelCallbacks } from "../../heart/core"

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

describe("toResponsesTools", () => {
  let toResponsesTools: (ccTools: any[]) => any[]
  let tools: any[]

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const streaming = await import("../../heart/streaming")
    const toolsMod = await import("../../repertoire/tools")
    toResponsesTools = streaming.toResponsesTools
    tools = toolsMod.tools
  })

  it("converts a single CC tool to Responses API FunctionTool format", () => {
    const ccTools = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read file contents",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]

    const result = toResponsesTools(ccTools)
    expect(result).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "read file contents",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: false,
      },
    ])
  })

  it("converts all tools in the exported tools array", () => {
    const result = toResponsesTools(tools)
    expect(result).toHaveLength(tools.length)
    // Spot-check a couple
    const readFile = result.find((t: any) => t.name === "read_file")
    expect(readFile).toBeDefined()
    expect(readFile.type).toBe("function")
    expect(readFile.strict).toBe(false)
    expect(readFile.description).toContain("Read file contents")

    const shell = result.find((t: any) => t.name === "shell")
    expect(shell).toBeDefined()
    expect(shell.name).toBe("shell")
    expect(typeof shell.description).toBe("string")
  })

  it("sets description to null when undefined", () => {
    const ccTools = [
      {
        type: "function",
        function: {
          name: "no_desc",
          parameters: { type: "object", properties: {} },
        },
      },
    ]

    const result = toResponsesTools(ccTools)
    expect(result[0].description).toBeNull()
  })

  it("sets parameters to null when undefined", () => {
    const ccTools = [
      {
        type: "function",
        function: {
          name: "no_params",
          description: "a tool without params",
        },
      },
    ]

    const result = toResponsesTools(ccTools)
    expect(result[0].parameters).toBeNull()
  })
})

describe("provider module boundary contract", () => {
  it("has dedicated provider runtime modules for azure/anthropic/minimax", () => {
    const providerDir = path.resolve(__dirname, "..", "..", "heart", "providers")
    expect(nodeFs.existsSync(providerDir)).toBe(true)
    expect(nodeFs.existsSync(path.join(providerDir, "azure.ts"))).toBe(true)
    expect(nodeFs.existsSync(path.join(providerDir, "anthropic.ts"))).toBe(true)
    expect(nodeFs.existsSync(path.join(providerDir, "minimax.ts"))).toBe(true)
  })
})

describe("toResponsesInput", () => {
  let toResponsesInput: (messages: any[]) => { instructions: string; input: any[] }
  let truncateResponsesFunctionCallOutput: (output: string, maxChars?: number) => string
  let RESPONSES_FUNCTION_CALL_OUTPUT_CAP: number

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const core = await import("../../heart/streaming")
    toResponsesInput = core.toResponsesInput
    truncateResponsesFunctionCallOutput = core.truncateResponsesFunctionCallOutput
    RESPONSES_FUNCTION_CALL_OUTPUT_CAP = core.RESPONSES_FUNCTION_CALL_OUTPUT_CAP
  })

  it("extracts system message content into instructions", () => {
    const messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]
    const result = toResponsesInput(messages)
    expect(result.instructions).toBe("you are helpful")
    // System message should not appear in input
    expect(result.input.find((i: any) => i.role === "system")).toBeUndefined()
  })

  it("converts user message to input item", () => {
    const messages = [{ role: "user", content: "hi" }]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ role: "user", content: "hi" }])
  })

  it("falls back to empty user text when user content is neither string nor array", () => {
    const messages = [{ role: "user", content: { unexpected: true } as never }]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ role: "user", content: "" }])
  })

  it("converts assistant message (text only) to input item", () => {
    const messages = [{ role: "assistant", content: "hello" }]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ role: "assistant", content: "hello" }])
  })

  it("converts assistant with tool_calls to content + function_call items", () => {
    const messages = [
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      { role: "assistant", content: "let me check" },
      {
        type: "function_call",
        call_id: "tc1",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
        status: "completed",
      },
    ])
  })

  it("converts tool message to function_call_output item", () => {
    const messages = [
      { role: "tool", tool_call_id: "tc1", content: "file contents" },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      { type: "function_call_output", call_id: "tc1", output: "file contents" },
    ])
  })

  it("truncates oversized function_call_output items before rebuilding Responses input", () => {
    const oversized = "A".repeat(RESPONSES_FUNCTION_CALL_OUTPUT_CAP + 5000)
    const result = toResponsesInput([{ role: "tool", tool_call_id: "tc1", content: oversized }])
    expect(result.input).toHaveLength(1)
    const output = result.input[0]?.output
    expect(typeof output).toBe("string")
    expect(output.length).toBeLessThanOrEqual(RESPONSES_FUNCTION_CALL_OUTPUT_CAP)
    expect(output).toContain("[truncated — function_call_output exceeded")
    expect(output.startsWith("AAAA")).toBe(true)
    expect(output.endsWith("AAAA")).toBe(true)
  })

  it("preserves both the leading and trailing edge when truncating oversized function_call_output", () => {
    const output = truncateResponsesFunctionCallOutput(`${"A".repeat(5000)}${"B".repeat(5000)}`, 4000)
    expect(output.length).toBeLessThanOrEqual(4000)
    expect(output.startsWith("AAAA")).toBe(true)
    expect(output).toContain("[truncated — function_call_output exceeded 4000 chars; original length 10000 chars]")
    expect(output.endsWith("BBBB")).toBe(true)
  })

  it("returns empty instructions when no system message", () => {
    const messages = [{ role: "user", content: "hi" }]
    const result = toResponsesInput(messages)
    expect(result.instructions).toBe("")
  })

  it("preserves order in mixed multi-turn conversation", () => {
    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "read this file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"x.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", content: "data" },
      { role: "assistant", content: "here is the file" },
    ]
    const result = toResponsesInput(messages)
    expect(result.instructions).toBe("system prompt")
    expect(result.input).toHaveLength(6)
    expect(result.input[0]).toEqual({ role: "user", content: "hello" })
    expect(result.input[1]).toEqual({ role: "assistant", content: "hi there" })
    expect(result.input[2]).toEqual({ role: "user", content: "read this file" })
    expect(result.input[3]).toEqual({
      type: "function_call",
      call_id: "tc1",
      name: "read_file",
      arguments: '{"path":"x.txt"}',
      status: "completed",
    })
    expect(result.input[4]).toEqual({
      type: "function_call_output",
      call_id: "tc1",
      output: "data",
    })
    expect(result.input[5]).toEqual({ role: "assistant", content: "here is the file" })
  })

  it("returns empty instructions and empty input for empty messages", () => {
    const result = toResponsesInput([])
    expect(result.instructions).toBe("")
    expect(result.input).toEqual([])
  })

  it("omits assistant content message when content is empty/falsy with tool_calls", () => {
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "shell", arguments: '{"command":"ls"}' } },
        ],
      },
    ]
    const result = toResponsesInput(messages)
    // Only function_call item, no assistant content message
    expect(result.input).toEqual([
      {
        type: "function_call",
        call_id: "tc1",
        name: "shell",
        arguments: '{"command":"ls"}',
        status: "completed",
      },
    ])
  })

  it("only extracts first system message as instructions", () => {
    const messages = [
      { role: "system", content: "first system" },
      { role: "system", content: "second system" },
      { role: "user", content: "hi" },
    ]
    const result = toResponsesInput(messages)
    expect(result.instructions).toBe("first system")
    // Neither system message should appear in input
    expect(result.input).toEqual([{ role: "user", content: "hi" }])
  })

  it("handles system message with empty content", () => {
    const messages = [
      { role: "system", content: "" },
      { role: "user", content: "hi" },
    ]
    const result = toResponsesInput(messages)
    expect(result.instructions).toBe("")
  })

  it("silently skips messages with unknown roles", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "function", content: "legacy" } as any,
      { role: "user", content: "bye" },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "bye" },
    ])
  })

  it("handles non-string content in system message", () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: "hi" },
    ]
    const result = toResponsesInput(messages)
    expect(result.instructions).toBe("")
  })

  it("handles non-string content in user message", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ])
  })

  it("preserves multimodal user content for responses input", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,aGVsbG8=", detail: "auto" } },
          { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "mp3" } },
          { type: "file", file: { file_data: "ZmlsZQ==", filename: "notes.txt" } },
        ],
      },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "see attached" },
          { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=", detail: "auto" },
          { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "mp3" } },
          { type: "input_file", file_data: "ZmlsZQ==", filename: "notes.txt" },
        ],
      },
    ])
  })

  it("drops invalid multimodal user parts and preserves file-id attachments", () => {
    const messages = [
      {
        role: "user",
        content: [
          null,
          { type: "image_url", image_url: { url: "" } },
          { type: "input_audio", input_audio: { data: "YXVkaW8=", format: "m4a" } },
          { type: "file", file: { file_id: "file-123", filename: "cached.txt" } },
        ],
      },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_file", file_id: "file-123", filename: "cached.txt" }],
      },
    ])
  })

  it("defaults image detail, drops non-string image urls, and ignores filename-only file parts", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: 123 } },
          { type: "file", file: { file_id: "file-456" } },
          { type: "file", file: { filename: "name-only.txt" } },
        ],
      },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
          { type: "input_file", file_id: "file-456" },
        ],
      },
    ])
  })

  it("falls back to empty string when multimodal user content has no usable parts", () => {
    const messages = [
      {
        role: "user",
        content: [null, { type: "image_url", image_url: { url: "" } }],
      },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ role: "user", content: "" }])
  })

  it("handles non-string content in assistant message", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ role: "assistant", content: "" }])
  })

  it("handles non-string content in tool message", () => {
    const messages = [
      { role: "tool", tool_call_id: "tc1", content: [{ type: "text", text: "data" }] },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ type: "function_call_output", call_id: "tc1", output: "" }])
  })

  // --- Unit 1c: Restore reasoning items in toResponsesInput ---

  it("restores _reasoning_items before assistant content in input", () => {
    const reasoningItem = { type: "reasoning", id: "r1", summary: [{ text: "thought", type: "summary_text" }], encrypted_content: "enc1" }
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "answer", _reasoning_items: [reasoningItem] },
    ]
    const result = toResponsesInput(messages)
    // reasoning item should come BEFORE assistant content
    expect(result.input[0]).toEqual({ role: "user", content: "hi" })
    expect(result.input[1]).toEqual(reasoningItem)
    expect(result.input[2]).toEqual({ role: "assistant", content: "answer" })
  })

  it("does not modify input when assistant has no _reasoning_items", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "hello" },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([{ role: "assistant", content: "hello" }])
  })

  it("emits reasoning items as-is (not wrapped or modified)", () => {
    const reasoningItem = { type: "reasoning", id: "r2", summary: [{ text: "deep thought", type: "summary_text" }], encrypted_content: "secretenc" }
    const messages = [
      { role: "assistant", content: "response", _reasoning_items: [reasoningItem] },
    ]
    const result = toResponsesInput(messages)
    expect(result.input[0]).toBe(reasoningItem)
  })

  it("restores _reasoning_items for multiple assistant messages", () => {
    const r1 = { type: "reasoning", id: "r1", summary: [], encrypted_content: "enc1" }
    const r2 = { type: "reasoning", id: "r2", summary: [], encrypted_content: "enc2" }
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1", _reasoning_items: [r1] },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2", _reasoning_items: [r2] },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      { role: "user", content: "q1" },
      r1,
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      r2,
      { role: "assistant", content: "a2" },
    ])
  })

  it("emits items in order: reasoning, then content, then function_calls", () => {
    const r1 = { type: "reasoning", id: "r1", summary: [], encrypted_content: "enc" }
    const messages = [
      {
        role: "assistant",
        content: "let me check",
        _reasoning_items: [r1],
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        ],
      },
    ]
    const result = toResponsesInput(messages)
    expect(result.input).toEqual([
      r1,
      { role: "assistant", content: "let me check" },
      {
        type: "function_call",
        call_id: "tc1",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
        status: "completed",
      },
    ])
  })
})

describe("ChannelCallbacks interface", () => {
  it("accepts an object with all required callback signatures", () => {
    const callbacks: ChannelCallbacks = {
      onModelStart: () => {},
      onModelStreamStart: () => {},
      onTextChunk: (_text: string) => {},
      onReasoningChunk: (_text: string) => {},
      onToolStart: (_name: string, _args: Record<string, string>) => {},
      onToolEnd: (_name: string, _summary: string, _success: boolean) => {},
      onError: (_error: Error) => {},
    }
    // Type check passes if this compiles
    expect(callbacks).toBeDefined()
    expect(typeof callbacks.onModelStart).toBe("function")
    expect(typeof callbacks.onModelStreamStart).toBe("function")
    expect(typeof callbacks.onTextChunk).toBe("function")
    expect(typeof callbacks.onReasoningChunk).toBe("function")
    expect(typeof callbacks.onToolStart).toBe("function")
    expect(typeof callbacks.onToolEnd).toBe("function")
    expect(typeof callbacks.onError).toBe("function")
  })
})

describe("streamChatCompletion", () => {
  let streamChatCompletion: any

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[], reasoningContent?: string) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    if (reasoningContent !== undefined) delta.reasoning_content = reasoningContent
    return { choices: [{ delta }] }
  }

  function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
    return {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      settleOutputMode: "retractable_buffer",
      ...overrides,
    } as ChannelCallbacks
  }

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const core = await import("../../heart/streaming")
    streamChatCompletion = core.streamChatCompletion
  })

  it("returns TurnResult with content for text-only response", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([makeChunk("hello")])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result).toEqual({ content: "hello", toolCalls: [], outputItems: [], settleStreamed: false })
  })

  it("calls onModelStreamStart once on first content delta", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([makeChunk("a"), makeChunk("b")])) } } }
    const callbacks = makeCallbacks()
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(callbacks.onModelStreamStart).toHaveBeenCalledTimes(1)
  })

  it("calls onTextChunk for each content delta", async () => {
    const textChunks: string[] = []
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([makeChunk("a"), makeChunk("b")])) } } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(textChunks).toEqual(["a", "b"])
  })

  it("accumulates tool call deltas and returns them in toolCalls", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path"' } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: ':"a.txt"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }])
  })

  it("calls onReasoningChunk for reasoning_content delta", async () => {
    const reasoningChunks: string[] = []
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      { choices: [{ delta: { reasoning_content: "thinking" } }] },
    ])) } } }
    const callbacks = makeCallbacks({ onReasoningChunk: (text: string) => reasoningChunks.push(text) })
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(reasoningChunks).toEqual(["thinking"])
  })

  it("routes think tags through processContentBuf correctly", async () => {
    const reasoningChunks: string[] = []
    const textChunks: string[] = []
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk("<think>reasoning</think>answer"),
    ])) } } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => textChunks.push(text),
      onReasoningChunk: (text: string) => reasoningChunks.push(text),
    })
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(reasoningChunks.join("")).toBe("reasoning")
    expect(textChunks.join("")).toBe("answer")
  })

  it("handles mixed content + tool_calls in same response", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk("text"),
      makeChunk(undefined, [{ index: 0, id: "c1", function: { name: "shell", arguments: '{"command":"ls"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.content).toBe("text")
    expect(result.toolCalls).toHaveLength(1)
  })

  it("always returns empty outputItems (CC path)", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([makeChunk("hello")])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.outputItems).toEqual([])
  })

  it("respects abort signal during stream iteration", async () => {
    const controller = new AbortController()
    const client = { chat: { completions: { create: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield makeChunk("first")
        controller.abort()
        yield makeChunk("second")
      },
    }) } } }
    const textChunks: string[] = []
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks, controller.signal)
    expect(textChunks).toEqual(["first"])
  })

  it("propagates errors from client.chat.completions.create", async () => {
    const client = { chat: { completions: { create: vi.fn().mockImplementation(() => { throw new Error("API down") }) } } }
    const callbacks = makeCallbacks()
    await expect(streamChatCompletion(client, { messages: [], stream: true }, callbacks)).rejects.toThrow("API down")
  })

  // --- Unit 2c: Capture MiniMax usage ---

  it("adds stream_options: { include_usage: true } to create params", async () => {
    const createMock = vi.fn().mockReturnValue(makeStream([makeChunk("hello")]))
    const client = { chat: { completions: { create: createMock } } }
    const callbacks = makeCallbacks()
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    const passedParams = createMock.mock.calls[0][0]
    expect(passedParams.stream_options).toEqual({ include_usage: true })
  })

  it("captures usage from final chunk with chunk.usage", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk("hello"),
      { choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 }, total_tokens: 150 } },
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 10,
      total_tokens: 150,
    })
  })

  it("maps MiniMax usage fields correctly", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      { choices: [{ delta: {} }], usage: { prompt_tokens: 500, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 80 }, total_tokens: 700 } },
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.usage!.input_tokens).toBe(500)
    expect(result.usage!.output_tokens).toBe(200)
    expect(result.usage!.reasoning_tokens).toBe(80)
    expect(result.usage!.total_tokens).toBe(700)
  })

  it("returns undefined usage when no usage chunk arrives", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([makeChunk("hello")])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.usage).toBeUndefined()
  })

  it("defaults reasoning_tokens to 0 when completion_tokens_details is missing", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      { choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.usage!.reasoning_tokens).toBe(0)
  })
})

describe("streamResponsesApi", () => {
  let streamResponsesApi: any

  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
    return {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const core = await import("../../heart/streaming")
    streamResponsesApi = core.streamResponsesApi
  })

  it("calls client.responses.create with createParams and signal", async () => {
    const create = vi.fn().mockReturnValue(makeResponsesStream([]))
    const client = { responses: { create } }
    const callbacks = makeCallbacks()
    const params = { model: "gpt-5", stream: true }
    const controller = new AbortController()
    await streamResponsesApi(client, params, callbacks, controller.signal)
    expect(create).toHaveBeenCalledWith(params, { signal: controller.signal })
  })

  it("calls client.responses.create without signal options when no signal", async () => {
    const create = vi.fn().mockReturnValue(makeResponsesStream([]))
    const client = { responses: { create } }
    const callbacks = makeCallbacks()
    await streamResponsesApi(client, { model: "gpt-5" }, callbacks)
    expect(create).toHaveBeenCalledWith({ model: "gpt-5" }, {})
  })

  it("fires onTextChunk and accumulates content on text delta events", async () => {
    const textChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_text.delta", delta: " world" },
    ])) } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(textChunks).toEqual(["hello", " world"])
    expect(result.content).toBe("hello world")
  })

  it("fires onReasoningChunk on reasoning summary text delta events", async () => {
    const reasoningChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    ])) } }
    const callbacks = makeCallbacks({ onReasoningChunk: (text: string) => reasoningChunks.push(text) })
    await streamResponsesApi(client, {}, callbacks)
    expect(reasoningChunks).toEqual(["thinking"])
  })

  it("fires onModelStreamStart once on first text or reasoning delta", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "a" },
      { type: "response.reasoning_summary_text.delta", delta: "b" },
      { type: "response.output_text.delta", delta: "c" },
    ])) } }
    const callbacks = makeCallbacks()
    await streamResponsesApi(client, {}, callbacks)
    expect(callbacks.onModelStreamStart).toHaveBeenCalledTimes(1)
  })

  it("fires onModelStreamStart on first reasoning delta when no text", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.reasoning_summary_text.delta", delta: "think" },
    ])) } }
    const callbacks = makeCallbacks()
    await streamResponsesApi(client, {}, callbacks)
    expect(callbacks.onModelStreamStart).toHaveBeenCalledTimes(1)
  })

  it("returns TurnResult with accumulated content, empty toolCalls and outputItems for text-only", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result).toEqual({ content: "hello", toolCalls: [], outputItems: [], settleStreamed: false })
  })

  it("silently ignores unknown event types", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.created" },
      { type: "response.completed" },
      { type: "some.unknown.event" },
      { type: "response.output_text.delta", delta: "ok" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.content).toBe("ok")
  })

  it("fires callback even for empty delta string", async () => {
    const textChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "" },
    ])) } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    await streamResponsesApi(client, {}, callbacks)
    expect(textChunks).toEqual([""])
  })

  it("casts non-string delta to String()", async () => {
    const reasoningChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.reasoning_summary_text.delta", delta: 42 },
    ])) } }
    const callbacks = makeCallbacks({ onReasoningChunk: (text: string) => reasoningChunks.push(text) })
    await streamResponsesApi(client, {}, callbacks)
    expect(reasoningChunks).toEqual(["42"])
  })

  it("respects abort signal during stream iteration", async () => {
    const controller = new AbortController()
    const textChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "response.output_text.delta", delta: "first" }
        controller.abort()
        yield { type: "response.output_text.delta", delta: "second" }
      },
    }) } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    await streamResponsesApi(client, {}, callbacks, controller.signal)
    expect(textChunks).toEqual(["first"])
  })

  it("handles abort signal already aborted before iteration", async () => {
    const controller = new AbortController()
    controller.abort()
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "should not fire" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks, controller.signal)
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(result.content).toBe("")
  })

  it("propagates errors from client.responses.create", async () => {
    const client = { responses: { create: vi.fn().mockImplementation(() => { throw new Error("API error") }) } }
    const callbacks = makeCallbacks()
    await expect(streamResponsesApi(client, {}, callbacks)).rejects.toThrow("API error")
  })

  it("handles stream with only non-content events", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.created" },
      { type: "response.completed" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(callbacks.onModelStreamStart).not.toHaveBeenCalled()
    expect(result.content).toBe("")
  })

  // --- Tool call events ---

  it("tracks function_call from output_item.added + arguments.delta + output_item.done", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"path"' },
      { type: "response.function_call_arguments.delta", delta: ':"a.txt"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' } },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }])
  })

  it("tracks multiple tool calls independently", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' } },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c2", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"command":"ls"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c2", name: "shell", arguments: '{"command":"ls"}' } },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe("read_file")
    expect(result.toolCalls[1].name).toBe("shell")
  })

  // --- Output item collection ---

  it("pushes all output_item.done items to outputItems regardless of type", async () => {
    const reasoningItem = { type: "reasoning", id: "r1", summary: [{ text: "thought", type: "summary_text" }], encrypted_content: "enc123" }
    const messageItem = { type: "message", id: "m1", content: [{ type: "output_text", text: "hello" }] }
    const fcItem = { type: "function_call", call_id: "c1", name: "read_file", arguments: '{}' }
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.done", item: reasoningItem },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "read_file", arguments: "" } },
      { type: "response.output_item.done", item: fcItem },
      { type: "response.output_item.done", item: messageItem },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.outputItems).toHaveLength(3)
    expect(result.outputItems[0]).toEqual(reasoningItem)
    expect(result.outputItems[1]).toEqual(fcItem)
    expect(result.outputItems[2]).toEqual(messageItem)
  })

  it("preserves encrypted_content in reasoning output items", async () => {
    const item = { type: "reasoning", id: "r1", summary: [], encrypted_content: "secret" }
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.done", item },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.outputItems[0].encrypted_content).toBe("secret")
  })

  it("returns empty outputItems when no done events", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "text" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.outputItems).toEqual([])
  })

  // --- TurnResult shape ---

  it("returns TurnResult with text + tool calls + output items", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "text" },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"command":"ls"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":"ls"}' } },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.content).toBe("text")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.outputItems).toHaveLength(1)
  })

  // --- Edge cases ---

  it("does not track output_item.added for non-function_call types", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "message", id: "m1" } },
      { type: "response.output_item.done", item: { type: "message", id: "m1", content: [] } },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.toolCalls).toEqual([])
    expect(result.outputItems).toHaveLength(1)
  })

  it("ignores function_call_arguments.delta when no active tool call", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.function_call_arguments.delta", delta: "stray args" },
      { type: "response.output_text.delta", delta: "ok" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.content).toBe("ok")
    expect(result.toolCalls).toEqual([])
  })

  it("handles tool call with empty arguments string", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "get_current_time", arguments: "" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "get_current_time", arguments: "" } },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.toolCalls).toEqual([{ id: "c1", name: "get_current_time", arguments: "" }])
  })

  // --- Unit 2a: Capture Azure usage from response.completed ---

  it("captures usage from response.completed event", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.completed", response: {
        usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 150 },
      }},
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 20,
      total_tokens: 150,
    })
  })

  it("captures usage from response.done event", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.done", response: {
        usage: { input_tokens: 120, output_tokens: 40, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 160 },
      }},
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.usage).toEqual({
      input_tokens: 120,
      output_tokens: 40,
      reasoning_tokens: 5,
      total_tokens: 160,
    })
  })

  it("returns undefined usage when no response.completed event fires", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "hello" },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.usage).toBeUndefined()
  })

  it("maps usage fields correctly from response.completed", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.completed", response: {
        usage: { input_tokens: 500, output_tokens: 200, output_tokens_details: { reasoning_tokens: 80 }, total_tokens: 700 },
      }},
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.usage!.input_tokens).toBe(500)
    expect(result.usage!.output_tokens).toBe(200)
    expect(result.usage!.reasoning_tokens).toBe(80)
    expect(result.usage!.total_tokens).toBe(700)
  })

  it("defaults reasoning_tokens to 0 when output_tokens_details is missing", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.completed", response: {
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }},
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.usage!.reasoning_tokens).toBe(0)
  })
})

// --- Unit 20a: SettleParser unit tests ---

describe("SettleParser", () => {
  let SettleParser: any

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const streaming = await import("../../heart/streaming")
    SettleParser = streaming.SettleParser
  })

  it("parses {\"answer\":\"hello world\"} and returns hello world", () => {
    const parser = new SettleParser()
    const result = parser.process('{"answer":"hello world"}')
    expect(result).toBe("hello world")
    expect(parser.active).toBe(true)
    expect(parser.complete).toBe(true)
  })

  it("handles JSON escapes: \\\" -> \", \\\\ -> \\, \\n -> newline, \\t -> tab, \\/ -> /", () => {
    const parser = new SettleParser()
    const result = parser.process('{"answer":"line1\\nline2\\t\\\\end\\\\\\/quote\\"done"}')
    expect(result).toBe('line1\nline2\t\\end\\/quote"done')
  })

  it("rejects an unknown JSON escape instead of leaking its raw character", () => {
    const parser = new SettleParser()
    parser.process('{"answer":"test\\xvalue"}')
    expect(parser.finish()).toEqual({ ok: false, errorCode: "invalid_settle_arguments" })
  })

  it("emits nothing before prefix \"answer\":\" is matched", () => {
    const parser = new SettleParser()
    const result = parser.process('{"answe')
    expect(result).toBe("")
    expect(parser.active).toBe(false)
    expect(parser.complete).toBe(false)
  })

  it("emits incrementally across multiple process() calls (delta chunking)", () => {
    const parser = new SettleParser()
    const chunks = [
      parser.process('{"ans'),
      parser.process('wer":"hel'),
      parser.process('lo wor'),
      parser.process('ld"}'),
    ]
    expect(chunks).toEqual(["", "hel", "lo wor", "ld"])
    expect(chunks.join("")).toBe("hello world")
    expect(parser.active).toBe(true)
    expect(parser.complete).toBe(true)
  })

  it("stops at unescaped closing \" -- subsequent process() calls return empty string", () => {
    const parser = new SettleParser()
    const first = parser.process('{"answer":"done"}')
    expect(first).toBe("done")
    expect(parser.complete).toBe(true)
    const second = parser.process("more stuff")
    expect(second).toBe("")
  })

  it("active is false before prefix, true after", () => {
    const parser = new SettleParser()
    expect(parser.active).toBe(false)
    parser.process('{"answer":"')
    expect(parser.active).toBe(true)
  })

  it("complete is false until closing \", true after", () => {
    const parser = new SettleParser()
    parser.process('{"answer":"hello')
    expect(parser.complete).toBe(false)
    parser.process('"')
    expect(parser.complete).toBe(true)
  })

  it("handles \"answer\": \" (space after colon) variant", () => {
    const parser = new SettleParser()
    const result = parser.process('{"answer": "spaced value"}')
    expect(result).toBe("spaced value")
    expect(parser.active).toBe(true)
    expect(parser.complete).toBe(true)
  })

  it("returns empty string when prefix never matches (e.g. {\"other\":\"value\"})", () => {
    const parser = new SettleParser()
    const result = parser.process('{"other":"value"}')
    expect(result).toBe("")
    expect(parser.active).toBe(false)
  })

  it("handles empty answer {\"answer\":\"\"}", () => {
    const parser = new SettleParser()
    const result = parser.process('{"answer":""}')
    expect(result).toBe("")
    expect(parser.active).toBe(true)
    expect(parser.complete).toBe(true)
  })

  it("still extracts answer when intent appears before answer in the same payload", () => {
    const parser = new SettleParser()
    let out = ""
    out += parser.process('{"intent":"blocked","ans')
    out += parser.process('wer":"need a credential"}')
    expect(out).toBe("need a credential")
    expect(parser.active).toBe(true)
    expect(parser.complete).toBe(true)
  })

  it("handles escape sequence split across deltas (e.g. \\ in one delta, n in next)", () => {
    const parser = new SettleParser()
    let out = ""
    out += parser.process('{"answer":"hello\\')
    out += parser.process('nworld"}')
    expect(out).toBe("hello\nworld")
  })

  const validJsonStringCases: ReadonlyArray<{
    label: string
    json: string
    answer: string
    supplementaryPair?: boolean
  }> = [
    { label: "escaped quote", json: String.raw`{"answer":"say \"hello\""}`, answer: 'say "hello"' },
    { label: "escaped backslash", json: String.raw`{"answer":"left\\right"}`, answer: "left\\right" },
    { label: "escaped slash", json: String.raw`{"answer":"left\/right"}`, answer: "left/right" },
    { label: "all escaped controls", json: String.raw`{"answer":"a\bb\fc\nd\re\tf"}`, answer: "a\bb\fc\nd\re\tf" },
    { label: "BMP unicode escape", json: String.raw`{"answer":"got it \u2014 now"}`, answer: "got it — now" },
    { label: "escaped supplementary pair", json: String.raw`{"answer":"hello \uD83E\uDD9D"}`, answer: "hello 🦝", supplementaryPair: true },
    { label: "literal supplementary scalar", json: '{"answer":"hello 🦝"}', answer: "hello 🦝", supplementaryPair: true },
    {
      label: "escaped high plus literal low surrogate",
      json: String.raw`{"answer":"mixed:\uD83E${"\uDD9D"}"}`,
      answer: "mixed:🦝",
      supplementaryPair: true,
    },
    {
      label: "literal high plus escaped low surrogate",
      json: String.raw`{"answer":"mixed:${"\uD83E"}\uDD9D"}`,
      answer: "mixed:🦝",
      supplementaryPair: true,
    },
    { label: "escaped lone high surrogate", json: String.raw`{"answer":"high:\uD800:end"}`, answer: "high:\uD800:end" },
    { label: "escaped lone low surrogate", json: String.raw`{"answer":"low:\uDC00:end"}`, answer: "low:\uDC00:end" },
    { label: "literal lone high surrogate", json: `{"answer":"high:${"\uD800"}:end"}`, answer: `high:${"\uD800"}:end` },
    { label: "literal lone low surrogate", json: `{"answer":"low:${"\uDC00"}:end"}`, answer: `low:${"\uDC00"}:end` },
    { label: "empty answer", json: '{"answer":""}', answer: "" },
    { label: "answer after non-answer fields", json: '{"intent":"reply","count":2,"answer":"grounded"}', answer: "grounded" },
    { label: "fields after answer", json: '{"answer":"first","intent":"reply"}', answer: "first" },
    { label: "JSON whitespace around top-level answer", json: '{\n\t"answer"\t:\n"spaced"\n}\t ', answer: "spaced" },
    { label: "nested answer before top-level answer", json: '{"meta":{"answer":"fake"},"answer":"real"}', answer: "real" },
  ]

  it.each(validJsonStringCases)("matches JSON.parse for $label at every UTF-16 split", ({ json, answer, supplementaryPair }) => {
    expect((JSON.parse(json) as { answer: string }).answer).toBe(answer)
    for (let split = 0; split <= json.length; split += 1) {
      const parser = new SettleParser()
      const chunks = [parser.process(json.slice(0, split)), parser.process(json.slice(split))]
      expect(chunks.join(""), `split=${split}`).toBe(answer)
      const terminal = parser.finish()
      expect(terminal, `split=${split}`).toEqual({ ok: true, answer })
      expect(parser.finish(), `repeat split=${split}`).toEqual(terminal)
      if (supplementaryPair) {
        expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)), `split=${split}`).toBe(true)
      }
    }

    const characterParser = new SettleParser()
    const characterChunks = json.split("").flatMap((character) => {
      const emitted = characterParser.process(character)
      return emitted ? [emitted] : []
    })
    expect(characterChunks.join("")).toBe(answer)
    const terminal = characterParser.finish()
    expect(terminal).toEqual({ ok: true, answer })
    expect(characterParser.finish()).toEqual(terminal)
    if (supplementaryPair) {
      expect(characterChunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
    }
  })

  it("decodes a split em dash escape without leaking raw u2014 text", () => {
    const parser = new SettleParser()
    const chunks = [
      parser.process(String.raw`{"answer":"got it \u`),
      parser.process("20"),
      parser.process('14 now"}'),
    ]
    expect(chunks).toEqual(["got it ", "", "— now"])
    expect(chunks.join("")).toBe("got it — now")
    expect(chunks.join("")).not.toContain("u2014")
    expect(parser.finish()).toEqual({ ok: true, answer: "got it — now" })
  })

  const terminalErrorCases = [
    { label: "unknown escape", json: String.raw`{"answer":"bad\xvalue"}`, eagerOutput: "bad", errorCode: "invalid_settle_arguments" },
    { label: "malformed unicode hex position 1", json: String.raw`{"answer":"bad\uG234"}`, eagerOutput: "bad", errorCode: "invalid_settle_arguments" },
    { label: "malformed unicode hex position 2", json: String.raw`{"answer":"bad\u1G34"}`, eagerOutput: "bad", errorCode: "invalid_settle_arguments" },
    { label: "malformed unicode hex position 3", json: String.raw`{"answer":"bad\u12G4"}`, eagerOutput: "bad", errorCode: "invalid_settle_arguments" },
    { label: "malformed unicode hex position 4", json: String.raw`{"answer":"bad\u123G"}`, eagerOutput: "bad", errorCode: "invalid_settle_arguments" },
    { label: "malformed escape after a high surrogate", json: String.raw`{"answer":"pair:\uD83E\x"}`, eagerOutput: "pair:", errorCode: "invalid_settle_arguments" },
    { label: "trailing payload", json: '{"answer":"done"} trailing', eagerOutput: "done", errorCode: "invalid_settle_arguments" },
    { label: "non-string answer", json: '{"answer":42}', eagerOutput: "", errorCode: "invalid_settle_arguments" },
    { label: "non-answer fields only", json: '{"intent":"observe"}', eagerOutput: "", errorCode: "invalid_settle_arguments" },
    { label: "empty arguments", json: "", eagerOutput: "", errorCode: "incomplete_settle_arguments" },
    { label: "missing closing quote", json: '{"answer":"unfinished', eagerOutput: "unfinished", errorCode: "incomplete_settle_arguments" },
    { label: "incomplete escape", json: '{"answer":"unfinished' + "\\", eagerOutput: "unfinished", errorCode: "incomplete_settle_arguments" },
    { label: "incomplete unicode escape", json: String.raw`{"answer":"unfinished\u12`, eagerOutput: "unfinished", errorCode: "incomplete_settle_arguments" },
    { label: "incomplete high surrogate", json: String.raw`{"answer":"pair:\uD83E`, eagerOutput: "pair:", errorCode: "incomplete_settle_arguments" },
  ] as const

  it.each(terminalErrorCases)("returns the exact terminal code for $label at every split", ({ json, eagerOutput, errorCode }) => {
    for (let split = 0; split <= json.length; split += 1) {
      const parser = new SettleParser()
      const emitted = parser.process(json.slice(0, split)) + parser.process(json.slice(split))
      expect(emitted, `split=${split}`).toBe(eagerOutput)
      const terminal = parser.finish()
      expect(terminal, `split=${split}`).toEqual({ ok: false, errorCode })
      expect(parser.finish(), `repeat split=${split}`).toEqual(terminal)
    }

    const characterParser = new SettleParser()
    const emitted = json.split("").map((character) => characterParser.process(character)).join("")
    expect(emitted).toBe(eagerOutput)
    const terminal = characterParser.finish()
    expect(terminal).toEqual({ ok: false, errorCode })
    expect(characterParser.finish()).toEqual(terminal)
  })

  it("recognizes an escaped top-level answer key without matching escaped text as a prefix", () => {
    const parser = new SettleParser()
    const json = String.raw`{"answ\u0065r":"decoded"}`
    expect(parser.process(json)).toBe("decoded")
    expect(parser.finish()).toEqual({ ok: true, answer: "decoded" })
  })

  it("supports nested arrays while rejecting a root array as settle arguments", () => {
    const nested = new SettleParser()
    expect(nested.process('{"meta":[{"answer":"fake"}],"answer":"real"}')).toBe("real")
    expect(nested.finish()).toEqual({ ok: true, answer: "real" })

    const root = new SettleParser()
    expect(root.process('["answer","not a settle object"]')).toBe("")
    expect(root.finish()).toEqual({ ok: false, errorCode: "invalid_settle_arguments" })
  })

  it.each([
    { label: "invalid escape in a root key", json: String.raw`{"ans\qwer":"value"}`, eagerOutput: "" },
    { label: "missing colon after answer key", json: '{"answer" "value"}', eagerOutput: "" },
    { label: "mismatched nested closer", json: '{"meta":[}', eagerOutput: "" },
    { label: "raw control character in answer", json: '{"answer":"safe\nunsafe"}', eagerOutput: "safe" },
    { label: "duplicate answer changes parsed value", json: '{"answer":"first","answer":"second"}', eagerOutput: "first" },
  ])("fails closed for $label", ({ json, eagerOutput }) => {
    const parser = new SettleParser()
    expect(parser.process(json)).toBe(eagerOutput)
    expect(parser.finish()).toEqual({ ok: false, errorCode: "invalid_settle_arguments" })
  })

  it.each([
    '{"intent":',
    '{"intent":1',
  ])("classifies truncated pre-answer JSON as incomplete: %s", (json) => {
    const parser = new SettleParser()
    expect(parser.process(json)).toBe("")
    expect(parser.finish()).toEqual({ ok: false, errorCode: "incomplete_settle_arguments" })
  })

  it("freezes after finish so later deltas cannot rewrite terminal truth", () => {
    const parser = new SettleParser()
    expect(parser.process('{"answer":"final"}')).toBe("final")
    expect(parser.finish()).toEqual({ ok: true, answer: "final" })
    expect(parser.process(" trailing")).toBe("")
    expect(parser.finish()).toEqual({ ok: true, answer: "final" })
  })

  it.each([
    { label: "non-syntax parser failure", error: new Error("unexpected parser failure") },
    { label: "syntax failure without a position", error: new SyntaxError("opaque parser failure") },
  ])("fails closed for defensive $label", ({ error }) => {
    const parser = new SettleParser()
    parser.process("x")
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => { throw error })
    try {
      expect(parser.finish()).toEqual({ ok: false, errorCode: "invalid_settle_arguments" })
    } finally {
      parse.mockRestore()
    }
  })
})

describe("SettleStreamer", () => {
  let SettleStreamer: any
  let finalizeSettleStream: any

  beforeAll(async () => {
    const streaming = await import("../../heart/streaming")
    SettleStreamer = streaming.SettleStreamer
    finalizeSettleStream = streaming.finalizeSettleStream
  })

  it("activate() calls onClearText and sets detected", () => {
    let cleared = false
    const streamer = new SettleStreamer({
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onClearText: () => { cleared = true },
      flushMarkdown: () => {},
      settleOutputMode: "retractable_buffer",
    })
    expect(streamer.detected).toBe(false)
    streamer.activate()
    expect(streamer.detected).toBe(true)
    expect(cleared).toBe(true)
  })

  it("activate() is idempotent — second call is no-op", () => {
    let clearCount = 0
    const streamer = new SettleStreamer({
      onModelStreamStart: () => {},
      onTextChunk: () => {},
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onClearText: () => { clearCount++ },
      flushMarkdown: () => {},
      settleOutputMode: "retractable_buffer",
    })
    streamer.activate()
    streamer.activate()
    expect(clearCount).toBe(1)
  })

  it("processDelta() emits parsed answer text via onTextChunk", () => {
    const chunks: string[] = []
    const streamer = new SettleStreamer({
      onModelStreamStart: () => {},
      onTextChunk: (t: string) => { chunks.push(t) },
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onClearText: () => {},
      flushMarkdown: () => {},
      settleOutputMode: "retractable_buffer",
    })
    streamer.activate()
    streamer.processDelta('{"answer":"hello"}')
    expect(chunks.join("")).toBe("hello")
    expect(streamer.streamed).toBe(false)
    expect(streamer.finish('{"answer":"hello"}')).toEqual({ ok: true, answer: "hello" })
    expect(streamer.streamed).toBe(true)
  })

  it("processDelta() is no-op when not detected", () => {
    const chunks: string[] = []
    const streamer = new SettleStreamer({
      onModelStreamStart: () => {},
      onTextChunk: (t: string) => { chunks.push(t) },
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      flushMarkdown: () => {},
    })
    streamer.processDelta('{"answer":"hello"}')
    expect(chunks.length).toBe(0)
    expect(streamer.streamed).toBe(false)
  })

  it("processDelta() stays silent when eager final-answer streaming is disabled", () => {
    let cleared = false
    const chunks: string[] = []
    const streamer = new SettleStreamer({
      onModelStreamStart: () => {},
      onTextChunk: (t: string) => { chunks.push(t) },
      onReasoningChunk: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onClearText: () => { cleared = true },
      flushMarkdown: () => {},
    }, false)
    streamer.activate()
    streamer.processDelta('{"answer":"hello"}')
    expect(cleared).toBe(false)
    expect(streamer.detected).toBe(false)
    expect(chunks).toEqual([])
    expect(streamer.streamed).toBe(false)
  })

  function makeFinalizationCallbacks(mode: "retractable_buffer" | "final_only") {
    let visible = ""
    let clearCount = 0
    const onTextChunk = vi.fn((text: string) => { visible += text })
    const onClearText = vi.fn(() => { visible = ""; clearCount += 1 })
    const callbacks = {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk,
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      onClearText,
      settleOutputMode: mode,
    }
    return {
      callbacks,
      visible: () => visible,
      clearCount: () => clearCount,
      onTextChunk,
      onClearText,
    }
  }

  it("finalizes retractable output once and emits only the not-yet-seen suffix", () => {
    const harness = makeFinalizationCallbacks("retractable_buffer")
    const streamer = new SettleStreamer(harness.callbacks)
    streamer.activate()
    streamer.processDelta('{"answer":"hello')
    expect(harness.visible()).toBe("hello")
    expect(harness.clearCount()).toBe(1)

    const terminal = streamer.finish('{"answer":"hello world"}')
    expect(terminal).toEqual({ ok: true, answer: "hello world" })
    expect(harness.visible()).toBe("hello world")
    expect(harness.onTextChunk.mock.calls.map(([text]) => text)).toEqual(["hello", " world"])

    expect(streamer.finish('{"answer":"conflicting replacement"}')).toEqual(terminal)
    expect(harness.onTextChunk).toHaveBeenCalledTimes(2)
    expect(harness.clearCount()).toBe(1)
  })

  it("replaces divergent streamed arguments with the provider's authoritative final value", () => {
    const harness = makeFinalizationCallbacks("retractable_buffer")
    const streamer = new SettleStreamer(harness.callbacks)
    streamer.activate()
    streamer.processDelta('{"answer":"stale')
    expect(harness.visible()).toBe("stale")

    expect(streamer.finish('{"answer":"authoritative"}')).toEqual({
      ok: true,
      answer: "authoritative",
    })
    expect(harness.visible()).toBe("authoritative")
    expect(harness.clearCount()).toBe(2)
    expect(harness.onTextChunk.mock.calls.map(([text]) => text)).toEqual([
      "stale",
      "authoritative",
    ])
  })

  it.each([
    { label: "incomplete", args: '{"answer":"unsafe', errorCode: "incomplete_settle_arguments" },
    { label: "invalid", args: String.raw`{"answer":"unsafe\x"}`, errorCode: "invalid_settle_arguments" },
  ])("retracts $label eager output during finalization", ({ args, errorCode }) => {
    const harness = makeFinalizationCallbacks("retractable_buffer")
    const streamer = new SettleStreamer(harness.callbacks)
    streamer.activate()
    streamer.processDelta(args)
    expect(harness.visible()).toBe("unsafe")
    expect(harness.clearCount()).toBe(1)

    const terminal = streamer.finish(args)
    expect(terminal).toEqual({ ok: false, errorCode })
    expect(harness.visible()).toBe("")
    expect(harness.clearCount()).toBe(2)
    expect(streamer.finish(args)).toEqual(terminal)
    expect(harness.clearCount()).toBe(2)
  })

  it("keeps structurally valid final-only output owned by core until semantic acceptance", () => {
    const harness = makeFinalizationCallbacks("final_only")
    const streamer = new SettleStreamer(harness.callbacks)
    streamer.activate()
    streamer.processDelta('{"answer":"private until done"}')
    expect(harness.visible()).toBe("")
    expect(harness.clearCount()).toBe(0)

    const terminal = streamer.finish('{"answer":"private until done"}')
    expect(terminal).toEqual({ ok: true, answer: "private until done" })
    expect(harness.visible()).toBe("")
    expect(harness.onTextChunk).not.toHaveBeenCalled()
    expect(streamer.streamed).toBe(false)
    expect(streamer.finish('{"answer":"conflicting replacement"}')).toEqual(terminal)
    expect(harness.onTextChunk).not.toHaveBeenCalled()
  })

  it.each([
    { label: "incomplete", args: '{"answer":"unsafe', errorCode: "incomplete_settle_arguments" },
    { label: "invalid", args: String.raw`{"answer":"unsafe\x"}`, errorCode: "invalid_settle_arguments" },
  ])("never exposes $label final-only output", ({ args, errorCode }) => {
    const harness = makeFinalizationCallbacks("final_only")
    const streamer = new SettleStreamer(harness.callbacks)
    streamer.activate()
    streamer.processDelta(args)
    expect(harness.visible()).toBe("")
    expect(streamer.finish(args)).toEqual({ ok: false, errorCode })
    expect(harness.visible()).toBe("")
    expect(harness.onClearText).not.toHaveBeenCalled()
  })

  it("cancels retractable and final-only streams without committing partial output", () => {
    for (const mode of ["retractable_buffer", "final_only"] as const) {
      const harness = makeFinalizationCallbacks(mode)
      const streamer = new SettleStreamer(harness.callbacks)
      streamer.activate()
      streamer.processDelta('{"answer":"partial')
      streamer.cancel()
      streamer.cancel()
      streamer.processDelta(' ignored"}')
      expect(harness.visible(), mode).toBe("")
      expect(streamer.finish('{"answer":"partial"}'), mode).toBeUndefined()
      expect(harness.onTextChunk, mode).toHaveBeenCalledTimes(mode === "retractable_buffer" ? 1 : 0)
    }
  })

  it("caches a successful final-only finish without invoking the irreversible callback", () => {
    const failure = new Error("callback failed")
    const onTextChunk = vi.fn(() => { throw failure })
    const streamer = new SettleStreamer({
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk,
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      settleOutputMode: "final_only",
    })
    streamer.activate()
    streamer.processDelta('{"answer":"done"}')
    expect(streamer.finish('{"answer":"done"}')).toEqual({ ok: true, answer: "done" })
    expect(streamer.finish('{"answer":"conflicting replacement"}')).toEqual({ ok: true, answer: "done" })
    expect(onTextChunk).not.toHaveBeenCalled()
    expect(streamer.streamed).toBe(false)
  })

  it("wraps a non-Error final callback throw as structurally non-retryable", () => {
    const streamer = new SettleStreamer({
      ...makeFinalizationCallbacks("retractable_buffer").callbacks,
      onTextChunk: vi.fn((text: string) => {
        if (text === "ne") throw "callback string failure" // eslint-disable-line no-throw-literal
      }),
    })
    streamer.activate()
    streamer.processDelta('{"answer":"do')

    let caught: any
    try {
      finalizeSettleStream(streamer, '{"answer":"done"}')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      name: "SettleFinalizationCallbackError",
      message: "settle finalization callback failed: callback string failure",
      retryable: false,
      cause: { message: "callback string failure" },
    })
    expect(finalizeSettleStream(streamer, '{"answer":"conflicting"}')).toEqual({
      ok: true,
      answer: "done",
    })
  })

  it("keeps unactivated and terminal cancellation guards inert", () => {
    const harness = makeFinalizationCallbacks("retractable_buffer")
    const streamer = new SettleStreamer(harness.callbacks)
    expect(streamer.finish('{"answer":"unused"}')).toBeUndefined()
    streamer.cancel()
    expect(harness.onClearText).not.toHaveBeenCalled()

    streamer.activate()
    streamer.processDelta('{"answer":"done"}')
    expect(streamer.finish('{"answer":"done"}')).toEqual({ ok: true, answer: "done" })
    streamer.cancel()
    streamer.processDelta("ignored")
    expect(harness.visible()).toBe("done")
  })

  it("keeps disabled finalization inert", () => {
    const harness = makeFinalizationCallbacks("retractable_buffer")
    const streamer = new SettleStreamer(harness.callbacks, false)
    streamer.activate()
    streamer.processDelta('{"answer":"done"}')
    streamer.cancel()
    expect(streamer.finish('{"answer":"done"}')).toBeUndefined()
    expect(harness.visible()).toBe("")
    expect(harness.onClearText).not.toHaveBeenCalled()
  })
})

// --- Unit 20a: streamChatCompletion settle streaming integration tests ---

describe("streamChatCompletion settle streaming", () => {
  let streamChatCompletion: any

  function makeStream(chunks: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeChunk(content?: string, toolCalls?: any[]) {
    const delta: any = {}
    if (content !== undefined) delta.content = content
    if (toolCalls !== undefined) delta.tool_calls = toolCalls
    return { choices: [{ delta }] }
  }

  function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
    return {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const streaming = await import("../../heart/streaming")
    streamChatCompletion = streaming.streamChatCompletion
  })

  it("streams settle argument deltas progressively via onTextChunk", async () => {
    const textChunks: string[] = []
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"ans' } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: 'wer":"hel' } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: 'lo wor' } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: 'ld"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(textChunks.join("")).toBe("hello world")
    expect(result.settleStreamed).toBe(true)
  })

  it("calls onClearText when settle tool call is first detected", async () => {
    const onClearText = vi.fn()
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk("some noise"),
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks({ onClearText })
    await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(onClearText).toHaveBeenCalledTimes(1)
  })

  it("sets settleStreamed to true when settle detected", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"done"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.settleStreamed).toBe(true)
  })

  it("does not stream arguments for non-settle tool calls", async () => {
    const textChunks: string[] = []
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(textChunks).toEqual([])
    expect(result.settleStreamed).toBe(false)
  })

  it("sets settleStreamed to false when prefix never matches", async () => {
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"other":"value"}' } }]),
    ])) } } }
    const callbacks = makeCallbacks()
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(result.settleStreamed).toBe(false)
  })

  it("finalizes a valid final-only settle exactly once after all arguments arrive", async () => {
    const { SettleParser } = await import("../../heart/streaming")
    const finish = vi.spyOn(SettleParser.prototype, "finish")
    const textChunks: string[] = []
    const create = vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"hel' } }]),
      makeChunk(undefined, [{ index: 0, function: { arguments: 'lo"}' } }]),
    ]))
    const client = { chat: { completions: { create } } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => textChunks.push(text),
      settleOutputMode: "final_only",
    } as any)
    try {
      const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
      expect(create).toHaveBeenCalledTimes(1)
      expect(finish).toHaveBeenCalledTimes(1)
      expect(textChunks).toEqual([])
      expect(result.settleFinalization).toEqual({ ok: true, answer: "hello" })
      expect(result.settleStreamed).toBe(false)
    } finally {
      finish.mockRestore()
    }
  })

  it("keeps a retractable Chat Completions settle exact when provider text follows it", async () => {
    let visible = ""
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{
        index: 0,
        id: "call_1",
        function: { name: "settle", arguments: '{"answer":"answer"}' },
      }]),
      makeChunk("after"),
    ])) } } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => { visible += text },
      onClearText: () => { visible = "" },
      settleOutputMode: "retractable_buffer",
    } as any)

    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)

    expect(result.settleFinalization).toEqual({ ok: true, answer: "answer" })
    expect(result.settleStreamed).toBe(true)
    expect(visible).toBe("answer")
  })

  it.each([
    { label: "incomplete", args: '{"answer":"partial', errorCode: "incomplete_settle_arguments" },
    { label: "invalid", args: String.raw`{"answer":"partial\x"}`, errorCode: "invalid_settle_arguments" },
  ])("returns exact $label finalization without retrying Chat Completions", async ({ args, errorCode }) => {
    let visible = "noise"
    const onClearText = vi.fn(() => { visible = "" })
    const create = vi.fn().mockReturnValue(makeStream([
      makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: args } }]),
    ]))
    const client = { chat: { completions: { create } } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => { visible += text },
      onClearText,
    })
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)
    expect(create).toHaveBeenCalledTimes(1)
    expect(result.settleFinalization).toEqual({ ok: false, errorCode })
    expect(visible).toBe("")
    expect(onClearText).toHaveBeenCalledTimes(2)
  })

  it("drops ordinary provider text before an invalid final-only Chat Completions settle", async () => {
    const onTextChunk = vi.fn()
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk("must stay private", [{
        index: 0,
        id: "call_1",
        function: { name: "settle", arguments: String.raw`{"answer":"partial\x"}` },
      }]),
    ])) } } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)

    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)

    expect(result.settleFinalization).toEqual({
      ok: false,
      errorCode: "invalid_settle_arguments",
    })
    expect(onTextChunk).not.toHaveBeenCalled()
  })

  it("releases ordinary final-only Chat Completions text when no settle is present", async () => {
    const onTextChunk = vi.fn()
    const client = { chat: { completions: { create: vi.fn().mockReturnValue(makeStream([
      makeChunk("ordinary "),
      makeChunk("answer"),
    ])) } } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)

    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks)

    expect(result.settleFinalization).toBeUndefined()
    expect(onTextChunk).toHaveBeenCalledOnce()
    expect(onTextChunk).toHaveBeenCalledWith("ordinary answer")
  })

  it("cancels a partial final-only Chat Completions settle without finalizing or emitting", async () => {
    const controller = new AbortController()
    const onTextChunk = vi.fn()
    const create = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"partial' } }])
        controller.abort()
        yield makeChunk(undefined, [{ index: 0, function: { arguments: '"}' } }])
      },
    })
    const client = { chat: { completions: { create } } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)
    const result = await streamChatCompletion(client, { messages: [], stream: true }, callbacks, controller.signal)
    expect(create).toHaveBeenCalledTimes(1)
    expect(onTextChunk).not.toHaveBeenCalled()
    expect(result.settleFinalization).toBeUndefined()
    expect(result.settleStreamed).toBe(false)
  })

  it("retracts a partial Chat Completions settle when stream iteration fails", async () => {
    const failure = new Error("stream failed")
    let visible = ""
    const onClearText = vi.fn(() => { visible = "" })
    const client = { chat: { completions: { create: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield makeChunk(undefined, [{ index: 0, id: "call_1", function: { name: "settle", arguments: '{"answer":"partial' } }])
        throw failure
      },
    }) } } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => { visible += text },
      onClearText,
      settleOutputMode: "retractable_buffer",
    } as any)

    await expect(streamChatCompletion(client, { messages: [], stream: true }, callbacks)).rejects.toBe(failure)
    expect(visible).toBe("")
    expect(onClearText).toHaveBeenCalledTimes(2)
  })
})

// --- Unit 20a: streamResponsesApi settle streaming integration tests ---

describe("streamResponsesApi settle streaming", () => {
  let streamResponsesApi: any

  function makeResponsesStream(events: any[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const event of events) {
          yield event
        }
      },
    }
  }

  function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
    return {
      onModelStart: vi.fn(),
      onModelStreamStart: vi.fn(),
      onTextChunk: vi.fn(),
      onReasoningChunk: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onError: vi.fn(),
      settleOutputMode: "retractable_buffer",
      ...overrides,
    } as ChannelCallbacks
  }

  beforeEach(async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ providers: { azure: { apiKey: "" }, minimax: { apiKey: "test-key" } } })
    const streaming = await import("../../heart/streaming")
    streamResponsesApi = streaming.streamResponsesApi
  })

  it("streams settle argument deltas progressively via onTextChunk", async () => {
    const textChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"answer":"hel' },
      { type: "response.function_call_arguments.delta", delta: 'lo world"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: '{"answer":"hello world"}' } },
    ])) } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(textChunks.join("")).toBe("hello world")
    expect(result.settleStreamed).toBe(true)
  })

  it("calls onClearText when settle function call item is added", async () => {
    const onClearText = vi.fn()
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "noise" },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"answer":"done"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: '{"answer":"done"}' } },
    ])) } }
    const callbacks = makeCallbacks({ onClearText })
    await streamResponsesApi(client, {}, callbacks)
    expect(onClearText).toHaveBeenCalledTimes(1)
  })

  it("sets settleStreamed to true when settle detected", async () => {
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"answer":"done"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: '{"answer":"done"}' } },
    ])) } }
    const callbacks = makeCallbacks()
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(result.settleStreamed).toBe(true)
  })

  it("does not emit text when delta only contains prefix portion (no answer text yet)", async () => {
    const textChunks: string[] = []
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"ans' },
      { type: "response.function_call_arguments.delta", delta: 'wer":"' },
      { type: "response.function_call_arguments.delta", delta: 'hello"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: '{"answer":"hello"}' } },
    ])) } }
    const callbacks = makeCallbacks({ onTextChunk: (text: string) => textChunks.push(text) })
    const result = await streamResponsesApi(client, {}, callbacks)
    // First two deltas contain only prefix chars, no text emitted
    // Third delta has answer text
    expect(textChunks.join("")).toBe("hello")
    expect(result.settleStreamed).toBe(true)
  })

  it("finalizes a valid final-only Responses settle from the completed arguments", async () => {
    const { SettleParser } = await import("../../heart/streaming")
    const finish = vi.spyOn(SettleParser.prototype, "finish")
    const onTextChunk = vi.fn()
    const create = vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"answer":"hel' },
      { type: "response.function_call_arguments.delta", delta: 'lo"}' },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: '{"answer":"hello"}' } },
    ]))
    const client = { responses: { create } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)
    try {
      const result = await streamResponsesApi(client, {}, callbacks)
      expect(create).toHaveBeenCalledTimes(1)
      expect(finish).toHaveBeenCalledTimes(1)
      expect(onTextChunk).not.toHaveBeenCalled()
      expect(result.settleFinalization).toEqual({ ok: true, answer: "hello" })
      expect(result.settleStreamed).toBe(false)
    } finally {
      finish.mockRestore()
    }
  })

  it("keeps a retractable Responses settle exact when provider text follows it", async () => {
    let visible = ""
    const args = '{"answer":"answer"}'
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: args },
      { type: "response.output_text.delta", delta: "after" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: args } },
    ])) } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => { visible += text },
      onClearText: () => { visible = "" },
      settleOutputMode: "retractable_buffer",
    } as any)

    const result = await streamResponsesApi(client, {}, callbacks)

    expect(result.settleFinalization).toEqual({ ok: true, answer: "answer" })
    expect(result.settleStreamed).toBe(true)
    expect(visible).toBe("answer")
  })

  it.each([
    { label: "incomplete", args: '{"answer":"partial', errorCode: "incomplete_settle_arguments" },
    { label: "invalid", args: String.raw`{"answer":"partial\x"}`, errorCode: "invalid_settle_arguments" },
  ])("returns exact $label finalization without retrying Responses", async ({ args, errorCode }) => {
    let visible = "noise"
    const onClearText = vi.fn(() => { visible = "" })
    const create = vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: args },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: args } },
    ]))
    const client = { responses: { create } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => { visible += text },
      onClearText,
    })
    const result = await streamResponsesApi(client, {}, callbacks)
    expect(create).toHaveBeenCalledTimes(1)
    expect(result.settleFinalization).toEqual({ ok: false, errorCode })
    expect(visible).toBe("")
    expect(onClearText).toHaveBeenCalledTimes(2)
  })

  it("drops ordinary provider text before an incomplete final-only Responses settle", async () => {
    const onTextChunk = vi.fn()
    const args = '{"answer":"partial'
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "must stay private" },
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: args },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "settle", arguments: args } },
    ])) } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)

    const result = await streamResponsesApi(client, {}, callbacks)

    expect(result.settleFinalization).toEqual({
      ok: false,
      errorCode: "incomplete_settle_arguments",
    })
    expect(onTextChunk).not.toHaveBeenCalled()
  })

  it("releases ordinary final-only Responses text when no settle is present", async () => {
    const onTextChunk = vi.fn()
    const client = { responses: { create: vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_text.delta", delta: "ordinary " },
      { type: "response.output_text.delta", delta: "answer" },
    ])) } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)

    const result = await streamResponsesApi(client, {}, callbacks)

    expect(result.settleFinalization).toBeUndefined()
    expect(onTextChunk).toHaveBeenCalledOnce()
    expect(onTextChunk).toHaveBeenCalledWith("ordinary answer")
  })

  it("finalizes a sole Responses settle from buffered arguments at normal EOF", async () => {
    const onTextChunk = vi.fn()
    const create = vi.fn().mockReturnValue(makeResponsesStream([
      { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } },
      { type: "response.function_call_arguments.delta", delta: '{"answer":"eof"}' },
    ]))
    const client = { responses: { create } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)

    const result = await streamResponsesApi(client, {}, callbacks)

    expect(create).toHaveBeenCalledTimes(1)
    expect(result.toolCalls).toEqual([{
      id: "c1",
      name: "settle",
      arguments: '{"answer":"eof"}',
    }])
    expect(result.settleFinalization).toEqual({ ok: true, answer: "eof" })
    expect(onTextChunk).not.toHaveBeenCalled()
    expect(result.settleStreamed).toBe(false)
  })

  it("cancels a partial final-only Responses settle without finalizing or emitting", async () => {
    const controller = new AbortController()
    const onTextChunk = vi.fn()
    const create = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } }
        yield { type: "response.function_call_arguments.delta", delta: '{"answer":"partial' }
        controller.abort()
        yield { type: "response.function_call_arguments.delta", delta: '"}' }
      },
    })
    const client = { responses: { create } }
    const callbacks = makeCallbacks({ onTextChunk, settleOutputMode: "final_only" } as any)
    const result = await streamResponsesApi(client, {}, callbacks, controller.signal)
    expect(create).toHaveBeenCalledTimes(1)
    expect(onTextChunk).not.toHaveBeenCalled()
    expect(result.settleFinalization).toBeUndefined()
    expect(result.settleStreamed).toBe(false)
  })

  it("retracts a partial Responses settle when stream iteration fails", async () => {
    const failure = new Error("responses stream failed")
    let visible = ""
    const onClearText = vi.fn(() => { visible = "" })
    const client = { responses: { create: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "response.output_item.added", item: { type: "function_call", call_id: "c1", name: "settle", arguments: "" } }
        yield { type: "response.function_call_arguments.delta", delta: '{"answer":"partial' }
        throw failure
      },
    }) } }
    const callbacks = makeCallbacks({
      onTextChunk: (text: string) => { visible += text },
      onClearText,
      settleOutputMode: "retractable_buffer",
    } as any)

    await expect(streamResponsesApi(client, {}, callbacks)).rejects.toBe(failure)
    expect(visible).toBe("")
    expect(onClearText).toHaveBeenCalledTimes(2)
  })
})
