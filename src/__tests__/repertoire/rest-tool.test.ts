import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"

describe("restTool definition", () => {
  it("exports a valid tool definition named rest", async () => {
    const { restTool } = await import("../../repertoire/tools-base")

    expect(restTool.type).toBe("function")
    expect(restTool.function.name).toBe("rest")
  })

  it("has description about resting/stopping", async () => {
    const { restTool } = await import("../../repertoire/tools-base")

    expect(restTool.function.description).toBeTruthy()
    expect(restTool.function.description).toContain("wheel")
  })

  it("has no required parameters", async () => {
    const { restTool } = await import("../../repertoire/tools-base")
    const params = restTool.function.parameters as any

    expect(params.properties).toEqual({})
    expect(params.required ?? []).toEqual([])
  })

  it("is re-exported from tools.ts", async () => {
    const tools = await import("../../repertoire/tools")
    expect((tools as any).restTool).toBeDefined()
    expect((tools as any).restTool.function.name).toBe("rest")
  })

  it("emits at least one nerves event when imported", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})
