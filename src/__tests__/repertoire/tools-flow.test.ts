import { describe, it, expect } from "vitest"

describe("speakTool schema (Unit 5)", () => {
  it("is exported from src/repertoire/tools-flow.ts", async () => {
    const flow = await import("../../repertoire/tools-flow")
    expect(flow.speakTool).toBeDefined()
  })

  it("is re-exported from src/repertoire/tools-base.ts", async () => {
    const base = await import("../../repertoire/tools-base")
    expect((base as any).speakTool).toBeDefined()
  })

  it("is re-exported from src/repertoire/tools.ts", async () => {
    const tools = await import("../../repertoire/tools")
    expect((tools as any).speakTool).toBeDefined()
  })

  it("function.name === 'speak'", async () => {
    const { speakTool } = await import("../../repertoire/tools-flow")
    expect(speakTool.function.name).toBe("speak")
  })

  it("type === 'function'", async () => {
    const { speakTool } = await import("../../repertoire/tools-flow")
    expect(speakTool.type).toBe("function")
  })

  it("description starts with first-person 'i ', includes the literal word 'speak', and contains no hedging", async () => {
    const { speakTool } = await import("../../repertoire/tools-flow")
    const description = speakTool.function.description ?? ""
    expect(description.length).toBeGreaterThan(0)
    expect(description.startsWith("i ")).toBe(true)
    expect(description).toContain("speak")
    // anti-hedging regex (matches Unit 9a) — "can" intentionally excluded; see doing doc Pass 8 note.
    expect(/(\b(may|should|prefer)\b|if relevant)/i.test(description)).toBe(false)
  })

  it("schema requires exactly one property `message: string` with required = ['message']", async () => {
    const { speakTool } = await import("../../repertoire/tools-flow")
    const params: any = speakTool.function.parameters
    expect(params.type).toBe("object")
    expect(Object.keys(params.properties)).toEqual(["message"])
    expect(params.properties.message.type).toBe("string")
    expect(params.required).toEqual(["message"])
  })

  it("Stranger With Candy: summarizeArgs('speak', { message: 'hi there' }) renders 'message=hi there' via the unknown-args fallback", async () => {
    const { summarizeArgs } = await import("../../repertoire/tools")
    expect(summarizeArgs("speak", { message: "hi there" })).toBe("message=hi there")
  })

  it("Stranger With Candy: summarizeArgs clips long messages at 60 chars with ellipsis", async () => {
    const { summarizeArgs } = await import("../../repertoire/tools")
    const longMsg = "x".repeat(80)
    const result = summarizeArgs("speak", { message: longMsg })
    expect(result.startsWith("message=")).toBe(true)
    expect(result.endsWith("...")).toBe(true)
    // 60 chars + "message=" prefix + "..."
    expect(result.length).toBe("message=".length + 60 + "...".length)
  })
})
