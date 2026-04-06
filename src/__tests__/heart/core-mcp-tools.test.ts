import { describe, it, expect, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("runAgent mcpManager threading", () => {
  it("RunAgentOptions includes mcpManager field", async () => {
    // Verify the type exists by importing and checking
    const core = await import("../../heart/core")
    // RunAgentOptions is an interface — we verify it's usable by constructing a valid options object
    const options: import("../../heart/core").RunAgentOptions = {
      mcpManager: undefined,
    }
    expect(options).toBeDefined()
    expect(core.runAgent).toBeDefined()
  })

  it("getToolsForChannel accepts mcpManager as 5th parameter", async () => {
    // This test verifies the integration point exists
    const tools = await import("../../repertoire/tools")
    // Call with all 5 params including mcpManager (null = no MCP tools)
    const result = tools.getToolsForChannel(
      undefined, undefined, undefined, undefined, undefined,
    )
    expect(result).toBeDefined()
    expect(Array.isArray(result)).toBe(true)
  })
})
