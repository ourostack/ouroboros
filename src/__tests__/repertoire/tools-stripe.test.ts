import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock stripe-client
const mockCreateVirtualCard = vi.fn()
const mockDeactivateCard = vi.fn()
const mockListCards = vi.fn()
const mockGetCard = vi.fn()

vi.mock("../../repertoire/stripe-client", () => ({
  createStripeClient: vi.fn().mockResolvedValue({
    createVirtualCard: (...args: unknown[]) => mockCreateVirtualCard(...args),
    deactivateCard: (...args: unknown[]) => mockDeactivateCard(...args),
    listCards: (...args: unknown[]) => mockListCards(...args),
    getCard: (...args: unknown[]) => mockGetCard(...args),
  }),
}))

// Mock credential-access
vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => ({
    getRawSecret: vi.fn().mockResolvedValue("test-key"),
    isReady: () => true,
  }),
}))

import { stripeToolDefinitions, resetStripeClient } from "../../repertoire/tools-stripe"
import type { ToolContext } from "../../repertoire/tools-base"

function findTool(name: string) {
  const def = stripeToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

describe("stripeToolDefinitions", () => {
  it("exports 3 tool definitions", () => {
    expect(stripeToolDefinitions).toHaveLength(3)
  })

  it("contains stripe_create_card, stripe_deactivate_card, stripe_list_cards", () => {
    const names = stripeToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("stripe_create_card")
    expect(names).toContain("stripe_deactivate_card")
    expect(names).toContain("stripe_list_cards")
  })

  it("all tools have valid schemas and handlers", () => {
    for (const def of stripeToolDefinitions) {
      expect(def.tool.function.parameters).toBeDefined()
      expect(def.tool.function.parameters!.type).toBe("object")
      expect(typeof def.handler).toBe("function")
    }
  })
})

describe("resetStripeClient", () => {
  it("resets the singleton without error", () => {
    expect(() => resetStripeClient()).not.toThrow()
  })
})

describe("stripe_create_card — no context", () => {
  const tool = findTool("stripe_create_card")

  it("returns error when no friend context", async () => {
    const result = await tool.handler({ type: "single_use", spend_limit: "100", currency: "usd" })
    expect(result).toContain("no friend context")
  })

  it("returns error when ctx has no friend", async () => {
    const result = await tool.handler(
      { type: "single_use", spend_limit: "100", currency: "usd" },
      { context: {} } as any,
    )
    expect(result).toContain("no friend context")
  })
})

describe("stripe_create_card handler", () => {
  const tool = findTool("stripe_create_card")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("creates a virtual card and returns cardId + last4", async () => {
    mockCreateVirtualCard.mockResolvedValue({
      cardId: "ic_123",
      last4: "4242",
      status: "active",
    })

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    const result = await tool.handler({
      type: "single_use",
      spend_limit: "500",
      currency: "usd",
    }, ctx)

    expect(result).toContain("ic_123")
    expect(result).toContain("4242")
    expect(result).not.toContain("4242424242424242") // no full card number
  })

  it("rejects non-family trust level", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Friend", trustLevel: "friend" },
      } as any,
    }

    const result = await tool.handler({
      type: "single_use",
      spend_limit: "100",
      currency: "usd",
    }, ctx)

    expect(result).toContain("family")
    expect(mockCreateVirtualCard).not.toHaveBeenCalled()
  })

  it("passes parsed merchant categories to Stripe", async () => {
    mockCreateVirtualCard.mockResolvedValue({
      cardId: "ic_mc",
      last4: "1234",
      status: "active",
    })

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    await tool.handler({
      type: "single_use",
      spend_limit: "500",
      currency: "usd",
      merchant_categories: "airlines_air_carriers, hotels_motels",
    }, ctx)

    expect(mockCreateVirtualCard).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantCategories: ["airlines_air_carriers", "hotels_motels"],
      }),
    )
  })

  it("handles Stripe API errors", async () => {
    mockCreateVirtualCard.mockRejectedValue(new Error("Stripe API error"))

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    const result = await tool.handler({
      type: "single_use",
      spend_limit: "100",
      currency: "usd",
    }, ctx)

    expect(result).toContain("error")
  })

  it("emits nerves events", async () => {
    mockCreateVirtualCard.mockResolvedValue({
      cardId: "ic_123",
      last4: "4242",
      status: "active",
    })

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    await tool.handler({ type: "single_use", spend_limit: "100", currency: "usd" }, ctx)
    expect(nervesEvents.some((e) => e.event === "repertoire.tool_stripe_create_card")).toBe(true)
  })
})

describe("stripe_deactivate_card handler", () => {
  const tool = findTool("stripe_deactivate_card")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("deactivates a card", async () => {
    mockDeactivateCard.mockResolvedValue({
      cardId: "ic_123",
      last4: "4242",
      status: "canceled",
    })

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    const result = await tool.handler({ card_id: "ic_123" }, ctx)
    expect(result).toContain("canceled")
  })

  it("rejects non-family trust", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Stranger", trustLevel: "acquaintance" },
      } as any,
    }

    const result = await tool.handler({ card_id: "ic_123" }, ctx)
    expect(result).toContain("family")
  })
})

describe("stripe_deactivate_card — no context", () => {
  const tool = findTool("stripe_deactivate_card")

  it("returns error when no friend context", async () => {
    const result = await tool.handler({ card_id: "ic_123" })
    expect(result).toContain("no friend context")
  })
})

describe("stripe_list_cards — no context", () => {
  const tool = findTool("stripe_list_cards")

  it("returns error when no friend context", async () => {
    const result = await tool.handler({})
    expect(result).toContain("no friend context")
  })
})

describe("stripe_list_cards handler", () => {
  const tool = findTool("stripe_list_cards")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("lists active cards", async () => {
    mockListCards.mockResolvedValue([
      { cardId: "ic_1", last4: "1111", status: "active" },
      { cardId: "ic_2", last4: "2222", status: "active" },
    ])

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    const result = await tool.handler({}, ctx)
    expect(result).toContain("ic_1")
    expect(result).toContain("ic_2")
  })

  it("handles no cards", async () => {
    mockListCards.mockResolvedValue([])

    const ctx: ToolContext = {
      context: {
        friend: { id: "f-1", name: "Ari", trustLevel: "family" },
      } as any,
    }

    const result = await tool.handler({}, ctx)
    expect(result).toContain("no") // "no active cards" or similar
  })
})
