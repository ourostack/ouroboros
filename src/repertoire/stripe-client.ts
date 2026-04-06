/**
 * Thin wrapper around the Stripe Issuing API.
 *
 * Initializes with a restricted API key from the agent's vault.
 * Card numbers are NEVER included in nerves events or log output.
 * The `getCardDetails` method exists only for internal payment flows
 * (e.g., passing card details to Duffel) — the returned data must
 * never escape the calling function's scope.
 */

import StripeConstructor from "stripe"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardCreateOptions {
  type: "single_use" | "persistent"
  spendLimit: number
  currency: string
  merchantCategories?: string[]
}

export interface CardInfo {
  cardId: string
  last4: string
  status: string
}

export interface CardDetails {
  cardId: string
  number: string
  cvc: string
  expMonth: number
  expYear: number
}

export interface StripeClient {
  createVirtualCard(opts: CardCreateOptions): Promise<CardInfo>
  getCard(cardId: string): Promise<CardInfo>
  updateCard(cardId: string, updates: Record<string, unknown>): Promise<CardInfo>
  deactivateCard(cardId: string): Promise<CardInfo>
  listCards(): Promise<CardInfo[]>
  getCardDetails(cardId: string): Promise<CardDetails>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function toCardInfo(card: { id: string; last4: string; status: string }): CardInfo {
  return {
    cardId: card.id,
    last4: card.last4,
    status: card.status,
  }
}

/**
 * Create a Stripe client initialized with a restricted key from the vault.
 */
export async function createStripeClient(): Promise<StripeClient> {
  const store = getCredentialStore()
  const apiKey = await store.getRawSecret("stripe.com", "restrictedKey")
  // StripeConstructor is a callable (not a class), cast the result
  const stripe = StripeConstructor(apiKey) as ReturnType<typeof StripeConstructor>

  return {
    async createVirtualCard(opts: CardCreateOptions): Promise<CardInfo> {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_card_create_start",
        message: "creating virtual card",
        meta: { type: opts.type, currency: opts.currency },
      })

      const spendingControls = {
        spending_limits: [
          {
            amount: opts.spendLimit * 100, // Stripe uses cents
            interval: opts.type === "single_use" ? "all_time" as const : "monthly" as const,
          },
        ],
        ...(opts.merchantCategories
          ? { allowed_categories: opts.merchantCategories }
          : {}),
      }

      const card = await stripe.issuing.cards.create({
        type: "virtual",
        currency: opts.currency,
        spending_controls: spendingControls as any,
        status: "active",
      })

      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_card_create_end",
        message: "virtual card created",
        meta: { cardId: card.id, last4: card.last4 },
      })

      return toCardInfo(card)
    },

    async getCard(cardId: string): Promise<CardInfo> {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_card_get",
        message: "retrieving card info",
        meta: { cardId },
      })

      const card = await stripe.issuing.cards.retrieve(cardId)
      return toCardInfo(card)
    },

    async updateCard(cardId: string, updates: Record<string, unknown>): Promise<CardInfo> {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_card_update",
        message: "updating card",
        meta: { cardId },
      })

      const card = await stripe.issuing.cards.update(cardId, updates as any)
      return toCardInfo(card)
    },

    async deactivateCard(cardId: string): Promise<CardInfo> {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_card_deactivate",
        message: "deactivating card",
        meta: { cardId },
      })

      const card = await stripe.issuing.cards.update(cardId, { status: "canceled" })
      return toCardInfo(card)
    },

    async listCards(): Promise<CardInfo[]> {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_cards_list",
        message: "listing cards",
        meta: {},
      })

      const result = await stripe.issuing.cards.list()
      return result.data.map(toCardInfo)
    },

    async getCardDetails(cardId: string): Promise<CardDetails> {
      // This method retrieves sensitive card details for payment flows.
      // The data must NEVER be logged, emitted, or returned to the model.
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.stripe_card_details_get",
        message: "retrieving card details for payment flow",
        meta: { cardId },
      })

      const card = await stripe.issuing.cards.retrieve(cardId, {
        expand: ["number", "cvc"],
      }) as any

      return {
        cardId: card.id,
        number: card.number,
        cvc: card.cvc,
        expMonth: card.exp_month,
        expYear: card.exp_year,
      }
    },
  }
}
