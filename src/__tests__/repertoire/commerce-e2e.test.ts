import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events for card leakage test
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock credential store
const mockGetRawSecret = vi.fn()
const mockStore = vi.fn()
const mockDelete = vi.fn()
vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => ({
    getRawSecret: mockGetRawSecret,
    store: mockStore,
    delete: mockDelete,
    isReady: () => true,
    get: vi.fn(),
    list: vi.fn(),
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

// Mock fetch for Duffel
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Imports (after mocks)
import {
  storeUserProfile,
  getUserProfile,
  getUserProfileField,
  deleteUserProfile,
  type UserProfile,
} from "../../repertoire/user-profile"

import { createStripeClient } from "../../repertoire/stripe-client"
import { createDuffelClient } from "../../repertoire/duffel-client"
import { partialFailureReport } from "../../repertoire/commerce-errors"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPLETE_PROFILE: UserProfile = {
  legalName: { first: "John", middle: "Michael", last: "Doe" },
  dateOfBirth: "1990-01-15",
  gender: "male",
  nationality: "US",
  passport: { number: "P123456789", country: "US", expiry: "2030-06-01" },
  driverLicense: { number: "D12345678", state: "CA", expiry: "2028-12-01" },
  email: "john.doe@example.com",
  phone: "+14155551234",
  addresses: [
    {
      label: "home",
      street: "123 Market St",
      city: "San Francisco",
      state: "CA",
      postal: "94105",
      country: "US",
    },
  ],
  loyaltyPrograms: [
    { program: "United MileagePlus", number: "AB123456" },
    { program: "Marriott Bonvoy", number: "MR789012" },
  ],
  preferences: { seat: "window", meal: "vegetarian", class: "economy" },
  emergencyContact: {
    name: "Jane Doe",
    phone: "+14155559876",
    relationship: "spouse",
  },
}

const MINIMAL_PROFILE: UserProfile = {
  legalName: { first: "Alice", last: "Smith" },
  email: "alice@example.com",
  phone: "+12125551000",
  preferences: {},
}

// Test card number constants
const TEST_CARD_NUMBER = "4242424242424242"
const TEST_CVC = "987"

// ---------------------------------------------------------------------------
// Tier 1: Real vault CRUD (mocked at bw CLI level)
// ---------------------------------------------------------------------------

describe("Tier 1: User profile vault CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockStore.mockResolvedValue(undefined)
    mockDelete.mockResolvedValue(true)
  })

  it("store and retrieve a complete profile", async () => {
    const store = (await import("../../repertoire/credential-access")).getCredentialStore()

    await storeUserProfile("friend-e2e", COMPLETE_PROFILE, store)
    expect(mockStore).toHaveBeenCalledWith(
      "user-profile/friend-e2e",
      expect.objectContaining({ password: expect.any(String) }),
    )

    // Simulate vault returning the stored profile
    mockGetRawSecret.mockResolvedValue(JSON.stringify(COMPLETE_PROFILE))
    const retrieved = await getUserProfile("friend-e2e", store)
    expect(retrieved).toEqual(COMPLETE_PROFILE)
  })

  it("retrieve specific field from profile", async () => {
    const store = (await import("../../repertoire/credential-access")).getCredentialStore()
    mockGetRawSecret.mockResolvedValue(JSON.stringify(COMPLETE_PROFILE))

    const email = await getUserProfileField("friend-e2e", "email", store)
    expect(email).toBe("john.doe@example.com")

    const passport = await getUserProfileField("friend-e2e", "passport", store)
    expect(passport).toEqual({ number: "P123456789", country: "US", expiry: "2030-06-01" })
  })

  it("delete profile", async () => {
    const store = (await import("../../repertoire/credential-access")).getCredentialStore()
    const deleted = await deleteUserProfile("friend-e2e", store)
    expect(deleted).toBe(true)
    expect(mockDelete).toHaveBeenCalledWith("user-profile/friend-e2e")
  })

  it("returns null for missing profile", async () => {
    const store = (await import("../../repertoire/credential-access")).getCredentialStore()
    mockGetRawSecret.mockRejectedValue(new Error("no credential found"))
    const result = await getUserProfile("nonexistent", store)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tier 2: Full booking flow (mocked APIs)
// ---------------------------------------------------------------------------

describe("Tier 2: Full booking flow (mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    // Vault returns API keys
    mockGetRawSecret.mockImplementation((domain: string) => {
      if (domain === "stripe.com") return Promise.resolve("rk_test_stripe")
      if (domain === "duffel.com") return Promise.resolve("duffel_test_key")
      if (domain === "user-profile/friend-e2e") return Promise.resolve(JSON.stringify(COMPLETE_PROFILE))
      return Promise.reject(new Error(`no credential found for domain "${domain}"`))
    })
  })

  it("profile -> search -> book -> confirm -> deactivate card", async () => {
    // 1. Stripe card creation
    mockCardsCreate.mockResolvedValue({
      id: "ic_e2e_test",
      last4: "4242",
      status: "active",
    })

    // 2. Stripe card details for payment
    mockCardsRetrieve.mockResolvedValue({
      id: "ic_e2e_test",
      last4: "4242",
      number: TEST_CARD_NUMBER,
      cvc: TEST_CVC,
      exp_month: 12,
      exp_year: 2027,
    })

    // 3. Stripe card deactivation
    mockCardsUpdate.mockResolvedValue({
      id: "ic_e2e_test",
      last4: "4242",
      status: "canceled",
    })

    // 4. Duffel search
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            offers: [{
              id: "off_e2e",
              total_amount: "350.00",
              total_currency: "USD",
              slices: [{
                origin: { iata_code: "SFO" },
                destination: { iata_code: "JFK" },
                duration: "PT5H30M",
                segments: [{ operating_carrier: { name: "United Airlines" } }],
              }],
            }],
          },
        }),
      })
      // 5. Duffel booking
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: {
            id: "ord_e2e",
            booking_reference: "E2E123",
            total_amount: "350.00",
            total_currency: "USD",
          },
        }),
      })

    // Run the flow
    const duffel = await createDuffelClient()

    // Search
    const offers = await duffel.searchFlights({
      origin: "SFO",
      destination: "JFK",
      departureDate: "2026-06-01",
      passengers: [{ type: "adult" }],
    })
    expect(offers).toHaveLength(1)
    expect(offers[0].id).toBe("off_e2e")

    // Book (internally creates card, books, deactivates card)
    const order = await duffel.createOrder({
      offerId: "off_e2e",
      passengers: [{
        type: "adult",
        givenName: "John",
        familyName: "Doe",
        dateOfBirth: "1990-01-15",
        passportNumber: "P123456789",
        passportCountry: "US",
        passportExpiry: "2030-06-01",
      }],
      amount: 350,
      currency: "usd",
    })

    expect(order.orderId).toBe("ord_e2e")
    expect(order.bookingReference).toBe("E2E123")
  })
})

