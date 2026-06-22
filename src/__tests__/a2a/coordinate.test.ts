import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { delegationStoresFor } from "../../a2a/delegation-stores"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmpA: TmpBundleHandle | null = null
let tmpB: TmpBundleHandle | null = null
let serverB: A2AServerHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  if (serverB) { await serverB.close(); serverB = null }
  tmpA?.cleanup(); tmpA = null
  tmpB?.cleanup(); tmpB = null
})

function tool(name: string) {
  const def = a2aToolDefinitions.find((entry) => entry.tool.function.name === name)
  if (!def) throw new Error(`missing tool ${name}`)
  return def.handler
}

function seededIdentity(): { id: DidKeyIdentity; seed: string } {
  const seedBytes = sodium.randombytes_buf(32)
  const kp = sodium.crypto_sign_seed_keypair(seedBytes)
  return { id: didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey }), seed: Buffer.from(seedBytes).toString("base64url") }
}

function asSelf(id: DidKeyIdentity, seed: string): A2AIdentity {
  return { ...id, seed }
}

type CtxFriendStore = NonNullable<ToolContext["friendStore"]>

function localCtx(agentRoot: string, store: CtxFriendStore): ToolContext {
  const requester: FriendRecord = {
    id: "owner", name: "Owner", trustLevel: "family", role: "human", kind: "human",
    agentMeta: { bundleName: "owner", familiarity: 0, sharedMissions: [], outcomes: [] },
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), schemaVersion: 1,
  }
  const senseType: SenseType = "local"
  return {
    signin: async () => undefined,
    agentRoot,
    friendStore: store,
    context: {
      friend: requester,
      channel: {
        channel: "cli", senseType,
        availableIntegrations: [], supportsMarkdown: false, supportsStreaming: false,
        supportsRichCards: false, maxMessageLength: Infinity,
      },
    },
  }
}

describe("coordinate (prepare/outbound) + read quarantined importedDelegations", () => {
  it("A coordinate(request, task) mints a requestId, seals it, and B imports it (no double-import)", async () => {
    // B: recipient with identity (DID card + inbound bridge that runs importCoordination).
    tmpB = createTmpBundle({ agentName: "coord-B" })
    const b = seededIdentity()
    serverB = await startA2AServer({
      agentName: "coord-B", agentRoot: tmpB.agentRoot, port: 0,
      identity: asSelf(b.id, b.seed),
      turnRunner: async () => ({ response: "ack" }),
    })
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)

    // A: sender. Seed A's identity; A trusts B at family (DID-keyed).
    tmpA = createTmpBundle({ agentName: "coord-A" })
    const a = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpA.agentName, { a2a: { identity: { ed25519Seed: a.seed } } })
    // B trusts A (so B's importCoordination accepts A's coordination at family).
    await upsertAgentPeer(bStore, {
      name: "Agent A", agentId: a.id.did, trustLevel: "family",
      a2a: { did: a.id.did, agentId: a.id.did, endpointUrl: "https://a.example/a2a" },
    })

    const aStore = new FileFriendStore(`${tmpA.agentRoot}/friends`)
    await upsertAgentPeer(aStore, {
      name: "Agent B", agentId: b.id.did, trustLevel: "family",
      a2a: { did: b.id.did, agentId: b.id.did, endpointUrl: serverB.endpointUrl },
    })
    const bRecord = await aStore.findByExternalId("a2a-agent", b.id.did)

    // A coordinates a request with a task to B.
    const out = await tool("coordinate")({
      friend_id: bRecord!.id,
      mission_key: "ship-feature",
      mission_title: "Ship the feature",
      task_summary: "build the API side",
      task_details: "the /v2 endpoints",
    }, localCtx(tmpA.agentRoot, aStore))

    // The tool reports the minted requestId.
    expect(out).toMatch(/request[_ ]?id|coordinated|delegated/i)
    const requestId = (out.match(/req[a-zA-Z0-9-]*|[0-9a-f-]{36}/) ?? [])[0]
    expect(requestId).toBeTruthy()

    // A's OWN first-party delegation was recorded (assignee = B).
    const aMission = await delegationStoresFor(tmpA.agentRoot).missionStore.findByMissionKey("ship-feature")
    const aDelegation = Object.values(aMission?.delegations ?? {})[0]
    expect(aDelegation?.assignee?.agentId).toBe(b.id.did)

    // B's inbound bridge already ran importCoordination → importedDelegations[A][reqId].
    const bMission = await delegationStoresFor(tmpB.agentRoot).missionStore.findByMissionKey("ship-feature")
    const bImported = bMission?.importedDelegations?.[a.id.did]
    expect(bImported).toBeDefined()
    expect(Object.keys(bImported ?? {})).toHaveLength(1)
    const importedReqId = Object.keys(bImported ?? {})[0]
    expect(bImported?.[importedReqId]?.task.summary).toBe("build the API side")
  })

  it("list_delegations reads the quarantined importedDelegations on B's side", async () => {
    // Construct B's mission store with a pre-imported delegation (simulating what the
    // inbound bridge wrote), then read it via the tool.
    tmpB = createTmpBundle({ agentName: "coord-list" })
    const aDid = "did:key:zAAA"
    const { missionStore } = delegationStoresFor(tmpB.agentRoot)
    const now = new Date().toISOString()
    // recordMission then add an imported delegation.
    const { recordMission } = await import("@ouro.bot/friends")
    const m = await recordMission(missionStore, { missionKey: "mk-list", title: "Listed" })
    await missionStore.put(m.id, {
      ...m,
      importedDelegations: { [aDid]: { "req-9": { task: { requestId: "req-9", summary: "imported task" }, provenance: { assertedBy: { agentId: aDid, displayName: "A" }, assertedAt: now, origin: "imported" } } } },
    })

    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)
    const out = await tool("list_delegations")({}, localCtx(tmpB.agentRoot, bStore))
    const parsed = JSON.parse(out)
    expect(Array.isArray(parsed)).toBe(true)
    const entry = parsed.find((d: { requestId: string }) => d.requestId === "req-9")
    expect(entry).toBeDefined()
    expect(entry.fromAgentId).toBe(aDid)
    expect(entry.missionKey).toBe("mk-list")
    expect(entry.summary).toBe("imported task")
  })

  it("coordinate refuses an untrusted (acquaintance) recipient — no_consent, nothing sealed", async () => {
    tmpA = createTmpBundle({ agentName: "coord-untrusted" })
    const a = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpA.agentName, { a2a: { identity: { ed25519Seed: a.seed } } })
    const peer = seededIdentity()
    const aStore = new FileFriendStore(`${tmpA.agentRoot}/friends`)
    await upsertAgentPeer(aStore, {
      name: "Acq", agentId: peer.id.did, trustLevel: "acquaintance",
      a2a: { did: peer.id.did, agentId: peer.id.did, endpointUrl: "https://acq.example/a2a" },
    })
    const rec = await aStore.findByExternalId("a2a-agent", peer.id.did)
    const out = await tool("coordinate")({
      friend_id: rec!.id, mission_key: "mk-x", mission_title: "X", task_summary: "do x",
    }, localCtx(tmpA.agentRoot, aStore))
    expect(out).toMatch(/friend or family|no_consent|not permitted/i)
  })
})
