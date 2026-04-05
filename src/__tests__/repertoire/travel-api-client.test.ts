import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// Mock bitwarden client
const mockGetRawSecret = vi.fn()
const mockIsConnected = vi.fn().mockReturnValue(true)

vi.mock("../../repertoire/bitwarden-client", () => ({
  getBitwardenClient: vi.fn(() => ({
    getRawSecret: mockGetRawSecret,
    isConnected: mockIsConnected,
  })),
}))

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import {
  getWeather,
  getWeatherByCity,
  getTravelAdvisory,
  geocode,
  reverseGeocode,
  searchPOI,
} from "../../repertoire/travel-api-client"

function mockFetchResponse(data: unknown, ok = true, status = 200): void {
  mockFetch.mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
    text: async () => JSON.stringify(data),
  })
}

describe("getWeather", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockGetRawSecret.mockResolvedValue("test-api-key")
  })

  it("returns structured weather data for valid coordinates", async () => {
    mockFetchResponse({
      main: { temp: 22, feels_like: 20, humidity: 65 },
      weather: [{ description: "clear sky" }],
      wind: { speed: 5.2 },
      name: "London",
      sys: { country: "GB" },
    })

    const result = await getWeather(51.5, -0.12)

    expect(result.temperature).toBe(22)
    expect(result.feelsLike).toBe(20)
    expect(result.description).toBe("clear sky")
    expect(result.humidity).toBe(65)
    expect(result.windSpeed).toBe(5.2)
    expect(result.city).toBe("London")
    expect(result.country).toBe("GB")
  })

  it("fetches API key from vault via getRawSecret", async () => {
    mockFetchResponse({
      main: { temp: 20, feels_like: 18, humidity: 50 },
      weather: [{ description: "rain" }],
      wind: { speed: 3 },
      name: "Paris",
      sys: { country: "FR" },
    })

    await getWeather(48.8, 2.3)

    expect(mockGetRawSecret).toHaveBeenCalledWith("openweathermap-api", "apiKey")
    // Verify API key appears in URL
    const fetchUrl = mockFetch.mock.calls[0][0] as string
    expect(fetchUrl).toContain("appid=test-api-key")
    // Verify it's NOT in Authorization header
    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts?.headers?.Authorization).toBeUndefined()
  })

  it("handles HTTP error gracefully", async () => {
    mockFetchResponse({ message: "unauthorized" }, false, 401)

    await expect(getWeather(0, 0)).rejects.toThrow()
  })

  it("handles network error gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"))

    await expect(getWeather(0, 0)).rejects.toThrow(/Network error/)
  })

  it("handles vault locked error", async () => {
    mockGetRawSecret.mockRejectedValue(new Error("vault not connected"))

    await expect(getWeather(0, 0)).rejects.toThrow(/vault/)
  })

  it("emits nerves events for start and end", async () => {
    mockFetchResponse({
      main: { temp: 20, feels_like: 18, humidity: 50 },
      weather: [{ description: "sunny" }],
      wind: { speed: 2 },
      name: "NYC",
      sys: { country: "US" },
    })

    await getWeather(40.7, -74)

    expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
  })

  it("emits error event on failure", async () => {
    mockFetch.mockRejectedValue(new Error("fail"))

    await expect(getWeather(0, 0)).rejects.toThrow()

    expect(nervesEvents.some((e) => e.event === "client.error")).toBe(true)
  })
})

describe("getWeatherByCity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockGetRawSecret.mockResolvedValue("test-key")
  })

  it("returns weather data for city name", async () => {
    mockFetchResponse({
      main: { temp: 15, feels_like: 13, humidity: 70 },
      weather: [{ description: "overcast" }],
      wind: { speed: 4 },
      name: "Berlin",
      sys: { country: "DE" },
    })

    const result = await getWeatherByCity("Berlin")

    expect(result.city).toBe("Berlin")
    expect(result.temperature).toBe(15)
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain("q=Berlin")
  })
})

describe("getTravelAdvisory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns advisory data for country code", async () => {
    mockFetchResponse({
      data: [
        {
          id: "AF",
          advisory: "Do Not Travel",
          advisory_text: "Level 4: Do Not Travel",
          level: 4,
          date_last_updated: "2026-01-15",
          country: "Afghanistan",
        },
      ],
    })

    const result = await getTravelAdvisory("AF")

    expect(result.countryCode).toBe("AF")
    expect(result.advisoryLevel).toBe(4)
    expect(result.countryName).toBe("Afghanistan")
    expect(result.lastUpdated).toBe("2026-01-15")
  })

  it("requires no authentication", async () => {
    mockFetchResponse({ data: [{ id: "US", advisory: "Exercise Normal Precautions", advisory_text: "Level 1", level: 1, date_last_updated: "2026-03-01", country: "United States" }] })

    await getTravelAdvisory("US")

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts?.headers?.Authorization).toBeUndefined()
  })

  it("handles HTTP error", async () => {
    mockFetchResponse({}, false, 404)

    await expect(getTravelAdvisory("XX")).rejects.toThrow()
  })

  it("emits nerves events", async () => {
    mockFetchResponse({ data: [{ id: "GB", advisory: "Normal", advisory_text: "Level 1", level: 1, date_last_updated: "2026-01-01", country: "United Kingdom" }] })

    await getTravelAdvisory("GB")

    expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
  })
})

describe("geocode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns structured location data", async () => {
    mockFetchResponse([
      { lat: "51.5074", lon: "-0.1278", display_name: "London, England", type: "city" },
    ])

    const results = await geocode("London")

    expect(results).toHaveLength(1)
    expect(results[0].lat).toBe(51.5074)
    expect(results[0].lon).toBe(-0.1278)
    expect(results[0].displayName).toBe("London, England")
  })

  it("includes User-Agent header per Nominatim policy", async () => {
    mockFetchResponse([])

    await geocode("test")

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts.headers["User-Agent"]).toContain("Ouroboros")
  })

  it("requires no auth", async () => {
    mockFetchResponse([])

    await geocode("test")

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts.headers.Authorization).toBeUndefined()
  })

  it("handles network error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"))

    await expect(geocode("test")).rejects.toThrow()
  })

  it("emits nerves events", async () => {
    mockFetchResponse([])

    await geocode("test")

    expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
  })
})

describe("reverseGeocode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns location for coordinates", async () => {
    mockFetchResponse({
      lat: "51.5074",
      lon: "-0.1278",
      display_name: "London, England",
      type: "city",
    })

    const result = await reverseGeocode(51.5074, -0.1278)

    expect(result.displayName).toBe("London, England")
    expect(result.lat).toBe(51.5074)
  })

  it("includes User-Agent header", async () => {
    mockFetchResponse({ lat: "0", lon: "0", display_name: "Test", type: "test" })

    await reverseGeocode(0, 0)

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts.headers["User-Agent"]).toContain("Ouroboros")
  })
})

describe("searchPOI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns POI results near coordinates", async () => {
    mockFetchResponse([
      { lat: "48.8584", lon: "2.2945", display_name: "Eiffel Tower", type: "attraction" },
    ])

    const results = await searchPOI("Eiffel Tower", 48.85, 2.29)

    expect(results).toHaveLength(1)
    expect(results[0].displayName).toBe("Eiffel Tower")
  })

  it("includes radius in search when provided", async () => {
    mockFetchResponse([])

    await searchPOI("restaurant", 40.7, -74, 5)

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain("viewbox=")
  })

  it("emits nerves events", async () => {
    mockFetchResponse([])

    await searchPOI("hotel", 0, 0)

    expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
  })
})
