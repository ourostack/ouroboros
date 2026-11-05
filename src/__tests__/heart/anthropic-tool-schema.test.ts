import { describe, it, expect } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"
import { toAnthropicTools } from "../../heart/providers/anthropic"
import { baseToolDefinitions } from "../../repertoire/tools-base"
import { rootHostToolDefinition } from "../../repertoire/tools-sanctuary-host"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

describe("Anthropic tool schemas", () => {
  it("never sends oneOf, allOf or anyOf at the top level of a tool's input_schema", () => {
    emitTestEvent("anthropic tool schema top-level combinators")
    // The API rejects the whole request when any tool has one, which silenced every Anthropic turn.
    const tools = toAnthropicTools([...baseToolDefinitions.map((definition) => definition.tool), rootHostToolDefinition.tool])
    expect(tools.some((tool) => tool.name === "external_event_disposition")).toBe(true)
    for (const tool of tools) {
      const schema = tool.input_schema as Record<string, unknown>
      expect(Object.keys(schema).filter((key) => key === "oneOf" || key === "allOf" || key === "anyOf"), String(tool.name)).toEqual([])
      expect(schema.type, String(tool.name)).toBe("object")
    }
  })

  it("keeps the rest of the schema and defaults a missing schema to an empty object", () => {
    emitTestEvent("anthropic tool schema keeps properties")
    const [union, bare] = toAnthropicTools([
      { type: "function", function: { name: "union", parameters: { type: "object", properties: { a: { type: "string" } }, anyOf: [{ required: ["a"] }], additionalProperties: false } } },
      { type: "function", function: { name: "bare" } },
    ])
    expect(union).toEqual({ name: "union", description: "", input_schema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } })
    expect(bare.input_schema).toEqual({ type: "object", properties: {} })
  })
})
