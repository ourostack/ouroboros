import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the travel API client
const mockGetWeather = vi.fn()
const mockGetWeatherByCity = vi.fn()
const mockGetTravelAdvisory = vi.fn()
const mockGeocode = vi.fn()
const mockSearchPOI = vi.fn()

vi.mock("../../repertoire/travel-api-client", () => ({
  getWeather: (...args: unknown[]) => mockGetWeather(...args),
  getWeatherByCity: (...args: unknown[]) => mockGetWeatherByCity(...args),
  getTravelAdvisory: (...args: unknown[]) => mockGetTravelAdvisory(...args),
  geocode: (...args: unknown[]) => mockGeocode(...args),
  searchPOI: (...args: unknown[]) => mockSearchPOI(...args),
}))

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

import { travelToolDefinitions } from "../../repertoire/tools-travel"

function findTool(name: string) {
  const def = travelToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool ${name} not found in travelToolDefinitions`)
  return def
}

describe("travelToolDefinitions", () => {
  it("exports an array of 3 tool definitions", () => {
    expect(travelToolDefinitions).toHaveLength(3)
  })

  it("contains weather_lookup, travel_advisory, geocode_search", () => {
    const names = travelToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("weather_lookup")
    expect(names).toContain("travel_advisory")
    expect(names).toContain("geocode_search")
  })

  it("no tools have confirmationRequired (read-only)", () => {
    for (const def of travelToolDefinitions) {
      expect(def.confirmationRequired).toBeFalsy()
    }
  })

  it("no tools have integration gate (base tools)", () => {
    for (const def of travelToolDefinitions) {
      expect(def.integration).toBeUndefined()
    }
  })
})

describe("weather_lookup handler", () => {
  const handler = findTool("weather_lookup").handler

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("with city calls getWeatherByCity", async () => {
    mockGetWeatherByCity.mockResolvedValue({
      temperature: 22, feelsLike: 20, description: "clear", humidity: 65, windSpeed: 5, city: "London", country: "GB",
    })

    const result = await handler({ city: "London" })

    expect(mockGetWeatherByCity).toHaveBeenCalledWith("London")
    expect(result).toContain("22")
    expect(result).toContain("London")
  })

  it("with lat/lon calls getWeather", async () => {
    mockGetWeather.mockResolvedValue({
      temperature: 15, feelsLike: 13, description: "rain", humidity: 80, windSpeed: 3, city: "Paris", country: "FR",
    })

    const result = await handler({ lat: "48.8", lon: "2.3" })

    expect(mockGetWeather).toHaveBeenCalledWith(48.8, 2.3)
    expect(result).toContain("Paris")
  })

  it("with neither city nor lat/lon returns error", async () => {
    const result = await handler({})

    expect(result).toContain("city")
    expect(mockGetWeather).not.toHaveBeenCalled()
    expect(mockGetWeatherByCity).not.toHaveBeenCalled()
  })

  it("emits nerves events", async () => {
    mockGetWeatherByCity.mockResolvedValue({
      temperature: 20, feelsLike: 18, description: "sunny", humidity: 50, windSpeed: 2, city: "NYC", country: "US",
    })

    await handler({ city: "NYC" })

    expect(nervesEvents.some((e) => e.event === "repertoire.travel_tool_call")).toBe(true)
  })

  it("returns error message on failure", async () => {
    mockGetWeatherByCity.mockRejectedValue(new Error("API down"))

    const result = await handler({ city: "fail" })

    expect(result).toContain("API down")
  })
})

describe("travel_advisory handler", () => {
  const handler = findTool("travel_advisory").handler

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("calls getTravelAdvisory with normalized country code", async () => {
    mockGetTravelAdvisory.mockResolvedValue({
      countryCode: "AF", countryName: "Afghanistan", advisoryLevel: 4, advisoryText: "Do Not Travel", lastUpdated: "2026-01-15",
    })

    const result = await handler({ country_code: "af" })

    expect(mockGetTravelAdvisory).toHaveBeenCalledWith("AF")
    expect(result).toContain("Afghanistan")
    expect(result).toContain("4")
  })

  it("emits nerves events", async () => {
    mockGetTravelAdvisory.mockResolvedValue({
      countryCode: "US", countryName: "United States", advisoryLevel: 1, advisoryText: "Normal", lastUpdated: "2026-01-01",
    })

    await handler({ country_code: "US" })

    expect(nervesEvents.some((e) => e.event === "repertoire.travel_tool_call")).toBe(true)
  })

  it("returns error on failure", async () => {
    mockGetTravelAdvisory.mockRejectedValue(new Error("Not found"))

    const result = await handler({ country_code: "XX" })

    expect(result).toContain("Not found")
  })
})

describe("geocode_search handler", () => {
  const handler = findTool("geocode_search").handler

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("with just query calls geocode", async () => {
    mockGeocode.mockResolvedValue([
      { lat: 51.5, lon: -0.1, displayName: "London", type: "city" },
    ])

    const result = await handler({ query: "London" })

    expect(mockGeocode).toHaveBeenCalledWith("London")
    expect(result).toContain("London")
  })

  it("with near_lat/near_lon calls searchPOI", async () => {
    mockSearchPOI.mockResolvedValue([
      { lat: 48.8, lon: 2.3, displayName: "Eiffel Tower", type: "attraction" },
    ])

    const result = await handler({ query: "Eiffel Tower", near_lat: "48.85", near_lon: "2.29" })

    expect(mockSearchPOI).toHaveBeenCalledWith("Eiffel Tower", 48.85, 2.29, undefined)
    expect(result).toContain("Eiffel Tower")
  })

  it("passes radius_km to searchPOI when provided", async () => {
    mockSearchPOI.mockResolvedValue([])

    await handler({ query: "restaurant", near_lat: "40.7", near_lon: "-74", radius_km: "5" })

    expect(mockSearchPOI).toHaveBeenCalledWith("restaurant", 40.7, -74, 5)
  })

  it("emits nerves events", async () => {
    mockGeocode.mockResolvedValue([])

    await handler({ query: "test" })

    expect(nervesEvents.some((e) => e.event === "repertoire.travel_tool_call")).toBe(true)
  })

  it("returns error on failure", async () => {
    mockGeocode.mockRejectedValue(new Error("Geocode failed"))

    const result = await handler({ query: "fail" })

    expect(result).toContain("Geocode failed")
  })
})
