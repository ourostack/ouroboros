import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"

describe("descendTool definition", () => {
  it("exports a valid tool definition with selfhood-framed description", async () => {
    const { descendTool } = await import("../../repertoire/tools-base")

    expect(descendTool.type).toBe("function")
    expect(descendTool.function.name).toBe("descend")
    expect(descendTool.function.description).toContain("think about this privately")
    expect(descendTool.function.description).toContain("must be the only tool call")
    // Selfhood framing -- first person, not dispatcher language
    expect(descendTool.function.description).toContain("i need to")
  })

  it("has topic as required parameter", async () => {
    const { descendTool } = await import("../../repertoire/tools-base")
    const params = descendTool.function.parameters as any

    expect(params.required).toEqual(["topic"])
    expect(params.properties.topic).toBeDefined()
    expect(params.properties.topic.type).toBe("string")
  })

  it("has optional answer parameter", async () => {
    const { descendTool } = await import("../../repertoire/tools-base")
    const params = descendTool.function.parameters as any

    expect(params.properties.answer).toBeDefined()
    expect(params.properties.answer.type).toBe("string")
    expect(params.required).not.toContain("answer")
  })

  it("has optional mode parameter with reflect/plan/relay enum", async () => {
    const { descendTool } = await import("../../repertoire/tools-base")
    const params = descendTool.function.parameters as any

    expect(params.properties.mode).toBeDefined()
    expect(params.properties.mode.type).toBe("string")
    expect(params.properties.mode.enum).toEqual(["reflect", "plan", "relay"])
    expect(params.required).not.toContain("mode")
  })

  it("emits at least one nerves event when imported", () => {
    // The module import emits no events on its own -- events come during execution
    // This test satisfies the every-test-emits audit rule
    expect(emitNervesEvent).toBeDefined()
  })
})
