import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import type { TurnResult } from "../../../heart/streaming"
import { chatAnswer, chatRequest, createWire, responsesEvents, responsesRequest, serveWire, sse } from "../../../eval/interviews/guest/h/wire"

const PREFIX = [{ role: "user" as const, content: "Morning." }, { role: "assistant" as const, content: "Morning, Ari." }]

function runtime(answers: TurnResult[], seen: ProviderTurnRequest[], resets: unknown[] = []): ProviderRuntime {
  return {
    id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
    resetTurnState: (messages) => { resets.push(messages) }, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
    streamTurn: async (request) => {
      seen.push(request)
      const answer = answers.shift()
      if (!answer) throw new Error("the host refused the call")
      return answer
    },
  }
}

const usage = { input_tokens: 100, output_tokens: 10, reasoning_tokens: 4, total_tokens: 110, cached_input_tokens: 20 }

describe("the H wire's Responses translation", () => {
  it("turns a Responses body into the harness's request: instructions first, the case's conversation before the first user message, calls and outputs paired", () => {
    const body = {
      model: "m", stream: true,
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a coding agent." }] },
        { type: "message", role: "developer", content: "Sandbox: none." },
        { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "Remove the bad copy." }] },
        { type: "reasoning", summary: [], encrypted_content: null },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call", call_id: "c2", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
        { type: "function_call_output", call_id: "c1", output: "a\nb" },
        { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "/home" }] },
        { type: "message", role: "developer", content: "A later note." },
      ],
      tools: [{ type: "function", name: "exec_command", description: "Run a command.", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    }
    expect(responsesRequest(body, PREFIX)).toEqual({
      messages: [
        { role: "system", content: "You are a coding agent.\n\nSandbox: none." },
        ...PREFIX,
        { role: "user", content: "<environment_context>cwd</environment_context>\nRemove the bad copy." },
        { role: "assistant", content: "Looking.", tool_calls: [
          { id: "c1", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } },
          { id: "c2", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" } },
        ] },
        { role: "tool", tool_call_id: "c1", content: "a\nb" },
        { role: "tool", tool_call_id: "c2", content: "/home" },
        { role: "system", content: "A later note." },
      ],
      activeTools: [{ type: "function", function: { name: "exec_command", description: "Run a command.", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } } } } }],
    })
    // The case's conversation goes in once, before the first user message only. A tool reaches the model exactly as
    // the arm sent it: nothing added where it sent no description or schema (or an empty one), and `strict` kept.
    expect(responsesRequest({ input: [{ type: "message", role: "user", content: "job" }, { type: "message", role: "system", content: "s" }, { type: "message", role: "user", content: "debrief" }], tools: [{ type: "function", name: "t" }, { type: "function", name: "u", description: "", strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } }] }, PREFIX)).toEqual({
      messages: [...PREFIX, { role: "user", content: "job" }, { role: "system", content: "s" }, { role: "user", content: "debrief" }],
      activeTools: [
        { type: "function", function: { name: "t" } },
        { type: "function", function: { name: "u", description: "", strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } } },
      ],
    })
    // A tool field the wire doesn't know would be dropped, so it is refused by name instead.
    expect(() => responsesRequest({ input: [], tools: [{ type: "function", name: "t", defer_loading: true }] }, [])).toThrow("the H wire can't carry a tool's defer_loading")
    // A call with no assistant text before it starts its own assistant message; no instructions and no tools are fine.
    expect(responsesRequest({ input: [{ type: "message", role: "user", content: "hi" }, { type: "function_call", call_id: "c", name: "t", arguments: "{}" }] }, [])).toEqual({
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }] }],
      activeTools: [],
    })
  })

  it("refuses what it can't carry faithfully, naming it", () => {
    expect(() => responsesRequest({ input: [{ type: "custom_tool_call", call_id: "c", name: "apply_patch", input: "x" }] }, [])).toThrow("the H wire can't carry an input item of type custom_tool_call")
    expect(() => responsesRequest({ input: [], tools: [{ type: "web_search" }] }, [])).toThrow("the H wire can't carry a tool of type web_search")
    expect(() => responsesRequest({ input: [{ type: "message", role: "critic", content: "x" }] }, [])).toThrow("the H wire can't carry a message from critic")
    expect(() => responsesRequest({ input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "x" }] }] }, [])).toThrow("the H wire can't carry content of type input_image")
    expect(() => responsesRequest({ input: [{ type: "function_call_output", call_id: "c", output: 3 }] }, [])).toThrow("the H wire can't carry content of type number")
    expect(() => responsesRequest({}, [])).toThrow("a Responses body needs an input list")
    expect(() => responsesRequest(null, [])).toThrow("a Responses body needs an input list")
    expect(() => responsesRequest({ input: [null] }, [])).toThrow("the H wire can't carry an input item of type null")
  })

  it("answers with the events the client reads: created, each item done, completed with usage", () => {
    const events = responsesEvents({ content: "Done.", toolCalls: [{ id: "c1", name: "exec_command", arguments: "{}" }], outputItems: [], usage }, "resp_1")
    expect(events).toEqual([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "resp_1_msg", content: [{ type: "output_text", text: "Done." }] } },
      { type: "response.output_item.done", item: { type: "function_call", id: "resp_1_fc_0", call_id: "c1", name: "exec_command", arguments: "{}" } },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 110 } } },
    ])
    // No text, no usage: no message item, and zero usage.
    expect(responsesEvents({ content: "", toolCalls: [], outputItems: [] }, "r").slice(1)).toEqual([
      { type: "response.completed", response: { id: "r", usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 } } },
    ])
    expect(sse([{ type: "a", x: 1 }, { type: "b" }])).toBe("event: a\ndata: {\"type\":\"a\",\"x\":1}\n\nevent: b\ndata: {\"type\":\"b\"}\n\n")
  })
})

