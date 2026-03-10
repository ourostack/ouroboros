import { describe, it, expect } from "vitest"
import { getChannelCapabilities } from "../../../mind/friends/channel"
import { isIntegration } from "../../../mind/friends/types"

describe("getChannelCapabilities", () => {
  it("returns CLI capabilities with empty integrations", () => {
    const caps = getChannelCapabilities("cli")
    expect(caps.channel).toBe("cli")
    expect(caps.availableIntegrations).toEqual([])
    expect(caps.supportsMarkdown).toBe(false)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsRichCards).toBe(false)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("returns Teams capabilities with ado and graph integrations", () => {
    const caps = getChannelCapabilities("teams")
    expect(caps.channel).toBe("teams")
    expect(caps.availableIntegrations).toEqual(["ado", "graph", "github"])
    expect(caps.supportsMarkdown).toBe(true)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsRichCards).toBe(true)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("returns BlueBubbles capabilities with remote-safe defaults", () => {
    const caps = getChannelCapabilities("bluebubbles")
    expect(caps.channel).toBe("bluebubbles")
    expect(caps.availableIntegrations).toEqual([])
    expect(caps.supportsMarkdown).toBe(false)
    expect(caps.supportsStreaming).toBe(false)
    expect(caps.supportsRichCards).toBe(false)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("returns minimal default capabilities for unknown channel", () => {
    const caps = getChannelCapabilities("slack" as any)
    expect(caps.channel).toBe("cli") // falls back to CLI-like defaults
    expect(caps.availableIntegrations).toEqual([])
    expect(caps.supportsMarkdown).toBe(false)
    expect(caps.supportsStreaming).toBe(false)
    expect(caps.supportsRichCards).toBe(false)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("all integration values are valid Integration types", () => {
    const teamsCaps = getChannelCapabilities("teams")
    for (const integration of teamsCaps.availableIntegrations) {
      expect(isIntegration(integration)).toBe(true)
    }
  })

  it("teams channel includes github in availableIntegrations", () => {
    const caps = getChannelCapabilities("teams")
    expect(caps.availableIntegrations).toContain("github")
  })

  it("cli channel does NOT include github in availableIntegrations", () => {
    const caps = getChannelCapabilities("cli")
    expect(caps.availableIntegrations).not.toContain("github")
  })

  it("all capability fields are present and correctly typed", () => {
    for (const channel of ["cli", "teams", "bluebubbles"] as const) {
      const caps = getChannelCapabilities(channel)
      expect(typeof caps.channel).toBe("string")
      expect(Array.isArray(caps.availableIntegrations)).toBe(true)
      expect(typeof caps.supportsMarkdown).toBe("boolean")
      expect(typeof caps.supportsStreaming).toBe("boolean")
      expect(typeof caps.supportsRichCards).toBe("boolean")
      expect(typeof caps.maxMessageLength).toBe("number")
    }
  })

  it("returns inner dialog capabilities with no markdown, streaming enabled, no rich cards, no integrations", () => {
    const caps = getChannelCapabilities("inner")
    expect(caps.channel).toBe("inner")
    expect(caps.availableIntegrations).toEqual([])
    expect(caps.supportsMarkdown).toBe(false)
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.supportsRichCards).toBe(false)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("inner channel is a registered channel, not a fallback", () => {
    const innerCaps = getChannelCapabilities("inner")
    const unknownCaps = getChannelCapabilities("slack" as any)
    // inner should have its own channel name, not fallback to "cli"
    expect(innerCaps.channel).toBe("inner")
    expect(unknownCaps.channel).toBe("cli") // fallback
  })
})
