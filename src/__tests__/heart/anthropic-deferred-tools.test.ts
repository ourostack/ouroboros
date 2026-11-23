import { beforeEach, describe, expect, it } from "vitest"
import type OpenAI from "openai"
import { emitNervesEvent } from "../../nerves/runtime"
import { anthropicToolPlan, toAnthropicMessages, toAnthropicTools } from "../../heart/providers/anthropic"
import { formatFindToolsReply, formatLoadedDoors } from "../../repertoire/tool-catalog"

const tool = (name: string, description = ""): OpenAI.ChatCompletionFunctionTool =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } })

const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } })

describe("Anthropic deferred tool loading", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "engine", event: "engine.test_run", message: "anthropic deferred tools", meta: { test: true } })
  })

  it("marks deferred doors with defer_loading and leaves the rest loaded", () => {
    const tools = toAnthropicTools([tool("settle"), tool("find_tools"), tool("mail_send")], new Set(["mail_send"]))
    expect(tools.map((entry) => [entry.name, entry.defer_loading])).toEqual([["settle", undefined], ["find_tools", undefined], ["mail_send", true]])
  })

  it("never defers every tool, since the API refuses a request with none loaded", () => {
    const tools = toAnthropicTools([tool("a"), tool("b")], new Set(["a", "b"]))
    expect(tools.every((entry) => entry.defer_loading === undefined)).toBe(true)
  })

  it("sends find_tools results as tool_reference blocks for deferred doors, so the API loads them", () => {
    const result = formatLoadedDoors([tool("mail_send", "send a draft"), tool("mail_search", "search mail")])
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "send it" },
      { role: "assistant", content: null, tool_calls: [call("c1", "find_tools"), call("c2", "settle")] },
      { role: "tool", tool_call_id: "c1", content: result },
      { role: "tool", tool_call_id: "c2", content: "done" },
    ]
    const converted = toAnthropicMessages(messages, { toolReferences: new Set(["mail_send", "mail_search"]) }).messages
    expect(converted[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [
      { type: "tool_reference", tool_name: "mail_send" }, { type: "tool_reference", tool_name: "mail_search" },
    ] }] })
    expect(converted[3]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "done" }] })
  })

  it("references only doors this request defers, and keeps the text when none are left", () => {
    const result = formatLoadedDoors([tool("mail_send"), tool("gone")])
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "assistant", content: null, tool_calls: [call("c1", "find_tools")] },
      { role: "tool", tool_call_id: "c1", content: result },
      { role: "assistant", content: null, tool_calls: [call("c2", "find_tools")] },
      { role: "tool", tool_call_id: "c2", content: formatLoadedDoors([tool("gone")]) },
    ]
    const converted = toAnthropicMessages(messages, { toolReferences: new Set(["mail_send"]) }).messages
    expect((converted[1]!.content as Array<Record<string, unknown>>)[0]!.content).toEqual([{ type: "tool_reference", tool_name: "mail_send" }])
    expect((converted[3]!.content as Array<Record<string, unknown>>)[0]!.content).toBe(formatLoadedDoors([tool("gone")]))
  })

  it("sends a skill note as text after the tool_result, so the referenced doors don't swallow it", () => {
    const note = "skill shelf-keeping documents this, in \"Removing\" (load_skill shelf-keeping for the whole skill):\n`shelf library remove <id>`"
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "assistant", content: null, tool_calls: [call("c1", "find_tools")] },
      { role: "tool", tool_call_id: "c1", content: formatFindToolsReply([tool("mail_send")], note) },
    ]
    const converted = toAnthropicMessages(messages, { toolReferences: new Set(["mail_send"]) }).messages
    // tool_result blocks lead a user message; a text block may follow them. The references stay the result's content.
    expect(converted[1]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "c1", content: [{ type: "tool_reference", tool_name: "mail_send" }] },
      { type: "text", text: `skills that document this job:\n${note}` },
    ] })
  })

  it("holds a skill note until a run of parallel tool results ends, so text never sits between them", () => {
    const note = "skill shelf-keeping documents this, in \"Removing\" (load_skill shelf-keeping for the whole skill):\nremove it"
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "assistant", content: null, tool_calls: [call("c1", "find_tools"), call("c2", "shell")] },
      { role: "tool", tool_call_id: "c1", content: formatFindToolsReply([tool("mail_send")], note) },
      { role: "tool", tool_call_id: "c2", content: "ok" },
      { role: "user", content: "next" },
    ]
    const converted = toAnthropicMessages(messages, { toolReferences: new Set(["mail_send"]) }).messages
    expect(converted[1]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "tool_reference", tool_name: "mail_send" }] }] })
    expect(converted[2]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "c2", content: "ok" },
      { type: "text", text: `skills that document this job:\n${note}` },
    ] })
    expect(converted[3]).toMatchObject({ role: "user" })
  })

  it("keeps find_tools results as text without the option, as every other provider reads them", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "assistant", content: null, tool_calls: [call("c1", "find_tools")] },
      { role: "tool", tool_call_id: "c1", content: formatLoadedDoors([tool("mail_send")]) },
    ]
    expect((toAnthropicMessages(messages).messages[1]!.content as Array<Record<string, unknown>>)[0]!.content).toBe(formatLoadedDoors([tool("mail_send")]))
  })

  it("sends every held-back door, deferred, after the loaded ones, so the tool list stays the same as doors load", () => {
    const pool = [tool("mail_send"), tool("mail_search"), tool("coding_spawn")]
    const before = anthropicToolPlan([tool("settle"), tool("find_tools")], pool, [])
    expect(before.tools.map((entry) => entry.function.name)).toEqual(["settle", "find_tools", "mail_send", "mail_search", "coding_spawn"])
    expect([...before.deferred]).toEqual(["mail_send", "mail_search", "coding_spawn"])
    const found: OpenAI.ChatCompletionMessageParam[] = [
      { role: "assistant", content: null, tool_calls: [call("f1", "find_tools")] },
      { role: "tool", tool_call_id: "f1", content: formatLoadedDoors([tool("mail_send")]) },
    ]
    const after = anthropicToolPlan([tool("settle"), tool("find_tools"), tool("mail_send")], pool, found)
    expect(after.tools.map((entry) => entry.function.name)).toEqual(before.tools.map((entry) => entry.function.name))
    expect([...after.deferred]).toEqual([...before.deferred])
  })

  it("loads outright a held-back door the engine made callable without a find_tools reply, such as a skill's", () => {
    const plan = anthropicToolPlan([tool("settle"), tool("find_tools"), tool("coding_spawn")], [tool("mail_send"), tool("coding_spawn")], [])
    expect(plan.tools.map((entry) => entry.function.name)).toEqual(["settle", "find_tools", "mail_send", "coding_spawn"])
    expect([...plan.deferred]).toEqual(["mail_send"])
  })

  it("sends the active tools as they are when nothing is held back", () => {
    const plan = anthropicToolPlan([tool("settle")], undefined, [])
    expect(plan.tools.map((entry) => entry.function.name)).toEqual(["settle"])
    expect(plan.deferred.size).toBe(0)
  })
})
