import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock credential store
const mockGetRawSecret = vi.fn()
vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => ({
    getRawSecret: mockGetRawSecret,
    isReady: () => true,
  }),
}))

// Mock stripe-client for payment flow
const mockCreateVirtualCard = vi.fn()
const mockGetCardDetails = vi.fn()
const mockDeactivateCard = vi.fn()

vi.mock("../../repertoire/stripe-client", () => ({
  createStripeClient: vi.fn().mockResolvedValue({
    createVirtualCard: (...args: unknown[]) => mockCreateVirtualCard(...args),
    getCardDetails: (...args: unknown[]) => mockGetCardDetails(...args),
    deactivateCard: (...args: unknown[]) => mockDeactivateCard(...args),
  }),
}))

// Mock fetch for Duffel API calls
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

import {
  createDuffelClient,
  type DuffelClient,
} from "../../repertoire/duffel-client"

describe("DuffelClient", () => {
  let client: DuffelClient

  beforeEach(async () => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockGetRawSecret.mockResolvedValue("duffel_test_api_key")
    client = await createDuffelClient()
  })

  describe("initialization", () => {
    it("gets API key from vault", () => {
      expect(mockGetRawSecret).toHaveBeenCalledWith("duffel.com", "apiKey")
    })

    it("throws on missing API key", async () => {
      mockGetRawSecret.mockRejectedValueOnce(new Error("no credential found"))
      await expect(createDuffelClient()).rejects.toThrow()
    })
  })

  describe("searchFlights", () => {
    it("searches for flights and returns offers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            offers: [
              {
                id: "off_123",
                total_amount: "350.00",
                total_currency: "USD",
                slices: [
                  {
                    origin: { iata_code: "SFO" },
                    destination: { iata_code: "JFK" },
                    duration: "PT5H30M",
                    segments: [{ operating_carrier: { name: "United Airlines" } }],
                  },
                ],
              },
            ],
          },
        }),
      })

      const result = await client.searchFlights({
        origin: "SFO",
        destination: "JFK",
        departureDate: "2026-05-01",
        passengers: [{ type: "adult" }],
      })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("off_123")
      expect(result[0].totalAmount).toBe("350.00")
    })

    it("handles no results", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { offers: [] } }),
      })

      const result = await client.searchFlights({
        origin: "SFO",
        destination: "XYZ",
        departureDate: "2026-05-01",
        passengers: [{ type: "adult" }],
      })

      expect(result).toHaveLength(0)
    })

    it("throws on API error", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ errors: [{ message: "Invalid API key" }] }),
      })

      await expect(
        client.searchFlights({
          origin: "SFO",
          destination: "JFK",
          departureDate: "2026-05-01",
          passengers: [{ type: "adult" }],
        }),
      ).rejects.toThrow("Invalid API key")
    })

    it("uses fallback error message when errors array is empty", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ errors: [] }),
      })

      await expect(
        client.searchFlights({
          origin: "SFO",
          destination: "JFK",
          departureDate: "2026-05-01",
          passengers: [{ type: "adult" }],
        }),
      ).rejects.toThrow("Duffel API error (500)")
    })

    it("includes return slice when returnDate is provided", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            offers: [{
              id: "off_rt",
              total_amount: "700.00",
              total_currency: "USD",
              slices: [
                {
                  origin: { iata_code: "SFO" },
                  destination: { iata_code: "JFK" },
                  duration: "PT5H",
                  segments: [{ operating_carrier: { name: "United" } }],
                },
                {
                  origin: { iata_code: "JFK" },
                  destination: { iata_code: "SFO" },
                  duration: "PT6H",
                  segments: [{ operating_carrier: { name: "Delta" } }],
                },
              ],
            }],
          },
        }),
      })

      const result = await client.searchFlights({
        origin: "SFO",
        destination: "JFK",
        departureDate: "2026-05-01",
        returnDate: "2026-05-08",
        passengers: [{ type: "adult" }],
      })

      expect(result[0].slices).toHaveLength(2)
      // Verify the fetch body includes return slice
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(fetchBody.data.slices).toHaveLength(2)
      expect(fetchBody.data.slices[1].departure_date).toBe("2026-05-08")
    })

    it("uses 'Unknown' carrier when segments are empty", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            offers: [{
              id: "off_unk",
              total_amount: "200.00",
              total_currency: "USD",
              slices: [{
                origin: { iata_code: "LAX" },
                destination: { iata_code: "ORD" },
                duration: "PT4H",
                segments: [],
              }],
            }],
          },
        }),
      })

      const result = await client.searchFlights({
        origin: "LAX",
        destination: "ORD",
        departureDate: "2026-06-01",
        passengers: [{ type: "adult" }],
      })

      expect(result[0].slices[0].carrier).toBe("Unknown")
    })
  })

  describe("createOrder (booking with payment)", () => {
    it("books a flight with passenger and payment data", async () => {
      // Card creation
      mockCreateVirtualCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "active",
      })

      // Card details for payment
      mockGetCardDetails.mockResolvedValue({
        cardId: "ic_test",
        number: "4242424242424242",
        cvc: "987",
        expMonth: 12,
        expYear: 2027,
      })

      // Duffel create order
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            id: "ord_123",
            booking_reference: "ABC123",
            total_amount: "350.00",
            total_currency: "USD",
          },
        }),
      })

      // Card deactivation
      mockDeactivateCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "canceled",
      })

      const result = await client.createOrder({
        offerId: "off_123",
        passengers: [
          {
            type: "adult",
            givenName: "John",
            familyName: "Doe",
            dateOfBirth: "1990-01-15",
          },
        ],
        amount: 350,
        currency: "usd",
      })

      expect(result.orderId).toBe("ord_123")
      expect(result.bookingReference).toBe("ABC123")
      // Card number should never appear in the result
      expect(JSON.stringify(result)).not.toContain("4242424242424242")
    })

    it("card details never escape function scope in return value", async () => {
      mockCreateVirtualCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "active",
      })
      mockGetCardDetails.mockResolvedValue({
        cardId: "ic_test",
        number: "4000056655665556",
        cvc: "321",
        expMonth: 6,
        expYear: 2028,
      })
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: { id: "ord_456", booking_reference: "XYZ789", total_amount: "500.00", total_currency: "USD" },
        }),
      })
      mockDeactivateCard.mockResolvedValue({ cardId: "ic_test", last4: "5556", status: "canceled" })

      const result = await client.createOrder({
        offerId: "off_456",
        passengers: [{ type: "adult", givenName: "Jane", familyName: "Smith", dateOfBirth: "1985-03-20" }],
        amount: 500,
        currency: "usd",
      })

      const resultStr = JSON.stringify(result)
      expect(resultStr).not.toContain("4000056655665556")
      expect(resultStr).not.toContain("321")
    })

    it("books a flight with passport data", async () => {
      mockCreateVirtualCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "active",
      })
      mockGetCardDetails.mockResolvedValue({
        cardId: "ic_test",
        number: "4242424242424242",
        cvc: "987",
        expMonth: 12,
        expYear: 2027,
      })
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            id: "ord_pp",
            booking_reference: "PP123",
            total_amount: "500.00",
            total_currency: "USD",
          },
        }),
      })
      mockDeactivateCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "canceled",
      })

      const result = await client.createOrder({
        offerId: "off_pp",
        passengers: [{
          type: "adult",
          givenName: "Jane",
          familyName: "Smith",
          dateOfBirth: "1985-03-20",
          passportNumber: "P12345",
          passportCountry: "US",
          passportExpiry: "2030-01-01",
        }],
        amount: 500,
        currency: "usd",
      })

      expect(result.orderId).toBe("ord_pp")
      // Verify passport data was included in the request body
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body)
      const passenger = fetchBody.data.passengers[0]
      expect(passenger.identity_documents).toBeDefined()
      expect(passenger.identity_documents[0].unique_identifier).toBe("P12345")
    })

    it("deactivates card even when deactivation itself fails on booking error", async () => {
      mockCreateVirtualCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "active",
      })
      mockGetCardDetails.mockResolvedValue({
        cardId: "ic_test",
        number: "4242424242424242",
        cvc: "987",
        expMonth: 12,
        expYear: 2027,
      })
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ errors: [{ message: "Server error" }] }),
      })
      // Deactivation also fails
      mockDeactivateCard.mockRejectedValue(new Error("deactivation failed"))

      await expect(
        client.createOrder({
          offerId: "off_fail",
          passengers: [{ type: "adult", givenName: "John", familyName: "Doe", dateOfBirth: "1990-01-15" }],
          amount: 350,
          currency: "usd",
        }),
      ).rejects.toThrow("Server error")

      // Card deactivation was attempted
      expect(mockDeactivateCard).toHaveBeenCalledWith("ic_test")
    })

    it("handles payment declined", async () => {
      mockCreateVirtualCard.mockResolvedValue({
        cardId: "ic_test",
        last4: "4242",
        status: "active",
      })
      mockGetCardDetails.mockResolvedValue({
        cardId: "ic_test",
        number: "4242424242424242",
        cvc: "987",
        expMonth: 12,
        expYear: 2027,
      })
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ errors: [{ message: "Payment declined" }] }),
      })
      mockDeactivateCard.mockResolvedValue({ cardId: "ic_test", last4: "4242", status: "canceled" })

      await expect(
        client.createOrder({
          offerId: "off_123",
          passengers: [{ type: "adult", givenName: "John", familyName: "Doe", dateOfBirth: "1990-01-15" }],
          amount: 350,
          currency: "usd",
        }),
      ).rejects.toThrow("Payment declined")
    })
  })

  describe("cancelOrder", () => {
    it("cancels an order", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: { id: "ocr_123", order_id: "ord_123", confirmed: true },
        }),
      })

      const result = await client.cancelOrder("ord_123")
      expect(result.confirmed).toBe(true)
    })
  })

  describe("nerves events", () => {
    it("emits events for search", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { offers: [] } }),
      })

      await client.searchFlights({
        origin: "SFO",
        destination: "JFK",
        departureDate: "2026-05-01",
        passengers: [{ type: "adult" }],
      })

      expect(nervesEvents.some((e) => e.event === "repertoire.duffel_search_start")).toBe(true)
    })
  })
})
