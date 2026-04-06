/**
 * Travel API client module.
 *
 * Provides HTTP clients for:
 * - Open-Meteo weather forecast (no auth, WMO weather codes)
 * - US State Dept Travel Advisories (no auth)
 * - Nominatim Geocoding (no auth, requires User-Agent)
 */

import { emitNervesEvent } from "../nerves/runtime"

export interface WeatherData {
  temperature: number
  feelsLike: number
  description: string
  humidity: number
  windSpeed: number
  city: string
  country: string
  /** Daily high temperature (when available from forecast). */
  dailyHigh?: number
  /** Daily low temperature (when available from forecast). */
  dailyLow?: number
}

export interface TravelAdvisory {
  countryCode: string
  countryName: string
  advisoryLevel: number // 1-4
  advisoryText: string
  lastUpdated: string
}

export interface GeoLocation {
  lat: number
  lon: number
  displayName: string
  type: string
}

// --- Open-Meteo Weather (zero auth) ---

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
const OPEN_METEO_GEOCODING = "https://geocoding-api.open-meteo.com/v1/search"

const OPEN_METEO_HEADERS = {
  "User-Agent": "Ouroboros/1.0 (https://github.com/ouroborosbot/ouroboros)",
  Accept: "application/json",
}

/**
 * WMO weather interpretation codes (WW) to human-readable descriptions.
 * Spec: https://www.nodc.noaa.gov/archive/arc0021/0002199/1.1/data/0-data/HTML/WMO-CODE/WMO4677.HTM
 */
export const WMO_WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snowfall",
  73: "moderate snowfall",
  75: "heavy snowfall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
}

/** Convert a WMO weather code to a human-readable description. */
export function wmoWeatherDescription(code: number): string {
  return WMO_WEATHER_CODES[code] ?? "unknown"
}