describe("the H wire's chat-completions translation", () => {
  it("turns a chat body into the harness's request: instructions first, the case's conversation before the first user message, calls and results as they are", () => {
    const body = {
      model: "openai/model", stream: false,
      messages: [
        { role: "system", content: [{ type: "text", text: "You are a helpful agent.", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "Remove the bad copy." },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", tool_call_id: "c1", name: "terminal", content: [{ type: "text", text: "books" }] },
        { role: "assistant", content: "Done." },
        { role: "user", content: [{ type: "text", text: "How did it go?" }] },
      ],
      tools: [{ type: "function", function: { name: "terminal", description: "Run a command.", parameters: { type: "object" } } }],
    }
    expect(chatRequest(body, PREFIX)).toEqual({
      messages: [
        { role: "system", content: "You are a helpful agent." },
        ...PREFIX,
        { role: "user", content: "Remove the bad copy." },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "books" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "How did it go?" },
      ],
      activeTools: [{ type: "function", function: { name: "terminal", description: "Run a command.", parameters: { type: "object" } } }],
    })
    // A developer message is a system message; no tools is fine, and so is a tool with no description or schema.
    expect(chatRequest({ messages: [{ role: "developer", content: "d" }, { role: "user", content: "u" }] }, [])).toEqual({ messages: [{ role: "system", content: "d" }, { role: "user", content: "u" }], activeTools: [] })
    expect(chatRequest({ messages: [], tools: [{ type: "function", function: { name: "t" } }] }, []).activeTools).toEqual([{ type: "function", function: { name: "t" } }])
  })

  it("refuses what it can't carry faithfully, naming it", () => {
    expect(() => chatRequest({ messages: [], stream: true }, [])).toThrow("the H wire answers chat completions only without streaming")
    expect(() => chatRequest({}, [])).toThrow("a chat body needs a messages list")
    expect(() => chatRequest({ messages: [{ role: "critic", content: "x" }] }, [])).toThrow("the H wire can't carry a message from critic")
    expect(() => chatRequest({ messages: [null] }, [])).toThrow("the H wire can't carry a message from undefined")
    expect(() => chatRequest({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }, [])).toThrow("the H wire can't carry content of type image_url")
    expect(() => chatRequest({ messages: [], tools: [{ type: "web_search" }] }, [])).toThrow("the H wire can't carry a tool of type web_search")
    // OpenHands' real tools at the pinned SDK commit (captured from a scripted run) reach the model exactly as sent:
    // name, description and the whole schema, with its required lists, enums and nested objects.
    const openhands = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/openhands-tools-ecea9a91.json"), "utf8")) as unknown[]
    expect(openhands.length).toBe(4)
    expect(chatRequest({ messages: [], tools: openhands }, []).activeTools).toEqual(openhands)
    expect(() => chatRequest({ messages: [], tools: [{ type: "function" }] }, [])).toThrow("a chat tool needs its function")
    expect(() => chatRequest({ messages: [], tools: [{ type: "function", function: { name: "t", cache_control: {} } }] }, [])).toThrow("the H wire can't carry a tool's cache_control")
    expect(chatRequest({ messages: [], tools: [{ type: "function", function: { name: "t", description: "d", strict: false, parameters: { type: "object", additionalProperties: false } } }] }, []).activeTools)
      .toEqual([{ type: "function", function: { name: "t", description: "d", strict: false, parameters: { type: "object", additionalProperties: false } } }])
  })

  it("answers with one chat completion: the reply, its calls, why it stopped and the usage", () => {
    expect(chatAnswer({ content: "Done.", toolCalls: [{ id: "c1", name: "terminal", arguments: "{}" }], outputItems: [], usage }, "chat_1")).toEqual({
      id: "chat_1", object: "chat.completion", created: 0, model: "model",
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: "Done.", tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 4 } },
    })
    expect(chatAnswer({ content: "", toolCalls: [], outputItems: [] }, "c").choices).toEqual([{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "" } }])
  })
})

