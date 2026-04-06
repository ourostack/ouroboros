import { describe, it, expect, vi, beforeEach } from "vitest"

describe("commerce tools in tool registry", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("user profile tools are included in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const toolNames = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(toolNames).toContain("user_profile_store")
    expect(toolNames).toContain("user_profile_get")
    expect(toolNames).toContain("user_profile_delete")
  })

  it("Stripe tools are included in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const toolNames = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(toolNames).toContain("stripe_create_card")
    expect(toolNames).toContain("stripe_deactivate_card")
    expect(toolNames).toContain("stripe_list_cards")
  })

  it("Duffel flight tools are included in baseToolDefinitions", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const toolNames = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(toolNames).toContain("flight_search")
    expect(toolNames).toContain("flight_hold")
    expect(toolNames).toContain("flight_book")
    expect(toolNames).toContain("flight_cancel")
  })

  it("all commerce tools have valid schemas", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const commerceToolNames = [
      "user_profile_store", "user_profile_get", "user_profile_delete",
      "stripe_create_card", "stripe_deactivate_card", "stripe_list_cards",
      "flight_search", "flight_hold", "flight_book", "flight_cancel",
    ]
    for (const name of commerceToolNames) {
      const def = baseToolDefinitions.find((d) => d.tool.function.name === name)
      expect(def, `${name} should be registered`).toBeDefined()
      expect(def!.tool.function.parameters).toBeDefined()
      expect(def!.tool.function.parameters!.type).toBe("object")
      expect(typeof def!.handler).toBe("function")
    }
  })

  it("user profile tools are family-trust gated in guardrails", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const familyTools = ["user_profile_store", "user_profile_get", "user_profile_delete"]
    for (const tool of familyTools) {
      // Friend trust should be denied
      const friendResult = guardInvocation(tool, {}, {
        readPaths: new Set(),
        trustLevel: "friend",
      })
      expect(friendResult.allowed, `${tool} should deny friend trust`).toBe(false)

      // Family trust should be allowed
      const familyResult = guardInvocation(tool, {}, {
        readPaths: new Set(),
        trustLevel: "family",
      })
      expect(familyResult.allowed, `${tool} should allow family trust`).toBe(true)
    }
  })

  it("Stripe tools are family-trust gated in guardrails", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const stripeTools = ["stripe_create_card", "stripe_deactivate_card", "stripe_list_cards"]
    for (const tool of stripeTools) {
      const friendResult = guardInvocation(tool, {}, {
        readPaths: new Set(),
        trustLevel: "friend",
      })
      expect(friendResult.allowed, `${tool} should deny friend trust`).toBe(false)

      const familyResult = guardInvocation(tool, {}, {
        readPaths: new Set(),
        trustLevel: "family",
      })
      expect(familyResult.allowed, `${tool} should allow family trust`).toBe(true)
    }
  })
})
