import { describe, it, expect } from "vitest"
import { getChannelCapabilities, isRemoteChannel, getAlwaysOnSenseNames } from "../../../mind/friends/channel"

describe("mcp channel capabilities", () => {
  it("returns mcp capabilities with correct channel name", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.channel).toBe("mcp")
  })

  it("has senseType 'local'", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.senseType).toBe("local")
  })

  it("has no integrations", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.availableIntegrations).toEqual([])
  })

  it("supports markdown (dev tools render markdown)", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.supportsMarkdown).toBe(true)
  })

  it("does not support streaming", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.supportsStreaming).toBe(false)
  })

  it("does not support rich cards", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.supportsRichCards).toBe(false)
  })

  it("has infinite max message length", () => {
    const caps = getChannelCapabilities("mcp")
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("is NOT a remote channel", () => {
    const caps = getChannelCapabilities("mcp")
    expect(isRemoteChannel(caps)).toBe(false)
  })

  it("is NOT in always-on sense names", () => {
    const alwaysOn = getAlwaysOnSenseNames()
    expect(alwaysOn).not.toContain("mcp")
  })

  it("is a registered channel, not fallback defaults", () => {
    const mcpCaps = getChannelCapabilities("mcp")
    const unknownCaps = getChannelCapabilities("slack" as any)
    // mcp should have its own channel name, not fallback to "cli"
    expect(mcpCaps.channel).toBe("mcp")
    expect(unknownCaps.channel).toBe("cli") // fallback
  })
})
