import { beforeEach, describe, expect, it } from "vitest"
import type OpenAI from "openai"
import {
  CORE_TOOL_NAMES, FIND_TOOLS_NAME, deferredNamesCalledInHistory, deferredToolLoadingEnabled, formatFindToolsResult, partitionTools, searchDeferredTools,
} from "../../repertoire/deferred-tools"
import { emitNervesEvent } from "../../nerves/runtime"

const tool = (name: string, description = "", properties: Record<string, unknown> = {}, required: string[] = []): OpenAI.ChatCompletionFunctionTool =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } })

const all = [
  tool("shell"), tool("coding_spawn", "start a coding agent", { task: {}, dir: {} }, ["task"]), tool("coding_status", "check a coding agent"),
  tool("trip_upsert", "save a trip"), tool("weather", "forecast"), tool("flight_book", "book a flight", { id: {} }, ["id"]),
]

describe("deferred tool loading", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "engine", event: "engine.test_run", message: "deferred tool loading unit test", meta: { test: true } })
  })

  it("is off unless the flag is set", () => {
    expect(deferredToolLoadingEnabled({})).toBe(false)
    expect(deferredToolLoadingEnabled({ OURO_DEFERRED_TOOLS: "0" })).toBe(false)
    expect(deferredToolLoadingEnabled({ OURO_DEFERRED_TOOLS: "On" })).toBe(true)
    expect(deferredToolLoadingEnabled({ OURO_DEFERRED_TOOLS: "1" })).toBe(true)
  })

  it("keeps core and required tools, adds find_tools, and appends loaded tools last", () => {
    const { active, deferred } = partitionTools(all, ["weather", "missing"], new Set(["flight_book"]))
    expect(active.map((t) => t.function.name)).toEqual(["shell", "flight_book", FIND_TOOLS_NAME, "weather"])
    expect(deferred.map((t) => t.function.name)).toEqual(["coding_spawn", "coding_status", "trip_upsert", "weather"])
    const catalogue = active.find((t) => t.function.name === FIND_TOOLS_NAME)!.function.description!
    expect(catalogue).toContain("coding_*(spawn,status)")
    expect(catalogue).toContain("trip_upsert")
    expect(CORE_TOOL_NAMES.has("shell")).toBe(true)
  })

  it("adds no find_tools when nothing is deferred", () => {
    expect(partitionTools([tool("shell")]).active.map((t) => t.function.name)).toEqual(["shell"])
  })

  it("finds by name or description and by exact select", () => {
    const { deferred } = partitionTools(all)
    expect(searchDeferredTools(deferred, "start coding agent").map((t) => t.function.name)).toEqual(["coding_spawn", "coding_status"])
    expect(searchDeferredTools(deferred, "forecast").map((t) => t.function.name)).toEqual(["weather"])
    expect(searchDeferredTools(deferred, "select:trip_upsert, nope").map((t) => t.function.name)).toEqual(["trip_upsert"])
    expect(searchDeferredTools(deferred, "weather").length).toBe(1)
    expect(searchDeferredTools(deferred, "coding_spawn").map((t) => t.function.name)[0]).toBe("coding_spawn")
    expect(searchDeferredTools(deferred, "")).toEqual([])
  })

  it("matches name fragments and tools without a description", () => {
    const bare = { type: "function", function: { name: "bare_tool", parameters: { type: "object", properties: {} } } } as OpenAI.ChatCompletionFunctionTool
    const { deferred } = partitionTools([...all, bare])
    expect(searchDeferredTools(deferred, "spaw").map((t) => t.function.name)).toEqual(["coding_spawn"])
    expect(searchDeferredTools(deferred, "bare").map((t) => t.function.name)).toEqual(["bare_tool"])
  })

  it("formats results with required arguments marked and guidance when empty", () => {
    const { deferred } = partitionTools(all)
    expect(formatFindToolsResult(searchDeferredTools(deferred, "select:coding_spawn"))).toContain("coding_spawn(task, dir?): start a coding agent")
    expect(formatFindToolsResult([])).toContain("no matching tools")
    expect(formatFindToolsResult([tool("bare")])).toContain("bare():")
    const noParams = { type: "function", function: { name: "np" } } as OpenAI.ChatCompletionFunctionTool
    expect(formatFindToolsResult([noParams])).toContain("np():")
  })

  it("lists deferred tools the history already called, once each", () => {
    const { deferred } = partitionTools(all)
    const call = (name: string) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } })
    const history: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [call("coding_status"), call("shell"), call("coding_status")] },
      { role: "assistant", content: "plain" },
    ]
    expect(deferredNamesCalledInHistory(history, deferred)).toEqual(["coding_status"])
  })
})
