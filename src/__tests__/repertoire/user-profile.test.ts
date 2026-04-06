import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock bitwarden-store module — we stub the class methods via prototype
const mockEnsureSession = vi.fn().mockResolvedValue("test-session")
const mockExecBw = vi.fn()

// We mock the entire bitwarden-store module to inject a controllable store
const mockStore = {
  isReady: vi.fn().mockReturnValue(true),
  get: vi.fn(),
  getRawSecret: vi.fn(),
  store: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  login: vi.fn().mockResolvedValue(undefined),
}

vi.mock("../../repertoire/credential-access", () => ({
  CredentialStore: class {},
}))

import type { UserProfile } from "../../repertoire/user-profile"

// Dynamically import after mocks are set up
import {
  storeUserProfile,
  getUserProfile,
  getUserProfileField,
  deleteUserProfile,
  updateUserProfileFields,
} from "../../repertoire/user-profile"

// We need to mock the vault operations the user-profile module uses.
// The module uses BitwardenCredentialStore internally for secure note storage.
// We mock at the bw CLI level.

// Mock the bw CLI used by the secure note storage
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

describe("UserProfile types", () => {
  it("UserProfile has required fields", () => {
    const profile: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: {},
    }
    expect(profile.legalName.first).toBe("John")
    expect(profile.legalName.last).toBe("Doe")
    expect(profile.email).toBe("john@example.com")
    expect(profile.phone).toBe("+1234567890")
    expect(profile.preferences).toEqual({})
  })

  it("UserProfile supports all optional fields", () => {
    const profile: UserProfile = {
      legalName: { first: "Jane", middle: "M", last: "Smith" },
      dateOfBirth: "1990-01-15",
      gender: "female",
      nationality: "US",
      passport: { number: "123456789", country: "US", expiry: "2030-01-01" },
      driverLicense: { number: "D1234567", state: "CA", expiry: "2028-06-01" },
      email: "jane@example.com",
      phone: "+1987654321",
      addresses: [
        {
          label: "home",
          street: "123 Main St",
          city: "San Francisco",
          state: "CA",
          postal: "94105",
          country: "US",
        },
      ],
      loyaltyPrograms: [
        { program: "United MileagePlus", number: "AB123456" },
      ],
      preferences: { seat: "window", meal: "vegetarian" },
      emergencyContact: {
        name: "Bob Smith",
        phone: "+1555555555",
        relationship: "spouse",
      },
    }
    expect(profile.passport?.number).toBe("123456789")
    expect(profile.addresses).toHaveLength(1)
    expect(profile.loyaltyPrograms).toHaveLength(1)
    expect(profile.emergencyContact?.name).toBe("Bob Smith")
  })
})

describe("storeUserProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("stores a profile as a secure note in the vault", async () => {
    const profile: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: {},
    }
    await storeUserProfile("friend-123", profile, mockStore as any)
    expect(mockStore.store).toHaveBeenCalled()
    const callArgs = mockStore.store.mock.calls[0]
    expect(callArgs[0]).toBe("user-profile/friend-123")
  })

  it("emits nerves events", async () => {
    const profile: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: {},
    }
    await storeUserProfile("friend-123", profile, mockStore as any)
    expect(nervesEvents.some((e) => e.event === "repertoire.user_profile_store")).toBe(true)
  })
})

describe("getUserProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("retrieves a stored profile", async () => {
    const stored: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: { seat: "aisle" },
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(stored))
    const result = await getUserProfile("friend-123", mockStore as any)
    expect(result).toEqual(stored)
    expect(mockStore.getRawSecret).toHaveBeenCalledWith("user-profile/friend-123", "password")
  })

  it("returns null when no profile exists", async () => {
    mockStore.getRawSecret.mockRejectedValue(new Error('no credential found for domain "user-profile/friend-123"'))
    const result = await getUserProfile("friend-123", mockStore as any)
    expect(result).toBeNull()
  })

  it("returns null for invalid JSON in vault", async () => {
    mockStore.getRawSecret.mockResolvedValue("not-valid-json{{{")
    const result = await getUserProfile("friend-123", mockStore as any)
    expect(result).toBeNull()
  })

  it("emits nerves events", async () => {
    mockStore.getRawSecret.mockRejectedValue(new Error("no credential found"))
    await getUserProfile("friend-123", mockStore as any)
    expect(nervesEvents.some((e) => e.event === "repertoire.user_profile_get")).toBe(true)
  })
})

