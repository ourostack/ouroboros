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
      reserveBlueBubblesOutbound,
    } = await import("../../../senses/bluebubbles/outbound-state")

    const first = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:2026-07-09T17:00:00.000Z",
      chat,
      attachment,
      text: "RSVP Update -- Ari & Rachel\n\nNo changes since last check.",
      tempGuid: "temp-rsvp-1",
      now: "2026-07-09T17:00:00.000Z",
    })
    const second = reserveBlueBubblesOutbound({
      agentRoot,
      idempotencyKey: "habit:slugger:rsvp:2026-07-09T17:00:00.000Z",
      chat,
      attachment,
      text: "RSVP Update -- Ari & Rachel\n\nNo changes since last check.",
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
})
