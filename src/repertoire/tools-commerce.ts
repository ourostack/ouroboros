import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import {
  commerceConfirmationMessage,
  confirmCommercePreview,
  createCommercePreview,
  readCommerceAccessLog,
  readCommerceRecord,
} from "../commerce/store"
import type { CommerceMandateItem } from "../commerce/types"
import type { ToolContext, ToolDefinition } from "./tools-base"

function requireFamilyContext(ctx?: ToolContext): { friendId: string; agentRoot: string } | string {
  if (!ctx?.context?.friend?.id) return "no friend context — cannot use commerce tools."
  if (ctx.context.friend.trustLevel !== "family") return "commerce tools require family trust level."
  /* v8 ignore next -- no-agentRoot fallback depends on process argv; normal tool calls inject agentRoot @preserve */
  if (ctx.agentRoot) return { friendId: ctx.context.friend.id, agentRoot: ctx.agentRoot }
  return { friendId: ctx.context.friend.id, agentRoot: getAgentRoot() }
}

function parseItems(raw: string | undefined): CommerceMandateItem[] | undefined {
  if (!raw?.trim()) return undefined
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error("items_json must be a JSON array")
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("each item must be an object")
    const record = item as Record<string, unknown>
    if (typeof record.name !== "string" || !record.name.trim()) throw new Error("each item needs a name")
    return {
      name: record.name,
      ...(typeof record.quantity === "number" ? { quantity: record.quantity } : {}),
      ...(typeof record.amount === "number" ? { amount: record.amount } : {}),
    }
  })
}

function parseExpiryMinutes(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value <= 0) throw new Error("expires_minutes must be a positive integer")
  return value
}

function parseToolName(raw: string | undefined): string {
  const toolName = raw?.trim()
  if (!toolName) throw new Error("tool_name is required")
  return toolName
}

function parseConstraints(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("constraints_json must be a JSON object")
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
}

export const commerceToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "commerce_checkout_preview",
        description: "Create an AP2-compatible local checkout preview before any payment or booking action. Requires family trust.",
        parameters: {
          type: "object",
          properties: {
            merchant: { type: "string", description: "Merchant, provider, or counterparty name." },
            amount: { type: "string", description: "Exact total amount." },
            currency: { type: "string", description: "Currency code, e.g. usd." },
            tool_name: { type: "string", description: "Exact tool this authority may be used with, e.g. stripe_create_card, flight_hold, or flight_book." },
            constraints_json: { type: "string", description: "Optional JSON object of exact tool-argument constraints, e.g. {\"offer_id\":\"off_123\"}." },
            reason: { type: "string", description: "Why this purchase/booking is being made." },
            items_json: { type: "string", description: "Optional JSON array of {name, quantity, amount} items." },
            expires_minutes: { type: "string", description: "Optional expiry window in minutes; defaults to 30." },
          },
          required: ["merchant", "amount", "currency", "tool_name", "reason"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_commerce_checkout_preview",
        message: "commerce_checkout_preview invoked",
        meta: { tool: "commerce_checkout_preview", merchant: args.merchant },
      })
      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard
      try {
        const expiresInMinutes = parseExpiryMinutes(args.expires_minutes)
        const toolName = parseToolName(args.tool_name)
        const record = createCommercePreview({
          agentRoot: guard.agentRoot,
          friendId: guard.friendId,
          merchant: args.merchant,
          amount: Number.parseFloat(args.amount),
          currency: args.currency,
          allowedTools: [toolName],
          constraints: parseConstraints(args.constraints_json),
          reason: args.reason,
          items: parseItems(args.items_json),
          ...(expiresInMinutes ? { expiresInMinutes } : {}),
	        })
	        const confirmationMessage = commerceConfirmationMessage(record)
	        return JSON.stringify({
	          checkoutId: record.id,
	          merchant: record.merchant,
	          amount: record.amount,
	          currency: record.currency,
	          allowedTools: record.allowedTools,
	          constraints: record.constraints,
	          expiresAt: record.expiresAt,
	          digest: record.digest,
	          confirmationMessage,
	          next: `Ask the family user to send the confirmationMessage exactly in a new turn after reviewing merchant, amount, currency, tool, and constraints; then call commerce_checkout_commit from that same turn.`,
	        }, null, 2)
      } catch (error) {
        return `commerce preview error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error parser failures */ String(error)}`
      }
    },
    summaryKeys: ["merchant", "amount", "currency"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates a purchase mandate preview" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "commerce_checkout_commit",
        description: "Confirm an exact checkout preview and return a commerce_authority token for the payment/booking tool. Requires family trust and confirmation=CONFIRM_PURCHASE.",
        parameters: {
          type: "object",
          properties: {
            checkout_id: { type: "string", description: "Checkout preview ID." },
            digest: { type: "string", description: "Digest returned by commerce_checkout_preview." },
            confirmation: { type: "string", description: "Must be CONFIRM_PURCHASE." },
          },
          required: ["checkout_id", "digest", "confirmation"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_commerce_checkout_commit",
        message: "commerce_checkout_commit invoked",
        meta: { tool: "commerce_checkout_commit", checkoutId: args.checkout_id },
      })
      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard
      try {
        const record = confirmCommercePreview({
          agentRoot: guard.agentRoot,
          checkoutId: args.checkout_id,
          digest: args.digest,
          confirmation: args.confirmation,
          friendId: guard.friendId,
          currentUserMessage: ctx?.currentUserMessage,
        })
        return JSON.stringify({
          checkoutId: record.id,
          status: record.status,
          authorityToken: record.authorityToken,
          expiresAt: record.expiresAt,
          use: "Pass this as commerce_authority to stripe_create_card, flight_hold, or flight_book.",
        }, null, 2)
      } catch (error) {
        return `commerce commit error: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error store failures */ String(error)}`
      }
    },
    summaryKeys: ["checkout_id"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "confirms a purchase mandate" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "commerce_receipt_get",
        description: "Read a local commerce checkout/mandate receipt. Requires family trust.",
        parameters: {
          type: "object",
          properties: {
            checkout_id: { type: "string", description: "Checkout ID." },
          },
          required: ["checkout_id"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_commerce_receipt_get",
        message: "commerce_receipt_get invoked",
        meta: { tool: "commerce_receipt_get", checkoutId: args.checkout_id },
      })
      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard
      const record = readCommerceRecord(guard.agentRoot, args.checkout_id)
      return record ? JSON.stringify(record, null, 2) : `commerce checkout not found: ${args.checkout_id}`
    },
    summaryKeys: ["checkout_id"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "commerce_access_log",
        description: "Read the commerce authority access log. Requires family trust.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "string", description: "Number of recent entries to return; defaults to 20." },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_commerce_access_log",
        message: "commerce_access_log invoked",
        meta: { tool: "commerce_access_log" },
      })
      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard
      const limit = args.limit ? Number.parseInt(args.limit, 10) : 20
      return JSON.stringify(readCommerceAccessLog(guard.agentRoot, Number.isInteger(limit) ? limit : 20), null, 2)
    },
    summaryKeys: ["limit"],
  },
]
