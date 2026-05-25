import { afterEach, describe, expect, it } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import {
  confirmCommercePreview,
  createCommercePreview,
  readCommerceAccessLog,
  validateCommerceAuthorityToken,
} from "../../commerce/store"
import { guardInvocation } from "../../repertoire/guardrails"
import { commerceToolDefinitions } from "../../repertoire/tools-commerce"
import type { ToolContext } from "../../repertoire/tools-base"
import type { FriendRecord } from "../../mind/friends/types"

let tmp: TmpBundleHandle | null = null

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

function commerceTool(name: string) {
  const def = commerceToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing commerce tool ${name}`)
  return def.handler
}

function familyContext(agentRoot: string): ToolContext {
  const friend: FriendRecord = {
    id: "family-1",
    name: "Family",
    trustLevel: "family",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  }
  return {
    signin: async () => undefined,
    agentRoot,
    context: {
      friend,
      channel: {
        channel: "cli",
        senseType: "local",
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    },
  }
}

describe("commerce authority", () => {
  it("creates, confirms, validates, and logs a commerce mandate", () => {
    tmp = createTmpBundle({ agentName: "commerce-store" })
    const preview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 320.5,
      currency: "USD",
      reason: "Book approved flight",
    })
    const confirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: preview.id,
      digest: preview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })
    expect(confirmed.authorityToken).toMatch(/^commerce:/)

    const valid = validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { amount: "320.50", currency: "usd" },
    })
    expect(valid.ok).toBe(true)

    const invalid = validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { amount: "999", currency: "usd" },
    })
    expect(invalid.ok).toBe(false)

    expect(readCommerceAccessLog(tmp.agentRoot, 10).length).toBeGreaterThanOrEqual(4)
  })

  it("blocks money-moving tools without authority and allows matching authority", () => {
    tmp = createTmpBundle({ agentName: "commerce-guard" })
    const preview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Stripe",
      amount: 100,
      currency: "usd",
      reason: "Virtual card for approved purchase",
    })
    const confirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: preview.id,
      digest: preview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })

    const blocked = guardInvocation("stripe_create_card", { spend_limit: "100", currency: "usd" }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
    })
    expect(blocked.allowed).toBe(false)

    const allowed = guardInvocation("stripe_create_card", {
      spend_limit: "100",
      currency: "usd",
      commerce_authority: confirmed.authorityToken!,
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
    })
    expect(allowed.allowed).toBe(true)
  })

  it("commerce tools run the preview/commit/read/log flow", async () => {
    tmp = createTmpBundle({ agentName: "commerce-tools" })
    const ctx = familyContext(tmp.agentRoot)

    const previewRaw = await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "250",
      currency: "usd",
      reason: "Book selected flight",
    }, ctx)
    const preview = JSON.parse(previewRaw)
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)

    const committedRaw = await commerceTool("commerce_checkout_commit")({
      checkout_id: preview.checkoutId,
      digest: preview.digest,
      confirmation: "CONFIRM_PURCHASE",
    }, ctx)
    const committed = JSON.parse(committedRaw)
    expect(committed.authorityToken).toMatch(/^commerce:/)

    const receipt = JSON.parse(await commerceTool("commerce_receipt_get")({ checkout_id: preview.checkoutId }, ctx))
    expect(receipt.status).toBe("confirmed")

    const log = JSON.parse(await commerceTool("commerce_access_log")({ limit: "10" }, ctx))
    expect(log.length).toBeGreaterThan(0)
  })
})

