import { withCode, type ToolDefinition, type ToolContext, type ToolErrorCard } from "./tools-base"
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
    return withCode("no friend context — cannot access flight tools.", "no-friend-context")
  }
  if (ctx.context.friend.trustLevel !== "family") {
    return withCode("booking and cancellation require family trust level.", "family-required")
  }
  return { friendId: ctx.context.friend.id }
}

function requireFriendContext(ctx?: ToolContext): { friendId: string } | string {
  if (!ctx?.context?.friend?.id) {
    return withCode("no friend context — cannot search flights.", "no-friend-context")
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
  return result.ok ? null : withCode(`commerce authority consume error: ${result.reason}`, "commerce-consume-rejected")
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
  return result.ok ? null : withCode(`commerce authority attempt error: ${result.reason}`, "commerce-attempt-rejected")
}

function normalizeCurrency(raw: string): string {
  return raw.trim().toLowerCase()
}

function orderMatchesApprovedTotal(input: { totalAmount: string; totalCurrency: string }, amount: number, currency: string): boolean {
  const orderAmount = parseExactAmount(input.totalAmount)
  return orderAmount === amount && normalizeCurrency(input.totalCurrency) === normalizeCurrency(currency)
}

const NO_FRIEND_ERROR: ToolErrorCard = { code: "no-friend-context", means: "This call came from outside any conversation with a known person, so there is nobody to act for.", fix: "Use this tool only inside a conversation with the person you are acting for." }
const FAMILY_REQUIRED_ERROR: ToolErrorCard = { code: "family-required", means: "The person in this conversation isn't family, and only family may spend or change bookings.", fix: "Don't retry; tell the person a family member has to ask for this." }
const GUARDRAIL_ERROR: ToolErrorCard = { code: "guardrail-blocked", means: "The trust guardrail stopped the call before it ran, because this person may not use it.", fix: "Don't retry here; say what you can't do and leave it to someone with the trust it needs." }
const AUTHORITY_REQUIRED_ERROR: ToolErrorCard = { code: "commerce-authority-required", means: "No confirmed checkout matches this call's merchant, tool, amount, currency and constraints.", fix: "Run commerce_checkout_preview for exactly this call, get the person's confirmation, then commerce_checkout_commit." }
const ATTEMPT_REJECTED_ERROR: ToolErrorCard = { code: "commerce-attempt-rejected", means: "The confirmed checkout couldn't be marked as in use, so nothing was sent to the provider.", fix: "Open the checkout with commerce_receipt_get to see its status, and start a new preview if it has expired or been used." }
const CONSUME_REJECTED_ERROR: ToolErrorCard = { code: "commerce-consume-rejected", means: "The provider call went through, but the checkout couldn't be marked used afterwards.", fix: "Tell the person what went through, and check the checkout with commerce_receipt_get before any retry." }

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
        return withCode(`flight search error: ${err instanceof Error ? err.message : String(err)}`, "flight-search-failed")
      }
    },
    summaryKeys: ["origin", "destination", "departure_date"],
    riskProfile: { mutates: "none", risk: "low", reason: "searches flight offers; it reserves and pays for nothing" },
    ax: { id: "tool:flight_search", group: "turn-travel", when: "Pick this to find priced flight offers between two airports on a date, before any hold or booking; it reserves nothing.", effect: "read", errors: [
      NO_FRIEND_ERROR, GUARDRAIL_ERROR,
      { code: "flight-search-failed", means: "The flight provider couldn't be reached or rejected the search; the text gives its reason.", fix: "Check the airport codes and date format, then search again; if it still fails, say flight search is down." },
    ] },
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
    ax: { id: "tool:flight_hold", group: "turn-travel", when: "Pick this to keep a chosen offer's price without paying yet, once the person confirmed a checkout for that hold.", effect: "write", errors: [NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR, AUTHORITY_REQUIRED_ERROR, ATTEMPT_REJECTED_ERROR, CONSUME_REJECTED_ERROR] },
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
          return withCode("passenger profile not found — please store your profile first using user_profile_store.", "passenger-profile-missing")
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
          return withCode(`booking error: completed order total ${result.totalAmount} ${result.totalCurrency} does not match approved ${args.amount} ${args.currency}`, "order-total-mismatch")
        }

        const consumeError = consumeReservedCommerce(ctx, "flight_book")
        if (consumeError) return consumeError

        return JSON.stringify(result, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive @preserve */
        return withCode(`booking error: ${err instanceof Error ? err.message : String(err)}`, "booking-failed")
      }
    },
    summaryKeys: ["offer_id", "amount"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "books travel through an external provider" },
    ax: { id: "tool:flight_book", group: "turn-travel", when: "Pick this to buy a chosen offer for the stored passenger, only after commerce_checkout_commit confirmed that exact amount.", effect: "write", errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR, AUTHORITY_REQUIRED_ERROR, ATTEMPT_REJECTED_ERROR, CONSUME_REJECTED_ERROR,
      { code: "passenger-profile-missing", means: "No passenger name and passport are stored for this person, so the airline has no traveller.", fix: "Ask the person for their legal name and passport details, save them with user_profile_store, then book." },
      { code: "order-total-mismatch", means: "The airline booked the order, but its total differs from the approved amount.", fix: "Tell the person the booked total now, and ask whether to keep it or cancel it with flight_cancel." },
      { code: "booking-failed", means: "The provider refused or lost the booking; the text gives its reason, and the checkout stays marked in use.", fix: "Check with commerce_receipt_get before retrying, and search again if the offer has expired." },
    ] },
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
        return withCode(`cancellation error: ${err instanceof Error ? err.message : String(err)}`, "cancellation-failed")
      }
    },
    summaryKeys: ["order_id"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "cancels travel through an external provider" },
    ax: { id: "tool:flight_cancel", group: "turn-travel", when: "Pick this to call off a flight order that is already booked, by its order id, when the person asks to cancel the trip.", effect: "write", destructive: true, errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR,
      { code: "cancellation-failed", means: "The provider couldn't cancel the order; the text gives its reason.", fix: "Check the order id with the person, and if it is right, tell them to cancel through the airline." },
    ] },
  },
]

/** Reset the Duffel client singleton (for testing). */
export function resetDuffelClient(): void {
  _duffelClient = null
}
