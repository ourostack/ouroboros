import { afterEach, describe, expect, it, vi } from "vitest"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileFriendStore } from "../../mind/friends/store-file"
import type { FriendRecord } from "../../mind/friends/types"
import type { ToolContext } from "../../repertoire/tools-base"

let tmp: TmpBundleHandle | null = null

afterEach(() => {
  tmp?.cleanup()
  tmp = null
  vi.resetModules()
})

function familyContextWithoutAgentRoot(): ToolContext {
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

describe("tool agent-root fallbacks", () => {
  it("uses the canonical agent root when A2A tools receive no ToolContext agentRoot", async () => {
    tmp = createTmpBundle({ agentName: "tool-root-fallback-a2a" })
    vi.doMock("../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
      return { ...actual, getAgentRoot: () => tmp!.agentRoot }
    })
    const { a2aToolDefinitions } = await import("../../repertoire/tools-a2a")
    const listPeers = a2aToolDefinitions.find((entry) => entry.tool.function.name === "a2a_list_peers")?.handler
    if (!listPeers) throw new Error("missing a2a_list_peers")

    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const now = new Date().toISOString()
    await store.put("peer-1", {
      id: "peer-1",
      name: "Peer",
      trustLevel: "friend",
      role: "agent-peer",
      kind: "agent",
      agentMeta: {
        bundleName: "peer",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: { endpointUrl: "https://peer.example/a2a", agentId: "peer-agent" },
      },
      externalIds: [{ provider: "a2a-agent", externalId: "peer-agent", linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    })

    const peers = JSON.parse(await listPeers({}, familyContextWithoutAgentRoot()))
    expect(peers[0].id).toBe("peer-1")
  })

  it("uses the canonical agent root when commerce tools receive no ToolContext agentRoot", async () => {
    tmp = createTmpBundle({ agentName: "tool-root-fallback-commerce" })
    vi.doMock("../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
      return { ...actual, getAgentRoot: () => tmp!.agentRoot }
    })
    const { commerceToolDefinitions } = await import("../../repertoire/tools-commerce")
    const preview = commerceToolDefinitions.find((entry) => entry.tool.function.name === "commerce_checkout_preview")?.handler
    if (!preview) throw new Error("missing commerce_checkout_preview")

    const raw = await preview({
      merchant: "Fallback Store",
      amount: "12",
      currency: "usd",
      reason: "Fallback root coverage",
    }, familyContextWithoutAgentRoot())
    const result = JSON.parse(raw)
    expect(result.checkoutId).toBeTruthy()
  })
})