describe("the H wire", () => {
  it("answers chat completions through the host's runtime too, keeping the same trace", async () => {
    const seen: ProviderTurnRequest[] = []
    const wire = createWire({ runtime: runtime([
      { content: "", toolCalls: [{ id: "c1", name: "terminal", arguments: "{\"command\":\"ls\"}" }], outputItems: [], usage },
      { content: "All done.", toolCalls: [], outputItems: [] },
    ], seen), prefix: PREFIX })
    const first = await wire.handle("/v1/chat/completions", { messages: [{ role: "user", content: "go" }] })
    expect(first.status).toBe(200)
    expect(first.contentType).toBe("application/json")
    expect(JSON.parse(first.body).choices[0].message.tool_calls[0].id).toBe("c1")
    const second = await wire.handle("/chat/completions", { messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "books" },
    ] })
    expect(JSON.parse(second.body).choices[0].message.content).toBe("All done.")
    expect(seen[0]!.messages).toEqual([...PREFIX, { role: "user", content: "go" }])
    expect(wire.timeline()).toEqual([{ kind: "call", name: "terminal", args: "{\"command\":\"ls\"}", result: "books" }, { kind: "reply", text: "All done." }])
    // A streaming request is refused, never sent.
    expect((await wire.handle("/v1/chat/completions", { messages: [], stream: true })).status).toBe(400)
    expect(wire.calls()).toBe(2)
  })

  it("sends each request through the host's runtime, reset first, and keeps the trace: each call with the output the client sent back, then the reply", async () => {
    const seen: ProviderTurnRequest[] = []
    const resets: unknown[] = []
    const wire = createWire({ runtime: runtime([
      { content: "", toolCalls: [{ id: "c1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }], outputItems: [], usage },
      { content: "All done.", toolCalls: [], outputItems: [] },
      { content: "6", toolCalls: [], outputItems: [] },
    ], seen, resets), prefix: PREFIX })
    const first = await wire.handle("/v1/responses", { input: [{ type: "message", role: "user", content: "go" }], tools: [] })
    expect(first.status).toBe(200)
    expect(first.contentType).toBe("text/event-stream")
    expect(first.body).toContain("\"call_id\":\"c1\"")
    expect(resets).toEqual([seen[0]!.messages])
    expect(seen[0]!.messages).toEqual([...PREFIX, { role: "user", content: "go" }])
    const second = await wire.handle("/v1/responses", { input: [
      { type: "message", role: "user", content: "go" },
      { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "c1", output: "books" },
    ] })
    expect(second.body).toContain("All done.")
    // The debrief resends the whole history; an output already recorded stays as it was.
    await wire.handle("/v1/responses", { input: [
      { type: "message", role: "user", content: "go" },
      { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "c1", output: "changed" },
      { type: "message", role: "assistant", content: "All done." },
      { type: "message", role: "user", content: "how did it go?" },
    ] })
    expect(wire.calls()).toBe(3)
    expect(wire.timeline()).toEqual([{ kind: "call", name: "exec_command", args: "{\"cmd\":\"ls\"}", result: "books" }, { kind: "reply", text: "All done." }, { kind: "reply", text: "6" }])
    expect(wire.error()).toBeNull()
  })

  it("answers a refused or failed call with an error the client stops on, and remembers why", async () => {
    const wire = createWire({ runtime: runtime([], []), prefix: [] })
    const failed = await wire.handle("/v1/responses", { input: [] })
    // 400, which codex never retries: a retry would be another metered call.
    expect(failed).toEqual({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "the host refused the call" } }) })
    expect(wire.error()).toBe("the host refused the call")
    expect(wire.calls()).toBe(1)
    // A body the wire can't carry is never sent.
    const refused = createWire({ runtime: runtime([], []), prefix: [] })
    expect((await refused.handle("/v1/responses", { input: [{ type: "local_shell_call" }] })).status).toBe(400)
    expect(refused.calls()).toBe(0)
    expect(refused.error()).toBe("the H wire can't carry an input item of type local_shell_call")
    expect(await refused.handle("/v1/models", {})).toEqual({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "no route /v1/models" } }) })
    const odd = createWire({ runtime: { ...runtime([], []), streamTurn: async () => { throw "plain" } }, prefix: [] })
    expect((await odd.handle("/responses", { input: [] })).status).toBe(400)
    expect(odd.error()).toBe("plain")
  })

  it("serves on the container's loopback, and reads a request's JSON body", async () => {
    const seen: ProviderTurnRequest[] = []
    const wire = createWire({ runtime: runtime([{ content: "hi", toolCalls: [], outputItems: [] }], seen), prefix: [] })
    const served = await serveWire(wire)
    try {
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      const response = await fetch(`${served.url}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: [{ type: "message", role: "user", content: "hello" }] }) })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(await response.text()).toContain("response.completed")
      const bad = await fetch(`${served.url}/responses`, { method: "POST", body: "not json" })
      expect(bad.status).toBe(400)
      expect(seen).toHaveLength(1)
    } finally {
      await served.close()
    }
  })

  it("answers a request whose handling throws, so none hangs and the guest stays up", async () => {
    const throwing: Parameters<typeof serveWire>[0] = { handle: async () => { throw new Error("broken") }, timeline: () => [], calls: () => 0, error: () => null }
    const served = await serveWire(throwing)
    try {
      const response = await fetch(`${served.url}/responses`, { method: "POST", body: "{}" })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { message: "broken" } })
    } finally {
      await served.close()
    }
  })
})
