import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock credential store
const mockGetRawSecret = vi.fn().mockResolvedValue("rk_test_stripe_key_123")
vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => ({
    getRawSecret: mockGetRawSecret,
    isReady: () => true,
  }),
}))

// Mock stripe SDK
const mockCardsCreate = vi.fn()
const mockCardsRetrieve = vi.fn()
const mockCardsUpdate = vi.fn()
const mockCardsList = vi.fn()

vi.mock("stripe", () => ({
  default: () => ({
    issuing: {
      cards: {
        create: mockCardsCreate,
        retrieve: mockCardsRetrieve,
        update: mockCardsUpdate,
        list: mockCardsList,
      },
    },
  }),
}))

import {
  createStripeClient,
  type StripeClient,
} from "../../repertoire/stripe-client"

describe("StripeClient", () => {
  let client: StripeClient

  beforeEach(async () => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    client = await createStripeClient()
  })

  describe("initialization", () => {
    it("gets API key from vault", async () => {
      expect(mockGetRawSecret).toHaveBeenCalledWith("stripe.com", "restrictedKey")
    })

    it("throws on invalid API key", async () => {
      mockGetRawSecret.mockRejectedValueOnce(new Error("no credential found"))
      await expect(createStripeClient()).rejects.toThrow()
    })
  })

  describe("createVirtualCard", () => {
    it("creates a single-use card with spend limit", async () => {
      mockCardsCreate.mockResolvedValue({
        id: "ic_test_123",
        last4: "4242",
        status: "active",
        spending_controls: { spending_limits: [{ amount: 50000 }] },
      })

      const result = await client.createVirtualCard({
        type: "single_use",
        spendLimit: 500,
        currency: "usd",
      })

      expect(mockCardsCreate).toHaveBeenCalled()
      expect(result.cardId).toBe("ic_test_123")
      expect(result.last4).toBe("4242")
      // Card number should NOT be in the result
      expect(result).not.toHaveProperty("number")
    })

    it("creates a persistent card with monthly limit", async () => {
      mockCardsCreate.mockResolvedValue({
        id: "ic_test_456",
        last4: "1234",
        status: "active",
      })

      const result = await client.createVirtualCard({
        type: "persistent",
        spendLimit: 1000,
        currency: "usd",
      })

      expect(result.cardId).toBe("ic_test_456")
    })

    it("supports merchant category restrictions", async () => {
      mockCardsCreate.mockResolvedValue({
        id: "ic_test_789",
        last4: "5678",
        status: "active",
      })

      await client.createVirtualCard({
        type: "single_use",
        spendLimit: 200,
        currency: "usd",
        merchantCategories: ["airlines_air_carriers"],
      })

      const callArgs = mockCardsCreate.mock.calls[0][0]
      expect(callArgs.spending_controls.allowed_categories).toContain("airlines_air_carriers")
    })

    it("emits nerves events without card numbers", async () => {
      mockCardsCreate.mockResolvedValue({
        id: "ic_test_123",
        last4: "4242",
        status: "active",
        number: "4242424242424242",
      })

      await client.createVirtualCard({
        type: "single_use",
        spendLimit: 100,
        currency: "usd",
      })

      // Verify no card numbers in nerves events
      for (const event of nervesEvents) {
        const eventStr = JSON.stringify(event)
        expect(eventStr).not.toContain("4242424242424242")
      }
    })
  })

  describe("getCard", () => {
    it("retrieves card info by ID", async () => {
      mockCardsRetrieve.mockResolvedValue({
        id: "ic_test_123",
        last4: "4242",
        status: "active",
      })

      const result = await client.getCard("ic_test_123")
      expect(result.cardId).toBe("ic_test_123")
      expect(result.last4).toBe("4242")
      expect(result.status).toBe("active")
    })
  })

  describe("updateCard", () => {
    it("updates card properties", async () => {
      mockCardsUpdate.mockResolvedValue({
        id: "ic_test_123",
        last4: "4242",
        status: "active",
      })

      const result = await client.updateCard("ic_test_123", { status: "inactive" })
      expect(mockCardsUpdate).toHaveBeenCalledWith("ic_test_123", { status: "inactive" })
      expect(result.cardId).toBe("ic_test_123")
    })
  })

  describe("deactivateCard", () => {
    it("sets card status to canceled", async () => {
      mockCardsUpdate.mockResolvedValue({
        id: "ic_test_123",
        last4: "4242",
        status: "canceled",
      })

      const result = await client.deactivateCard("ic_test_123")
      expect(mockCardsUpdate).toHaveBeenCalledWith("ic_test_123", { status: "canceled" })
      expect(result.status).toBe("canceled")
    })
  })

  describe("listCards", () => {
    it("returns active cards", async () => {
      mockCardsList.mockResolvedValue({
        data: [
          { id: "ic_1", last4: "1111", status: "active" },
          { id: "ic_2", last4: "2222", status: "active" },
        ],
      })

      const result = await client.listCards()
      expect(result).toHaveLength(2)
      expect(result[0].cardId).toBe("ic_1")
      expect(result[1].last4).toBe("2222")
    })
  })

  describe("error handling", () => {
    it("handles Stripe API errors (401)", async () => {
      mockCardsCreate.mockRejectedValue(new Error("Invalid API Key provided"))
      await expect(
        client.createVirtualCard({ type: "single_use", spendLimit: 100, currency: "usd" }),
      ).rejects.toThrow("Invalid API Key")
    })

    it("handles network failures", async () => {
      mockCardsList.mockRejectedValue(new Error("ECONNREFUSED"))
      await expect(client.listCards()).rejects.toThrow("ECONNREFUSED")
    })
  })

  describe("getCardDetails (internal, for payment flow)", () => {
    it("retrieves full card details with expanded number and cvc", async () => {
      mockCardsRetrieve.mockResolvedValue({
        id: "ic_test_123",
        last4: "4242",
        number: "4242424242424242",
        cvc: "123",
        exp_month: 12,
        exp_year: 2027,
      })

      const result = await client.getCardDetails("ic_test_123")
      // Details should contain the full card number for payment flow
      expect(result.number).toBe("4242424242424242")
      expect(result.cvc).toBe("123")
    })

    it("never includes card number in nerves events even when retrieved", async () => {
      mockCardsRetrieve.mockResolvedValue({
        id: "ic_test_999",
        last4: "4242",
        number: "4242424242424242",
        cvc: "987",
        exp_month: 12,
        exp_year: 2027,
      })

      await client.getCardDetails("ic_test_999")

      for (const event of nervesEvents) {
        const eventStr = JSON.stringify(event)
        expect(eventStr).not.toContain("4242424242424242")
        expect(eventStr).not.toContain("987") // CVC should also be absent from events
      }
    })
  })
})
