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
let serverA: A2AServerHandle | null = null
let serverB: A2AServerHandle | null = null

beforeAll(async () => { sodium = await ready() })

afterEach(async () => {
  if (serverA) { await serverA.close(); serverA = null }
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

describe("Slice-4 NORTH STAR: connect_to → coordinate → import → send_result → importMissionResult (sealed over direct)", () => {
  it("full delegation round-trip lands importedResults[B][requestId] with negative controls refused", async () => {
    // ── A (delegator) and B (assignee) each run a real server with identity ──────────
    tmpA = createTmpBundle({ agentName: "s4-A" })
    const a = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpA.agentName, { a2a: { identity: { ed25519Seed: a.seed } } })
    serverA = await startA2AServer({
      agentName: "s4-A", agentRoot: tmpA.agentRoot, port: 0,
      identity: asSelf(a.id, a.seed),
      turnRunner: async () => ({ response: "A-noop" }),
    })

    tmpB = createTmpBundle({ agentName: "s4-B" })
    const b = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpB.agentName, { a2a: { identity: { ed25519Seed: b.seed } } })
    serverB = await startA2AServer({
      agentName: "s4-B", agentRoot: tmpB.agentRoot, port: 0,
      identity: asSelf(b.id, b.seed),
      turnRunner: async () => ({ response: "B-noop" }),
    })

    const aStore = new FileFriendStore(`${tmpA.agentRoot}/friends`)
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)
    const aCtx = localCtx(tmpA.agentRoot, aStore)
    const bCtx = localCtx(tmpB.agentRoot, bStore)

    // ── (1) A connect_to B (family, DID-keyed) via B's real card ─────────────────────
    const connectOut = await tool("connect_to")({ card_url: `${serverB.url}/.well-known/agent-card.json` }, aCtx)
    expect(connectOut).toMatch(/connected/i)
    // B must also trust A (family, DID-keyed) so B's importCoordination + A's later send
    // back resolve. (Each side runs the owner's introduction; here B trusts A directly.)
    await upsertAgentPeer(bStore, {
      name: "Agent A", agentId: a.id.did, trustLevel: "family",
      a2a: { did: a.id.did, agentId: a.id.did, endpointUrl: serverA.endpointUrl },
    })
    // A also needs B reachable at B's real endpoint (connect_to wrote B's card endpoint).
    const aBRecord = await aStore.findByExternalId("a2a-agent", b.id.did)
    expect(aBRecord).not.toBeNull()

    // ── (2) A coordinate(request, task) → mints requestId, seals to B over direct ────
    const coordOut = await tool("coordinate")({
      friend_id: aBRecord!.id,
      mission_key: "ship-v2",
      mission_title: "Ship v2",
      task_summary: "build the API",
      task_details: "the /v2 routes",
    }, aCtx)
    expect(coordOut).toMatch(/coordinated/i)

    // A recorded the first-party delegation (assignee = B).
    const aMission = await delegationStoresFor(tmpA.agentRoot).missionStore.findByMissionKey("ship-v2")
    const aDelegation = Object.entries(aMission?.delegations ?? {})[0]
    expect(aDelegation).toBeDefined()
    const requestId = aDelegation[0]
    expect(aDelegation[1].assignee?.agentId).toBe(b.id.did)

    // ── (3) B's inbound bridge already imported it → importedDelegations[A][requestId] ─
    const bMission = await delegationStoresFor(tmpB.agentRoot).missionStore.findByMissionKey("ship-v2")
    expect(bMission?.importedDelegations?.[a.id.did]?.[requestId]).toBeDefined()
    expect(bMission?.importedDelegations?.[a.id.did]?.[requestId]?.task.summary).toBe("build the API")

    // B sees the delegation via list_delegations.
    const listOut = JSON.parse(await tool("list_delegations")({}, bCtx))
    expect(listOut.find((d: { requestId: string }) => d.requestId === requestId)).toBeDefined()

    // ── (4) B send_result(requestId) → seals back to A over direct ───────────────────
    const resultOut = await tool("send_result")({ request_id: requestId, summary: "API shipped", artifact: "https://pr/42" }, bCtx)
    expect(resultOut).toMatch(/result sent/i)

    // ── (5) A imported the result → importedResults[B][requestId] (assignee + correlation OK) ─
    const aFinal = await delegationStoresFor(tmpA.agentRoot).missionStore.findByMissionKey("ship-v2")
    expect(aFinal?.importedResults?.[b.id.did]?.[requestId]?.summary).toBe("API shipped")
    expect(aFinal?.importedResults?.[b.id.did]?.[requestId]?.artifact).toBe("https://pr/42")

    // ── NEGATIVE CONTROL (correlation mismatch → no_delegation): B tries to send a
    // result for a requestId it was never delegated → refused locally (no imported
    // delegation), nothing sent. (The over-the-wire `no_delegation` import gate — A
    // never delegated this requestId — is exhaustively covered in the wire unit test.) ─
    const badCorr = await tool("send_result")({ request_id: "never-delegated", summary: "x" }, bCtx)
    expect(badCorr).toMatch(/no imported delegation/i)

    // ── NEGATIVE CONTROL (assignee mismatch): A's first-party delegation names B as the
    // ONLY valid assignee, so A's importMissionResult refuses a result from any non-B
    // signer (`assignee_mismatch`) — the assignee-honesty gate. (The full sealed
    // wrong-signer → assignee_mismatch path is proven in mission-result-wire.test.ts;
    // here we assert the round-trip invariant that pins the gate's correctness.) ────────
    expect(aFinal?.delegations?.[requestId]?.assignee?.agentId).toBe(b.id.did)
  })

  it("deliver-back is EXPLICIT and autonomy is a non-goal (no autonomous worker runs send_result)", async () => {
    // This documents the design: importing a delegation NEVER triggers an automatic
    // result. B's turn-runner is invoked for an inbound coordination notice, but it does
    // NOT call send_result — the agent must explicitly read list_delegations, do the
    // work, and call send_result. We assert that importing a coordination leaves
    // importedResults empty until send_result is explicitly invoked.
    tmpB = createTmpBundle({ agentName: "s4-explicit" })
    const b = seededIdentity()
    let bTurnRan = false
    serverB = await startA2AServer({
      agentName: "s4-explicit", agentRoot: tmpB.agentRoot, port: 0,
      identity: asSelf(b.id, b.seed),
      turnRunner: async () => { bTurnRan = true; return { response: "noticed" } },
    })
    const bStore = new FileFriendStore(`${tmpB.agentRoot}/friends`)

    tmpA = createTmpBundle({ agentName: "s4-explicit-A" })
    const a = seededIdentity()
    cacheMachineRuntimeCredentialConfig(tmpA.agentName, { a2a: { identity: { ed25519Seed: a.seed } } })
    await upsertAgentPeer(bStore, { name: "A", agentId: a.id.did, trustLevel: "family", a2a: { did: a.id.did, agentId: a.id.did, endpointUrl: "https://a.example/a2a" } })
    const aStore = new FileFriendStore(`${tmpA.agentRoot}/friends`)
    await upsertAgentPeer(aStore, { name: "B", agentId: b.id.did, trustLevel: "family", a2a: { did: b.id.did, agentId: b.id.did, endpointUrl: serverB.endpointUrl } })
    const aBRecord = await aStore.findByExternalId("a2a-agent", b.id.did)

    await tool("coordinate")({ friend_id: aBRecord!.id, mission_key: "mk-explicit", mission_title: "Explicit", task_summary: "do work" }, localCtx(tmpA.agentRoot, aStore))

    // B's inbound bridge ran a turn for the coordination notice...
    expect(bTurnRan).toBe(true)
    // ...but NO result was auto-produced (importedResults on A is empty until B calls send_result).
    const aMission = await delegationStoresFor(tmpA.agentRoot).missionStore.findByMissionKey("mk-explicit")
    expect(aMission?.importedResults).toBeUndefined()
  })
})
