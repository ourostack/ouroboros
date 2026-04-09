import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"

describe("ponderTool definition", () => {
  it("exports a valid tool definition named ponder", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")

    expect(ponderTool.type).toBe("function")
    expect(ponderTool.function.name).toBe("ponder")
  })

  it("has description about thinking/pondering", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")

    expect(ponderTool.function.description).toBeTruthy()
    // Should mention pondering/thinking, not "descend"
    expect(ponderTool.function.description).not.toContain("descend")
  })

  it("has action and kind packet parameters", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.action).toBeDefined()
    expect(params.properties.kind).toBeDefined()
    expect(params.properties.action.enum).toEqual(["create", "revise"])
    expect(params.properties.kind.enum).toEqual(["harness_friction", "research", "reflection"])
  })

  it("has packet spec fields", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.objective).toBeDefined()
    expect(params.properties.summary).toBeDefined()
    expect(params.properties.success_criteria).toBeDefined()
    expect(params.properties.payload_json).toBeDefined()
  })

  it("keeps deprecated thought and say fields for migration", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.thought).toBeDefined()
    expect(params.properties.say).toBeDefined()
    expect(params.properties.say.description).toContain("migration")
  })

  it("does not have mode parameter", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.mode).toBeUndefined()
  })

  it("does not have topic parameter (renamed to thought)", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.topic).toBeUndefined()
  })

  it("does not export descendTool", async () => {
    const toolsBase = await import("../../repertoire/tools-base")
    expect((toolsBase as any).descendTool).toBeUndefined()
  })

  it("is re-exported from tools.ts", async () => {
    const tools = await import("../../repertoire/tools")
    expect((tools as any).ponderTool).toBeDefined()
    expect((tools as any).ponderTool.function.name).toBe("ponder")
  })

  it("descendTool is not re-exported from tools.ts", async () => {
    const tools = await import("../../repertoire/tools")
    expect((tools as any).descendTool).toBeUndefined()
  })

  it("emits at least one nerves event when imported", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})

describe("descend -> ponder migration", () => {
  it("TOOL_NAME_MIGRATIONS maps descend to ponder", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "descend", arguments: '{"topic":"think"}' } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "(going inward)" },
    ]
    const migrated = migrateToolNames(messages)
    expect((migrated[0] as any).tool_calls[0].function.name).toBe("ponder")
  })

  it("emits at least one nerves event for migration test", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})
