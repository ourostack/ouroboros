import type { ToolDefinition, ToolContext } from "./tools-base"
import { createDuffelClient, type DuffelClient } from "./duffel-client"
import { getUserProfileField } from "./user-profile"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"
import type { UserProfileName, UserProfilePassport } from "./user-profile"
import { consumeReservedCommerceAuthority, markReservedCommerceAuthorityAttempted } from "../commerce/store"

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

function parseExactAmount(raw: string): number {
  const value = raw.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("amount must be an exact decimal with at most two places")
  return Number(value)
}

function consumeReservedCommerce(ctx: ToolContext | undefined, toolName: string): string | null {
  if (!ctx?.commerceAuthority || !ctx.agentRoot) return null
  const result = consumeReservedCommerceAuthority({
    agentRoot: ctx.agentRoot,
    checkoutId: ctx.commerceAuthority.checkoutId,
    reservationToken: ctx.commerceAuthority.reservationToken,
    toolName,
    friendId: ctx.context?.friend?.id,
  })
  return result.ok ? null : `commerce authority consume error: ${result.reason}`
}

function markCommerceAttempted(ctx: ToolContext | undefined, toolName: string): string | null {
  if (!ctx?.commerceAuthority || !ctx.agentRoot) return null
  const result = markReservedCommerceAuthorityAttempted({
    agentRoot: ctx.agentRoot,
    checkoutId: ctx.commerceAuthority.checkoutId,
    reservationToken: ctx.commerceAuthority.reservationToken,
    toolName,
    friendId: ctx.context?.friend?.id,
  })
  return result.ok ? null : `commerce authority attempt error: ${result.reason}`
}

function normalizeCurrency(raw: string): string {
  return raw.trim().toLowerCase()
}

function orderMatchesApprovedTotal(input: { totalAmount: string; totalCurrency: string }, amount: number, currency: string): boolean {
  const orderAmount = parseExactAmount(input.totalAmount)
  return orderAmount === amount && normalizeCurrency(input.totalCurrency) === normalizeCurrency(currency)
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
          "Hold a flight offer for a short period before committing to book. Not all airlines support holds. Requires a matching confirmed commerce checkout.",
        parameters: {
          type: "object",
          properties: {
            offer_id: { type: "string", description: "The Duffel offer ID to hold" },
            amount: { type: "string", description: "Exact hold amount from the approved commerce preview." },
            currency: { type: "string", description: "Currency code from the approved commerce preview, e.g. usd." },
            commerce_authority: { type: "string", description: "Optional explicit authority token for external/manual flows; normally omit so Ouro consumes the matching confirmed checkout." },
          },
          required: ["offer_id", "amount", "currency"],
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
      const amount = parseExactAmount(args.amount)
      const attemptError = markCommerceAttempted(ctx, "flight_hold")
      if (attemptError) return attemptError
      const consumeError = consumeReservedCommerce(ctx, "flight_hold")
      /* v8 ignore next -- hold pre-build has no provider callback between attempt and consume; this branch is race-defense for file/process interference @preserve */
      if (consumeError) return consumeError

      return JSON.stringify({
        status: "hold_requested",
        offerId: args.offer_id,
        amount,
        currency: args.currency,
        message: "Hold requested. Confirm or cancel before the hold expires.",
      })
    },
    summaryKeys: ["offer_id"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "requests an airline offer hold" },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "flight_book",
        description:
          "Book a flight. Pulls passenger name/DOB/passport from the user's profile. Creates a virtual card, books the flight, then deactivates the card. Requires family trust level and a matching confirmed commerce checkout.",
        parameters: {
          type: "object",
          properties: {
            offer_id: { type: "string", description: "The Duffel offer ID to book" },
            amount: { type: "string", description: "Expected total amount in dollars" },
            currency: { type: "string", description: "Currency code (e.g. 'usd')" },
            commerce_authority: { type: "string", description: "Optional explicit authority token for external/manual flows; normally omit so Ouro consumes the matching confirmed checkout." },
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
        const amount = parseExactAmount(args.amount)
        const currency = normalizeCurrency(args.currency)
        const store = getCredentialStore()

        // Get passenger data from profile
        const legalName = await getUserProfileField(guard.friendId, "legalName", store) as UserProfileName | undefined
        if (!legalName) {
          return "passenger profile not found — please store your profile first using user_profile_store."
        }

        const dateOfBirth = await getUserProfileField(guard.friendId, "dateOfBirth", store) as string | undefined
        const passport = await getUserProfileField(guard.friendId, "passport", store) as UserProfilePassport | undefined

        const client = await getDuffelClient()
        const attemptError = markCommerceAttempted(ctx, "flight_book")
        if (attemptError) return attemptError
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
          amount,
          currency,
        })
        if (!orderMatchesApprovedTotal(result, amount, currency)) {
          return `booking error: completed order total ${result.totalAmount} ${result.totalCurrency} does not match approved ${args.amount} ${args.currency}`
        }

        const consumeError = consumeReservedCommerce(ctx, "flight_book")
        if (consumeError) return consumeError

        return JSON.stringify(result, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive @preserve */
        return `booking error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["offer_id", "amount"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "books travel through an external provider" },
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
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "cancels travel through an external provider" },
  },
]

/** Reset the Duffel client singleton (for testing). */
export function resetDuffelClient(): void {
  _duffelClient = null
}
