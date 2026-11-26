import { withCode, type ToolDefinition, type ToolContext, type ToolErrorCard } from "./tools-base"
import { createStripeClient, type StripeClient } from "./stripe-client"
import { emitNervesEvent } from "../nerves/runtime"
import { consumeReservedCommerceAuthority, markReservedCommerceAuthorityAttempted } from "../commerce/store"

// Lazy-initialized Stripe client singleton
let _stripeClient: StripeClient | null = null
async function getStripeClient(): Promise<StripeClient> {
  if (!_stripeClient) {
    _stripeClient = await createStripeClient()
  }
  return _stripeClient
}

function requireFamilyContext(ctx?: ToolContext): { friendId: string } | string {
  if (!ctx?.context?.friend?.id) {
    return withCode("no friend context — cannot access payment tools.", "no-friend-context")
  }
  if (ctx.context.friend.trustLevel !== "family") {
    return withCode("payment tools require family trust level.", "family-required")
  }
  return { friendId: ctx.context.friend.id }
}

function parseExactSpendLimit(raw: string): number {
  const value = raw.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("spend_limit must be an exact decimal with at most two places")
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

const NO_FRIEND_ERROR: ToolErrorCard = { code: "no-friend-context", means: "This call came from outside any conversation with a known person, so there is nobody to act for.", fix: "Use this tool only inside a conversation with the person you are acting for." }
const FAMILY_REQUIRED_ERROR: ToolErrorCard = { code: "family-required", means: "The person in this conversation isn't family, and only family may spend or change bookings.", fix: "Don't retry; tell the person a family member has to ask for this." }
const GUARDRAIL_ERROR: ToolErrorCard = { code: "guardrail-blocked", means: "The trust guardrail stopped the call before it ran, because this person may not use it.", fix: "Don't retry here; say what you can't do and leave it to someone with the trust it needs." }
const AUTHORITY_REQUIRED_ERROR: ToolErrorCard = { code: "commerce-authority-required", means: "No confirmed checkout matches this call's merchant, tool, amount, currency and constraints.", fix: "Run commerce_checkout_preview for exactly this call, get the person's confirmation, then commerce_checkout_commit." }
const ATTEMPT_REJECTED_ERROR: ToolErrorCard = { code: "commerce-attempt-rejected", means: "The confirmed checkout couldn't be marked as in use, so nothing was sent to the provider.", fix: "Open the checkout with commerce_receipt_get to see its status, and start a new preview if it has expired or been used." }
const CONSUME_REJECTED_ERROR: ToolErrorCard = { code: "commerce-consume-rejected", means: "The provider call went through, but the checkout couldn't be marked used afterwards.", fix: "Tell the person what went through, and check the checkout with commerce_receipt_get before any retry." }

export const stripeToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "stripe_create_card",
        description:
          "Create a virtual card for an approved transaction. Returns card ID and last 4 digits (not the full card number). Requires family trust level and a matching confirmed commerce checkout.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["single_use", "persistent"],
              description: "Card type: single_use (one transaction) or persistent (recurring)",
            },
            spend_limit: {
              type: "string",
              description: "Maximum spend limit in dollars (e.g. '500')",
            },
            currency: {
              type: "string",
              description: "Currency code (e.g. 'usd')",
            },
            merchant_categories: {
              type: "string",
              description: "Comma-separated allowed merchant categories from the confirmed commerce constraints.",
            },
            commerce_authority: {
              type: "string",
              description: "Optional explicit authority token for external/manual flows; normally omit so Ouro consumes the matching confirmed checkout without exposing a bearer token.",
            },
          },
          required: ["type", "spend_limit", "currency", "merchant_categories"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_stripe_create_card",
        message: "stripe_create_card invoked",
        meta: { tool: "stripe_create_card" },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const categories = args.merchant_categories.split(",").map((c: string) => c.trim()).filter(Boolean)
        if (categories.length === 0) throw new Error("merchant_categories is required")
        const spendLimit = parseExactSpendLimit(args.spend_limit)
        const attemptError = markCommerceAttempted(ctx, "stripe_create_card")
        if (attemptError) return attemptError

        const client = await getStripeClient()
        const card = await client.createVirtualCard({
          type: args.type as "single_use" | "persistent",
          spendLimit,
          currency: args.currency,
          merchantCategories: categories,
        })

        const consumeError = consumeReservedCommerce(ctx, "stripe_create_card")
        if (consumeError) return consumeError

        return JSON.stringify({
          cardId: card.cardId,
          last4: card.last4,
          status: card.status,
          spendLimit: args.spend_limit,
        })
      } catch (err) {
        /* v8 ignore next -- defensive: Stripe errors are always Error instances @preserve */
        return withCode(`card creation error: ${err instanceof Error ? err.message : String(err)}`, "card-creation-failed")
      }
    },
    summaryKeys: ["type", "spend_limit", "currency"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "creates a virtual payment card" },
    ax: { id: "tool:stripe_create_card", group: "turn-payments", when: "Pick this to make a single-use or capped virtual card for one confirmed purchase, after commerce_checkout_commit.", effect: "write", errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR, AUTHORITY_REQUIRED_ERROR, ATTEMPT_REJECTED_ERROR, CONSUME_REJECTED_ERROR,
      { code: "card-creation-failed", means: "Stripe refused or lost the request; the text gives its reason, and the checkout stays marked in use.", fix: "Call stripe_list_cards to see whether a card was made before trying again with a new checkout." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "stripe_deactivate_card",
        description:
          "Deactivate (cancel) a virtual card. Use after a transaction is complete or to revoke access. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {
            card_id: {
              type: "string",
              description: "The Stripe card ID to deactivate (e.g. 'ic_...')",
            },
          },
          required: ["card_id"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_stripe_deactivate_card",
        message: "stripe_deactivate_card invoked",
        meta: { tool: "stripe_deactivate_card", cardId: args.card_id },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const client = await getStripeClient()
        const card = await client.deactivateCard(args.card_id)
        return JSON.stringify({
          cardId: card.cardId,
          last4: card.last4,
          status: card.status,
        })
      } catch (err) {
        /* v8 ignore next -- defensive: Stripe errors are always Error instances @preserve */
        return withCode(`card deactivation error: ${err instanceof Error ? err.message : String(err)}`, "card-deactivation-failed")
      }
    },
    summaryKeys: ["card_id"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "deactivates a virtual payment card" },
    ax: { id: "tool:stripe_deactivate_card", group: "turn-payments", when: "Pick this to switch off a virtual card that is spent or no longer wanted, so nothing more can be charged to it.", effect: "write", idempotent: true, errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR,
      { code: "card-deactivation-failed", means: "Stripe couldn't switch the card off; the text gives its reason.", fix: "Check the card id against stripe_list_cards, then try again with the right one." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "stripe_list_cards",
        description:
          "List all active virtual cards. Shows card IDs and last 4 digits only. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async (_args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_stripe_list_cards",
        message: "stripe_list_cards invoked",
        meta: { tool: "stripe_list_cards" },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const client = await getStripeClient()
        const cards = await client.listCards()
        if (cards.length === 0) {
          return "no active cards."
        }
        return JSON.stringify(cards.map((c) => ({
          cardId: c.cardId,
          last4: c.last4,
          status: c.status,
        })))
      } catch (err) {
        /* v8 ignore next -- defensive: Stripe errors are always Error instances @preserve */
        return withCode(`card listing error: ${err instanceof Error ? err.message : String(err)}`, "card-listing-failed")
      }
    },
    summaryKeys: [],
    riskProfile: { mutates: "none", risk: "low", reason: "lists active virtual cards" },
    ax: { id: "tool:stripe_list_cards", group: "turn-payments", when: "Pick this to see which virtual cards are still active and their limits, before making a new one or switching one off.", effect: "read", idempotent: true, errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR,
      { code: "card-listing-failed", means: "Stripe couldn't be reached or refused the request; the text gives its reason.", fix: "Try once more; if it still fails, tell the person card details are unavailable right now." },
    ] },
  },
]

/** Reset the Stripe client singleton (for testing). */
export function resetStripeClient(): void {
  _stripeClient = null
}
