import { afterEach, describe, expect, it } from "vitest"
import * as path from "node:path"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { FileFriendStore } from "@ouro.bot/friends"
import type { FriendRecord } from "@ouro.bot/friends"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"

let tmp: TmpBundleHandle | null = null
let server: A2AServerHandle | null = null

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
  tmp?.cleanup()
  tmp = null
})

function tool(name: string) {
  const def = a2aToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def.handler
}

function friendRecord(input: Partial<FriendRecord> = {}): FriendRecord {
  const now = new Date().toISOString()
  return {
    id: input.id ?? "peer-1",
    name: input.name ?? "Remote Agent",
    trustLevel: input.trustLevel ?? "friend",
    role: input.role ?? "agent-peer",
    kind: input.kind ?? "agent",
    agentMeta: input.agentMeta ?? {
      bundleName: "remote",
      familiarity: 0,
      sharedMissions: [],
      outcomes: [],
    },
    externalIds: input.externalIds ?? [{ provider: "a2a-agent", externalId: "remote-agent", linkedAt: now }],
    tenantMemberships: input.tenantMemberships ?? [],
    toolPreferences: input.toolPreferences ?? {},
    notes: input.notes ?? {},
    totalTokens: input.totalTokens ?? 0,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    schemaVersion: input.schemaVersion ?? 1,
  }
}

