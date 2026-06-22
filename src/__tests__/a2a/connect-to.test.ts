import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, findFriendByDid, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null
let peerServer: A2AServerHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  if (peerServer) {
    await peerServer.close()
    peerServer = null
  }
  tmp?.cleanup()
  tmp = null
})

function tool(name: string) {
  const def = a2aToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def.handler
}

function mintIdentity(): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

function asSelf(id: DidKeyIdentity): A2AIdentity {
  return { ...id, seed: "test-seed" }
}

/** Start a real peer A2A server that serves a DID-bearing card. Returns its card URL. */
async function startPeer(agentRoot: string, identity: DidKeyIdentity): Promise<string> {
  peerServer = await startA2AServer({
    agentName: "peer-agent",
    agentRoot,
    port: 0,
    identity: asSelf(identity),
    turnRunner: async ({ message }) => ({ response: `peer:${message}` }),
  })
  return `${peerServer.url}/.well-known/agent-card.json`
}

type CtxFriendStore = NonNullable<ToolContext["friendStore"]>

/** A requester context at a given management sense. Owner stdio/CLI is `local`. */
function ctxAt(senseType: SenseType, opts: { agentRoot: string; store?: CtxFriendStore }): ToolContext {
  const requester: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", role: "human", kind: "human",
    agentMeta: { bundleName: "owner", familiarity: 0, sharedMissions: [], outcomes: [] },
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
  }
  return {
    signin: async () => undefined,
    agentRoot: opts.agentRoot,
    ...(opts.store ? { friendStore: opts.store } : {}),
    context: {
      friend: requester,
      channel: {
        channel: senseType === "local" ? "cli" : "teams",
        senseType,
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    },
  }
}

describe("connect_to tool (owner/local sense, DID-keyed)", () => {
  it("links a DID-bearing peer from the owner/local sense at family, DID-keyed", async () => {
    tmp = createTmpBundle({ agentName: "connect-local-ok" })
    const peer = mintIdentity()
    const cardUrl = await startPeer(tmp.agentRoot, peer)
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const ctx = ctxAt("local", { agentRoot: tmp.agentRoot, store })

    const out = await tool("connect_to")({ card_url: cardUrl }, ctx)

    expect(out).toMatch(/connected/i)
    const found = await findFriendByDid(store, peer.did)
    expect(found).not.toBeNull()
    expect(found?.trustLevel).toBe("family")
    const a2aExternal = found?.externalIds.find((id) => id.provider === "a2a-agent")
    expect(a2aExternal?.externalId).toBe(peer.did)
  })

  it("refuses (downgrades) from a NON-local network sense — no link written", async () => {
    tmp = createTmpBundle({ agentName: "connect-nonlocal-refuse" })
    const peer = mintIdentity()
    const cardUrl = await startPeer(tmp.agentRoot, peer)
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const ctx = ctxAt("open", { agentRoot: tmp.agentRoot, store })

    const out = await tool("connect_to")({ card_url: cardUrl }, ctx)

    expect(out).toMatch(/owner|local|management|not available/i)
    expect(await findFriendByDid(store, peer.did)).toBeNull()
  })

  it("refuses (downgrades) from the internal (inner-dialog) sense — no link", async () => {
    tmp = createTmpBundle({ agentName: "connect-internal-refuse" })
    const peer = mintIdentity()
    const cardUrl = await startPeer(tmp.agentRoot, peer)
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const ctx = ctxAt("internal", { agentRoot: tmp.agentRoot, store })

    const out = await tool("connect_to")({ card_url: cardUrl }, ctx)

    expect(out).toMatch(/owner|local|management|not available/i)
    expect(await findFriendByDid(store, peer.did)).toBeNull()
  })

  it("requires a trusted requester (no friend context → refused)", async () => {
    tmp = createTmpBundle({ agentName: "connect-no-ctx" })
    const out = await tool("connect_to")({ card_url: "https://peer.example/.well-known/agent-card.json" }, undefined)
    expect(out).toMatch(/no friend context|require/i)
  })

  it("returns an error when the peer card cannot be fetched (no link)", async () => {
    tmp = createTmpBundle({ agentName: "connect-fetch-fail" })
    const store = new FileFriendStore(`${tmp.agentRoot}/friends`)
    const ctx = ctxAt("local", { agentRoot: tmp.agentRoot, store })

    const out = await tool("connect_to")({ card_url: "http://127.0.0.1:1/.well-known/agent-card.json" }, ctx)
    expect(out).toMatch(/error/i)
    const all = store.listAll ? await store.listAll.call(store) : []
    expect(all).toHaveLength(0)
  })
})
