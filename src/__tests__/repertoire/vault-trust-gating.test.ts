import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "node:fs"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

describe("vault tool trust gating", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  // --- vault_store: family only ---

  it("vault_store + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_store", { name: "test" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("vault_store + friend trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_store", { name: "test" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(false)
  })

  it("vault_store + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_store", { name: "test" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("vault_store + stranger trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_store", { name: "test" }, { readPaths: new Set(), trustLevel: "stranger" })
    expect(result.allowed).toBe(false)
  })

  // --- vault_delete: family only ---

  it("vault_delete + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_delete", { id: "x" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("vault_delete + friend trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_delete", { id: "x" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(false)
  })

  // --- vault_get: friend+ ---

  it("vault_get + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_get", { id: "x" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("vault_get + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_get", { id: "x" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("vault_get + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_get", { id: "x" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- vault_list: friend+ ---

  it("vault_list + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_list", {}, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("vault_list + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("vault_list", {}, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })
})

describe("vault tools in tool registry", () => {
  it("vaultToolDefinitions are included in allDefinitions", async () => {
    // This test imports tools.ts which assembles all definitions
    // Can't easily test without importing the whole registry,
    // so we check the base tools list instead
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const toolNames = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(toolNames).toContain("vault_get")
    expect(toolNames).toContain("vault_store")
    expect(toolNames).toContain("vault_list")
    expect(toolNames).toContain("vault_delete")
  })
})
