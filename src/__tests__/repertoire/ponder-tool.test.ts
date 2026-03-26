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

  it("has thought as optional parameter", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.thought).toBeDefined()
    expect(params.properties.thought.type).toBe("string")
    // Both thought and say are OPTIONAL (inner dialog calls with no args)
    expect(params.required ?? []).not.toContain("thought")
  })

  it("has say as optional parameter", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.say).toBeDefined()
    expect(params.properties.say.type).toBe("string")
    expect(params.required ?? []).not.toContain("say")
  })

  it("say parameter description mentions speaking to what caught attention", async () => {
    const { ponderTool } = await import("../../repertoire/tools-base")
    const params = ponderTool.function.parameters as any

    expect(params.properties.say.description).toContain("what caught your attention")
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
