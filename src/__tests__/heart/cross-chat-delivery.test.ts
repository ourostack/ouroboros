import { describe, expect, it, vi } from "vitest"

type CrossChatDeliveryModule = typeof import("../../heart/cross-chat-delivery")

async function loadCrossChatDeliveryModule(): Promise<CrossChatDeliveryModule> {
  return import("../../heart/cross-chat-delivery")
}

describe("deliverCrossChatMessage", () => {
  it("delivers immediately for a trusted explicit cross-chat request without requiring the target to already be directly trusted", async () => {
    const { deliverCrossChatMessage } = await loadCrossChatDeliveryModule()
    const queuePending = vi.fn()
    const bluebubblesDeliver = vi.fn().mockResolvedValue({
      status: "delivered_now",
      detail: "sent to active bluebubbles session",
    })

    const result = await deliverCrossChatMessage({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "tell the group the plan changed",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        trustLevel: "friend",
      },
    }, {
      agentName: "slugger",
      queuePending,
      deliverers: {
        bluebubbles: bluebubblesDeliver,
      },
    })

    expect(result).toEqual({
      status: "delivered_now",
      detail: "sent to active bluebubbles session",
    })
    expect(queuePending).not.toHaveBeenCalled()
    expect(bluebubblesDeliver).toHaveBeenCalledWith(expect.objectContaining({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      intent: "explicit_cross_chat",
      authorizingSession: expect.objectContaining({
        friendId: "friend-uuid-1",
        trustLevel: "friend",
      }),
    }))
  })

  it("blocks explicit cross-chat delivery when the asking session is not trusted enough to authorize outward action", async () => {
    const { deliverCrossChatMessage } = await loadCrossChatDeliveryModule()
    const queuePending = vi.fn()
    const bluebubblesDeliver = vi.fn()

    const result = await deliverCrossChatMessage({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "tell them hi",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-2",
        channel: "bluebubbles",
        key: "chat:any;-;new-person@icloud.com",
        trustLevel: "acquaintance",
      },
    }, {
      agentName: "slugger",
      queuePending,
      deliverers: {
        bluebubbles: bluebubblesDeliver,
      },
    })

    expect(result).toEqual({
      status: "blocked",
      detail: "explicit cross-chat delivery requires a trusted asking session",
    })
    expect(queuePending).not.toHaveBeenCalled()
    expect(bluebubblesDeliver).not.toHaveBeenCalled()
  })

  it("queues for later when explicit cross-chat delivery is authorized but no live delivery path is available right now", async () => {
    const { deliverCrossChatMessage } = await loadCrossChatDeliveryModule()
    const queuePending = vi.fn()

    const result = await deliverCrossChatMessage({
      friendId: "group-uuid",
      channel: "teams",
      key: "group-thread",
      content: "carry this over later",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "teams",
        key: "ari-thread",
        trustLevel: "friend",
      },
    }, {
      agentName: "slugger",
      queuePending,
      deliverers: {},
    })

    expect(result).toEqual({
      status: "queued_for_later",
      detail: "live delivery unavailable right now; queued for the next active turn",
    })
    expect(queuePending).toHaveBeenCalledWith(expect.objectContaining({
      from: "slugger",
      friendId: "group-uuid",
      channel: "teams",
      key: "group-thread",
      content: "carry this over later",
    }))
  })

  it("keeps generic outreach on queued semantics instead of granting explicit cross-chat power", async () => {
    const { deliverCrossChatMessage } = await loadCrossChatDeliveryModule()
    const queuePending = vi.fn()
    const bluebubblesDeliver = vi.fn()

    const result = await deliverCrossChatMessage({
      friendId: "friend-uuid-3",
      channel: "bluebubbles",
      key: "chat:any;-;friend@icloud.com",
      content: "checking in",
      intent: "generic_outreach",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        trustLevel: "friend",
      },
    }, {
      agentName: "slugger",
      queuePending,
      deliverers: {
        bluebubbles: bluebubblesDeliver,
      },
    })

    expect(result).toEqual({
      status: "queued_for_later",
      detail: "generic outreach stays queued until the target session is next active",
    })
    expect(queuePending).toHaveBeenCalledTimes(1)
    expect(bluebubblesDeliver).not.toHaveBeenCalled()
  })

  it("surfaces channel-send failure truthfully instead of pretending the message merely queued", async () => {
    const { deliverCrossChatMessage } = await loadCrossChatDeliveryModule()
    const queuePending = vi.fn()
    const bluebubblesDeliver = vi.fn().mockResolvedValue({
      status: "failed",
      detail: "bluebubbles send failed: gateway timeout",
    })

    const result = await deliverCrossChatMessage({
      friendId: "group-uuid",
      channel: "bluebubbles",
      key: "chat:any;+;project-group-123",
      content: "tell them the build is red",
      intent: "explicit_cross_chat",
      authorizingSession: {
        friendId: "friend-uuid-1",
        channel: "bluebubbles",
        key: "chat:any;-;ari@icloud.com",
        trustLevel: "friend",
      },
    }, {
      agentName: "slugger",
      queuePending,
      deliverers: {
        bluebubbles: bluebubblesDeliver,
      },
    })

    expect(result).toEqual({
      status: "failed",
      detail: "bluebubbles send failed: gateway timeout",
    })
    expect(queuePending).not.toHaveBeenCalled()
  })
})
