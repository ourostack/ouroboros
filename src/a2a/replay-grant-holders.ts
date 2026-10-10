import { emitNervesEvent } from "../nerves/runtime"
import { readGrantFile } from "./operator-trust"

/**
 * The friends the replay gate provisioned as replay peers, kept by the gate itself as root inside the operator trust directory
 * (`replay-identities.json`, `{ schemaVersion: 1, grants: { <friend id>: { who, name, did } } }`). A grant for one of them must
 * carry an expiry (and so must every grant when this file is present but cannot be trusted), so a permanent grant can never be left behind by a replay run. This list is the authority for that rule: the
 * bundle's own replay registry and a grant's free-text source are the agent's to edit and decide nothing here.
 */
export const REPLAY_GRANT_HOLDERS_FILE = "replay-identities.json"

interface ReplayGrantHolder {
  who: string
  name: string
  did: string
}

function validHolder(value: unknown): value is ReplayGrantHolder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const holder = value as Record<string, unknown>
  return typeof holder.who === "string" && typeof holder.name === "string" && typeof holder.did === "string"
}

/**
 * True when a grant with no expiry for this friend must be refused. That is the case for a friend the list names, for an entry in the list
 * that is malformed (its id is read from the file but its content is not trusted), and for every friend when the list is present but
 * untrusted or malformed: a list the Butler cannot rely on must never let a permanent replay grant through. A list that does not exist
 * yet (no replay gate has run) names nobody.
 */
export function isReplayGrantHolder(agentRoot: string, friendId: string): boolean {
  const view = readGrantFile(agentRoot, REPLAY_GRANT_HOLDERS_FILE, validHolder)
  if (view.state === "untrusted") {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.a2a_replay_list_untrusted", message: "the replay list is present but cannot be trusted, so no grant without an expiry is honoured", meta: { file: REPLAY_GRANT_HOLDERS_FILE } })
    return true
  }
  return Object.prototype.hasOwnProperty.call(view.grants, friendId) || view.ignored.includes(friendId)
}
