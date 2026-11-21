import { withCode, type ToolDefinition } from "./tools-base"
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

        return withCode("Please provide either a city name or lat/lon coordinates.", "missing-location")
      } catch (err) {
        /* v8 ignore next -- defensive: callers throw Error instances @preserve */
        return withCode(`Weather lookup error: ${err instanceof Error ? err.message : String(err)}`, "weather-lookup-failed")
      }
    },
    summaryKeys: ["city", "lat", "lon"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads public weather data" },
    ax: { id: "tool:weather_lookup", group: "turn-travel", when: "Pick this for conditions at one place right now and today's high and low, such as what to wear; it has no later forecast.", effect: "read", errors: [
      { code: "guardrail-blocked", means: "The person asking isn't a trusted friend, so the weather lookup didn't run.", fix: "Tell them a trusted friend of the agent has to ask; don't call it again in this conversation." },
      { code: "missing-location", means: "Neither city nor both lat and lon were given, so nothing was looked up.", fix: "Call again with city, or with lat and lon together (geocode_search finds them)." },
      { code: "weather-lookup-failed", means: "The weather service failed or found no such city; the text before the code says which.", fix: "Check the city's spelling or pass lat and lon from geocode_search, then call again." },
    ] },
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
              description: "ISO 3166 alpha-2 country code (e.g. 'US', 'FR', 'AF')",
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
        return withCode(`Travel advisory error: ${err instanceof Error ? err.message : String(err)}`, "advisory-lookup-failed")
      }
    },
    summaryKeys: ["country_code"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads a public travel advisory" },
    ax: { id: "tool:travel_advisory", group: "turn-travel", when: "Pick this to check how risky a country is to visit before suggesting or booking a trip there.", effect: "read", errors: [
      { code: "advisory-lookup-failed", means: "The advisory service failed, or has no advisory for that code; the text before the code says which.", fix: "If no advisory was found, pass a two-letter ISO code such as FR or JP, not a name; if the service failed, say it's unavailable." },
      { code: "guardrail-blocked", means: "The person asking isn't a trusted friend, so no advisory was looked up.", fix: "Tell them a trusted friend of the agent has to ask; don't retry the advisory in this conversation." },
    ] },
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
        return withCode(`Geocode error: ${err instanceof Error ? err.message : String(err)}`, "geocode-failed")
      }
    },
    summaryKeys: ["query"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads public map data" },
    ax: { id: "tool:geocode_search", group: "turn-travel", when: "Pick this to turn a place or address into coordinates, or to find places near a point, before weather_lookup or advice on getting around.", effect: "read", errors: [
      { code: "geocode-failed", means: "The map service failed to answer; the text before the code says how.", fix: "Wait a moment and call again, or shorten the query to a place name and city." },
      { code: "guardrail-blocked", means: "The person asking isn't a trusted friend, so no place was searched.", fix: "Tell them a trusted friend of the agent has to ask; don't search again in this conversation." },
    ] },
  },
]