function requesterContext(input: {
  agentRoot?: string
  store?: ToolContext["friendStore"]
  trustLevel?: FriendRecord["trustLevel"]
}): ToolContext {
  const requester = friendRecord({ id: "requester", trustLevel: input.trustLevel ?? "family", kind: "human" })
  return {
    signin: async () => undefined,
    ...(input.agentRoot ? { agentRoot: input.agentRoot } : {}),
    ...(input.store ? { friendStore: input.store } : {}),
    context: {
      friend: requester,
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

describe("A2A repertoire tools", () => {
  it("lists peers, sends messages, and fetches remote tasks", async () => {
    tmp = createTmpBundle({ agentName: "a2a-tools" })
    server = await startA2AServer({
      agentName: "remote",
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message }) => ({ response: `remote:${message}` }),
    })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const peer = friendRecord({
      agentMeta: {
        bundleName: "remote",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: {
          endpointUrl: server.endpointUrl,
          agentId: "remote-agent",
        },
      },
    })
    await store.put(peer.id, peer)
    const fallbackTrustPeer = friendRecord({
      id: "peer-no-trust",
      agentMeta: {
        bundleName: "remote",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: {
          endpointUrl: server.endpointUrl,
          agentId: "remote-agent-no-trust",
        },
      },
    })
    delete fallbackTrustPeer.trustLevel
    await store.put(fallbackTrustPeer.id, fallbackTrustPeer)
    const ctx = requesterContext({ agentRoot: tmp.agentRoot, store })

    const peers = JSON.parse(await tool("a2a_list_peers")({}, ctx))
    expect(peers).toHaveLength(2)
    expect(peers.find((entry: { id: string }) => entry.id === fallbackTrustPeer.id)?.trustLevel).toBe("friend")

    const sent = JSON.parse(await tool("a2a_send_message")({ friend_id: peer.id, message: "ping" }, ctx))
    expect(sent.status.state).toBe("completed")
    expect(sent.artifacts[0].parts[0].text).toBe("remote:ping")
    expect(sent.metadata.a2a.accessToken).toBeUndefined()

    const fetched = JSON.parse(await tool("a2a_get_task")({
      friend_id: peer.id,
      task_id: sent.id,
    }, ctx))
    expect(fetched.id).toBe(sent.id)
    expect(fetched.metadata.a2a.accessToken).toBeUndefined()
  })

  it("enforces requester and store guards", async () => {
    tmp = createTmpBundle({ agentName: "a2a-tool-guards" })
    expect(await tool("a2a_list_peers")({}, undefined)).toContain("no friend context")

    const strangerCtx = requesterContext({ agentRoot: tmp.agentRoot, trustLevel: "stranger" })
    expect(await tool("a2a_list_peers")({}, strangerCtx)).toContain("require friend or family")

    const noListCtx = requesterContext({
      agentRoot: tmp.agentRoot,
      store: { get: async () => null },
    })
    expect(await tool("a2a_list_peers")({}, noListCtx)).toContain("does not support listing")

    const rawPeer = friendRecord({ id: "raw-peer" })
    delete rawPeer.trustLevel
    const rawListCtx = requesterContext({
      agentRoot: tmp.agentRoot,
      store: { get: async () => null, listAll: async () => [rawPeer] },
    })
    const rawPeers = JSON.parse(await tool("a2a_list_peers")({}, rawListCtx))
    expect(rawPeers[0].trustLevel).toBe("friend")

    const fileStore = new FileFriendStore(`${tmp.agentRoot}/friends`)
    await fileStore.put("file-peer", friendRecord({ id: "file-peer" }))
    const noInjectedStoreCtx = requesterContext({ agentRoot: tmp.agentRoot })
    const filePeers = JSON.parse(await tool("a2a_list_peers")({}, noInjectedStoreCtx))
    expect(filePeers.some((entry: { id: string }) => entry.id === "file-peer")).toBe(true)
  })

  it("resolves card URLs, external URL identities, and peer trust failures", async () => {
    tmp = createTmpBundle({ agentName: "a2a-card-tools" })
    server = await startA2AServer({
      agentName: "remote-card",
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message }) => ({ response: `card:${message}` }),
    })

    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const cardPeer = friendRecord({
      id: "card-peer",
      agentMeta: {
        bundleName: "remote-card",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: { cardUrl: `${server.url}/.well-known/agent-card.json` },
      },
    })
    const externalPeer = friendRecord({
      id: "external-peer",
      agentMeta: {
        bundleName: "remote-card",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
      },
      externalIds: [{ provider: "a2a-agent", externalId: `${server.url}/.well-known/agent-card.json`, linkedAt: new Date().toISOString() }],
    })
    const acquaintancePeer = friendRecord({ id: "acquaintance-peer", trustLevel: "acquaintance" })
    const invalidPeer = friendRecord({
      id: "invalid-peer",
      agentMeta: {
        bundleName: "remote-card",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
      },
      externalIds: [{ provider: "a2a-agent", externalId: "remote-agent", linkedAt: new Date().toISOString() }],
    })
    await store.put(cardPeer.id, cardPeer)
    await store.put(externalPeer.id, externalPeer)
    await store.put(acquaintancePeer.id, acquaintancePeer)
    await store.put(invalidPeer.id, invalidPeer)

    const ctx = requesterContext({ agentRoot: tmp.agentRoot, store })

    const cardSent = JSON.parse(await tool("a2a_send_message")({ friend_id: cardPeer.id, message: "ping" }, ctx))
    expect(cardSent.artifacts[0].parts[0].text).toBe("card:ping")

    const externalSent = JSON.parse(await tool("a2a_send_message")({ friend_id: externalPeer.id, message: "pong" }, ctx))
    expect(externalSent.artifacts[0].parts[0].text).toBe("card:pong")

    expect(await tool("a2a_send_message")({ friend_id: cardPeer.id, message: "ping" }, undefined)).toContain("no friend context")
    expect(await tool("a2a_get_task")({ friend_id: cardPeer.id, task_id: "task", access_token: "token" }, requesterContext({ agentRoot: tmp.agentRoot, trustLevel: "acquaintance" }))).toContain("A2A tools require")
    expect(await tool("a2a_send_message")({ friend_id: "missing", message: "ping" }, ctx)).toContain("A2A peer not found")
    expect(await tool("a2a_get_task")({ friend_id: "missing", task_id: "task", access_token: "token" }, ctx)).toContain("A2A peer not found")
    expect(await tool("a2a_send_message")({ friend_id: acquaintancePeer.id, message: "ping" }, ctx)).toContain("target A2A peer must be friend or family")
    expect(await tool("a2a_get_task")({ friend_id: acquaintancePeer.id, task_id: "task", access_token: "token" }, ctx)).toContain("target A2A peer must be friend or family")
    expect(await tool("a2a_send_message")({ friend_id: invalidPeer.id, message: "ping" }, ctx)).toContain("A2A send error")
    expect(await tool("a2a_get_task")({ friend_id: invalidPeer.id, task_id: "task", access_token: "token" }, ctx)).toContain("A2A task error")
  })

  it("uses the local bundle name as outbound sender metadata with safe fallbacks", async () => {
    tmp = createTmpBundle({ agentName: "a2a-sender-fallbacks" })
    cacheMachineRuntimeCredentialConfig(tmp.agentName, { a2a: { publicUrl: "https://sender.example" } })
    server = await startA2AServer({
      agentName: "remote-sender",
      agentRoot: tmp.agentRoot,
      port: 0,
      turnRunner: async ({ message, peerName }) => ({ response: `sender:${peerName}:${message}` }),
    })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const peer = friendRecord({
      agentMeta: {
        bundleName: "remote-sender",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: {
          endpointUrl: server.endpointUrl,
          agentId: "remote-sender-agent",
        },
      },
    })
    await store.put(peer.id, peer)

    const bundleRootSender = JSON.parse(await tool("a2a_send_message")({
      friend_id: peer.id,
      message: "bundle root",
    }, requesterContext({ agentRoot: tmp.agentRoot, store })))
    expect(bundleRootSender.artifacts[0].parts[0].text).toBe("sender:a2a-sender-fallbacks:bundle root")

    cacheMachineRuntimeCredentialConfig(tmp.agentName, { a2a: { publicUrl: " " } })
    const blankPublicUrlSender = JSON.parse(await tool("a2a_send_message")({
      friend_id: peer.id,
      message: "blank public url",
    }, requesterContext({ agentRoot: tmp.agentRoot, store })))
    expect(blankPublicUrlSender.artifacts[0].parts[0].text).toBe("sender:a2a-sender-fallbacks:blank public url")

    cacheMachineRuntimeCredentialConfig(tmp.agentName, { a2a: [] })
    const invalidConfigSender = JSON.parse(await tool("a2a_send_message")({
      friend_id: peer.id,
      message: "invalid config",
    }, requesterContext({ agentRoot: tmp.agentRoot, store })))
    expect(invalidConfigSender.artifacts[0].parts[0].text).toBe("sender:a2a-sender-fallbacks:invalid config")

    const missingRootSender = JSON.parse(await tool("a2a_send_message")({
      friend_id: peer.id,
      message: "missing root",
    }, requesterContext({ store })))
    expect(missingRootSender.artifacts[0].parts[0].text).toBe("sender:Ouro agent:missing root")
    const missingRootTask = JSON.parse(await tool("a2a_get_task")({
      friend_id: peer.id,
      task_id: missingRootSender.id,
    }, requesterContext({ store })))
    expect(missingRootTask.id).toBe(missingRootSender.id)

    const nonBundleRootSender = JSON.parse(await tool("a2a_send_message")({
      friend_id: peer.id,
      message: "non bundle root",
    }, requesterContext({ agentRoot: path.join(tmp.agentRoot, "state"), store })))
    expect(nonBundleRootSender.artifacts[0].parts[0].text).toBe("sender:Ouro agent:non bundle root")
  })
})
