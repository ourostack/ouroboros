import type { ToolDefinition, ToolContext } from "./tools-base"
import { createStripeClient, type StripeClient } from "./stripe-client"
import { emitNervesEvent } from "../nerves/runtime"

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
    return "no friend context — cannot access payment tools."
  }
  if (ctx.context.friend.trustLevel !== "family") {
    return "payment tools require family trust level."
  }
  return { friendId: ctx.context.friend.id }
}

export const stripeToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "stripe_create_card",
        description:
          "Create a virtual card for a transaction. Returns card ID and last 4 digits (never the full card number). Requires family trust level.",
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
              description: "Comma-separated allowed merchant categories (optional)",
            },
          },
          required: ["type", "spend_limit", "currency"],
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
        const client = await getStripeClient()
        const categories = args.merchant_categories
          ? args.merchant_categories.split(",").map((c: string) => c.trim())
          : undefined

        const card = await client.createVirtualCard({
          type: args.type as "single_use" | "persistent",
          spendLimit: parseFloat(args.spend_limit),
          currency: args.currency,
          merchantCategories: categories,
        })

        return JSON.stringify({
          cardId: card.cardId,
          last4: card.last4,
          status: card.status,
          spendLimit: args.spend_limit,
        })
      } catch (err) {
        /* v8 ignore next -- defensive: Stripe errors are always Error instances @preserve */
        return `card creation error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["type", "spend_limit", "currency"],
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
        return `card deactivation error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["card_id"],
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
        return `card listing error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: [],
  },
]

/** Reset the Stripe client singleton (for testing). */
export function resetStripeClient(): void {
  _stripeClient = null
}