export async function getWeather(lat: number, lon: number): Promise<WeatherData> {
  return withNervesEvents("getWeather", { lat, lon }, async () => {
    const url =
      `${OPEN_METEO_FORECAST}?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
      `&timezone=auto`

    const res = await fetch(url, { headers: OPEN_METEO_HEADERS })

    if (!res.ok) {
      throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return parseOpenMeteoResponse(data, lat, lon)
  })
}

export async function getWeatherByCity(city: string): Promise<WeatherData> {
  return withNervesEvents("getWeatherByCity", { city }, async () => {
    // Step 1: geocode the city name via Open-Meteo geocoding
    const geoUrl = `${OPEN_METEO_GEOCODING}?name=${encodeURIComponent(city)}&count=1&language=en`
    const geoRes = await fetch(geoUrl, { headers: OPEN_METEO_HEADERS })

    if (!geoRes.ok) {
      throw new Error(`Open-Meteo geocoding error: ${geoRes.status} ${geoRes.statusText}`)
    }

    const geoData = await geoRes.json()
    const results = geoData.results as any[] | undefined

    if (!results || results.length === 0) {
      throw new Error(`No location found for city "${city}"`)
    }

    const loc = results[0]

    // Step 2: fetch forecast for the resolved coordinates
    const url =
      `${OPEN_METEO_FORECAST}?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
      `&timezone=auto`

    const res = await fetch(url, { headers: OPEN_METEO_HEADERS })

    if (!res.ok) {
      throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return parseOpenMeteoResponse(data, loc.latitude, loc.longitude, loc.name, loc.country_code)
  })
}

function parseOpenMeteoResponse(
  data: any,
  lat: number,
  lon: number,
  cityName?: string,
  countryCode?: string,
): WeatherData {
  const current = data.current ?? {}
  const daily = data.daily ?? {}

  return {
    temperature: current.temperature_2m ?? 0,
    feelsLike: current.apparent_temperature ?? 0,
    description: wmoWeatherDescription(current.weather_code ?? -1),
    humidity: current.relative_humidity_2m ?? 0,
    windSpeed: current.wind_speed_10m ?? 0,
    city: cityName ?? `${lat},${lon}`,
    country: countryCode ?? "",
    dailyHigh: daily.temperature_2m_max?.[0],
    dailyLow: daily.temperature_2m_min?.[0],
  }
}

// --- US State Dept Travel Advisories ---

/**
 * Official US State Department travel advisories RSS feed.
 * This is the canonical public feed maintained by travel.state.gov.
 * Returns XML/RSS with per-country advisory items.
 */
export const TRAVEL_ADVISORY_RSS_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml"

/**
 * Mapping of ISO 3166-1 alpha-2 codes to country names, ONLY for codes
 * where ISO differs from FIPS 10-4 (which the State Dept RSS feed uses).
 *
 * The RSS feed Country-Tag uses FIPS codes. Callers typically pass ISO codes.
 * When the codes match (e.g. AF for Afghanistan), no lookup is needed.
 * This table handles the ~30 codes where they diverge.
 */
const ISO_FIPS_DIVERGENCE: Record<string, string> = {
  AG: "Antigua and Barbuda", // FIPS: AC
  AT: "Austria",       // FIPS: AU
  AU: "Australia",     // FIPS: AS
  BD: "Bangladesh",    // FIPS: BG
  BH: "Bahrain",       // FIPS: BA
  BN: "Brunei",        // FIPS: BX
  BO: "Bolivia",       // FIPS: BL
  BS: "Bahamas",       // FIPS: BF
  BW: "Botswana",      // FIPS: BC
  CD: "Congo (Kinshasa)", // FIPS: CG
  CH: "Switzerland",   // FIPS: SZ
  CI: "Cote d'Ivoire", // FIPS: IV
  CL: "Chile",         // FIPS: CI
  CN: "China",         // FIPS: CH
  CZ: "Czechia",       // FIPS: EZ
  DE: "Germany",       // FIPS: GM
  DK: "Denmark",       // FIPS: DA
  DO: "Dominican Republic", // FIPS: DR
  DZ: "Algeria",       // FIPS: AG
  ES: "Spain",         // FIPS: SP
  FI: "Finland",       // FIPS: FI → same, but title might say "Finland"
  GQ: "Equatorial Guinea", // FIPS: EK
  HR: "Croatia",       // FIPS: HR → same
  IE: "Ireland",       // FIPS: EI
  IL: "Israel",        // FIPS: IS
  JP: "Japan",         // FIPS: JA
  KP: "North Korea",   // FIPS: KN
  KR: "South Korea",   // FIPS: KS
  LT: "Lithuania",     // FIPS: LH
  MA: "Morocco",       // FIPS: MO
  MM: "Burma",         // FIPS: BM (State Dept uses "Burma (Myanmar)")
  NG: "Nigeria",       // FIPS: NI
  NO: "Norway",        // FIPS: NO → same
  PH: "Philippines",   // FIPS: RP
  PT: "Portugal",      // FIPS: PO
  RO: "Romania",       // FIPS: RO → same
  SE: "Sweden",        // FIPS: SW
  SG: "Singapore",     // FIPS: SN
  TL: "Timor-Leste",   // FIPS: TT
  TR: "Turkey",        // FIPS: TU
  TW: "Taiwan",        // FIPS: TW → same
  UA: "Ukraine",       // FIPS: UP
  VA: "Holy See",      // FIPS: VT
  VN: "Vietnam",       // FIPS: VM
  YE: "Yemen",         // FIPS: YM
  ZA: "South Africa",  // FIPS: SF
}

/**
 * Look up the expected country name for an ISO alpha-2 code,
 * but ONLY when that code diverges from the FIPS code used in the RSS feed.
 * Returns undefined for codes where ISO == FIPS (no title fallback needed).
 */
export function isoToCountryName(isoCode: string): string | undefined {
  return ISO_FIPS_DIVERGENCE[isoCode.toUpperCase()]
}

/**
 * Parse advisory level (1-4) from an RSS item title like
 * "Afghanistan - Level 4: Do Not Travel"
 */
export function parseAdvisoryLevel(title: string): number {
  const match = title.match(/Level\s+(\d)/)
  return match ? parseInt(match[1], 10) : 0
}

/**
 * Parse country name from an RSS item title like
 * "Afghanistan - Level 4: Do Not Travel"
 */
export function parseCountryName(title: string): string {
  const dashIdx = title.indexOf(" - ")
  return dashIdx > 0 ? title.slice(0, dashIdx).trim() : title.trim()
}

/**
 * Extract advisory text from title (the part after "Level N: ").
 */
export function parseAdvisoryText(title: string): string {
  const match = title.match(/Level\s+\d:\s*(.+)/)
  return match ? match[1].trim() : title.trim()
}

export async function getTravelAdvisory(countryCode: string): Promise<TravelAdvisory> {
  return withNervesEvents("getTravelAdvisory", { countryCode }, async () => {
    const res = await fetch(TRAVEL_ADVISORY_RSS_URL, {
      headers: {
        Accept: "application/xml, text/xml",
      },
    })

    if (!res.ok) {
      throw new Error(`Travel advisory API error: ${res.status} ${res.statusText}`)
    }

    const xml = await res.text()
    const upperCode = countryCode.toUpperCase()

    // When the caller's ISO code diverges from FIPS, we need a title-based fallback.
    const expectedCountryName = isoToCountryName(upperCode)

    // Parse RSS items via regex (no XML parser dependency needed).
    // Each <item> contains <title>, <pubDate>, and <category domain="Country-Tag">.
    const itemPattern = /<item>([\s\S]*?)<\/item>/g
    let titleFallbackMatch: TravelAdvisory | null = null
    let match: RegExpExecArray | null

    while ((match = itemPattern.exec(xml)) !== null) {
      const block = match[1]

      const titleMatch = block.match(/<title>(.*?)<\/title>/)
      const title = titleMatch?.[1] ?? ""

      const pubDateMatch = block.match(/<pubDate>(.*?)<\/pubDate>/)
      const pubDate = pubDateMatch?.[1]?.trim() ?? ""

      // Extract country tag from <category domain="Country-Tag">XX</category>
      const tagMatch = block.match(/<category\s+domain="Country-Tag">(.*?)<\/category>/)
      const tag = tagMatch?.[1]?.trim().toUpperCase()

      // Primary match: FIPS tag matches the requested code directly.
      // Skip this path when the caller's ISO code is known to diverge from FIPS —
      // e.g. ISO "ES" = Spain, but FIPS "ES" = El Salvador. In that case, only
      // the title-based fallback should match.
      if (tag === upperCode && !expectedCountryName) {
        return {
          countryCode,
          countryName: parseCountryName(title),
          advisoryLevel: parseAdvisoryLevel(title),
          advisoryText: parseAdvisoryText(title),
          lastUpdated: pubDate,
        }
      }

      // Title-based match: when ISO differs from FIPS, match by country name.
      // Uses startsWith to handle names like "Burma (Myanmar)" matching "Burma".
      if (expectedCountryName && !titleFallbackMatch) {
        const titleCountry = parseCountryName(title)
        if (titleCountry.toLowerCase().startsWith(expectedCountryName.toLowerCase())) {
          titleFallbackMatch = {
            countryCode,
            countryName: titleCountry,
            advisoryLevel: parseAdvisoryLevel(title),
            advisoryText: parseAdvisoryText(title),
            lastUpdated: pubDate,
          }
        }
      }
    }

    if (titleFallbackMatch) return titleFallbackMatch

    throw new Error(`No travel advisory found for country code "${countryCode}"`)
  })
}

// --- Nominatim Geocoding ---

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
const NOMINATIM_HEADERS = {
  "User-Agent": "Ouroboros/1.0 (https://github.com/ouroborosbot/ouroboros)",
  Accept: "application/json",
}

export async function geocode(query: string): Promise<GeoLocation[]> {
  return withNervesEvents("geocode", { query }, async () => {
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json`
    const res = await fetch(url, { headers: NOMINATIM_HEADERS })

    if (!res.ok) {
      throw new Error(`Nominatim geocode error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return (data as any[]).map(parseGeoLocation)
  })
}

export async function reverseGeocode(lat: number, lon: number): Promise<GeoLocation> {
  return withNervesEvents("reverseGeocode", { lat, lon }, async () => {
    const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lon}&format=json`
    const res = await fetch(url, { headers: NOMINATIM_HEADERS })

    if (!res.ok) {
      throw new Error(`Nominatim reverse geocode error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return parseGeoLocation(data)
  })
}

