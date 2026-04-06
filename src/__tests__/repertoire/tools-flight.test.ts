import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock duffel-client
const mockSearchFlights = vi.fn()
const mockCreateOrder = vi.fn()
const mockCancelOrder = vi.fn()

vi.mock("../../repertoire/duffel-client", () => ({
  createDuffelClient: vi.fn().mockResolvedValue({
    searchFlights: (...args: unknown[]) => mockSearchFlights(...args),
    createOrder: (...args: unknown[]) => mockCreateOrder(...args),
    cancelOrder: (...args: unknown[]) => mockCancelOrder(...args),
  }),
}))

// Mock user-profile for passenger data
const mockGetUserProfileField = vi.fn()
vi.mock("../../repertoire/user-profile", () => ({
  getUserProfileField: (...args: unknown[]) => mockGetUserProfileField(...args),
}))

// Mock credential-access
vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => ({
    getRawSecret: vi.fn().mockResolvedValue("test-key"),
    isReady: () => true,
  }),
}))

import { flightToolDefinitions, resetDuffelClient } from "../../repertoire/tools-flight"
import type { ToolContext } from "../../repertoire/tools-base"

function findTool(name: string) {
  const def = flightToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

const familyCtx: ToolContext = {
  context: {
    friend: { id: "f-1", name: "Ari", trustLevel: "family" },
  } as any,
}

const friendCtx: ToolContext = {
  context: {
    friend: { id: "f-1", name: "Friend", trustLevel: "friend" },
  } as any,
}

describe("flightToolDefinitions", () => {
  it("exports 4 tool definitions", () => {
    expect(flightToolDefinitions).toHaveLength(4)
  })

  it("contains flight_search, flight_hold, flight_book, flight_cancel", () => {
    const names = flightToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("flight_search")
    expect(names).toContain("flight_hold")
    expect(names).toContain("flight_book")
    expect(names).toContain("flight_cancel")
  })
})

describe("flight_search handler — no context", () => {
  const tool = findTool("flight_search")

  it("returns error when no friend context is provided", async () => {
    const result = await tool.handler({ origin: "SFO", destination: "JFK", departure_date: "2026-05-01" })
    expect(result).toContain("no friend context")
  })

  it("returns error when ctx has no friend", async () => {
    const result = await tool.handler(
      { origin: "SFO", destination: "JFK", departure_date: "2026-05-01" },
      { context: {} } as any,
    )
    expect(result).toContain("no friend context")
  })
})

describe("flight_hold handler", () => {
  const tool = findTool("flight_hold")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns hold acknowledgment for family trust", async () => {
    const result = await tool.handler({ offer_id: "off_123" }, familyCtx)
    const parsed = JSON.parse(result)
    expect(parsed.status).toBe("hold_requested")
    expect(parsed.offerId).toBe("off_123")
  })

  it("requires family trust level", async () => {
    const result = await tool.handler({ offer_id: "off_123" }, friendCtx)
    expect(result).toContain("family")
  })

  it("returns error when no friend context", async () => {
    const result = await tool.handler({ offer_id: "off_123" })
    expect(result).toContain("no friend context")
  })
})

describe("flight_search — no results", () => {
  const tool = findTool("flight_search")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns message when no flights found", async () => {
    mockSearchFlights.mockResolvedValue([])
    const result = await tool.handler({
      origin: "SFO",
      destination: "XYZ",
      departure_date: "2026-05-01",
    }, friendCtx)
    expect(result).toContain("no flights found")
  })
})

describe("resetDuffelClient", () => {
  it("resets the singleton without error", () => {
    expect(() => resetDuffelClient()).not.toThrow()
  })
})

