import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock user-profile module
const mockStoreUserProfile = vi.fn()
const mockGetUserProfile = vi.fn()
const mockGetUserProfileField = vi.fn()
const mockDeleteUserProfile = vi.fn()
const mockUpdateUserProfileFields = vi.fn()

vi.mock("../../repertoire/user-profile", () => ({
  storeUserProfile: (...args: unknown[]) => mockStoreUserProfile(...args),
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  getUserProfileField: (...args: unknown[]) => mockGetUserProfileField(...args),
  deleteUserProfile: (...args: unknown[]) => mockDeleteUserProfile(...args),
  updateUserProfileFields: (...args: unknown[]) => mockUpdateUserProfileFields(...args),
}))

// Mock credential-access for the store factory
const mockBwStore = {
  isReady: vi.fn().mockReturnValue(true),
  get: vi.fn(),
  getRawSecret: vi.fn(),
  store: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  login: vi.fn().mockResolvedValue(undefined),
}

vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => mockBwStore,
}))

import { userProfileToolDefinitions } from "../../repertoire/tools-user-profile"
import type { ToolContext } from "../../repertoire/tools-base"

function findTool(name: string) {
  const def = userProfileToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found in userProfileToolDefinitions`)
  return def
}

describe("userProfileToolDefinitions", () => {
  it("exports an array of 3 tool definitions", () => {
    expect(userProfileToolDefinitions).toHaveLength(3)
  })

  it("contains user_profile_store, user_profile_get, user_profile_delete", () => {
    const names = userProfileToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("user_profile_store")
    expect(names).toContain("user_profile_get")
    expect(names).toContain("user_profile_delete")
  })

  it("all tools have valid JSON schema parameters", () => {
    for (const def of userProfileToolDefinitions) {
      expect(def.tool.function.parameters).toBeDefined()
      expect(def.tool.function.parameters!.type).toBe("object")
    }
  })

  it("all tools have handler functions", () => {
    for (const def of userProfileToolDefinitions) {
      expect(typeof def.handler).toBe("function")
    }
  })
})

describe("user_profile_store handler", () => {
  const tool = findTool("user_profile_store")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockUpdateUserProfileFields.mockResolvedValue(undefined)
  })

  it("stores profile fields for a friend", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    const result = await tool.handler(
      { fields: JSON.stringify({ email: "ari@example.com", phone: "+1234567890" }) },
      ctx,
    )
    expect(mockUpdateUserProfileFields).toHaveBeenCalled()
    expect(result).toContain("stored")
  })

  it("rejects non-family trust level", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Stranger", trustLevel: "friend" },
      } as any,
    }
    const result = await tool.handler(
      { fields: JSON.stringify({ email: "test@example.com" }) },
      ctx,
    )
    expect(result).toContain("family")
    expect(mockUpdateUserProfileFields).not.toHaveBeenCalled()
  })

  it("rejects when no context", async () => {
    const result = await tool.handler({ fields: "{}" })
    expect(result).toContain("context")
    expect(mockUpdateUserProfileFields).not.toHaveBeenCalled()
  })

  it("handles invalid JSON in fields", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    const result = await tool.handler({ fields: "not-json{" }, ctx)
    expect(result).toContain("invalid")
  })

  it("emits nerves events", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    await tool.handler(
      { fields: JSON.stringify({ email: "ari@example.com" }) },
      ctx,
    )
    expect(nervesEvents.some((e) => e.event === "repertoire.tool_user_profile_store")).toBe(true)
  })
})

describe("user_profile_get handler", () => {
  const tool = findTool("user_profile_get")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("retrieves specific fields", async () => {
    mockGetUserProfileField.mockResolvedValue("ari@example.com")
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    const result = await tool.handler({ field: "email" }, ctx)
    expect(result).toContain("ari@example.com")
    expect(mockGetUserProfileField).toHaveBeenCalledWith("friend-123", "email", expect.anything())
  })

  it("rejects non-family trust level", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Acquaintance", trustLevel: "acquaintance" },
      } as any,
    }
    const result = await tool.handler({ field: "email" }, ctx)
    expect(result).toContain("family")
    expect(mockGetUserProfileField).not.toHaveBeenCalled()
  })

  it("handles missing profile field", async () => {
    mockGetUserProfileField.mockResolvedValue(undefined)
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    const result = await tool.handler({ field: "dateOfBirth" }, ctx)
    expect(result).toContain("not set")
  })

  it("emits nerves events", async () => {
    mockGetUserProfileField.mockResolvedValue("ari@example.com")
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    await tool.handler({ field: "email" }, ctx)
    expect(nervesEvents.some((e) => e.event === "repertoire.tool_user_profile_get")).toBe(true)
  })
})

describe("user_profile_delete handler", () => {
  const tool = findTool("user_profile_delete")

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("deletes a profile", async () => {
    mockDeleteUserProfile.mockResolvedValue(true)
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    const result = await tool.handler({}, ctx)
    expect(result).toContain("deleted")
    expect(mockDeleteUserProfile).toHaveBeenCalledWith("friend-123", expect.anything())
  })

  it("reports when no profile to delete", async () => {
    mockDeleteUserProfile.mockResolvedValue(false)
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    const result = await tool.handler({}, ctx)
    expect(result).toContain("no profile")
  })

  it("rejects non-family trust level", async () => {
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Friend", trustLevel: "friend" },
      } as any,
    }
    const result = await tool.handler({}, ctx)
    expect(result).toContain("family")
    expect(mockDeleteUserProfile).not.toHaveBeenCalled()
  })

  it("emits nerves events", async () => {
    mockDeleteUserProfile.mockResolvedValue(true)
    const ctx: ToolContext = {
      context: {
        friend: { id: "friend-123", name: "Ari", trustLevel: "family" },
      } as any,
    }
    await tool.handler({}, ctx)
    expect(nervesEvents.some((e) => e.event === "repertoire.tool_user_profile_delete")).toBe(true)
  })
})
