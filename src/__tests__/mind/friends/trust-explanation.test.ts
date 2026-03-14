import { describe, expect, it } from "vitest"

import type { FriendRecord } from "../../../mind/friends/types"

type TrustExplanationModule = typeof import("../../../mind/friends/trust-explanation")

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "partner",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-14T17:42:00.000Z",
    updatedAt: "2026-03-14T17:42:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

async function loadTrustExplanationModule(): Promise<TrustExplanationModule> {
  const modulePath = "../../../mind/friends/trust-explanation"
  return import(modulePath)
}

describe("describeTrustContext", () => {
  it("explains direct family/friend trust as direct trust with broad permission language", async () => {
    const { describeTrustContext } = await loadTrustExplanationModule()

    const explanation = describeTrustContext({
      friend: makeFriend({
        name: "Ari",
        trustLevel: "family",
      }),
      channel: "bluebubbles",
    })

    expect(explanation.level).toBe("family")
    expect(explanation.basis).toBe("direct")
    expect(explanation.summary.toLowerCase()).toContain("direct")
    expect(explanation.why.toLowerCase()).toContain("direct")
    expect(explanation.permits.join(" ").toLowerCase()).toContain("local")
  })

  it("explains acquaintance trust as shared-group context with explicit constraints", async () => {
    const { describeTrustContext } = await loadTrustExplanationModule()

    const explanation = describeTrustContext({
      friend: makeFriend({
        name: "Project Group Person",
        role: "acquaintance",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "imessage-handle", externalId: "project@example.com", linkedAt: "2026-03-14T17:42:00.000Z" },
          { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-03-14T17:42:00.000Z" },
        ],
      }),
      channel: "bluebubbles",
    })

    expect(explanation.level).toBe("acquaintance")
    expect(explanation.basis).toBe("shared_group")
    expect(explanation.relatedGroupId).toBe("group:any;+;project-group-123")
    expect(explanation.why.toLowerCase()).toContain("shared")
    expect(explanation.constraints.join(" ").toLowerCase()).toContain("guard")
  })

  it("explains strangers as truly unknown and constrained", async () => {
    const { describeTrustContext } = await loadTrustExplanationModule()

    const explanation = describeTrustContext({
      friend: makeFriend({
        name: "Unknown Person",
        role: "stranger",
        trustLevel: "stranger",
      }),
      channel: "bluebubbles",
    })

    expect(explanation.level).toBe("stranger")
    expect(explanation.basis).toBe("unknown")
    expect(explanation.summary.toLowerCase()).toContain("unknown")
    expect(explanation.constraints.join(" ").toLowerCase()).toContain("first contact")
  })
})
