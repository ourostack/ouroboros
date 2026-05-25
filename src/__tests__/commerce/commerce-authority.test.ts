import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import {
  commerceAuthorityToken,
  confirmCommercePreview,
  createCommercePreview,
  readCommerceAccessLog,
  readCommerceRecord,
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

  it("covers commerce store validation and readback failures", () => {
    tmp = createTmpBundle({ agentName: "commerce-store-errors" })
    expect(() => createCommercePreview({
      agentRoot: tmp!.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 0,
      currency: "usd",
      reason: "Invalid amount",
    })).toThrow("positive number")
    expect(() => createCommercePreview({
      agentRoot: tmp!.agentRoot,
      friendId: "family-1",
      merchant: " ",
      amount: 1,
      currency: "usd",
      reason: "Invalid merchant",
    })).toThrow("merchant")
    expect(() => createCommercePreview({
      agentRoot: tmp!.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 1,
      currency: " ",
      reason: "Invalid currency",
    })).toThrow("currency")
    expect(() => createCommercePreview({
      agentRoot: tmp!.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 1,
      currency: "usd",
      reason: " ",
    })).toThrow("reason")
    expect(readCommerceRecord(tmp.agentRoot, "missing")).toBeNull()
    expect(readCommerceAccessLog(path.join(tmp.agentRoot, "fresh"), 5)).toEqual([])

    const withItems = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Store",
      items: [{ name: " Widget ", quantity: 2, amount: 12.345 }, { name: "Service" }],
      amount: 24.69,
      currency: "USD",
      reason: "Custom items",
    })
    expect(withItems.items[0]).toEqual({ name: "Widget", quantity: 2, amount: 12.35 })
    expect(withItems.items[1]).toEqual({ name: "Service" })

    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-2",
    })).toThrow("different friend")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: "bad-digest",
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })).toThrow("digest mismatch")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "almost",
      friendId: "family-1",
    })).toThrow("CONFIRM_PURCHASE")

    const previewToken = commerceAuthorityToken(withItems)
    const previewValidation = validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: previewToken,
      toolName: "stripe_create_card",
    })
    expect(previewValidation.ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: undefined,
      toolName: "stripe_create_card",
    })).toEqual({ ok: false, reason: "missing commerce_authority token" })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: "not-a-token",
      toolName: "stripe_create_card",
    })).toEqual({ ok: false, reason: "invalid commerce_authority token format" })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: `commerce:missing:${"0".repeat(64)}`,
      toolName: "stripe_create_card",
    })).toEqual({ ok: false, reason: "commerce checkout not found" })

    const confirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: {},
    }).ok).toBe(true)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "bogus" },
    }).ok).toBe(true)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: `commerce:${confirmed.id}:${"0".repeat(64)}`,
      toolName: "stripe_create_card",
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "24.69", currency: "eur" },
    }).ok).toBe(false)

    const recordPath = path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${confirmed.id}.json`)
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: confirmed.id,
      digest: confirmed.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })).toThrow("not previewed")
    fs.writeFileSync(recordPath, `${JSON.stringify({
      ...confirmed,
      status: "previewed",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }, null, 2)}\n`, "utf-8")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: confirmed.id,
      digest: confirmed.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })).toThrow("preview has expired")
    fs.writeFileSync(recordPath, `${JSON.stringify({
      ...confirmed,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
    }).ok).toBe(false)
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
    const noAgentRoot = guardInvocation("stripe_create_card", { commerce_authority: confirmed.authorityToken! }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(noAgentRoot.allowed).toBe(false)
    expect(noAgentRoot.reason).toContain("agent root")

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
      items_json: JSON.stringify([{ name: "Flight", quantity: 1, amount: 250 }]),
      expires_minutes: "10",
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
    const defaultLog = JSON.parse(await commerceTool("commerce_access_log")({ limit: "nan" }, ctx))
    expect(defaultLog.length).toBeGreaterThan(0)
    const implicitDefaultLog = JSON.parse(await commerceTool("commerce_access_log")({}, ctx))
    expect(implicitDefaultLog.length).toBeGreaterThan(0)

    const minimalPreviewRaw = await commerceTool("commerce_checkout_preview")({
      merchant: "Minimal",
      amount: "15",
      currency: "usd",
      reason: "Default item and expiry",
    }, ctx)
    const minimalPreview = JSON.parse(minimalPreviewRaw)
    expect(minimalPreview.checkoutId).toBeTruthy()

    const itemOnlyPreviewRaw = await commerceTool("commerce_checkout_preview")({
      merchant: "Item Only",
      amount: "15",
      currency: "usd",
      reason: "Optional item fields",
      items_json: JSON.stringify([{ name: "Service" }]),
    }, ctx)
    const itemOnlyPreview = JSON.parse(itemOnlyPreviewRaw)
    expect(itemOnlyPreview.checkoutId).toBeTruthy()
  })

  it("commerce tools report guard and parser errors", async () => {
    tmp = createTmpBundle({ agentName: "commerce-tool-errors" })
    const family = familyContext(tmp.agentRoot)
    const friend = familyContext(tmp.agentRoot)
    friend.context!.friend!.trustLevel = "friend"

    expect(await commerceTool("commerce_checkout_preview")({}, undefined)).toContain("no friend context")
    expect(await commerceTool("commerce_checkout_preview")({}, friend)).toContain("family trust")
    expect(await commerceTool("commerce_checkout_commit")({}, friend)).toContain("family trust")
    expect(await commerceTool("commerce_receipt_get")({}, friend)).toContain("family trust")
    expect(await commerceTool("commerce_access_log")({}, friend)).toContain("family trust")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      reason: "Bad items",
      items_json: "{}",
    }, family)).toContain("items_json must be a JSON array")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      reason: "Bad item",
      items_json: JSON.stringify([null]),
    }, family)).toContain("each item must be an object")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      reason: "Bad item name",
      items_json: JSON.stringify([{ quantity: 1 }]),
    }, family)).toContain("each item needs a name")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      reason: "Bad expiry",
      expires_minutes: "0",
    }, family)).toContain("expires_minutes must be a positive integer")
    expect(await commerceTool("commerce_checkout_commit")({
      checkout_id: "missing",
      digest: "digest",
      confirmation: "CONFIRM_PURCHASE",
    }, family)).toContain("commerce commit error")
    expect(await commerceTool("commerce_receipt_get")({ checkout_id: "missing" }, family)).toContain("not found")
  })
})