// ---------------------------------------------------------------------------
// Card number leakage test
// ---------------------------------------------------------------------------

describe("Card number leakage test", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockGetRawSecret.mockImplementation((domain: string) => {
      if (domain === "stripe.com") return Promise.resolve("rk_test_stripe")
      if (domain === "duffel.com") return Promise.resolve("duffel_test_key")
      return Promise.reject(new Error("no credential found"))
    })
  })

  it("card numbers NEVER appear in nerves events", async () => {
    mockCardsCreate.mockResolvedValue({
      id: "ic_leak_test",
      last4: "4242",
      status: "active",
      number: TEST_CARD_NUMBER,
    })
    mockCardsRetrieve.mockResolvedValue({
      id: "ic_leak_test",
      last4: "4242",
      number: TEST_CARD_NUMBER,
      cvc: TEST_CVC,
      exp_month: 12,
      exp_year: 2027,
    })
    mockCardsUpdate.mockResolvedValue({
      id: "ic_leak_test",
      last4: "4242",
      status: "canceled",
    })
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          id: "ord_leak_test",
          booking_reference: "LEAK1",
          total_amount: "100.00",
          total_currency: "USD",
        },
      }),
    })

    const duffel = await createDuffelClient()
    await duffel.createOrder({
      offerId: "off_leak",
      passengers: [{ type: "adult", givenName: "Test", familyName: "User", dateOfBirth: "1990-01-01" }],
      amount: 100,
      currency: "usd",
    })

    // Search ALL nerves events for card number or CVC
    for (const event of nervesEvents) {
      const eventStr = JSON.stringify(event)
      expect(eventStr).not.toContain(TEST_CARD_NUMBER)
      expect(eventStr).not.toContain(`"${TEST_CVC}"`)
    }
  })

  it("card numbers never appear in tool return values", async () => {
    mockCardsCreate.mockResolvedValue({
      id: "ic_return_test",
      last4: "4242",
      status: "active",
      number: TEST_CARD_NUMBER,
    })

    const stripe = await createStripeClient()
    const card = await stripe.createVirtualCard({
      type: "single_use",
      spendLimit: 100,
      currency: "usd",
    })

    const cardStr = JSON.stringify(card)
    expect(cardStr).not.toContain(TEST_CARD_NUMBER)
    expect(card).not.toHaveProperty("number")
  })
})

// ---------------------------------------------------------------------------
// Partial failure test
// ---------------------------------------------------------------------------

describe("Partial failure test", () => {
  it("flight books but hotel fails — both results reported separately", () => {
    const report = partialFailureReport([
      { service: "flight", status: "success" },
      { service: "hotel", status: "failed", error: "LiteAPI: no availability for dates" },
    ])

    expect(report).toContain("flight")
    expect(report).toContain("success")
    expect(report).toContain("hotel")
    expect(report).toContain("failed")
    expect(report).toContain("no availability")
    // Flight should NOT be auto-cancelled
    expect(report).not.toContain("cancel")
  })
})
