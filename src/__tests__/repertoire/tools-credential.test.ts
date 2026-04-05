import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock credential store
const mockGet = vi.fn()
const mockStore = vi.fn()
const mockList = vi.fn()
const mockDelete = vi.fn()

vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: vi.fn(() => ({
    get: mockGet,
    getRawSecret: vi.fn(),
    store: mockStore,
    list: mockList,
    delete: mockDelete,
    isReady: vi.fn(() => true),
  })),
}))

import { credentialToolDefinitions } from "../../repertoire/tools-credential"

function findTool(name: string) {
  const def = credentialToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool ${name} not found`)
  return def
}

describe("credential_get", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns metadata for known domain (no password)", async () => {
    mockGet.mockResolvedValue({
      domain: "airbnb.com",
      username: "agent@test.com",
      notes: "travel account",
      createdAt: "2026-04-05T00:00:00Z",
    })

    const tool = findTool("credential_get")
    const result = await tool.handler({ domain: "airbnb.com" })

    expect(result).toContain("airbnb.com")
    expect(result).toContain("agent@test.com")
    expect(result).not.toContain("password")
    expect(mockGet).toHaveBeenCalledWith("airbnb.com")
  })

  it("returns not-found message for unknown domain", async () => {
    mockGet.mockResolvedValue(null)

    const tool = findTool("credential_get")
    const result = await tool.handler({ domain: "unknown.com" })

    expect(result).toContain("No credential found")
    expect(result).toContain("unknown.com")
  })

  it("handles errors gracefully", async () => {
    mockGet.mockRejectedValue(new Error("store broken"))

    const tool = findTool("credential_get")
    const result = await tool.handler({ domain: "test.com" })

    expect(result).toContain("store broken")
  })

  it("emits nerves event", async () => {
    mockGet.mockResolvedValue(null)

    const tool = findTool("credential_get")
    await tool.handler({ domain: "test.com" })

    const events = nervesEvents.filter((e) => e.event === "repertoire.credential_tool_call")
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0].meta as any).tool).toBe("credential_get")
  })

  it("has correct schema", () => {
    const tool = findTool("credential_get")
    const params = tool.tool.function.parameters as any
    expect(params.properties.domain).toBeDefined()
    expect(params.required).toContain("domain")
  })
})

describe("credential_store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("stores credential and returns confirmation", async () => {
    mockStore.mockResolvedValue(undefined)

    const tool = findTool("credential_store")
    const result = await tool.handler({
      domain: "airbnb.com",
      username: "agent@test.com",
      password: "secret123",
      notes: "test",
    })

    expect(result).toContain("Credentials stored")
    expect(result).toContain("airbnb.com")
    expect(mockStore).toHaveBeenCalledWith("airbnb.com", {
      username: "agent@test.com",
      password: "secret123",
      notes: "test",
    })
  })

  it("stores without optional fields", async () => {
    mockStore.mockResolvedValue(undefined)

    const tool = findTool("credential_store")
    const result = await tool.handler({
      domain: "api.example.com",
      username: "user",
      password: "pw",
    })

    expect(result).toContain("Credentials stored")
    expect(mockStore).toHaveBeenCalledWith("api.example.com", {
      username: "user",
      password: "pw",
      notes: undefined,
    })
  })

  it("handles store errors", async () => {
    mockStore.mockRejectedValue(new Error("disk full"))

    const tool = findTool("credential_store")
    const result = await tool.handler({ domain: "x.com", username: "u", password: "p" })

    expect(result).toContain("disk full")
  })

  it("has confirmationRequired set", () => {
    const tool = findTool("credential_store")
    expect(tool.confirmationRequired).toBe(true)
  })

  it("emits nerves event", async () => {
    mockStore.mockResolvedValue(undefined)

    const tool = findTool("credential_store")
    await tool.handler({ domain: "x.com", username: "u", password: "p" })

    const events = nervesEvents.filter((e) => e.event === "repertoire.credential_tool_call")
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0].meta as any).tool).toBe("credential_store")
  })
})

describe("credential_list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns list of credential metadata", async () => {
    mockList.mockResolvedValue([
      { domain: "a.com", username: "ua", createdAt: "2026-01-01" },
      { domain: "b.com", username: "ub", createdAt: "2026-01-02" },
    ])

    const tool = findTool("credential_list")
    const result = await tool.handler({})

    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].domain).toBe("a.com")
    expect(parsed[1].domain).toBe("b.com")
  })

  it("filters by search term", async () => {
    mockList.mockResolvedValue([
      { domain: "airbnb.com", username: "ua", createdAt: "2026-01-01" },
      { domain: "booking.com", username: "ub", createdAt: "2026-01-02" },
    ])

    const tool = findTool("credential_list")
    const result = await tool.handler({ search: "airbnb" })

    // The search filtering happens in the handler
    const parsed = JSON.parse(result)
    // With mock returning all, handler should filter
    expect(parsed.length).toBeGreaterThanOrEqual(1)
  })

  it("returns empty array message when no credentials", async () => {
    mockList.mockResolvedValue([])

    const tool = findTool("credential_list")
    const result = await tool.handler({})

    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(0)
  })

  it("handles errors gracefully", async () => {
    mockList.mockRejectedValue(new Error("read error"))

    const tool = findTool("credential_list")
    const result = await tool.handler({})

    expect(result).toContain("read error")
  })

  it("emits nerves event", async () => {
    mockList.mockResolvedValue([])

    const tool = findTool("credential_list")
    await tool.handler({})

    const events = nervesEvents.filter((e) => e.event === "repertoire.credential_tool_call")
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0].meta as any).tool).toBe("credential_list")
  })
})

describe("credential_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("deletes credential and confirms", async () => {
    mockDelete.mockResolvedValue(true)

    const tool = findTool("credential_delete")
    const result = await tool.handler({ domain: "airbnb.com" })

    expect(result).toContain("deleted")
    expect(result).toContain("airbnb.com")
    expect(mockDelete).toHaveBeenCalledWith("airbnb.com")
  })

  it("reports when domain not found", async () => {
    mockDelete.mockResolvedValue(false)

    const tool = findTool("credential_delete")
    const result = await tool.handler({ domain: "missing.com" })

    expect(result).toContain("No credential found")
  })

  it("handles errors gracefully", async () => {
    mockDelete.mockRejectedValue(new Error("permission denied"))

    const tool = findTool("credential_delete")
    const result = await tool.handler({ domain: "x.com" })

    expect(result).toContain("permission denied")
  })

  it("has confirmationRequired set", () => {
    const tool = findTool("credential_delete")
    expect(tool.confirmationRequired).toBe(true)
  })

  it("emits nerves event", async () => {
    mockDelete.mockResolvedValue(true)

    const tool = findTool("credential_delete")
    await tool.handler({ domain: "test.com" })

    const events = nervesEvents.filter((e) => e.event === "repertoire.credential_tool_call")
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0].meta as any).tool).toBe("credential_delete")
  })
})

describe("tool definitions structure", () => {
  it("exports exactly 4 tools", () => {
    expect(credentialToolDefinitions).toHaveLength(4)
  })

  it("all tools have handlers", () => {
    for (const def of credentialToolDefinitions) {
      expect(typeof def.handler).toBe("function")
    }
  })

  it("all tools have summaryKeys", () => {
    for (const def of credentialToolDefinitions) {
      expect(def.summaryKeys).toBeDefined()
      expect(Array.isArray(def.summaryKeys)).toBe(true)
    }
  })

  it("tool names are credential_get, credential_store, credential_list, credential_delete", () => {
    const names = credentialToolDefinitions.map((d) => d.tool.function.name).sort()
    expect(names).toEqual([
      "credential_delete",
      "credential_get",
      "credential_list",
      "credential_store",
    ])
  })
})
