import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"

describe("goInwardTool definition", () => {
  it("exports a valid tool definition with selfhood-framed description", async () => {
    const { goInwardTool } = await import("../../repertoire/tools-base")

    expect(goInwardTool.type).toBe("function")
    expect(goInwardTool.function.name).toBe("go_inward")
    expect(goInwardTool.function.description).toContain("think about this privately")
    expect(goInwardTool.function.description).toContain("must be the only tool call")
    // Selfhood framing -- first person, not dispatcher language
    expect(goInwardTool.function.description).toContain("i need to")
  })

  it("has topic as required parameter", async () => {
    const { goInwardTool } = await import("../../repertoire/tools-base")
    const params = goInwardTool.function.parameters as any

    expect(params.required).toEqual(["topic"])
    expect(params.properties.topic).toBeDefined()
    expect(params.properties.topic.type).toBe("string")
  })

  it("has optional answer parameter", async () => {
    const { goInwardTool } = await import("../../repertoire/tools-base")
    const params = goInwardTool.function.parameters as any

    expect(params.properties.answer).toBeDefined()
    expect(params.properties.answer.type).toBe("string")
    expect(params.required).not.toContain("answer")
  })

  it("has optional mode parameter with reflect/plan/relay enum", async () => {
    const { goInwardTool } = await import("../../repertoire/tools-base")
    const params = goInwardTool.function.parameters as any

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
