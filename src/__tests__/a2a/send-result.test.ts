import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  didKeyIdentityFromEd25519,
  type DidKeyIdentity,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer, recordMission, type FriendRecord, type SenseType } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { cacheMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { delegationStoresFor } from "../../a2a/delegation-stores"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import type { ToolContext } from "../../repertoire/tools-base"
import type { A2AIdentity } from "../../a2a/identity"

let sodium: Sodium
let tmpB: TmpBundleHandle | null = null
let tmpA: TmpBundleHandle | null = null
let serverA: A2AServerHandle | null = null

beforeAll(async () => { sodium = await ready() })

afterEach(async () => {
  if (serverA) { await serverA.close(); serverA = null }
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

function asSelf(id: DidKeyIdentity, seed: string): A2AIdentity { return { ...id, seed } }

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
    signin: async () => undefined, agentRoot, friendStore: store,
    context: {
      friend: requester,
      channel: { channel: "cli", senseType, availableIntegrations: [], supportsMarkdown: false, supportsStreaming: false, supportsRichCards: false, maxMessageLength: Infinity },
    },
  }
}

/** Seed B's side with a quarantined imported delegation from A (as the inbound bridge
 * would have written it), plus A as a trusted DID-keyed peer with a reachable endpoint. */
async function seedImportedDelegation(opts: {
  agentRoot: string; bStore: FileFriendStore; aDid: string; aEndpoint: string; requestId: string; missionKey: string
}): Promise<void> {
  await upsertAgentPeer(opts.bStore, {
    name: "Agent A", agentId: opts.aDid, trustLevel: "family",
    a2a: { did: opts.aDid, agentId: opts.aDid, endpointUrl: opts.aEndpoint },
  })
  const { missionStore } = delegationStoresFor(opts.agentRoot)
  const now = new Date().toISOString()
  const m = await recordMission(missionStore, { missionKey: opts.missionKey, title: "Shared mission" })
  await missionStore.put(m.id, {
    ...m,
    importedDelegations: { [opts.aDid]: { [opts.requestId]: { task: { requestId: opts.requestId, summary: "build the thing" }, provenance: { assertedBy: { agentId: opts.aDid, displayName: "A" }, assertedAt: now, origin: "imported" } } } },
  })
}

describe("send_result tool (B returns a result over the harness-owned wire)", () => {
  it("sends B's result for an imported delegation; A imports it (importedResults[B][requestId])", async () => {
    // A: the delegator — a real server with identity + inbound result wire.
    tmpA = createTmpBundle({ agentName: "sr-A" })
    const a = seededIdentity()
    serverA = await startA2AServer({
      agentName: "sr-A", agentRoot: tmpA.agentRoot, port: 0,
      identity: asSelf(a.id, a.seed),
      turnRunner: async () => ({ response: "noop" }),
    })
    // A's first-party delegation to B (so A's importMissionResult correlates + assignee-checks).
    const aStore = new FileFriendStore(`${tmpA.agentRoot}/friends`)

    // B: the assignee. Seed B's identity + the imported delegation from A.
    tmpB = createTmpBundle({ agentName: "sr-B" })
    const b = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpB.agentName, { a2a: { identity: { ed25519Seed: b.seed } } })
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)
    await seedImportedDelegation({ agentRoot: tmpB.agentRoot, bStore, aDid: a.id.did, aEndpoint: serverA.endpointUrl, requestId: "req-1", missionKey: "mk-1" })

    // A's side: record the first-party delegation to B (assignee = B) so the import gates pass.
    await upsertAgentPeer(aStore, { name: "Agent B", agentId: b.id.did, trustLevel: "family", a2a: { did: b.id.did, agentId: b.id.did, endpointUrl: "https://b.example/a2a" } })
    const { missionStore: aMissions } = delegationStoresFor(tmpA.agentRoot)
    const now = new Date().toISOString()
    const am = await recordMission(aMissions, { missionKey: "mk-1", title: "Shared mission" })
    await aMissions.put(am.id, {
      ...am,
      delegations: { "req-1": { task: { requestId: "req-1", summary: "build the thing" }, assignee: { agentId: b.id.did, displayName: "B" }, provenance: { assertedBy: { agentId: a.id.did, displayName: "A" }, assertedAt: now } } },
    })

    const out = await tool("send_result")({ request_id: "req-1", summary: "built it", artifact: "https://pr/1" }, localCtx(tmpB.agentRoot, bStore))
    expect(out).toMatch(/result sent|delivered/i)

    // A received + imported the result under importedResults[B][req-1].
    const aReloaded = await delegationStoresFor(tmpA.agentRoot).missionStore.findByMissionKey("mk-1")
    expect(aReloaded?.importedResults?.[b.id.did]?.["req-1"]?.summary).toBe("built it")
  })

  it("refuses when the requestId has no matching imported delegation (unknown)", async () => {
    tmpB = createTmpBundle({ agentName: "sr-unknown-req" })
    const b = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpB.agentName, { a2a: { identity: { ed25519Seed: b.seed } } })
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)
    const out = await tool("send_result")({ request_id: "nope", summary: "x" }, localCtx(tmpB.agentRoot, bStore))
    expect(out).toMatch(/no.*delegation|unknown|not found/i)
  })

  it("requires a trusted requester (no friend context → refused)", async () => {
    tmpB = createTmpBundle({ agentName: "sr-no-ctx" })
    const out = await tool("send_result")({ request_id: "r", summary: "x" }, undefined)
    expect(out).toMatch(/no friend context|require/i)
  })
})
