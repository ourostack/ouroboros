import * as os from "os"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * BlueBubbles acts as whichever Apple ID is signed in to the macOS account its
 * server runs under. Each agent declares that account as
 * `senses.bluebubbles.hostUsername`. These checks gate the daemon (the sense
 * runs only once a host is declared) and BlueBubbles server setup (it is only
 * installed or repaired under a declared host account). At runtime, the
 * BlueBubbles client confirms the server's actual account before every action
 * that acts as the Apple ID (see senses/bluebubbles/host-account-verifier).
 */

export interface OsAccount {
  username: string
  uid: number
}

export type BlueBubblesHostAccountCheck =
  | { ok: true }
  | { ok: false; reason: "unset" | "mismatch"; message: string }

const HUMAN_DECISION = "Choosing senses.bluebubbles.hostUsername is a human decision, because it chooses whose Apple ID the agent speaks as."

export function currentOsAccount(): OsAccount {
  const info = os.userInfo()
  return { username: info.username, uid: info.uid }
}

function refuse(reason: "unset" | "mismatch", message: string, meta: Record<string, unknown>): BlueBubblesHostAccountCheck {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.bluebubbles_host_account_refused",
    message: "refused BlueBubbles outside its declared macOS host account",
    meta: { reason, ...meta },
  })
  return { ok: false, reason, message }
}

/** Does `agent` declare its iMessage host account at all? */
export function checkBlueBubblesHostDeclared(agent: string, hostUsername: string | undefined): BlueBubblesHostAccountCheck {
  if (hostUsername !== undefined) return { ok: true }
  return refuse(
    "unset",
    `BlueBubbles refused for agent "${agent}": no host account is declared (senses.bluebubbles.hostUsername), so Ouro cannot tell whose Apple ID would send. `
    + `Not starting. Fix: a human sets senses.bluebubbles.hostUsername in agent.json to the macOS account signed in to the agent's own Apple ID. ${HUMAN_DECISION}`,
    { agent },
  )
}

/**
 * May the BlueBubbles server be installed or repaired under `targetUsername`?
 * Only if some agent with BlueBubbles enabled declares that account as its host.
 */
export function checkBlueBubblesHostTarget(
  targetUsername: string,
  declared: ReadonlyArray<{ agent: string; hostUsername?: string }>,
): BlueBubblesHostAccountCheck {
  if (declared.some((entry) => entry.hostUsername === targetUsername)) return { ok: true }
  const withHost = declared.filter((entry) => entry.hostUsername !== undefined)
  if (withHost.length === 0) {
    return refuse(
      "unset",
      `BlueBubbles host setup refused for macOS account "${targetUsername}": no agent with BlueBubbles enabled declares senses.bluebubbles.hostUsername. `
      + `Fix: a human declares the macOS account signed in to the agent's own Apple ID as senses.bluebubbles.hostUsername. ${HUMAN_DECISION}`,
      { targetUsername },
    )
  }
  const hosts = withHost.map((entry) => `${entry.agent} -> "${entry.hostUsername}"`).join(", ")
  return refuse(
    "mismatch",
    `BlueBubbles host setup refused for macOS account "${targetUsername}": no agent declares it as its iMessage host (declared: ${hosts}). `
    + `Set up BlueBubbles under a declared account instead. ${HUMAN_DECISION}`,
    { targetUsername, hosts },
  )
}