describe("flight_search handler", () => {
  const tool = findTool("flight_search")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("searches flights and returns structured results", async () => {
    mockSearchFlights.mockResolvedValue([
      {
        id: "off_123",
        totalAmount: "350.00",
        totalCurrency: "USD",
        slices: [{ origin: "SFO", destination: "JFK", duration: "PT5H", carrier: "United" }],
      },
    ])

    const result = await tool.handler({
      origin: "SFO",
      destination: "JFK",
      departure_date: "2026-05-01",
      passengers: "1",
    }, friendCtx)

    expect(result).toContain("off_123")
    expect(result).toContain("350.00")
  })

  it("allows friend trust level (search is safe)", async () => {
    mockSearchFlights.mockResolvedValue([])
    const result = await tool.handler({
      origin: "SFO",
      destination: "JFK",
      departure_date: "2026-05-01",
      passengers: "1",
    }, friendCtx)
    // Should not be denied
    expect(result).not.toContain("family")
  })
})

describe("flight_book handler", () => {
  const tool = findTool("flight_book")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("books a flight using profile passenger data", async () => {
    mockGetUserProfileField.mockImplementation((_id: string, field: string) => {
      if (field === "legalName") return Promise.resolve({ first: "John", last: "Doe" })
      if (field === "dateOfBirth") return Promise.resolve("1990-01-15")
      if (field === "passport") return Promise.resolve({ number: "P123", country: "US", expiry: "2030-01-01" })
      return Promise.resolve(undefined)
    })

    mockCreateOrder.mockResolvedValue({
      orderId: "ord_123",
      bookingReference: "ABC123",
      totalAmount: "350.00",
      totalCurrency: "USD",
    })

    const result = await tool.handler({
      offer_id: "off_123",
      amount: "350",
      currency: "usd",
    }, familyCtx)

    expect(result).toContain("ord_123")
    expect(result).toContain("ABC123")
    expect(mockCreateOrder).toHaveBeenCalled()
  })

  it("requires family trust level for booking", async () => {
    const result = await tool.handler({
      offer_id: "off_123",
      amount: "350",
      currency: "usd",
    }, friendCtx)

    expect(result).toContain("family")
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })

  it("handles missing profile", async () => {
    mockGetUserProfileField.mockResolvedValue(undefined)

    const result = await tool.handler({
      offer_id: "off_123",
      amount: "350",
      currency: "usd",
    }, familyCtx)

    expect(result).toContain("profile")
  })

  it("emits nerves events", async () => {
    mockGetUserProfileField.mockImplementation((_id: string, field: string) => {
      if (field === "legalName") return Promise.resolve({ first: "John", last: "Doe" })
      if (field === "dateOfBirth") return Promise.resolve("1990-01-15")
      return Promise.resolve(undefined)
    })

    mockCreateOrder.mockResolvedValue({
      orderId: "ord_123",
      bookingReference: "ABC123",
      totalAmount: "350.00",
      totalCurrency: "USD",
    })

    await tool.handler({ offer_id: "off_123", amount: "350", currency: "usd" }, familyCtx)
    expect(nervesEvents.some((e) => e.event === "repertoire.tool_flight_book")).toBe(true)
  })
})

describe("flight_book — no context", () => {
  const tool = findTool("flight_book")

  it("returns error when no friend context", async () => {
    const result = await tool.handler({ offer_id: "off_123", amount: "350", currency: "usd" })
    expect(result).toContain("no friend context")
  })
})

describe("flight_cancel handler", () => {
  const tool = findTool("flight_cancel")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("cancels an order", async () => {
    mockCancelOrder.mockResolvedValue({
      id: "ocr_123",
      orderId: "ord_123",
      confirmed: true,
    })

    const result = await tool.handler({ order_id: "ord_123" }, familyCtx)
    expect(result).toContain("confirmed")
  })

  it("requires family trust", async () => {
    const result = await tool.handler({ order_id: "ord_123" }, friendCtx)
    expect(result).toContain("family")
  })

  it("returns error when no friend context", async () => {
    const result = await tool.handler({ order_id: "ord_123" })
    expect(result).toContain("no friend context")
  })
})
