import * as os from "os"
import { emitNervesEvent } from "../nerves/runtime"
import { loadAgentConfig, type AgentConfig } from "./identity"

/**
 * BlueBubbles sends iMessages as whichever Apple ID is signed in to the macOS
 * account it runs under. Running it under the wrong account makes the agent
 * speak as that account's human. Every path that starts the BlueBubbles sense
 * or installs/repairs the BlueBubbles server checks the account here first,
 * and fails closed when the host account is not declared.
 */

export interface OsAccount {
  username: string
  uid: number
}

export type BlueBubblesHostAccountCheck =
  | { ok: true }
  | { ok: false; reason: "unset" | "mismatch"; message: string }

const FIX_SET_FIELD = "set senses.bluebubbles.hostUsername in agent.json"

export function currentOsAccount(): OsAccount {
  const info = os.userInfo()
  return { username: info.username, uid: info.uid }
}

function refuse(reason: "unset" | "mismatch", message: string, meta: Record<string, unknown>): BlueBubblesHostAccountCheck {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.bluebubbles_host_account_refused",
    message: "refused BlueBubbles outside its configured macOS host account",
    meta: { reason, ...meta },
  })
  return { ok: false, reason, message }
}

/** Is the current OS account the one `agent` declares as its iMessage host? */
export function checkBlueBubblesHostAccount(
  agent: string,
  hostUsername: string | undefined,
  current: OsAccount,
): BlueBubblesHostAccountCheck {
  if (hostUsername === current.username) return { ok: true }
  const running = `this process is running as "${current.username}" (uid ${current.uid})`
  if (hostUsername === undefined) {
    return refuse(
      "unset",
      `BlueBubbles refused for agent "${agent}": no host account is configured (senses.bluebubbles.hostUsername), and ${running}. `
      + `Not starting, so the agent cannot send from the wrong Apple ID. Fix: ${FIX_SET_FIELD} to the macOS account signed in to the agent's own Apple ID.`,
      { agent, currentUsername: current.username },
    )
  }
  return refuse(
    "mismatch",
    `BlueBubbles refused for agent "${agent}": iMessage is configured to run under macOS account "${hostUsername}", but ${running}. `
    + `Not starting, so the agent cannot send from the wrong Apple ID. Fix: run ouro as "${hostUsername}", or ${FIX_SET_FIELD}.`,
    { agent, hostUsername, currentUsername: current.username },
  )
}

/**
 * Agent-independent check for installing or repairing the BlueBubbles server
 * under `targetUsername`: some agent with BlueBubbles enabled must declare
 * that account as its host.
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
      + `Fix: ${FIX_SET_FIELD} for the agent, naming the macOS account signed in to its own Apple ID.`,
      { targetUsername },
    )
  }
  const hosts = withHost.map((entry) => `${entry.agent} -> "${entry.hostUsername}"`).join(", ")
  return refuse(
    "mismatch",
    `BlueBubbles host setup refused for macOS account "${targetUsername}": no agent declares it as its iMessage host (declared: ${hosts}). `
    + `Run this as the declared account, or ${FIX_SET_FIELD}.`,
    { targetUsername, hosts },
  )
}

/** The sense-process check: the running agent's own declared host account against this process. */
export function checkBlueBubblesSenseHostAccount(
  agent: string,
  loadConfig: () => Pick<AgentConfig, "senses"> = () => loadAgentConfig(),
  current: OsAccount = currentOsAccount(),
): BlueBubblesHostAccountCheck {
  return checkBlueBubblesHostAccount(agent, loadConfig().senses?.bluebubbles.hostUsername, current)
}
