import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock credential store
const mockGetRawSecret = vi.fn()

vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: vi.fn(() => ({
    get: vi.fn(),
    getRawSecret: mockGetRawSecret,
    store: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    isReady: vi.fn(() => true),
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

describe("apiRequest with credentialDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("fetches token from credential store when credentialDomain is provided", async () => {
    mockGetRawSecret.mockResolvedValue("credential-resolved-token")
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "", credentialDomain: "api.openweathermap.org" })

    expect(mockGetRawSecret).toHaveBeenCalledWith("api.openweathermap.org", "password")
    const fetchCall = mockFetch.mock.calls[0]
    const headers = fetchCall[1].headers
    expect(headers.Authorization).toBe("Bearer credential-resolved-token")
  })

  it("uses custom credentialField when provided", async () => {
    mockGetRawSecret.mockResolvedValue("custom-field-token")
    mockFetchOk({ result: "ok" })

    await apiRequest({
      ...BASE_OPTIONS,
      token: "",
      credentialDomain: "api.example.com",
      credentialField: "apiKey",
    })

    expect(mockGetRawSecret).toHaveBeenCalledWith("api.example.com", "apiKey")
  })

  it("uses explicit token when credentialDomain is not provided", async () => {
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "explicit-token" })

    expect(mockGetRawSecret).not.toHaveBeenCalled()
    const fetchCall = mockFetch.mock.calls[0]
    expect(fetchCall[1].headers.Authorization).toBe("Bearer explicit-token")
  })

  it("returns error when credential store getRawSecret fails", async () => {
    mockGetRawSecret.mockRejectedValue(new Error('no credential found for domain "missing.com"'))

    const result = await apiRequest({ ...BASE_OPTIONS, token: "", credentialDomain: "missing.com" })

    expect(result).toContain("no credential found")
  })

  it("emits nerves event for credential fetch", async () => {
    mockGetRawSecret.mockResolvedValue("token")
    mockFetchOk({ result: "ok" })

    await apiRequest({ ...BASE_OPTIONS, token: "", credentialDomain: "test-cred.com" })

    const credEvents = nervesEvents.filter((e) => e.event === "client.credential_fetch")
    expect(credEvents.length).toBeGreaterThanOrEqual(1)
    expect((credEvents[0].meta as any).credentialDomain).toBe("test-cred.com")
  })

  it("emits credential_error event when credential fetch fails", async () => {
    mockGetRawSecret.mockRejectedValue(new Error("store error"))

    await apiRequest({ ...BASE_OPTIONS, token: "", credentialDomain: "bad.com" })

    const errorEvents = nervesEvents.filter((e) => e.event === "client.credential_error")
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
  })
})
