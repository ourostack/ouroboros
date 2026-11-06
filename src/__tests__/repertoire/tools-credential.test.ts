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

  it("accepts item name/path as the preferred lookup argument", async () => {
    mockGet.mockResolvedValue({
      domain: "ops/custom/service",
      username: "agent@test.com",
      notes: "stored outside workflow binding",
      createdAt: "2026-04-05T00:00:00Z",
    })

    const tool = findTool("credential_get")
    const result = await tool.handler({ item: "ops/custom/service", domain: "ignored.example" })

    expect(result).toContain("ops/custom/service")
    expect(mockGet).toHaveBeenCalledWith("ops/custom/service")
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

    expect(result).toContain("Credentials stored and verified")
    expect(result).toContain("airbnb.com")
    expect(mockStore).toHaveBeenCalledWith("airbnb.com", {
      username: "agent@test.com",
      password: "secret123",
      notes: "test",
    })
  })

  it("stores under item name/path when provided", async () => {
    mockStore.mockResolvedValue(undefined)

    const tool = findTool("credential_store")
    const result = await tool.handler({
      item: "ops/custom/service",
      domain: "ignored.example",
      username: "agent@test.com",
      password: "secret123",
    })

    expect(result).toContain("ops/custom/service")
    expect(mockStore).toHaveBeenCalledWith("ops/custom/service", {
      username: "agent@test.com",
      password: "secret123",
    })
  })

  it("stores without optional fields", async () => {
    mockStore.mockResolvedValue(undefined)

    const tool = findTool("credential_store")
    const result = await tool.handler({
      domain: "  api.example.com  ",
      username: "  user  ",
      password: "pw",
      notes: "   ",
    })

    expect(result).toContain("Credentials stored and verified")
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

  it("sanitizes non-Error store failures without leaking raw command prefixes", async () => {
    mockStore.mockRejectedValue("Command failed: bw create item\n")

    const tool = findTool("credential_store")
    const result = await tool.handler({
      domain: "x.com",
      username: "agent@example.com",
      password: "secret123",
    })

    expect(result).toContain("command failed")
    expect(result).not.toContain("Command failed:")
  })

  it("redacts raw bw payloads and hidden prompt echoes from store errors", async () => {
    const leakedEncodedPayload = Buffer
      .from(JSON.stringify({ login: { password: "secret123" } }))
      .toString("base64")
    mockStore.mockRejectedValue(
      new Error(`Command failed: bw create item ${leakedEncodedPayload}\n? Master password: [input is hidden]\nsecret123`),
    )

    const tool = findTool("credential_store")
    const result = await tool.handler({
      domain: "x.com",
      username: "agent@example.com",
      password: "secret123",
    })

    expect(result).toContain("command failed")
    expect(result).not.toContain("bw create item")
    expect(result).not.toContain(leakedEncodedPayload)
    expect(result).not.toContain("secret123")
    expect(result).not.toContain("[input is hidden]")
  })

  it("redacts the password from store errors", async () => {
    mockStore.mockRejectedValue(new Error("save failed for secret123"))

    const tool = findTool("credential_store")
    const result = await tool.handler({ domain: "x.com", username: "u", password: "secret123" })

    expect(result).toContain("[redacted]")
    expect(result).not.toContain("secret123")
  })

  it("redacts multiple secret fields from store errors", async () => {
    mockStore.mockRejectedValue(new Error("save failed for agent@example.com / secret123 / private note"))

    const tool = findTool("credential_store")
    const result = await tool.handler({
      domain: "x.com",
      username: "agent@example.com",
      password: "secret123",
      notes: "private note",
    })

    expect(result).not.toContain("agent@example.com")
    expect(result).not.toContain("secret123")
    expect(result).not.toContain("private note")
    expect(result.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it("rejects blank required fields before storing", async () => {
    const tool = findTool("credential_store")

    const blankDomain = await tool.handler({ domain: "   ", username: "u", password: "p" })
    const blankUsername = await tool.handler({ domain: "x.com", username: "   ", password: "p" })
    const blankPassword = await tool.handler({ domain: "x.com", username: "u", password: "   " })

    expect(blankDomain).toContain("domain must be a non-empty string")
    expect(blankUsername).toContain("username must be a non-empty string")
    expect(blankPassword).toContain("password must be a non-empty string")
    expect(mockStore).not.toHaveBeenCalled()
  })

  it("rejects non-string notes before storing", async () => {
    const tool = findTool("credential_store")
    const result = await tool.handler({ domain: "x.com", username: "u", password: "secret123", notes: true } as any)

    expect(result).toContain("notes must be a string if provided")
    expect(mockStore).not.toHaveBeenCalled()
  })

  it("does not require confirmation (trust gating is sufficient)", () => {
    const tool = findTool("credential_store")
    expect(tool.confirmationRequired).toBeUndefined()
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

describe("credential_generate_password", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns a strong default password for the requested domain", async () => {
    const tool = findTool("credential_generate_password")
    const result = await tool.handler({ domain: "airbnb.com" } as any)
    const parsed = JSON.parse(result)

    expect(parsed.domain).toBe("airbnb.com")
    expect(parsed.length).toBe(24)
    expect(parsed.symbols).toBe(true)
    expect(parsed.password).toHaveLength(24)
    expect(/[a-z]/.test(parsed.password)).toBe(true)
    expect(/[A-Z]/.test(parsed.password)).toBe(true)
    expect(/[2-9]/.test(parsed.password)).toBe(true)
    expect(/[!@#$%^&*()\-_=\+\[\]{}:,.?]/.test(parsed.password)).toBe(true)
  })

  it("can generate a password without symbols", async () => {
    const tool = findTool("credential_generate_password")
    const result = await tool.handler({ domain: "airbnb.com", length: 18, symbols: false } as any)
    const parsed = JSON.parse(result)

    expect(parsed.password).toHaveLength(18)
    expect(parsed.symbols).toBe(false)
    expect(/[!@#$%^&*()\-_=\+\[\]{}:,.?]/.test(parsed.password)).toBe(false)
    expect(/[a-z]/.test(parsed.password)).toBe(true)
    expect(/[A-Z]/.test(parsed.password)).toBe(true)
    expect(/[2-9]/.test(parsed.password)).toBe(true)
  })

  it("accepts string-form generation options", async () => {
    const tool = findTool("credential_generate_password")

    const noSymbolsResult = await tool.handler({
      domain: "airbnb.com",
      length: "18",
      symbols: "false",
    } as any)
    const noSymbols = JSON.parse(noSymbolsResult)

    const symbolsResult = await tool.handler({
      domain: "airbnb.com",
      length: "18",
      symbols: "true",
    } as any)
    const withSymbols = JSON.parse(symbolsResult)

    expect(noSymbols.password).toHaveLength(18)
    expect(noSymbols.symbols).toBe(false)
    expect(/[!@#$%^&*()\-_=\+\[\]{}:,.?]/.test(noSymbols.password)).toBe(false)

    expect(withSymbols.password).toHaveLength(18)
    expect(withSymbols.symbols).toBe(true)
    expect(/[!@#$%^&*()\-_=\+\[\]{}:,.?]/.test(withSymbols.password)).toBe(true)
  })

  it("rejects invalid generation inputs", async () => {
    const tool = findTool("credential_generate_password")

    const blankDomain = await tool.handler({ domain: "   " } as any)
    const badLength = await tool.handler({ domain: "airbnb.com", length: 6 } as any)
    const badSymbols = await tool.handler({ domain: "airbnb.com", symbols: "sometimes" } as any)

    expect(blankDomain).toContain("domain must be a non-empty string")
    expect(badLength).toContain("length must be an integer between 12 and 128")
    expect(badSymbols).toContain("symbols must be true or false")
  })

  it("emits nerves events without logging the generated password", async () => {
    const tool = findTool("credential_generate_password")
    const result = await tool.handler({ domain: "airbnb.com" } as any)
    const parsed = JSON.parse(result)

    const events = nervesEvents.filter((e) => e.event === "repertoire.credential_tool_call")
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0].meta as any).tool).toBe("credential_generate_password")
    expect(JSON.stringify(events)).not.toContain(parsed.password)
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

  it("deletes by item name/path when provided", async () => {
    mockDelete.mockResolvedValue(true)

    const tool = findTool("credential_delete")
    const result = await tool.handler({ item: "ops/custom/service", domain: "ignored.example" })

    expect(result).toContain("ops/custom/service")
    expect(mockDelete).toHaveBeenCalledWith("ops/custom/service")
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

  it("does not require confirmation (trust gating is sufficient)", () => {
    const tool = findTool("credential_delete")
    expect(tool.confirmationRequired).toBeUndefined()
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
  it("exports exactly 5 tools", () => {
    expect(credentialToolDefinitions).toHaveLength(5)
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

  it("tool names include the credential generation flow", () => {
    const names = credentialToolDefinitions.map((d) => d.tool.function.name).sort()
    expect(names).toEqual([
      "credential_delete",
      "credential_generate_password",
      "credential_get",
      "credential_list",
      "credential_store",
    ])
  })

  it("describes stored credentials as vault item names, not only domains", () => {
    for (const toolName of ["credential_get", "credential_store", "credential_list", "credential_delete"]) {
      const tool = findTool(toolName)
      expect(tool.tool.function.description.toLowerCase()).toContain("vault item")
    }

    const getParams = findTool("credential_get").tool.function.parameters as any
    expect(getParams.properties.item).toBeDefined()
    expect(getParams.properties.item.description).toContain("name/path")
    expect(getParams.properties.domain.description).toContain("compatibility alias")

    const storeParams = findTool("credential_store").tool.function.parameters as any
    expect(storeParams.properties.item).toBeDefined()
    expect(storeParams.properties.item.description).toContain("name/path")
    expect(storeParams.properties.notes.description).toContain("human/agent orientation")
    expect(storeParams.properties.notes.description).toContain("not parsed by code")
  })
})
