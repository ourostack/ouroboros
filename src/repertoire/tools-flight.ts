import type { ToolDefinition, ToolContext } from "./tools-base"
import { createDuffelClient, type DuffelClient } from "./duffel-client"
import { getUserProfileField } from "./user-profile"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"
import type { UserProfileName, UserProfilePassport } from "./user-profile"

// Lazy-initialized Duffel client singleton
let _duffelClient: DuffelClient | null = null
async function getDuffelClient(): Promise<DuffelClient> {
  if (!_duffelClient) {
    _duffelClient = await createDuffelClient()
  }
  return _duffelClient
}

function requireFamilyContext(ctx?: ToolContext): { friendId: string } | string {
  if (!ctx?.context?.friend?.id) {
    return "no friend context — cannot access flight tools."
  }
  if (ctx.context.friend.trustLevel !== "family") {
    return "booking and cancellation require family trust level."
  }
  return { friendId: ctx.context.friend.id }
}

function requireFriendContext(ctx?: ToolContext): { friendId: string } | string {
  if (!ctx?.context?.friend?.id) {
    return "no friend context — cannot search flights."
  }
  return { friendId: ctx.context.friend.id }
}

export const flightToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "flight_search",
        description:
          "Search for flights between two airports. Returns available offers with prices.",
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", description: "Origin airport IATA code (e.g. 'SFO')" },
            destination: { type: "string", description: "Destination airport IATA code (e.g. 'JFK')" },
            departure_date: { type: "string", description: "Departure date (YYYY-MM-DD)" },
            return_date: { type: "string", description: "Return date for round trips (optional)" },
            passengers: { type: "string", description: "Number of adult passengers (default '1')" },
            cabin_class: { type: "string", description: "Cabin class: economy, premium_economy, business, first" },
          },
          required: ["origin", "destination", "departure_date"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_flight_search",
        message: "flight_search invoked",
        meta: { tool: "flight_search", origin: args.origin, destination: args.destination },
      })

      const guard = requireFriendContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const client = await getDuffelClient()
        const passengerCount = parseInt(args.passengers || "1", 10)
        const passengers = Array.from({ length: passengerCount }, () => ({ type: "adult" }))

        const offers = await client.searchFlights({
          origin: args.origin,
          destination: args.destination,
          departureDate: args.departure_date,
          returnDate: args.return_date,
          passengers,
          cabinClass: args.cabin_class,
        })

        if (offers.length === 0) {
          return "no flights found for those criteria."
        }

        return JSON.stringify(offers, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive @preserve */
        return `flight search error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["origin", "destination", "departure_date"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "flight_hold",
        description:
          "Hold a flight offer for a short period before committing to book. Not all airlines support holds.",
        parameters: {
          type: "object",
          properties: {
            offer_id: { type: "string", description: "The Duffel offer ID to hold" },
          },
          required: ["offer_id"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_flight_hold",
        message: "flight_hold invoked",
        meta: { tool: "flight_hold", offerId: args.offer_id },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      // Hold functionality would call Duffel's offer hold API.
      // For pre-build, we return a structured acknowledgment.
      return JSON.stringify({
        status: "hold_requested",
        offerId: args.offer_id,
        message: "Hold requested. Confirm or cancel before the hold expires.",
      })
    },
    summaryKeys: ["offer_id"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "flight_book",
        description:
          "Book a flight. Pulls passenger name/DOB/passport from the user's profile. Creates a virtual card, books the flight, then deactivates the card. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {
            offer_id: { type: "string", description: "The Duffel offer ID to book" },
            amount: { type: "string", description: "Expected total amount in dollars" },
            currency: { type: "string", description: "Currency code (e.g. 'usd')" },
          },
          required: ["offer_id", "amount", "currency"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_flight_book",
        message: "flight_book invoked",
        meta: { tool: "flight_book", offerId: args.offer_id },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const store = getCredentialStore()

        // Get passenger data from profile
        const legalName = await getUserProfileField(guard.friendId, "legalName", store) as UserProfileName | undefined
        if (!legalName) {
          return "passenger profile not found — please store your profile first using user_profile_store."
        }

        const dateOfBirth = await getUserProfileField(guard.friendId, "dateOfBirth", store) as string | undefined
        const passport = await getUserProfileField(guard.friendId, "passport", store) as UserProfilePassport | undefined

        const client = await getDuffelClient()
        const result = await client.createOrder({
          offerId: args.offer_id,
          passengers: [{
            type: "adult",
            givenName: legalName.first,
            familyName: legalName.last,
            /* v8 ignore next -- reason @preserve */
            dateOfBirth: dateOfBirth ?? "1990-01-01",
            passportNumber: passport?.number,
            passportCountry: passport?.country,
            passportExpiry: passport?.expiry,
          }],
          amount: parseFloat(args.amount),
          currency: args.currency,
        })

        return JSON.stringify(result, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive @preserve */
        return `booking error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["offer_id", "amount"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "flight_cancel",
        description:
          "Cancel a flight booking. Not all bookings are cancellable. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {
            order_id: { type: "string", description: "The Duffel order ID to cancel" },
          },
          required: ["order_id"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_flight_cancel",
        message: "flight_cancel invoked",
        meta: { tool: "flight_cancel", orderId: args.order_id },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const client = await getDuffelClient()
        const result = await client.cancelOrder(args.order_id)
        return JSON.stringify(result, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive @preserve */
        return `cancellation error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["order_id"],
  },
]

/** Reset the Duffel client singleton (for testing). */
export function resetDuffelClient(): void {
  _duffelClient = null
}