describe("getUserProfileField", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("retrieves a specific field from the profile", async () => {
    const stored: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: {},
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(stored))
    const result = await getUserProfileField("friend-123", "email", mockStore as any)
    expect(result).toBe("john@example.com")
  })

  it("returns undefined for missing field", async () => {
    const stored: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: {},
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(stored))
    const result = await getUserProfileField("friend-123", "dateOfBirth", mockStore as any)
    expect(result).toBeUndefined()
  })

  it("returns undefined when no profile exists", async () => {
    mockStore.getRawSecret.mockRejectedValue(new Error("no credential found"))
    const result = await getUserProfileField("friend-123", "email", mockStore as any)
    expect(result).toBeUndefined()
  })

  it("retrieves nested fields like legalName", async () => {
    const stored: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: {},
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(stored))
    const result = await getUserProfileField("friend-123", "legalName", mockStore as any)
    expect(result).toEqual({ first: "John", last: "Doe" })
  })

  it("retrieves preference values", async () => {
    const stored: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: { seat: "window" },
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(stored))
    const result = await getUserProfileField("friend-123", "preferences", mockStore as any)
    expect(result).toEqual({ seat: "window" })
  })
})

describe("deleteUserProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("deletes a profile from the vault", async () => {
    mockStore.delete.mockResolvedValue(true)
    const result = await deleteUserProfile("friend-123", mockStore as any)
    expect(result).toBe(true)
    expect(mockStore.delete).toHaveBeenCalledWith("user-profile/friend-123")
  })

  it("returns false when profile does not exist", async () => {
    mockStore.delete.mockResolvedValue(false)
    const result = await deleteUserProfile("friend-123", mockStore as any)
    expect(result).toBe(false)
  })

  it("emits nerves events", async () => {
    mockStore.delete.mockResolvedValue(true)
    await deleteUserProfile("friend-123", mockStore as any)
    expect(nervesEvents.some((e) => e.event === "repertoire.user_profile_delete")).toBe(true)
  })
})

describe("updateUserProfileFields", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("merges partial fields into existing profile", async () => {
    const existing: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: { seat: "aisle" },
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(existing))
    mockStore.store.mockResolvedValue(undefined)

    await updateUserProfileFields("friend-123", { email: "newemail@example.com" }, mockStore as any)

    expect(mockStore.store).toHaveBeenCalled()
    const storedJson = JSON.parse(mockStore.store.mock.calls[0][1].password)
    expect(storedJson.email).toBe("newemail@example.com")
    expect(storedJson.legalName.first).toBe("John") // unchanged
  })

  it("creates new profile when none exists", async () => {
    mockStore.getRawSecret.mockRejectedValue(new Error("no credential found"))
    mockStore.store.mockResolvedValue(undefined)

    await updateUserProfileFields("friend-123", {
      legalName: { first: "Jane", last: "Smith" },
      email: "jane@example.com",
      phone: "+1111111111",
      preferences: {},
    }, mockStore as any)

    expect(mockStore.store).toHaveBeenCalled()
  })

  it("updates preference keys without losing existing ones", async () => {
    const existing: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: { seat: "aisle", meal: "vegan" },
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(existing))
    mockStore.store.mockResolvedValue(undefined)

    await updateUserProfileFields("friend-123", {
      preferences: { seat: "window" },
    }, mockStore as any)

    const storedJson = JSON.parse(mockStore.store.mock.calls[0][1].password)
    expect(storedJson.preferences.seat).toBe("window")
    expect(storedJson.preferences.meal).toBe("vegan")
  })

  it("merges fields without preferences key (uses empty default)", async () => {
    const existing: UserProfile = {
      legalName: { first: "John", last: "Doe" },
      email: "john@example.com",
      phone: "+1234567890",
      preferences: { seat: "aisle" },
    }
    mockStore.getRawSecret.mockResolvedValue(JSON.stringify(existing))
    mockStore.store.mockResolvedValue(undefined)

    // Update without providing preferences
    await updateUserProfileFields("friend-123", { email: "new@example.com" }, mockStore as any)

    const storedJson = JSON.parse(mockStore.store.mock.calls[0][1].password)
    expect(storedJson.email).toBe("new@example.com")
    // Existing preferences preserved via ?? {} fallback
    expect(storedJson.preferences.seat).toBe("aisle")
  })

  it("emits nerves events", async () => {
    mockStore.getRawSecret.mockRejectedValue(new Error("no credential found"))
    mockStore.store.mockResolvedValue(undefined)

    await updateUserProfileFields("friend-123", {
      legalName: { first: "Jane", last: "Smith" },
      email: "jane@example.com",
      phone: "+1111111111",
      preferences: {},
    }, mockStore as any)

    expect(nervesEvents.some((e) => e.event === "repertoire.user_profile_update")).toBe(true)
  })
})
