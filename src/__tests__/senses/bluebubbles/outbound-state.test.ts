import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlueBubblesChatRef } from "../../../senses/bluebubbles/model"

const emitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => emitNervesEvent(...args),
}))

const chat: BlueBubblesChatRef = {
  chatGuid: "iMessage;-;+15555550100",
  chatIdentifier: "+15555550100",
  isGroup: false,
  sessionKey: "chat:iMessage;-;+15555550100",
  sendTarget: { kind: "chat_guid", value: "iMessage;-;+15555550100" },
  participantHandles: ["+15555550100"],
}

const routeChangedChat: BlueBubblesChatRef = {
  ...chat,
  chatGuid: "iMessage;-;+15555550999",
  chatIdentifier: "+15555550999",
  sessionKey: "chat:iMessage;-;+15555550999",
  sendTarget: { kind: "chat_guid", value: "iMessage;-;+15555550999" },
  participantHandles: ["+15555550999"],
}

const attachment = {
  serverUrl: "http://bluebubbles.local",
  accountId: "default",
}

describe("BlueBubbles durable outbound state", () => {
  let agentRoot: string

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-outbound-state-"))
    emitNervesEvent.mockReset()
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("atomically reserves an idempotency key before transport send and blocks a crash retry from sending twice", async () => {
    const {
      blueBubblesOutboundRecordPath,
      readBlueBubblesOutboundRecordByIdempotencyKey,
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const first = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:2026-07-09T17:00:00.000Z",
      chat,
      attachment,
      text: "RSVP Update -- Wedding\n\nNo changes since last check.",
      tempGuid: "temp-rsvp-1",
      now: "2026-07-09T17:00:00.000Z",
    })
    const second = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:2026-07-09T17:00:00.000Z",
      chat,
      attachment,
      text: "RSVP Update -- Wedding\n\nNo changes since last check.",
      tempGuid: "temp-rsvp-1-retry",
      now: "2026-07-09T17:00:15.000Z",
    })

    expect(first.status).toBe("reserved")
    expect(first.record).toMatchObject({
      status: "reserved",
      idempotencyKey: "habit:slugger:rsvp:2026-07-09T17:00:00.000Z",
      tempGuid: "temp-rsvp-1",
      contentStored: false,
    })
    expect(second).toMatchObject({
      status: "duplicate",
      record: expect.objectContaining({
        status: "reserved",
        tempGuid: "temp-rsvp-1",
      }),
    })
    expect(fs.existsSync(blueBubblesOutboundRecordPath(agentRoot, first.record.recordId))).toBe(true)
    expect(readBlueBubblesOutboundRecordByIdempotencyKey(
      agentRoot,
      "habit:slugger:rsvp:2026-07-09T17:00:00.000Z",
    )).toEqual(first.record)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_outbound_reserved",
    }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_outbound_duplicate",
    }))
  })

  it("moves reused keys to pending manual verification when route or attachment identity proof changes", async () => {
    const {
      readBlueBubblesOutboundRecord,
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const first = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "manual:ari:rsvp:test",
      chat,
      attachment,
      text: "same report",
      tempGuid: "temp-stable",
      now: "2026-07-09T17:00:00.000Z",
    })
    const mismatch = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "manual:ari:rsvp:test",
      chat: routeChangedChat,
      attachment: { ...attachment, serverUrl: "http://other-bluebubbles.local" },
      text: "same report",
      tempGuid: "temp-changed",
      now: "2026-07-09T17:01:00.000Z",
    })

    expect(mismatch).toMatchObject({
      status: "pending-manual-verification",
      reason: "identity-proof-mismatch",
      record: expect.objectContaining({
        status: "pending-manual-verification",
        tempGuid: "temp-stable",
        manualVerificationReason: "identity-proof-mismatch",
      }),
    })
    expect(readBlueBubblesOutboundRecord(agentRoot, first.record.recordId)).toMatchObject({
      status: "pending-manual-verification",
      routeProof: expect.objectContaining({ chatGuid: "iMessage;-;+15555550100" }),
      attachmentProof: expect.objectContaining({ endpointOrigin: "http://bluebubbles.local" }),
    })
  })

  it("treats participant drift and account-only attachment drift as identity mismatches", async () => {
    const {
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const first = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "manual:ari:rsvp:participant-drift",
      chat,
      attachment,
      text: "same report",
      tempGuid: "temp-drift-1",
      now: "2026-07-09T17:00:00.000Z",
    })
    const drift = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "manual:ari:rsvp:participant-drift",
      chat: { ...chat, participantHandles: ["+15555550100", "+15555550200"] },
      attachment: { ...attachment, accountId: "secondary" },
      text: "same report",
      tempGuid: "temp-drift-2",
      now: "2026-07-09T17:01:00.000Z",
    })

    expect(first.status).toBe("reserved")
    expect(drift).toMatchObject({
      status: "pending-manual-verification",
      reason: "identity-proof-mismatch",
      record: expect.objectContaining({
        status: "pending-manual-verification",
        tempGuid: "temp-drift-1",
      }),
    })
  })

  it("supports sparse route proofs, reply-target hashes, and accountless attachments without storing secrets", async () => {
    const {
      readBlueBubblesOutboundRecord,
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const sparseChat: BlueBubblesChatRef = {
      isGroup: false,
      sessionKey: "chat_identifier:+15555550100",
      sendTarget: { kind: "chat_identifier", value: "+15555550100" },
      participantHandles: [],
    }
    const reserved = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "manual:ari:rsvp:sparse-route",
      chat: sparseChat,
      attachment: { serverUrl: "http://bluebubbles.local/path-is-ignored" },
      text: "reply target proof",
      tempGuid: "temp-sparse-route",
      replyToMessageGuid: "incoming-guid-1",
    })
    const record = readBlueBubblesOutboundRecord(agentRoot, reserved.record.recordId)

    expect(record).toMatchObject({
      routeProof: {
        chatGuid: null,
        chatIdentifier: null,
        sessionKey: "chat_identifier:+15555550100",
        rawParticipantHandlesStored: false,
      },
      attachmentProof: {
        endpointOrigin: "http://bluebubbles.local",
        accountId: null,
        secretStored: false,
      },
      contentStored: false,
    })
    expect(record?.replyToMessageGuidHash).toMatch(/^sha256:/)
  })

  it("tracks accepted, enqueued, local-visible, delivered, failed, and pending-manual-verification states", async () => {
    const {
      markBlueBubblesOutboundAccepted,
      markBlueBubblesOutboundDelivered,
      markBlueBubblesOutboundEnqueued,
      markBlueBubblesOutboundFailed,
      markBlueBubblesOutboundLocalVisible,
      markBlueBubblesOutboundPendingManualVerification,
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const reservation = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:state-machine",
      chat,
      attachment,
      text: "RSVP Update",
      tempGuid: "temp-rsvp-state",
      now: "2026-07-09T17:00:00.000Z",
    })
    const accepted = markBlueBubblesOutboundAccepted({
      agentRoot,
      recordId: reservation.record.recordId,
      acceptedAt: "2026-07-09T17:00:01.000Z",
      messageGuid: "server-guid-1",
    })
    const enqueued = markBlueBubblesOutboundEnqueued({
      agentRoot,
      recordId: reservation.record.recordId,
      enqueuedAt: "2026-07-09T17:00:02.000Z",
      messageGuid: "server-guid-1",
    })
    const visible = markBlueBubblesOutboundLocalVisible({
      agentRoot,
      recordId: reservation.record.recordId,
      visibleAt: "2026-07-09T17:00:03.000Z",
      messageGuid: "local-guid-1",
      tempGuid: "temp-rsvp-state",
    })
    const delivered = markBlueBubblesOutboundDelivered({
      agentRoot,
      recordId: reservation.record.recordId,
      deliveredAt: "2026-07-09T17:00:04.000Z",
      messageGuid: "local-guid-1",
    })
    const failed = markBlueBubblesOutboundFailed({
      agentRoot,
      recordId: reservation.record.recordId,
      failedAt: "2026-07-09T17:00:05.000Z",
      reason: "HTTP 500",
    })
    const pending = markBlueBubblesOutboundPendingManualVerification({
      agentRoot,
      recordId: reservation.record.recordId,
      decidedAt: "2026-07-09T17:00:06.000Z",
      reason: "local-visibility-timeout",
    })

    expect([
      accepted.status,
      enqueued.status,
      visible.status,
      delivered.status,
      failed.status,
      pending.status,
    ]).toEqual([
      "accepted",
      "enqueued",
      "local-visible",
      "delivered",
      "failed",
      "pending-manual-verification",
    ])
    expect(pending).toMatchObject({
      status: "pending-manual-verification",
      messageGuid: "local-guid-1",
      tempGuid: "temp-rsvp-state",
      manualVerificationReason: "local-visibility-timeout",
    })
  })

  it("allows local visibility and delivery reconciliation when tempGuid or messageGuid is absent", async () => {
    const {
      markBlueBubblesOutboundDelivered,
      markBlueBubblesOutboundLocalVisible,
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const reservation = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:optional-reconcile",
      chat,
      attachment,
      text: "RSVP Update",
      tempGuid: "temp-optional-reconcile",
      now: "2026-07-09T17:00:00.000Z",
    })
    const visible = markBlueBubblesOutboundLocalVisible({
      agentRoot,
      recordId: reservation.record.recordId,
      visibleAt: "2026-07-09T17:00:03.000Z",
      messageGuid: "local-guid-optional",
    })
    const delivered = markBlueBubblesOutboundDelivered({
      agentRoot,
      recordId: reservation.record.recordId,
      deliveredAt: "2026-07-09T17:00:04.000Z",
    })

    expect(visible.tempGuid).toBe("temp-optional-reconcile")
    expect(delivered.messageGuid).toBe("local-guid-optional")
  })

  it("fails closed when an existing reservation file is unreadable", async () => {
    const {
      blueBubblesOutboundRecordPath,
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const reserved = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:unreadable-existing",
      chat,
      attachment,
      text: "RSVP Update",
      tempGuid: "temp-unreadable",
      now: "2026-07-09T17:00:00.000Z",
    })
    fs.writeFileSync(blueBubblesOutboundRecordPath(agentRoot, reserved.record.recordId), "{not-json", "utf-8")

    expect(() => reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:unreadable-existing",
      chat,
      attachment,
      text: "RSVP Update",
      tempGuid: "temp-unreadable-2",
      now: "2026-07-09T17:01:00.000Z",
    })).toThrow("bluebubbles outbound reservation is unreadable")
  })

  it("throws on status reconciliation for missing records instead of inventing delivery state", async () => {
    const {
      markBlueBubblesOutboundAccepted,
      markBlueBubblesOutboundPendingManualVerification,
    } = await import("../../../senses/bluebubbles/outbound-state")

    expect(() => markBlueBubblesOutboundAccepted({
      agentRoot,
      recordId: "bbout_missing",
      acceptedAt: "2026-07-09T17:00:00.000Z",
    })).toThrow("bluebubbles outbound record not found: bbout_missing")
    expect(() => markBlueBubblesOutboundPendingManualVerification({
      agentRoot,
      recordId: "bbout_missing",
      decidedAt: "2026-07-09T17:00:00.000Z",
      reason: "missing-local-visible-message",
    })).toThrow("bluebubbles outbound record not found: bbout_missing")
  })
})
