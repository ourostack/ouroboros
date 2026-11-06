import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import {
  commerceConfirmationMessage,
  commerceAuthorityToken,
  confirmationPhrase,
  confirmCommercePreview,
  consumeCommerceAuthorityToken,
  consumeReservedCommerceAuthority,
  createCommercePreview,
  markReservedCommerceAuthorityAttempted,
  readCommerceAccessLog,
  readCommerceRecord,
  releaseReservedCommerceAuthority,
  reserveCommerceAuthority,
  validateCommerceAuthority,
  validateCommerceAuthorityToken,
} from "../../commerce/store"
import { guardInvocation } from "../../repertoire/guardrails"
import { commerceToolDefinitions } from "../../repertoire/tools-commerce"
import type { ToolContext } from "../../repertoire/tools-base"
import type { FriendRecord } from "@ouro.bot/friends"

let tmp: TmpBundleHandle | null = null

afterEach(() => {
  vi.restoreAllMocks()
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

function confirmationMessage(record: Parameters<typeof commerceConfirmationMessage>[0]): string {
  return commerceConfirmationMessage(record)
}

function testToken(checkoutId: string, digest: string): string {
  return `commerce:${checkoutId}:${digest}:${randomUUID()}`
}

function testTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
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
      const persistedConfirmed = readCommerceRecord(tmp.agentRoot, confirmed.id)
      expect(persistedConfirmed?.authorityToken).toBeUndefined()
      expect(persistedConfirmed?.authorityTokenHash).toMatch(/^[a-f0-9]{64}$/)

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

  it("rejects tokenless forged confirmations without an authority token hash", () => {
    tmp = createTmpBundle({ agentName: "commerce-tokenless-forge" })
    const preview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Stripe",
      amount: 55,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
      reason: "Forged confirmation without authority token",
    })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${preview.id}.json`), `${JSON.stringify({
      ...preview,
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
      confirmation: "CONFIRM_PURCHASE",
      confirmedByMessage: confirmationMessage(preview),
    }, null, 2)}\n`, "utf-8")

    expect(validateCommerceAuthority({
      agentRoot: tmp.agentRoot,
      token: undefined,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "55", currency: "usd", merchant_categories: "travel" },
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority confirmation state is invalid" })
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
      constraints: { type: "single_use", merchant_categories: "travel" },
      reason: "Custom items",
    })
    expect(withItems.items[0]).toEqual({ name: "Widget", quantity: 2, amount: 12.35 })
    expect(withItems.items[1]).toEqual({ name: "Service" })
    expect(confirmationPhrase()).toBe("CONFIRM_PURCHASE")

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
    expect(commerceConfirmationMessage({
      id: "legacy-consent",
      digest: "4".repeat(64),
      merchant: "Legacy",
      amount: 1,
      currency: "usd",
      allowedTools: undefined as unknown as string[],
      constraints: undefined as unknown as Record<string, string>,
    })).toContain("Legacy 1 usd via  constraints {}")

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
    const invalidExpiryPreview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Invalid Expiry Store",
      amount: 11,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
      reason: "Exercise invalid expiry during confirmation",
    })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${invalidExpiryPreview.id}.json`), `${JSON.stringify({
      ...invalidExpiryPreview,
      expiresAt: "not-a-date",
    }, null, 2)}\n`, "utf-8")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: invalidExpiryPreview.id,
      digest: invalidExpiryPreview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(invalidExpiryPreview),
    })).toThrow("invalid expiry")
    const tamperedPreview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Tampered Store",
      amount: 12,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
      reason: "Exercise confirmation digest recomputation",
    })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${tamperedPreview.id}.json`), `${JSON.stringify({
      ...tamperedPreview,
      amount: 13,
    }, null, 2)}\n`, "utf-8")
    expect(() => confirmCommercePreview({
      agentRoot: tmp!.agentRoot,
      checkoutId: tamperedPreview.id,
      digest: tamperedPreview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(tamperedPreview),
    })).toThrow("commerce record digest mismatch")
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
      currentUserMessage: `do not ${confirmationMessage(withItems)}`,
    })).toThrow("exactly equal")
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

      expect(() => commerceAuthorityToken(withItems)).toThrow("only available after confirmation")
      const statusFlipToken = testToken(withItems.id, withItems.digest)
      fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${withItems.id}.json`), `${JSON.stringify({
        ...withItems,
        status: "confirmed",
      }, null, 2)}\n`, "utf-8")
      expect(validateCommerceAuthorityToken({
        agentRoot: tmp.agentRoot,
        token: statusFlipToken,
        toolName: "stripe_create_card",
        args: { type: "single_use", spend_limit: "24.69", currency: "usd", merchant_categories: "travel" },
      })).toEqual({ ok: false, reason: "commerce_authority confirmation state is invalid" })
      fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${withItems.id}.json`), `${JSON.stringify(withItems, null, 2)}\n`, "utf-8")
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
        token: `commerce:missing:${"0".repeat(64)}:${randomUUID()}`,
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
    expect(commerceAuthorityToken(confirmed)).toBe(confirmed.authorityToken)
    const badConfirmationToken = testToken("bad-confirmation", confirmed.digest)
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", "bad-confirmation.json"), `${JSON.stringify({
      ...confirmed,
      id: "bad-confirmation",
      confirmation: "CONFIRM_ALMOST",
      authorityTokenHash: testTokenHash(badConfirmationToken),
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: badConfirmationToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69", currency: "usd", merchant_categories: "travel" },
    })).toEqual({ ok: false, reason: "commerce_authority confirmation state is invalid" })
    const badMessageToken = testToken("bad-message", confirmed.digest)
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", "bad-message.json"), `${JSON.stringify({
      ...confirmed,
      id: "bad-message",
      confirmedByMessage: "wrong exact message",
      authorityTokenHash: testTokenHash(badMessageToken),
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: badMessageToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69", currency: "usd", merchant_categories: "travel" },
    })).toEqual({ ok: false, reason: "commerce_authority confirmation state is invalid" })
    const digestMismatchId = "digest-mismatch"
    const digestMismatchToken = testToken(digestMismatchId, "3".repeat(64))
    const digestMismatchRecord = {
      ...confirmed,
      id: digestMismatchId,
      confirmedByMessage: confirmationMessage({ ...confirmed, id: digestMismatchId }),
      authorityTokenHash: testTokenHash(digestMismatchToken),
    }
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${digestMismatchId}.json`), `${JSON.stringify(digestMismatchRecord, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: digestMismatchToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69", currency: "usd", merchant_categories: "travel" },
    })).toEqual({ ok: false, reason: "commerce_authority digest mismatch" })
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
    })).toEqual({ ok: false, reason: "tool spend_limit is required for commerce_authority validation" })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "bogus" },
    })).toEqual({ ok: false, reason: "tool amount does not match commerce_authority amount" })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "9".repeat(400), currency: "usd", merchant_categories: "travel" },
    })).toEqual({ ok: false, reason: "tool spend_limit is required for commerce_authority validation" })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-123", amount: "24.69", currency: "usd" },
    }).ok).toBe(false)
    expect(consumeCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-123", amount: "24.69", currency: "usd" },
    })).toEqual({ ok: false, reason: "tool is not allowed by commerce_authority" })
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
      args: { type: "single_use", spend_limit: "24.69", currency: "usd", merchant_categories: "travel" },
      friendId: "family-2",
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
        token: `commerce:${confirmed.id}:${"0".repeat(64)}:${randomUUID()}`,
        toolName: "stripe_create_card",
      }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "24.69", currency: "eur", merchant_categories: "travel" },
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
        token: `commerce:${legacyNoAllowedToolsId}:${legacyNoAllowedToolsDigest}:${randomUUID()}`,
        toolName: "stripe_create_card",
        args: { type: "single_use", spend_limit: "24.69", currency: "usd", merchant_categories: "travel" },
      })).toEqual({ ok: false, reason: "commerce_authority is missing allowed tools" })

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
        token: `commerce:${legacyNoConstraintsId}:${legacyNoConstraintsDigest}:${randomUUID()}`,
        toolName: "stripe_create_card",
        args: { spend_limit: "24.69", currency: "usd" },
      })).toEqual({ ok: false, reason: "commerce_authority constraints are invalid" })

    const tamperedPath = path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${confirmed.id}.json`)
    fs.writeFileSync(tamperedPath, `${JSON.stringify({
      ...confirmed,
      amount: 1,
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "1", currency: "usd", merchant_categories: "travel" },
    })).toEqual({ ok: false, reason: "commerce_authority record digest mismatch" })
    fs.writeFileSync(tamperedPath, `${JSON.stringify(confirmed, null, 2)}\n`, "utf-8")

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
      args: { offer_id: "hold-offer-1", amount: "1", currency: "usd" },
    }).ok).toBe(true)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: holdConfirmed.authorityToken,
      toolName: "flight_hold",
      args: { offer_id: "hold-offer-1" },
    }).ok).toBe(false)
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: holdConfirmed.authorityToken,
      toolName: "flight_hold",
      args: { offer_id: "hold-offer-2", amount: "1", currency: "usd" },
    }).ok).toBe(false)
    const missingConstraintPreview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Duffel",
      amount: 2,
      currency: "usd",
      allowedTools: ["flight_book"],
      reason: "Book offer without stored offer constraint",
    })
    const missingConstraintConfirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: missingConstraintPreview.id,
      digest: missingConstraintPreview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(missingConstraintPreview),
    })
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: missingConstraintConfirmed.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-any", amount: "2", currency: "usd" },
    })).toEqual({ ok: false, reason: "commerce_authority is missing required offer_id constraint" })

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
      const expiredPreview = createCommercePreview({
        agentRoot: tmp.agentRoot,
        friendId: "family-1",
      merchant: "Expired Store",
      amount: 3,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
        reason: "Exercise expired authority validation",
        expiresInMinutes: -1,
      })
      const expiredToken = testToken(expiredPreview.id, expiredPreview.digest)
      fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${expiredPreview.id}.json`), `${JSON.stringify({
        ...expiredPreview,
        status: "confirmed",
        confirmedAt: new Date().toISOString(),
        confirmation: "CONFIRM_PURCHASE",
        confirmedByMessage: confirmationMessage(expiredPreview),
        authorityTokenHash: testTokenHash(expiredToken),
      }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: expiredToken,
      toolName: "stripe_create_card",
      args: { type: "single_use", spend_limit: "3", currency: "usd", merchant_categories: "travel" },
    })).toEqual({ ok: false, reason: "commerce_authority expired" })
    fs.writeFileSync(recordPath, `${JSON.stringify({
      ...confirmed,
      expiresAt: "not-a-date",
      digest: confirmed.digest,
    }, null, 2)}\n`, "utf-8")
    expect(validateCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
    })).toEqual({ ok: false, reason: "commerce_authority has invalid expiry" })
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
      constraints: { type: "single_use", merchant_categories: "travel" },
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

    const wrongMerchant = guardInvocation("stripe_create_card", {
      spend_limit: "100",
      currency: "usd",
      type: "single_use",
      merchant_categories: "electronics",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
    })
    expect(wrongMerchant.allowed).toBe(false)
    expect(wrongMerchant.reason).toContain("merchant_categories")

    const allowed = guardInvocation("stripe_create_card", {
      spend_limit: "100",
      currency: "usd",
      type: "single_use",
      merchant_categories: "travel",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
    })
    expect(allowed.allowed).toBe(true)
    expect(readCommerceRecord(tmp.agentRoot, preview.id)?.status).toBe("confirmed")
    const replayBeforeExecution = guardInvocation("stripe_create_card", {
      spend_limit: "100",
      currency: "usd",
      type: "single_use",
      merchant_categories: "travel",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
    })
    expect(replayBeforeExecution.allowed).toBe(true)

    const reserved = reserveCommerceAuthority({
      agentRoot: tmp.agentRoot,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })
    expect(reserved.ok).toBe(true)
    expect(readCommerceRecord(tmp.agentRoot, preview.id)?.status).toBe("reserved")
    const reservedReplay = guardInvocation("stripe_create_card", {
      spend_limit: "100",
      currency: "usd",
      type: "single_use",
      merchant_categories: "travel",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
    })
    expect(reservedReplay.allowed).toBe(false)
    expect(reservedReplay.reason).toContain("reserved")
    if (!reserved.ok) throw new Error("expected reservation")
    const released = releaseReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: reserved.checkoutId,
      reservationToken: reserved.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-1",
    })
    expect(released.ok).toBe(true)
    expect(readCommerceRecord(tmp.agentRoot, preview.id)?.status).toBe("confirmed")

    const consumed = consumeCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })
    expect(consumed.ok).toBe(true)
    const replay = guardInvocation("stripe_create_card", {
      spend_limit: "100",
      currency: "usd",
      type: "single_use",
      merchant_categories: "travel",
    }, {
      readPaths: new Set(),
      trustLevel: "family",
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
    })
    expect(replay.allowed).toBe(false)
    expect(replay.reason).toContain("consumed")

    const secondPreview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Stripe",
      amount: 100,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
      reason: "Second matching authority",
    })
    const secondConfirmed = confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: secondPreview.id,
      digest: secondPreview.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(secondPreview),
    })
    const directlyConsumed = consumeCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: secondConfirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })
    expect(directlyConsumed.ok).toBe(true)
  })

  it("reserves authority explicitly and tolerates malformed checkout files", () => {
    tmp = createTmpBundle({ agentName: "commerce-reserve" })
    expect(reserveCommerceAuthority({
      agentRoot: tmp.agentRoot,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "no matching confirmed commerce_authority" })
    expect(reserveCommerceAuthority({
      agentRoot: tmp.agentRoot,
      token: "not-a-commerce-token",
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "invalid commerce_authority token format" })
    expect(consumeCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: "not-a-commerce-token",
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "invalid commerce_authority token format" })

    const preview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Stripe",
      amount: 100,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
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
    expect(validateCommerceAuthority({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    }).ok).toBe(true)
    expect(reserveCommerceAuthority({
      agentRoot: tmp.agentRoot,
      token: `commerce:${confirmed.id}:${"0".repeat(64)}:${randomUUID()}`,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority token mismatch" })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "commerce", "checkouts", "malformed.json"), "{", "utf-8")

    const reserved = reserveCommerceAuthority({
      agentRoot: tmp.agentRoot,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) throw new Error("expected reservation")
    expect(releaseReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: reserved.checkoutId,
      reservationToken: reserved.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-1",
    }).ok).toBe(true)

    const explicitReserved = reserveCommerceAuthority({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })
    expect(explicitReserved.ok).toBe(true)
  })

  it("rejects ambiguous matching authority before reserving or consuming", () => {
    tmp = createTmpBundle({ agentName: "commerce-ambiguous-authority" })
    const createConfirmed = () => {
      const preview = createCommercePreview({
        agentRoot: tmp!.agentRoot,
        friendId: "family-1",
        merchant: "Stripe",
        amount: 100,
        currency: "usd",
        allowedTools: ["stripe_create_card"],
        constraints: { type: "single_use", merchant_categories: "travel" },
        reason: "Virtual card for approved purchase",
      })
      confirmCommercePreview({
        agentRoot: tmp!.agentRoot,
        checkoutId: preview.id,
        digest: preview.digest,
        confirmation: "CONFIRM_PURCHASE",
        friendId: "family-1",
        currentUserMessage: confirmationMessage(preview),
      })
    }
    createConfirmed()
    createConfirmed()
    const input = {
      agentRoot: tmp.agentRoot,
      toolName: "stripe_create_card",
      args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    }
    expect(validateCommerceAuthority(input)).toEqual({ ok: false, reason: "multiple matching confirmed commerce_authority records" })
    expect(reserveCommerceAuthority(input)).toEqual({ ok: false, reason: "multiple matching confirmed commerce_authority records" })
    expect(consumeCommerceAuthorityToken(input)).toEqual({ ok: false, reason: "multiple matching confirmed commerce_authority records" })
  })

  it("reports reservation ownership mismatches without consuming or releasing", () => {
    tmp = createTmpBundle({ agentName: "commerce-reservation-mismatches" })
    const reserve = () => {
      const preview = createCommercePreview({
        agentRoot: tmp!.agentRoot,
        friendId: "family-1",
        merchant: "Stripe",
        amount: 100,
        currency: "usd",
        allowedTools: ["stripe_create_card"],
        constraints: { type: "single_use", merchant_categories: "travel" },
        reason: "Virtual card for approved purchase",
      })
      confirmCommercePreview({
        agentRoot: tmp!.agentRoot,
        checkoutId: preview.id,
        digest: preview.digest,
        confirmation: "CONFIRM_PURCHASE",
        friendId: "family-1",
        currentUserMessage: confirmationMessage(preview),
      })
      const reserved = reserveCommerceAuthority({
        agentRoot: tmp!.agentRoot,
        toolName: "stripe_create_card",
        args: { spend_limit: "100", currency: "usd", type: "single_use", merchant_categories: "travel" },
        friendId: "family-1",
      })
      if (!reserved.ok) throw new Error("expected reservation")
      return reserved
    }

    const confirmedButNotReserved = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Stripe",
      amount: 5,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
      reason: "Unreserved checkout",
    })
    confirmCommercePreview({
      agentRoot: tmp.agentRoot,
      checkoutId: confirmedButNotReserved.id,
      digest: confirmedButNotReserved.digest,
      confirmation: "CONFIRM_PURCHASE",
      friendId: "family-1",
      currentUserMessage: confirmationMessage(confirmedButNotReserved),
    })
    expect(consumeReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: confirmedButNotReserved.id,
      reservationToken: "not-reserved",
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce checkout is confirmed, not reserved or attempted" })
    expect(markReservedCommerceAuthorityAttempted({
      agentRoot: tmp.agentRoot,
      checkoutId: "missing",
      reservationToken: "not-reserved",
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce checkout not found" })
    expect(markReservedCommerceAuthorityAttempted({
      agentRoot: tmp.agentRoot,
      checkoutId: confirmedButNotReserved.id,
      reservationToken: "not-reserved",
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce checkout is confirmed, not reserved" })

    const wrongTool = reserve()
    expect(consumeReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: wrongTool.checkoutId,
      reservationToken: wrongTool.reservationToken,
      toolName: "flight_book",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority reservation belongs to a different tool" })

    const wrongFriend = reserve()
    expect(consumeReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: wrongFriend.checkoutId,
      reservationToken: wrongFriend.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-2",
    })).toEqual({ ok: false, reason: "commerce_authority belongs to a different friend" })

    const wrongToken = reserve()
    expect(consumeReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: wrongToken.checkoutId,
      reservationToken: "wrong-token",
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority reservation token mismatch" })

    const attemptWrongTool = reserve()
    expect(markReservedCommerceAuthorityAttempted({
      agentRoot: tmp.agentRoot,
      checkoutId: attemptWrongTool.checkoutId,
      reservationToken: attemptWrongTool.reservationToken,
      toolName: "flight_book",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority reservation belongs to a different tool" })

    const attemptWrongFriend = reserve()
    expect(markReservedCommerceAuthorityAttempted({
      agentRoot: tmp.agentRoot,
      checkoutId: attemptWrongFriend.checkoutId,
      reservationToken: attemptWrongFriend.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-2",
    })).toEqual({ ok: false, reason: "commerce_authority belongs to a different friend" })

    const attemptWrongToken = reserve()
    expect(markReservedCommerceAuthorityAttempted({
      agentRoot: tmp.agentRoot,
      checkoutId: attemptWrongToken.checkoutId,
      reservationToken: "wrong-token",
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority reservation token mismatch" })

    const attempted = reserve()
    expect(markReservedCommerceAuthorityAttempted({
      agentRoot: tmp.agentRoot,
      checkoutId: attempted.checkoutId,
      reservationToken: attempted.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-1",
    }).ok).toBe(true)
    expect(readCommerceRecord(tmp.agentRoot, attempted.checkoutId)?.status).toBe("attempted")
    expect(releaseReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: attempted.checkoutId,
      reservationToken: attempted.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce checkout is not reserved" })
    expect(consumeReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: attempted.checkoutId,
      reservationToken: attempted.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-1",
    }).ok).toBe(true)

    const releaseWrongTool = reserve()
    expect(releaseReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: releaseWrongTool.checkoutId,
      reservationToken: releaseWrongTool.reservationToken,
      toolName: "flight_book",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority reservation belongs to a different tool" })

    const releaseWrongFriend = reserve()
    expect(releaseReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: releaseWrongFriend.checkoutId,
      reservationToken: releaseWrongFriend.reservationToken,
      toolName: "stripe_create_card",
      friendId: "family-2",
    })).toEqual({ ok: false, reason: "commerce_authority belongs to a different friend" })

    const releaseWrongToken = reserve()
    expect(releaseReservedCommerceAuthority({
      agentRoot: tmp.agentRoot,
      checkoutId: releaseWrongToken.checkoutId,
      reservationToken: "wrong-token",
      toolName: "stripe_create_card",
      friendId: "family-1",
    })).toEqual({ ok: false, reason: "commerce_authority reservation token mismatch" })

    const badToolConsume = consumeCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmedButNotReserved.authorityToken,
      toolName: "flight_book",
      args: { offer_id: "offer-1", amount: "5", currency: "usd" },
      friendId: "family-1",
    })
    expect(badToolConsume.ok).toBe(false)
  })

  it("cleans stale commerce locks and times out on live lock contention", () => {
    tmp = createTmpBundle({ agentName: "commerce-locks" })
    const preview = createCommercePreview({
      agentRoot: tmp.agentRoot,
      friendId: "family-1",
      merchant: "Stripe",
      amount: 25,
      currency: "usd",
      allowedTools: ["stripe_create_card"],
      constraints: { type: "single_use", merchant_categories: "travel" },
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
    const lockPath = path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${preview.id}.json.lock`)
    fs.writeFileSync(lockPath, "stale")
    const staleTime = new Date(Date.now() - 31_000)
    fs.utimesSync(lockPath, staleTime, staleTime)
    const consumed = consumeCommerceAuthorityToken({
      agentRoot: tmp.agentRoot,
      token: confirmed.authorityToken,
      toolName: "stripe_create_card",
      args: { spend_limit: "25", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })
    expect(consumed.ok).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)

    const lockedId = "locked-checkout"
    const lockedPath = path.join(tmp.agentRoot, "state", "commerce", "checkouts", `${lockedId}.json.lock`)
    fs.writeFileSync(lockedPath, "live")
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_025)
      .mockReturnValueOnce(7_000)
    expect(() => consumeCommerceAuthorityToken({
      agentRoot: tmp!.agentRoot,
      token: `commerce:${lockedId}:${"0".repeat(64)}:${randomUUID()}`,
      toolName: "stripe_create_card",
      args: { spend_limit: "25", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })).toThrow("commerce_authority lock timed out")
    vi.restoreAllMocks()
    expect(() => consumeCommerceAuthorityToken({
      agentRoot: tmp!.agentRoot,
      token: `commerce:${"x".repeat(300)}:${"0".repeat(64)}:${randomUUID()}`,
      toolName: "stripe_create_card",
      args: { spend_limit: "25", currency: "usd", type: "single_use", merchant_categories: "travel" },
      friendId: "family-1",
    })).toThrow()
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
      expect(preview.confirmationMessage).toContain("Duffel 250 usd via flight_book")

      const committedRaw = await commerceTool("commerce_checkout_commit")({
        checkout_id: preview.checkoutId,
        digest: preview.digest,
        confirmation: "CONFIRM_PURCHASE",
      }, { ...ctx, currentUserMessage: preview.confirmationMessage })
    const committed = JSON.parse(committedRaw)
    expect(committed.authorityToken).toBeUndefined()
    expect(committed.use).toContain("without exposing a bearer token")

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
      constraints_json: JSON.stringify({ type: "single_use", merchant_categories: "travel" }),
      reason: "Default item and expiry",
    }, ctx)
    const minimalPreview = JSON.parse(minimalPreviewRaw)
    expect(minimalPreview.checkoutId).toBeTruthy()

    const itemOnlyPreviewRaw = await commerceTool("commerce_checkout_preview")({
      merchant: "Item Only",
      amount: "15",
      currency: "usd",
      tool_name: "stripe_create_card",
      constraints_json: JSON.stringify({ type: "single_use", merchant_categories: "travel" }),
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
      amount: "10usd",
      currency: "usd",
      tool_name: "flight_book",
      reason: "Bad amount",
    }, family)).toContain("amount must be an exact decimal")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Bad constraints",
      constraints_json: "[]",
    }, family)).toContain("constraints_json must be a JSON object")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Missing card type",
      constraints_json: JSON.stringify({ merchant_categories: "travel" }),
    }, family)).toContain("constraints_json.type is required")
    expect(await commerceTool("commerce_checkout_preview")({
      merchant: "Duffel",
      amount: "10",
      currency: "usd",
      tool_name: "stripe_create_card",
      reason: "Missing merchant categories",
      constraints_json: JSON.stringify({ type: "single_use" }),
    }, family)).toContain("constraints_json.merchant_categories is required")
    expect(await commerceTool("commerce_checkout_commit")({
      checkout_id: "missing",
      digest: "digest",
      confirmation: "CONFIRM_PURCHASE",
    }, { ...family, currentUserMessage: "CONFIRM_PURCHASE checkout missing digest digest" })).toContain("commerce commit error")
    expect(await commerceTool("commerce_receipt_get")({ checkout_id: "missing" }, family)).toContain("not found")
  })
})
