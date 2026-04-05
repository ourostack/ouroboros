/**
 * Travel API client module.
 *
 * Provides HTTP clients for:
 * - OpenWeatherMap (query-param auth via vault)
 * - US State Dept Travel Advisories (no auth)
 * - Nominatim Geocoding (no auth, requires User-Agent)
 */

import { emitNervesEvent } from "../nerves/runtime"
import { getBitwardenClient } from "./bitwarden-client"

export interface WeatherData {
  temperature: number
  feelsLike: number
  description: string
  humidity: number
  windSpeed: number
  city: string
  country: string
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

// --- OpenWeatherMap ---

async function getWeatherApiKey(): Promise<string> {
  const client = getBitwardenClient()
  return client.getRawSecret("openweathermap-api", "apiKey")
}

export async function getWeather(lat: number, lon: number): Promise<WeatherData> {
  return withNervesEvents("getWeather", { lat, lon }, async () => {
    const apiKey = await getWeatherApiKey()
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`
    const res = await fetch(url)

    if (!res.ok) {
      throw new Error(`OpenWeatherMap API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return parseWeatherResponse(data)
  })
}

export async function getWeatherByCity(city: string): Promise<WeatherData> {
  return withNervesEvents("getWeatherByCity", { city }, async () => {
    const apiKey = await getWeatherApiKey()
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`
    const res = await fetch(url)

    if (!res.ok) {
      throw new Error(`OpenWeatherMap API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    return parseWeatherResponse(data)
  })
}

function parseWeatherResponse(data: any): WeatherData {
  return {
    temperature: data.main.temp,
    feelsLike: data.main.feels_like,
    description: data.weather?.[0]?.description ?? "unknown",
    humidity: data.main.humidity,
    windSpeed: data.wind.speed,
    city: data.name,
    country: data.sys.country,
  }
}

// --- US State Dept Travel Advisories ---

const TRAVEL_ADVISORY_URL = "https://cadatalog.state.gov/catalog/api/3/action/package_search"

export async function getTravelAdvisory(countryCode: string): Promise<TravelAdvisory> {
  return withNervesEvents("getTravelAdvisory", { countryCode }, async () => {
    const url = `${TRAVEL_ADVISORY_URL}?q=${encodeURIComponent(countryCode)}`
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    })

    if (!res.ok) {
      throw new Error(`Travel advisory API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json()
    const entry = data.data?.[0]

    if (!entry) {
      throw new Error(`No travel advisory found for country code "${countryCode}"`)
    }

    return {
      countryCode: entry.id,
      countryName: entry.country,
      advisoryLevel: entry.level,
      advisoryText: entry.advisory_text,
      lastUpdated: entry.date_last_updated,
    }
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
