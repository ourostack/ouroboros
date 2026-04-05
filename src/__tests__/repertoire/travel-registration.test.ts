import { describe, it, expect, vi, beforeEach } from "vitest"

describe("travel tools in tool registry", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("travelToolDefinitions are included in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const toolNames = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(toolNames).toContain("weather_lookup")
    expect(toolNames).toContain("travel_advisory")
    expect(toolNames).toContain("geocode_search")
  })

  it("travel tools appear in allDefinitions (tools.ts)", async () => {
    // The allDefinitions array is not directly exported, but getToolsForChannel returns base tools
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const tools = getToolsForChannel()
    const toolNames = tools.map((t) => t.function.name)
    expect(toolNames).toContain("weather_lookup")
    expect(toolNames).toContain("travel_advisory")
    expect(toolNames).toContain("geocode_search")
  })

  it("travel tools are base tools (no integration gate)", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const travelTools = baseToolDefinitions.filter((d) =>
      ["weather_lookup", "travel_advisory", "geocode_search"].includes(d.tool.function.name),
    )
    for (const tool of travelTools) {
      expect(tool.integration).toBeUndefined()
    }
  })
})
