import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fetch globally
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
  parseAdvisoryLevel,
  parseCountryName,
  parseAdvisoryText,
  isoToCountryName,
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

function mockFetchText(text: string, ok = true, status = 200): void {
  mockFetch.mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => text,
    json: async () => { throw new Error("not json") },
  })
}

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Travel Advisories</title>
  <item>
    <title>Afghanistan - Level 4: Do Not Travel</title>
    <link>https://travel.state.gov/.../destination.afg.html</link>
    <pubDate>Mon, 15 Jan 2026</pubDate>
    <category domain="Threat-Level">Level 4: Do Not Travel</category>
    <category domain="Country-Tag">AF</category>
  </item>
  <item>
    <title>United Kingdom - Level 1: Exercise Normal Precautions</title>
    <link>https://travel.state.gov/.../destination.gbr.html</link>
    <pubDate>Sun, 01 Jan 2026</pubDate>
    <category domain="Threat-Level">Level 1: Exercise Normal Precautions</category>
    <category domain="Country-Tag">UK</category>
  </item>
</channel>
</rss>`

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

  it("returns 'unknown' description when weather array is missing", async () => {
    mockFetchResponse({
      main: { temp: 10, feels_like: 8, humidity: 80 },
      weather: [],
      wind: { speed: 1 },
      name: "Nowhere",
      sys: { country: "XX" },
    })

    const result = await getWeather(0, 0)
    expect(result.description).toBe("unknown")
  })

  it("fetches API key from credential store via getRawSecret", async () => {
    mockFetchResponse({
      main: { temp: 20, feels_like: 18, humidity: 50 },
      weather: [{ description: "rain" }],
      wind: { speed: 3 },
      name: "Paris",
      sys: { country: "FR" },
    })

    await getWeather(48.8, 2.3)

    expect(mockGetRawSecret).toHaveBeenCalledWith("api.openweathermap.org", "password")
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

  it("handles credential store error", async () => {
    mockGetRawSecret.mockRejectedValue(new Error("no credential found"))

    await expect(getWeather(0, 0)).rejects.toThrow(/credential/)
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

  it("handles HTTP error for city lookup", async () => {
    mockFetchResponse({}, false, 404)

    await expect(getWeatherByCity("NonexistentCity")).rejects.toThrow(/OpenWeatherMap/)
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

describe("parseAdvisoryLevel", () => {
  it("extracts level number from title", () => {
    expect(parseAdvisoryLevel("Afghanistan - Level 4: Do Not Travel")).toBe(4)
    expect(parseAdvisoryLevel("United Kingdom - Level 1: Exercise Normal Precautions")).toBe(1)
  })

  it("returns 0 for unparseable titles", () => {
    expect(parseAdvisoryLevel("Unknown format")).toBe(0)
  })
})

describe("parseCountryName", () => {
  it("extracts country name before dash", () => {
    expect(parseCountryName("Afghanistan - Level 4: Do Not Travel")).toBe("Afghanistan")
    expect(parseCountryName("United Kingdom - Level 1: Exercise Normal Precautions")).toBe("United Kingdom")
  })

  it("returns full string if no dash", () => {
    expect(parseCountryName("NoDash")).toBe("NoDash")
  })
})

describe("parseAdvisoryText", () => {
  it("extracts advisory text after Level N:", () => {
    expect(parseAdvisoryText("Afghanistan - Level 4: Do Not Travel")).toBe("Do Not Travel")
    expect(parseAdvisoryText("UK - Level 1: Exercise Normal Precautions")).toBe("Exercise Normal Precautions")
  })

  it("returns full string if no match", () => {
    expect(parseAdvisoryText("Unknown")).toBe("Unknown")
  })
})

describe("getTravelAdvisory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns advisory data for country code from RSS feed", async () => {
    mockFetchText(SAMPLE_RSS)

    const result = await getTravelAdvisory("AF")

    expect(result.countryCode).toBe("AF")
    expect(result.advisoryLevel).toBe(4)
    expect(result.countryName).toBe("Afghanistan")
    expect(result.advisoryText).toBe("Do Not Travel")
    expect(result.lastUpdated).toBe("Mon, 15 Jan 2026")
  })

  it("fetches from the official RSS endpoint", async () => {
    mockFetchText(SAMPLE_RSS)

    await getTravelAdvisory("AF")

    const fetchUrl = mockFetch.mock.calls[0][0] as string
    expect(fetchUrl).toBe("https://travel.state.gov/_res/rss/TAsTWs.xml")
  })

  it("requires no authentication", async () => {
    mockFetchText(SAMPLE_RSS)

    await getTravelAdvisory("AF")

    const fetchOpts = mockFetch.mock.calls[0][1]
    expect(fetchOpts?.headers?.Authorization).toBeUndefined()
  })

  it("handles HTTP error", async () => {
    mockFetchText("", false, 404)

    await expect(getTravelAdvisory("XX")).rejects.toThrow(/Travel advisory API error/)
  })

  it("throws when no entry found for country", async () => {
    mockFetchText(SAMPLE_RSS)

    await expect(getTravelAdvisory("ZZ")).rejects.toThrow(/No travel advisory found/)
  })

  it("matches country code case-insensitively", async () => {
    mockFetchText(SAMPLE_RSS)

    const result = await getTravelAdvisory("uk")

    expect(result.countryName).toBe("United Kingdom")
    expect(result.advisoryLevel).toBe(1)
  })

  it("emits nerves events", async () => {
    mockFetchText(SAMPLE_RSS)

    await getTravelAdvisory("AF")

    expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
  })

  it("defaults title to empty string when <title> tag is missing from RSS item", async () => {
    const rssNoTitle = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <pubDate>Mon, 15 Jan 2026</pubDate>
    <category domain="Country-Tag">AF</category>
  </item>
</channel></rss>`
    mockFetchText(rssNoTitle)

    const result = await getTravelAdvisory("AF")

    expect(result.countryCode).toBe("AF")
    expect(result.countryName).toBe("")
    expect(result.lastUpdated).toBe("Mon, 15 Jan 2026")
  })

  it("defaults pubDate to empty string when <pubDate> tag is missing from RSS item", async () => {
    const rssNoPubDate = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Afghanistan - Level 4: Do Not Travel</title>
    <category domain="Country-Tag">AF</category>
  </item>
</channel></rss>`
    mockFetchText(rssNoPubDate)

    const result = await getTravelAdvisory("AF")

    expect(result.countryCode).toBe("AF")
    expect(result.advisoryLevel).toBe(4)
    expect(result.lastUpdated).toBe("")
  })

  it("falls back to title-based matching when ISO code differs from FIPS code (ES -> Spain)", async () => {
    // The RSS feed uses FIPS "SP" for Spain, but callers pass ISO "ES"
    const rssSpain = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Spain - Level 2: Exercise Increased Caution</title>
    <pubDate>Mon, 01 Mar 2026</pubDate>
    <category domain="Country-Tag">SP</category>
  </item>
  <item>
    <title>El Salvador - Level 3: Reconsider Travel</title>
    <pubDate>Mon, 01 Feb 2026</pubDate>
    <category domain="Country-Tag">ES</category>
  </item>
</channel></rss>`
    mockFetchText(rssSpain)

    // ES in ISO = Spain, ES in FIPS = El Salvador
    // The function should resolve ES to Spain via title-based matching
    const result = await getTravelAdvisory("ES")

    expect(result.countryName).toBe("Spain")
    expect(result.advisoryLevel).toBe(2)
  })

  it("still matches FIPS codes directly when they match", async () => {
    // AF is both ISO and FIPS for Afghanistan
    mockFetchText(SAMPLE_RSS)

    const result = await getTravelAdvisory("AF")

    expect(result.countryName).toBe("Afghanistan")
    expect(result.advisoryLevel).toBe(4)
  })

  it("throws when ISO code diverges from FIPS but no matching title found", async () => {
    // DE maps to "Germany" in the divergence table, but RSS has no Germany entry
    const rssNoGermany = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Afghanistan - Level 4: Do Not Travel</title>
    <pubDate>Mon, 15 Jan 2026</pubDate>
    <category domain="Country-Tag">AF</category>
  </item>
</channel></rss>`
    mockFetchText(rssNoGermany)

    await expect(getTravelAdvisory("DE")).rejects.toThrow(/No travel advisory found/)
  })

  it("matches Burma/Myanmar via ISO code MM (FIPS is BM)", async () => {
    const rssBurma = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Burma (Myanmar) - Level 4: Do Not Travel</title>
    <pubDate>Tue, 15 Jan 2026</pubDate>
    <category domain="Country-Tag">BM</category>
  </item>
</channel></rss>`
    mockFetchText(rssBurma)

    const result = await getTravelAdvisory("MM")

    expect(result.countryName).toBe("Burma (Myanmar)")
    expect(result.advisoryLevel).toBe(4)
  })
})

