import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock bitwarden client
const mockGetRawSecret = vi.fn()
const mockIsConnected = vi.fn()

vi.mock("../../repertoire/bitwarden-client", () => ({
  getBitwardenClient: vi.fn(() => ({
    getRawSecret: mockGetRawSecret,
    isConnected: mockIsConnected,
  })),
}))

// Mock api-error
vi.mock("../../heart/api-error", () => ({
  handleApiError: vi.fn((err: unknown) => {
    if (err && typeof err === "object" && "status" in err) {
      return `API_ERROR:${(err as any).status}`
    }
    return `NETWORK_ERROR: ${err instanceof Error ? err.message : String(err)}`
  }),
}))

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import { apiRequest } from "../../repertoire/api-client"

function mockFetchOk(data: unknown): void {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

const BASE_OPTIONS = {
  baseUrl: "https://example.com",
  method: "GET",
  path: "/test",
  clientName: "test",
  serviceLabel: "Test",
  connectionName: "test",
}

describe("apiRequest with vaultKey", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockIsConnected.mockReturnValue(true)
  })

  it("fetches token from vault when vaultKey is provided", async () => {
    mockGetRawSecret.mockResolvedValue("vault-resolved-token")
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "", vaultKey: "weather-api" })

    expect(mockGetRawSecret).toHaveBeenCalledWith("weather-api", "apiKey")
    // Verify the resolved token is used in the Authorization header
    const fetchCall = mockFetch.mock.calls[0]
    const headers = fetchCall[1].headers
    expect(headers.Authorization).toBe("Bearer vault-resolved-token")
  })

  it("uses custom vaultField when provided", async () => {
    mockGetRawSecret.mockResolvedValue("custom-field-token")
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "", vaultKey: "weather-api", vaultField: "secret" })

    expect(mockGetRawSecret).toHaveBeenCalledWith("weather-api", "secret")
  })

  it("uses explicit token when vaultKey is not provided", async () => {
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "explicit-token" })

    expect(mockGetRawSecret).not.toHaveBeenCalled()
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1].headers.Authorization).toBe("Bearer explicit-token")
  })

  it("returns error when vault is locked", async () => {
    mockIsConnected.mockReturnValue(false)

    const result = await apiRequest({ ...BASE_OPTIONS, token: "", vaultKey: "x" })

    expect(result).toContain("Vault is locked")
  })

  it("returns error when vault key not found", async () => {
    mockGetRawSecret.mockRejectedValue(new Error("field \"apiKey\" not found"))

    const result = await apiRequest({ ...BASE_OPTIONS, token: "", vaultKey: "missing" })

    expect(result).toContain("not found")
  })

  it("emits nerves event for vault credential fetch", async () => {
    mockGetRawSecret.mockResolvedValue("token")
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "", vaultKey: "test-cred" })

    const vaultEvents = nervesEvents.filter((e) => e.event === "client.vault_fetch")
    expect(vaultEvents.length).toBeGreaterThanOrEqual(1)
    expect((vaultEvents[0].meta as any).vaultKey).toBe("test-cred")
  })

  it("emits vault_error event when vault fetch fails", async () => {
    mockGetRawSecret.mockRejectedValue(new Error("vault error"))

    await apiRequest({ ...BASE_OPTIONS, token: "", vaultKey: "bad" })

    const errorEvents = nervesEvents.filter((e) => e.event === "client.vault_error")
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
  })
})