export async function searchPOI(
  query: string,
  lat: number,
  lon: number,
  radiusKm?: number,
): Promise<GeoLocation[]> {
  return withNervesEvents("searchPOI", { query, lat, lon, radiusKm }, async () => {
    const radius = radiusKm ?? 10
    // Nominatim uses viewbox for bounded search (approximate degrees from km)
    const degOffset = radius / 111 // ~111 km per degree
    const viewbox = `${lon - degOffset},${lat + degOffset},${lon + degOffset},${lat - degOffset}`
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&viewbox=${viewbox}&bounded=1`
    const res = await fetch(url, { headers: NOMINATIM_HEADERS })

    if (!res.ok) {
      throw new Error(`Nominatim POI search error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return (data as any[]).map(parseGeoLocation)
  })
}

function parseGeoLocation(item: any): GeoLocation {
  return {
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    displayName: item.display_name,
    type: item.type ?? "unknown",
  }
}

// --- Shared nerves event wrapper ---

async function withNervesEvents<T>(
  operation: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  emitNervesEvent({
    event: "client.request_start",
    component: "clients",
    message: `travel API ${operation} starting`,
    meta: { operation, ...meta },
  })

  try {
    const result = await fn()
    emitNervesEvent({
      event: "client.request_end",
      component: "clients",
      message: `travel API ${operation} complete`,
      meta: { operation, ...meta },
    })
    return result
  } catch (err) {
    emitNervesEvent({
      level: "error",
      event: "client.error",
      component: "clients",
      message: `travel API ${operation} failed`,
      /* v8 ignore next -- defensive: callers throw Error instances @preserve */
      meta: { operation, reason: err instanceof Error ? err.message : String(err), ...meta },
    })
    throw err
  }
}
