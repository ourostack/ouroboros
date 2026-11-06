import { describe, expect, it } from "vitest"
import {
  createDelegatedMailSourceState,
  markForwardingProbeResult,
  markMboxBackfillComplete,
  renderDelegatedMailSourceNextStep,
} from "../../mailroom/source-state"

const ALIAS = "me.mendelow.ari.slugger@ouro.bot"

describe("delegated mail source setup state", () => {
  it("starts HEY onboarding as a resumable Slugger-managed browser/MFA workflow", () => {
    const state = createDelegatedMailSourceState({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: ALIAS,
    })

    expect(state).toMatchObject({
      schemaVersion: 1,
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: ALIAS,
      backfill: {
        status: "not_started",
      },
      forwarding: {
        status: "blocked_by_human",
        targetAlias: ALIAS,
        browserAutomationOwner: "agent",
        humanRequired: ["browser_auth", "mfa_or_captcha", "export_download", "forwarding_confirmation"],
      },
    })

    const nextStep = renderDelegatedMailSourceNextStep(state)
    expect(nextStep).toContain("Slugger")
    expect(nextStep).toContain("browser automation")
    expect(nextStep).toContain("MFA")
    expect(nextStep).toContain(ALIAS)
    expect(nextStep).not.toContain("to slugger@ouro.bot")
  })

  it("records archive backfill freshness without marking forwarding ready", () => {
    const state = createDelegatedMailSourceState({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: ALIAS,
    })

    const completed = markMboxBackfillComplete(state, {
      scanned: 3,
      imported: 2,
      duplicates: 1,
      sourceFreshThrough: "2026-04-02T16:00:00.000Z",
      completedAt: "2026-04-22T21:00:00.000Z",
    })

    expect(completed.backfill).toEqual({
      status: "ready",
      scanned: 3,
      imported: 2,
      duplicates: 1,
      sourceFreshThrough: "2026-04-02T16:00:00.000Z",
      completedAt: "2026-04-22T21:00:00.000Z",
    })
    expect(completed.forwarding.status).toBe("blocked_by_human")
  })

  it("uses safe defaults and records forwarding probes that have no message id", () => {
    const state = createDelegatedMailSourceState({
      agentId: " Slugger ",
      ownerEmail: "ARI@MENDELOW.ME",
      source: "   ",
      aliasAddress: ALIAS,
    })

    expect(state.agentId).toBe("slugger")
    expect(state.ownerEmail).toBe("ari@mendelow.me")
    expect(state.source).toBe("hey")

    const ready = markForwardingProbeResult(state, {
      observedRecipient: ALIAS,
      checkedAt: "2026-04-22T21:08:00.000Z",
    })
    expect(ready.forwarding).toEqual(expect.objectContaining({
      status: "ready",
      observedRecipient: ALIAS,
      expectedRecipient: ALIAS,
      verifiedAt: "2026-04-22T21:08:00.000Z",
    }))
    expect(ready.forwarding).not.toHaveProperty("lastProbeMessageId")

    const wrongAlias = markForwardingProbeResult(state, {
      observedRecipient: "slugger@ouro.bot",
      checkedAt: "2026-04-22T21:09:00.000Z",
    })
    expect(wrongAlias.forwarding).toEqual(expect.objectContaining({
      status: "failed_recoverable",
      observedRecipient: "slugger@ouro.bot",
      expectedRecipient: ALIAS,
    }))
    expect(wrongAlias.forwarding).not.toHaveProperty("lastProbeMessageId")
  })

  it("distinguishes verified, pending, and wrong-alias forwarding probes", () => {
    const state = createDelegatedMailSourceState({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: ALIAS,
    })

    const ready = markForwardingProbeResult(state, {
      observedRecipient: ALIAS,
      messageId: "mail_forwarding_probe",
      checkedAt: "2026-04-22T21:05:00.000Z",
    })
    expect(ready.forwarding).toEqual(expect.objectContaining({
      status: "ready",
      verifiedAt: "2026-04-22T21:05:00.000Z",
      lastProbeMessageId: "mail_forwarding_probe",
    }))
    expect(renderDelegatedMailSourceNextStep(ready)).toBe(`${ready.source} forwarding is verified for ${ALIAS}.`)

    const pending = markForwardingProbeResult(state, {
      observedRecipient: null,
      checkedAt: "2026-04-22T21:06:00.000Z",
    })
    expect(pending.forwarding).toEqual(expect.objectContaining({
      status: "pending_propagation",
      recoveryAction: "Wait briefly, then have Slugger re-check the delegated source alias before asking the human to change HEY again.",
    }))

    const wrongAlias = markForwardingProbeResult(state, {
      observedRecipient: "slugger@ouro.bot",
      messageId: "mail_wrong_lane",
      checkedAt: "2026-04-22T21:07:00.000Z",
    })
    expect(wrongAlias.forwarding).toEqual(expect.objectContaining({
      status: "failed_recoverable",
      observedRecipient: "slugger@ouro.bot",
      expectedRecipient: ALIAS,
      recoveryAction: `HEY is forwarding to slugger@ouro.bot. Slugger must correct the HEY forwarding target to ${ALIAS}; do not import or label that probe as delegated Ari HEY mail.`,
    }))
  })
})