describe("isoToCountryName", () => {
  it("returns country name for known ISO codes that differ from FIPS", () => {
    expect(isoToCountryName("ES")).toBe("Spain")
    expect(isoToCountryName("MM")).toBe("Burma")
    expect(isoToCountryName("TL")).toBe("Timor-Leste")
  })

  it("is case-insensitive", () => {
    expect(isoToCountryName("es")).toBe("Spain")
  })

  it("returns undefined for codes not in the divergence table", () => {
    expect(isoToCountryName("US")).toBeUndefined()
    expect(isoToCountryName("AF")).toBeUndefined()
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

  it("handles HTTP error", async () => {
    mockFetchResponse({}, false, 500)

    await expect(geocode("test")).rejects.toThrow(/Nominatim geocode/)
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

  it("handles HTTP error", async () => {
    mockFetchResponse({}, false, 500)

    await expect(reverseGeocode(0, 0)).rejects.toThrow(/Nominatim reverse geocode/)
  })
})

describe("searchPOI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns 'unknown' type when type field is missing from result", async () => {
    mockFetchResponse([
      { lat: "40.7", lon: "-74.0", display_name: "Test Place" },
    ])

    const results = await searchPOI("test", 40.7, -74)
    expect(results[0].type).toBe("unknown")
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

  it("handles HTTP error", async () => {
    mockFetchResponse({}, false, 500)

    await expect(searchPOI("hotel", 0, 0)).rejects.toThrow(/Nominatim POI search/)
  })

  it("emits nerves events", async () => {
    mockFetchResponse([])

    await searchPOI("hotel", 0, 0)

    expect(nervesEvents.some((e) => e.event === "client.request_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "client.request_end")).toBe(true)
  })
})
