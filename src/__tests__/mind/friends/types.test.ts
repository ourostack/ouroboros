import { describe, it, expect } from "vitest"
import {
  isIdentityProvider,
  isIntegration,
  type IdentityProvider,
  type Integration,
  type ExternalId,
  type FriendRecord,
  type ChannelCapabilities,
  type ResolvedContext,
  type AgentMeta,
  type RelationshipOutcome,
} from "../../../mind/friends/types"

describe("IdentityProvider type guard", () => {
  it("accepts 'aad'", () => {
    expect(isIdentityProvider("aad")).toBe(true)
  })

  it("accepts 'local'", () => {
    expect(isIdentityProvider("local")).toBe(true)
  })

  it("accepts 'teams-conversation'", () => {
    expect(isIdentityProvider("teams-conversation")).toBe(true)
  })

  it("accepts 'imessage-handle'", () => {
    expect(isIdentityProvider("imessage-handle")).toBe(true)
  })

  it("rejects invalid strings", () => {
    expect(isIdentityProvider("google")).toBe(false)
    expect(isIdentityProvider("")).toBe(false)
    expect(isIdentityProvider("AAD")).toBe(false)
  })

  it("rejects non-string values", () => {
    expect(isIdentityProvider(42)).toBe(false)
    expect(isIdentityProvider(null)).toBe(false)
    expect(isIdentityProvider(undefined)).toBe(false)
  })
})

describe("Integration type guard", () => {
  it("accepts 'ado'", () => {
    expect(isIntegration("ado")).toBe(true)
  })

  it("accepts 'github'", () => {
    expect(isIntegration("github")).toBe(true)
  })

  it("accepts 'graph'", () => {
    expect(isIntegration("graph")).toBe(true)
  })

  it("rejects invalid strings", () => {
    expect(isIntegration("slack")).toBe(false)
    expect(isIntegration("")).toBe(false)
    expect(isIntegration("ADO")).toBe(false)
  })

  it("rejects non-string values", () => {
    expect(isIntegration(123)).toBe(false)
    expect(isIntegration(null)).toBe(false)
    expect(isIntegration(undefined)).toBe(false)
  })
})

describe("ExternalId type", () => {
  it("constructs with all required fields", () => {
    const id: ExternalId = {
      provider: "aad",
      externalId: "abc-123",
      linkedAt: "2026-03-02T00:00:00.000Z",
    }
    expect(id.provider).toBe("aad")
    expect(id.externalId).toBe("abc-123")
    expect(id.linkedAt).toBe("2026-03-02T00:00:00.000Z")
    expect(id.tenantId).toBeUndefined()
  })

  it("constructs with optional tenantId", () => {
    const id: ExternalId = {
      provider: "aad",
      externalId: "abc-123",
      tenantId: "tenant-456",
      linkedAt: "2026-03-02T00:00:00.000Z",
    }
    expect(id.tenantId).toBe("tenant-456")
  })

  it("constructs with teams-conversation provider", () => {
    const id: ExternalId = {
      provider: "teams-conversation",
      externalId: "conv-id-123",
      linkedAt: "2026-03-02T00:00:00.000Z",
    }
    expect(id.provider).toBe("teams-conversation")
    expect(id.externalId).toBe("conv-id-123")
  })
})

describe("FriendRecord type", () => {
  it("constructs with all required fields", () => {
    const record: FriendRecord = {
      id: "uuid-1",
      name: "Jordan",
      role: "partner",
      trustLevel: "friend",
      connections: [{ name: "Ari", relationship: "teammate" }],
      externalIds: [
        { provider: "aad", externalId: "aad-id", tenantId: "t1", linkedAt: "2026-03-02T00:00:00.000Z" },
      ],
      tenantMemberships: ["t1"],
      toolPreferences: { ado: "flat backlog view" },
      notes: { role: { value: "engineering manager", savedAt: "2026-01-01T00:00:00.000Z" } },
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      schemaVersion: 1,
    }
    expect(record.id).toBe("uuid-1")
    expect(record.name).toBe("Jordan")
    expect(record.role).toBe("partner")
    expect(record.trustLevel).toBe("friend")
    expect(record.connections).toEqual([{ name: "Ari", relationship: "teammate" }])
    expect(record.externalIds).toHaveLength(1)
    expect(record.tenantMemberships).toEqual(["t1"])
    expect(record.toolPreferences.ado).toBe("flat backlog view")
    expect(record.notes.role.value).toBe("engineering manager")
    expect(record.schemaVersion).toBe(1)
  })

  it("constructs with empty toolPreferences and notes", () => {
    const record: FriendRecord = {
      id: "uuid-2",
      name: "Alex",
      role: "friend",
      trustLevel: "acquaintance",
      connections: [],
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      schemaVersion: 1,
    }
    expect(Object.keys(record.toolPreferences)).toHaveLength(0)
    expect(Object.keys(record.notes)).toHaveLength(0)
  })
})

