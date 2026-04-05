import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "node:fs"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

describe("credential tool trust gating", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  // --- credential_store: family only ---

  it("credential_store + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_store", { domain: "test.com" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("credential_store + friend trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_store", { domain: "test.com" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(false)
  })

  it("credential_store + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_store", { domain: "test.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("credential_store + stranger trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_store", { domain: "test.com" }, { readPaths: new Set(), trustLevel: "stranger" })
    expect(result.allowed).toBe(false)
  })

  // --- credential_delete: family only ---

  it("credential_delete + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_delete", { domain: "x.com" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("credential_delete + friend trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_delete", { domain: "x.com" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(false)
  })

  // --- credential_get: friend+ ---

  it("credential_get + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_get", { domain: "x.com" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("credential_get + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_get", { domain: "x.com" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("credential_get + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_get", { domain: "x.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- credential_list: friend+ ---

  it("credential_list + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_list", {}, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("credential_list + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("credential_list", {}, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })
})

describe("credential tools in tool registry", () => {
  it("credentialToolDefinitions are included in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const toolNames = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(toolNames).toContain("credential_get")
    expect(toolNames).toContain("credential_store")
    expect(toolNames).toContain("credential_list")
    expect(toolNames).toContain("credential_delete")
  })
})

describe("travel tool trust gating", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  // --- weather_lookup: friend+ (accesses credentials indirectly) ---

  it("weather_lookup + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("weather_lookup", { city: "London" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("weather_lookup + family trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("weather_lookup", { city: "London" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  it("weather_lookup + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("weather_lookup", { city: "London" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("weather_lookup + stranger trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("weather_lookup", { city: "London" }, { readPaths: new Set(), trustLevel: "stranger" })
    expect(result.allowed).toBe(false)
  })

  // --- travel_advisory: friend+ ---

  it("travel_advisory + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("travel_advisory", { country_code: "AF" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("travel_advisory + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("travel_advisory", { country_code: "AF" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- geocode_search: friend+ ---

  it("geocode_search + friend trust = allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("geocode_search", { query: "London" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("geocode_search + acquaintance trust = denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("geocode_search", { query: "London" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- undefined trustLevel defaults to friend (trusted) ---

  it("weather_lookup + undefined trust = allowed (friend default)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("weather_lookup", { city: "London" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })
})
