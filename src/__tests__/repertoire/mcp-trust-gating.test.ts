import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "node:fs"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

describe("MCP server trust gating via shell guardrails", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  // --- browser MCP: friend+ trust, no group chat ---

  it("browser MCP call allowed for family trust in non-group context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call browser navigate --args '{}'" },
      { readPaths: new Set(), trustLevel: "family", isGroupChat: false },
    )
    expect(result.allowed).toBe(true)
  })

  it("browser MCP call allowed for friend trust in non-group context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call browser navigate" },
      { readPaths: new Set(), trustLevel: "friend" },
    )
    expect(result.allowed).toBe(true)
  })

  it("browser MCP call denied for acquaintance trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call browser navigate" },
      { readPaths: new Set(), trustLevel: "acquaintance" },
    )
    expect(result.allowed).toBe(false)
  })

  it("browser MCP call denied in group chat even for family trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call browser navigate" },
      { readPaths: new Set(), trustLevel: "family", isGroupChat: true },
    )
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toContain("1:1")
    }
  })

  // --- non-browser MCP: default friend-level trust ---

  it("duffel MCP call allowed for friend trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call duffel search_flights" },
      { readPaths: new Set(), trustLevel: "friend" },
    )
    expect(result.allowed).toBe(true)
  })

  it("duffel MCP call denied for acquaintance trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call duffel search_flights" },
      { readPaths: new Set(), trustLevel: "acquaintance" },
    )
    expect(result.allowed).toBe(false)
  })

  it("duffel MCP call allowed in group chat for friend trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro mcp call duffel search_flights" },
      { readPaths: new Set(), trustLevel: "friend", isGroupChat: true },
    )
    expect(result.allowed).toBe(true)
  })

  // --- non-MCP ouro commands unaffected ---

  it("ouro whoami still works for acquaintance", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation(
      "shell",
      { command: "ouro whoami" },
      { readPaths: new Set(), trustLevel: "acquaintance" },
    )
    expect(result.allowed).toBe(true)
  })
})
