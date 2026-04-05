import type { ToolDefinition } from "./tools-base"
import {
  getWeather,
  getWeatherByCity,
  getTravelAdvisory,
  geocode,
  searchPOI,
} from "./travel-api-client"
import { emitNervesEvent } from "../nerves/runtime"

export const travelToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "weather_lookup",
        description:
          "Get current weather for a location. Provide either a city name or lat/lon coordinates.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name (e.g. 'London', 'New York')" },
            lat: { type: "string", description: "Latitude (decimal)" },
            lon: { type: "string", description: "Longitude (decimal)" },
          },
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.travel_tool_call",
        message: "weather_lookup invoked",
        meta: { tool: "weather_lookup" },
      })

      try {
        if (args.city) {
          const data = await getWeatherByCity(args.city)
          return JSON.stringify(data, null, 2)
        }

        if (args.lat && args.lon) {
          const data = await getWeather(parseFloat(args.lat), parseFloat(args.lon))
          return JSON.stringify(data, null, 2)
        }

        return "Please provide either a city name or lat/lon coordinates."
      } catch (err) {
        /* v8 ignore next -- defensive: callers throw Error instances @preserve */
        return `Weather lookup error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["city", "lat", "lon"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "travel_advisory",
        description:
          "Get US State Department travel advisory for a country. Returns advisory level (1-4) and description.",
        parameters: {
          type: "object",
          properties: {
            country_code: {
              type: "string",
              description: "ISO 3166 alpha-2 country code (e.g. 'US', 'GB', 'AF')",
            },
          },
          required: ["country_code"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.travel_tool_call",
        message: "travel_advisory invoked",
        meta: { tool: "travel_advisory" },
      })

      try {
        const data = await getTravelAdvisory(args.country_code.toUpperCase())
        return JSON.stringify(data, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: callers throw Error instances @preserve */
        return `Travel advisory error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["country_code"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "geocode_search",
        description:
          "Search for locations, addresses, or points of interest. Returns coordinates and display names.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (e.g. 'Eiffel Tower', '123 Main St')" },
            near_lat: { type: "string", description: "Latitude to search near (for POI search)" },
            near_lon: { type: "string", description: "Longitude to search near (for POI search)" },
            radius_km: { type: "string", description: "Search radius in km (default 10)" },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.travel_tool_call",
        message: "geocode_search invoked",
        meta: { tool: "geocode_search" },
      })

      try {
        if (args.near_lat && args.near_lon) {
          const radiusKm = args.radius_km ? parseFloat(args.radius_km) : undefined
          const data = await searchPOI(
            args.query,
            parseFloat(args.near_lat),
            parseFloat(args.near_lon),
            radiusKm,
          )
          return JSON.stringify(data, null, 2)
        }

        const data = await geocode(args.query)
        return JSON.stringify(data, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: callers throw Error instances @preserve */
        return `Geocode error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["query"],
  },
]
