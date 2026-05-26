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

function confirmationMessage(record: { id: string; digest: string }): string {
  return `CONFIRM_PURCHASE checkout ${record.id} digest ${record.digest}`
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
      allowedTools: ["flight_book"],
      constraints: { offer_id: "offer-123" },
      reason: "Book approved flight",
    })
    const confirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: preview.id,
      digest: preview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(preview),
    })
    expect(confirmed.authorityToken).toMatch(/^commerce:/)

    const valid = validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-123", amount: "320.50", currency: "usd" },
      friendId: "family-1",
    })
    expect(valid.ok).toBe(true)

    const invalid = validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-123", amount: "999", currency: "usd" },
      friendId: "family-1",
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
    expect(() => createCommercePreview({
      agentRoot: tmp!.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 1,
      currency: "usd",
      reason: "Missing tool",
    })).toThrow("at least one allowed tool")
    expect(() => createCommercePreview({
      agentRoot: tmp!.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 1,
      currency: "usd",
      allowedTools: [" "],
      reason: "Blank tool",
    })).toThrow("allowed tool is required")
    expect(readCommerceRecord(tmp.agentRoot, "missing")).toBeNull()
    expect(readCommerceAccessLog(path.join(tmp.agentRoot, "fresh"), 5)).toEqual([])

    const withItems = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Store",
      items: [{ name: " Widget ", quantity: 2, amount: 12.345 }, { name: "Service" }],
      amount: 24.69,
      currency: "USD",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use" },
      reason: "Custom items",
    })
    expect(withItems.items[0]).toEqual({ name: "Widget", quantity: 2, amount: 12.35 })
    expect(withItems.items[1]).toEqual({ name: "Service" })

    const noConstraints = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "No Constraint Store",
      amount: 5,
      currency: "usd",
      allowedTools: ["custom_checkout"],
      reason: "No constraints path",
    })
    expect(noConstraints.constraints).toEqual({})

    const sortedConstraints = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Custom Checkout",
      amount: 10,
      currency: "usd",
      allowedTools: ["custom_checkout"],
      constraints: { zeta: "last", alpha: "first", " ": "ignored", blank: " " },
      reason: "Exercise exact custom constraints",
    })
    expect(Object.keys(sortedConstraints.constraints)).toEqual(["alpha", "zeta"])
    const sortedConfirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: sortedConstraints.id,
      digest: sortedConstraints.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(sortedConstraints),
    })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: sortedConfirmed.authorityToken,
      toolName: "custom_checkout",
      args: { alpha: "first", zeta: "last" },
      friendId: "family-1",
    }).ok).toBe(true)

    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-2",
      currentUserMessage: confirmationMessage(withItems),
    })).toThrow("different friend")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: "bad-digest",
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(withItems),
    })).toThrow("digest mismatch")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "almost",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(withItems),
    })).toThrow("CONFIRM_PURCHASE")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: "the model saw the preview but the human did not confirm",
    })).toThrow("current human message")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: withItems.id,
      digest: withItems.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
    })).toThrow("current human message")

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
      currentUserMessage: confirmationMessage(withItems),
    })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: {},
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "bogus" },
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-123", amount: "24.69", currency: "usd" },
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { type: "persistent", spend_limit: "24.69", currency: "usd" },
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69" },
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69", currency: "usd" },
      friendId: "family-2",
    }).ok).toBe(false)
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

    const legacyNoAllowedToolsId = "legacy-no-allowed-tools"
    const legacyNoAllowedToolsDigest = "1".repeat(64)
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${legacyNoAllowedToolsId}.json`), `${JSON.stringify({
      ...confirmed,
      id: legacyNoAllowedToolsId,
      digest: legacyNoAllowedToolsDigest,
      status: "confirmed",
      allowedTools: undefined,
      constraints: undefined,
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: `commerce:${legacyNoAllowedToolsId}:${legacyNoAllowedToolsDigest}`,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69", currency: "usd" },
    })).toEqual({ ok: false, reason: "tool is not allowed by commerce_authority" })

    const legacyNoConstraintsId = "legacy-no-constraints"
    const legacyNoConstraintsDigest = "2".repeat(64)
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${legacyNoConstraintsId}.json`), `${JSON.stringify({
      ...confirmed,
      id: legacyNoConstraintsId,
      digest: legacyNoConstraintsDigest,
      status: "confirmed",
      allowedTools: ["stripe_create_card"],
      constraints: undefined,
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: `commerce:${legacyNoConstraintsId}:${legacyNoConstraintsDigest}`,
      toolName: "stripe_create_card",
      args: { spend_limit: "24.69", currency: "usd" },
    })).toEqual({ ok: false, reason: "commerce_authority is missing required type constraint" })

    const holdPreview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 1,
      currency: "usd",
      allowedTools: ["flight_hold"],
      constraints: { offer_id: "hold-offer-1" },
      reason: "Hold selected offer",
    })
    const holdConfirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: holdPreview.id,
      digest: holdPreview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(holdPreview),
    })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: holdConfirmed.authorityToken,
      toolName: "flight_hold",
      args: { offer_id: "hold-offer-1" },
    }).ok).toBe(true)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: holdConfirmed.authorityToken,
      toolName: "flight_hold",
      args: { offer_id: "hold-offer-2" },
    }).ok).toBe(false)

    const recordPath = path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${confirmed.id}.json`)
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: confirmed.id,
      digest: confirmed.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(confirmed),
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
      currentUserMessage: confirmationMessage(confirmed),
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
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use" },
      reason: "Virtual card for approved purchase",
    })
    const confirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: preview.id,
      digest: preview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(preview),
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
      type: "single_use",
      commerce_authority: confirmed.authorityToken!,
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
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
      tool_name: "flight_book",
      constraints_json: JSON.stringify({ offer_id: "offer-250" }),
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
    }, { ...ctx, currentUserMessage: confirmationMessage({ id: preview.checkoutId, digest: preview.digest }) })
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
      tool_name: "stripe_create_card",
      constraints_json: JSON.stringify({ type: "single_use" }),
      reason: "Default item and expiry",
    }, ctx)
    const minimalPreview = JSON.parse(minimalPreviewRaw)
    expect(minimalPreview.checkoutId).toBeTruthy()

    const itemOnlyPreviewRaw = await commerceTool("commerce_checkout_preview")({
      merchant: "Item Only",
      amount: "15",
      currency: "usd",
      tool_name: "stripe_create_card",
      constraints_json: JSON.stringify({ type: "single_use" }),
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
      tool_name: "stripe_create_card",
      reason: "Bad items",
      items_json: "{}",
    }, family)).toContain("items_json must be a JSON array")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Bad item",
      items_json: JSON.stringify([null]),
    }, family)).toContain("each item must be an object")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Bad item name",
      items_json: JSON.stringify([{ quantity: 1 }]),
    }, family)).toContain("each item needs a name")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Bad expiry",
      expires_minutes: "0",
    }, family)).toContain("expires_minutes must be a positive integer")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      reason: "Missing tool",
    }, family)).toContain("tool_name is required")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Bad constraints",
      constraints_json: "[]",
    }, family)).toContain("constraints_json must be a JSON object")
    expect(await commerceTool("commerce_checkout_commit")({
      checkout_id: "missing",
      digest: "digest",
      confirmation: "CONFIRM_PURCHASE",
    }, { ...family, currentUserMessage: "CONFIRM_PURCHASE checkout missing digest digest" })).toContain("commerce commit error")
    expect(await commerceTool("commerce_receipt_get")({ checkout_id: "missing" }, family)).toContain("not found")
  })
})
