import * as path from "node:path"
import {
  FileMissionStore,
  FileGrantStore,
  missionsDirFor,
  grantsDirFor,
  type MissionStore,
  type GrantStore,
} from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * The Slice-4 delegation stores, rooted at the SAME canonical home the Slice-1 inbound
 * bridge uses (`<agentRoot>/friends/_missions` via `missionsDirFor`). This is the
 * single source of truth for the delegation surface: the inbound bridge's
 * `receiveShare → importCoordination` writes `importedDelegations[A][requestId]` HERE,
 * and the Slice-4 `coordinate` / `send_result` tools read/prepare from the SAME store —
 * so a quarantined inbound delegation is visible to the read surface, and no second
 * store at a divergent path can fork the state.
 *
 * `FileGrantStore` is required because `prepareCoordination` and `prepareMissionResult`
 * both take a `GrantStore` (consent-gated producers). The grants home is the sibling
 * `<agentRoot>/friends/_grants` (`grantsDirFor`). `FileRosterStore` is NOT wired —
 * roster auto-family is out of scope.
 */
export interface DelegationStores {
  missionStore: MissionStore
  grantStore: GrantStore
  /** The resolved mission directory (`<agentRoot>/friends/_missions`). */
  missionsDir: string
  /** The resolved grants directory (`<agentRoot>/friends/_grants`). */
  grantsDir: string
}

export function delegationStoresFor(agentRoot: string): DelegationStores {
  const friendsDir = path.join(agentRoot, "friends")
  const missionsDir = missionsDirFor(friendsDir)
  const grantsDir = grantsDirFor(friendsDir)
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_delegation_stores_init",
    message: "initialized A2A delegation stores (mission + grant)",
    meta: { missionsDir, grantsDir },
  })
  return {
    missionStore: new FileMissionStore(missionsDir),
    grantStore: new FileGrantStore(grantsDir),
    missionsDir,
    grantsDir,
  }
}