describe("ChannelCapabilities type", () => {
  it("constructs CLI capabilities", () => {
    const caps: ChannelCapabilities = {
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    expect(caps.channel).toBe("cli")
    expect(caps.availableIntegrations).toEqual([])
    expect(caps.supportsStreaming).toBe(true)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("constructs Teams capabilities", () => {
    const caps: ChannelCapabilities = {
      channel: "teams",
      availableIntegrations: ["ado", "graph"],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    expect(caps.channel).toBe("teams")
    expect(caps.availableIntegrations).toEqual(["ado", "graph"])
    expect(caps.supportsRichCards).toBe(true)
    expect(caps.maxMessageLength).toBe(Infinity)
  })

  it("constructs BlueBubbles capabilities", () => {
    const caps: ChannelCapabilities = {
      channel: "bluebubbles",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: false,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    expect(caps.channel).toBe("bluebubbles")
    expect(caps.availableIntegrations).toEqual([])
    expect(caps.supportsStreaming).toBe(false)
    expect(caps.supportsRichCards).toBe(false)
  })
})

describe("RelationshipOutcome type", () => {
  it("constructs with all required fields", () => {
    const outcome: RelationshipOutcome = {
      missionId: "mission-1",
      result: "success",
      timestamp: "2026-04-01T00:00:00.000Z",
    }
    expect(outcome.missionId).toBe("mission-1")
    expect(outcome.result).toBe("success")
    expect(outcome.timestamp).toBe("2026-04-01T00:00:00.000Z")
    expect(outcome.note).toBeUndefined()
  })

  it("constructs with optional note", () => {
    const outcome: RelationshipOutcome = {
      missionId: "mission-2",
      result: "partial",
      timestamp: "2026-04-01T12:00:00.000Z",
      note: "halfway there",
    }
    expect(outcome.note).toBe("halfway there")
  })

  it("accepts all result values", () => {
    const results: RelationshipOutcome["result"][] = ["success", "partial", "failed"]
    for (const r of results) {
      const outcome: RelationshipOutcome = {
        missionId: "m",
        result: r,
        timestamp: "2026-04-01T00:00:00.000Z",
      }
      expect(outcome.result).toBe(r)
    }
  })
})

describe("AgentMeta type", () => {
  it("constructs with all required fields", () => {
    const meta: AgentMeta = {
      bundleName: "slugger.ouro",
      familiarity: 5,
      sharedMissions: ["mission-1", "mission-2"],
      outcomes: [],
    }
    expect(meta.bundleName).toBe("slugger.ouro")
    expect(meta.familiarity).toBe(5)
    expect(meta.sharedMissions).toEqual(["mission-1", "mission-2"])
    expect(meta.outcomes).toEqual([])
  })

  it("constructs with outcomes", () => {
    const outcome: RelationshipOutcome = {
      missionId: "mission-1",
      result: "success",
      timestamp: "2026-04-01T00:00:00.000Z",
      note: "nailed it",
    }
    const meta: AgentMeta = {
      bundleName: "copilot.ouro",
      familiarity: 3,
      sharedMissions: ["mission-1"],
      outcomes: [outcome],
    }
    expect(meta.outcomes).toHaveLength(1)
    expect(meta.outcomes[0].result).toBe("success")
  })
})

describe("FriendRecord kind and agentMeta fields", () => {
  it("accepts kind: 'human'", () => {
    const record: FriendRecord = {
      id: "uuid-h",
      name: "Jordan",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      schemaVersion: 1,
      kind: "human",
    }
    expect(record.kind).toBe("human")
    expect(record.agentMeta).toBeUndefined()
  })

  it("accepts kind: 'agent' with agentMeta", () => {
    const record: FriendRecord = {
      id: "uuid-a",
      name: "Slugger",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      schemaVersion: 1,
      kind: "agent",
      agentMeta: {
        bundleName: "slugger.ouro",
        familiarity: 10,
        sharedMissions: ["deploy-v2"],
        outcomes: [
          {
            missionId: "deploy-v2",
            result: "success",
            timestamp: "2026-04-01T00:00:00.000Z",
            note: "smooth deploy",
          },
        ],
      },
    }
    expect(record.kind).toBe("agent")
    expect(record.agentMeta).toBeDefined()
    expect(record.agentMeta!.bundleName).toBe("slugger.ouro")
    expect(record.agentMeta!.familiarity).toBe(10)
    expect(record.agentMeta!.sharedMissions).toEqual(["deploy-v2"])
    expect(record.agentMeta!.outcomes).toHaveLength(1)
  })

  it("kind and agentMeta are optional", () => {
    const record: FriendRecord = {
      id: "uuid-legacy",
      name: "Legacy Friend",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      schemaVersion: 1,
    }
    expect(record.kind).toBeUndefined()
    expect(record.agentMeta).toBeUndefined()
  })
})

describe("ResolvedContext type", () => {
  it("constructs with friend and channel (no identity, no memory, no checker)", () => {
    const friend: FriendRecord = {
      id: "uuid-1",
      name: "Jordan",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
      schemaVersion: 1,
    }
    const channel: ChannelCapabilities = {
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    const ctx: ResolvedContext = { friend, channel }
    expect(ctx.friend).toBe(friend)
    expect(ctx.channel).toBe(channel)
    // ResolvedContext has only friend + channel, no legacy fields
    expect(Object.keys(ctx)).toEqual(["friend", "channel"])
  })
})
