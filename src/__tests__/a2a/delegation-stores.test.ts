import { afterEach, describe, expect, it } from "vitest"
import * as path from "node:path"
import { missionsDirFor, grantsDirFor, recordMission } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { delegationStoresFor } from "../../a2a/delegation-stores"

let tmp: TmpBundleHandle | null = null

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

describe("delegation store footprint (FileMissionStore + FileGrantStore, canonical path)", () => {
  it("roots the mission store at the SAME path the Slice-1 inbound bridge uses", () => {
    tmp = createTmpBundle({ agentName: "delg-store-path" })
    const stores = delegationStoresFor(tmp.agentRoot)
    // The canonical mission home is <agentRoot>/friends/_missions (missionsDirFor),
    // identical to the inbound bridge's `new FileMissionStore(missionsDirFor(...))`.
    expect(stores.missionsDir).toBe(missionsDirFor(path.join(tmp.agentRoot, "friends")))
    // The grant home is the sibling <agentRoot>/friends/_grants (grantsDirFor).
    expect(stores.grantsDir).toBe(grantsDirFor(path.join(tmp.agentRoot, "friends")))
  })

  it("the mission store round-trips a mission with the 4 delegation namespaces", async () => {
    tmp = createTmpBundle({ agentName: "delg-store-roundtrip" })
    const { missionStore } = delegationStoresFor(tmp.agentRoot)

    // Create a first-party mission and write into all four namespaces; read it back
    // through a FRESH store at the same path (durability + normalize round-trip).
    const created = await recordMission(missionStore, { missionKey: "mk-1", title: "Test mission" })
    const now = new Date().toISOString()
    await missionStore.put(created.id, {
      ...created,
      delegations: { "req-1": { task: { requestId: "req-1", summary: "do X" }, assignee: { agentId: "did:key:zB", displayName: "B" }, provenance: { assertedBy: { agentId: "self", displayName: "Self" }, assertedAt: now } } },
      importedDelegations: { "did:key:zA": { "req-2": { task: { requestId: "req-2", summary: "do Y" }, provenance: { assertedBy: { agentId: "did:key:zA", displayName: "A" }, assertedAt: now, origin: "imported" } } } },
      results: { "req-1": { requestId: "req-1", summary: "did X", provenance: { assertedBy: { agentId: "self", displayName: "Self" }, assertedAt: now } } },
      importedResults: { "did:key:zB": { "req-3": { requestId: "req-3", summary: "B did Z", provenance: { assertedBy: { agentId: "did:key:zB", displayName: "B" }, assertedAt: now, origin: "imported" } } } },
    })

    const fresh = delegationStoresFor(tmp.agentRoot).missionStore
    const reloaded = await fresh.get(created.id)
    expect(reloaded).not.toBeNull()
    expect(reloaded?.delegations?.["req-1"]?.assignee?.agentId).toBe("did:key:zB")
    expect(reloaded?.importedDelegations?.["did:key:zA"]?.["req-2"]?.task.summary).toBe("do Y")
    expect(reloaded?.results?.["req-1"]?.summary).toBe("did X")
    expect(reloaded?.importedResults?.["did:key:zB"]?.["req-3"]?.summary).toBe("B did Z")
  })

  it("findByMissionKey resolves a recorded mission", async () => {
    tmp = createTmpBundle({ agentName: "delg-store-bykey" })
    const { missionStore } = delegationStoresFor(tmp.agentRoot)
    await recordMission(missionStore, { missionKey: "mk-find", title: "Findable" })
    const found = await missionStore.findByMissionKey("mk-find")
    expect(found?.missionKey).toBe("mk-find")
  })
})
