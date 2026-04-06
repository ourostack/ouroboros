import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}))

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import { guardInvocation } from "../../repertoire/guardrails"

describe("first-class MCP tool trust gating", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  // --- browser MCP tools: friend+ trust, no group chat ---

  it("browser MCP tool blocked when trust level insufficient (acquaintance)", () => {
    const result = guardInvocation(
      "browser_navigate",
      { url: "https://example.com" },
      { readPaths: new Set(), trustLevel: "acquaintance", mcpServerName: "browser" },
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain("vouch")
  })

  it("browser MCP tool blocked in group chat even for family trust", () => {
    const result = guardInvocation(
      "browser_navigate",
      { url: "https://example.com" },
      { readPaths: new Set(), trustLevel: "family", isGroupChat: true, mcpServerName: "browser" },
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toContain("1:1")
  })

  it("browser MCP tool allowed for friend trust in non-group context", () => {
    const result = guardInvocation(
      "browser_navigate",
      { url: "https://example.com" },
      { readPaths: new Set(), trustLevel: "friend", mcpServerName: "browser" },
    )
    expect(result.allowed).toBe(true)
  })

  it("browser MCP tool allowed for family trust in non-group context", () => {
    const result = guardInvocation(
      "browser_navigate",
      { url: "https://example.com" },
      { readPaths: new Set(), trustLevel: "family", mcpServerName: "browser" },
    )
    expect(result.allowed).toBe(true)
  })

  // --- non-browser MCP tools: default pass-through ---

  it("non-browser MCP tool (duffel) allowed with no special trust rules", () => {
    const result = guardInvocation(
      "duffel_search_flights",
      {},
      { readPaths: new Set(), trustLevel: "friend", mcpServerName: "duffel" },
    )
    expect(result.allowed).toBe(true)
  })

  it("non-browser MCP tool allowed for acquaintance (no MCP trust entry)", () => {
    const result = guardInvocation(
      "duffel_search_flights",
      {},
      { readPaths: new Set(), trustLevel: "acquaintance", mcpServerName: "duffel" },
    )
    // No trust rules for duffel — allowed at any trust level
    expect(result.allowed).toBe(true)
  })

  // --- non-MCP tools: behavior unchanged ---

  it("non-MCP tool without mcpServerName: existing guardrails still apply", () => {
    const result = guardInvocation(
      "shell",
      { command: "npm test" },
      { readPaths: new Set(), trustLevel: "acquaintance" },
    )
    expect(result.allowed).toBe(false)
  })

  it("read-only tools still allowed regardless of mcpServerName presence", () => {
    const result = guardInvocation(
      "read_file",
      { path: "/tmp/test.txt" },
      { readPaths: new Set(), trustLevel: "acquaintance" },
    )
    expect(result.allowed).toBe(true)
  })
})
