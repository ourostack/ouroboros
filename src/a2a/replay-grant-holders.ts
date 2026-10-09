import { readGrantFile } from "./operator-trust"

/**
 * The friends the replay gate provisioned as replay peers, kept by the gate itself as root inside the operator trust directory
 * (`replay-identities.json`, `{ schemaVersion: 1, grants: { <friend id>: { who, name, did } } }`). A grant for one of them must
 * carry an expiry, so a permanent grant can never be left behind by a replay run. This list is the authority for that rule: the
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

export function isReplayGrantHolder(agentRoot: string, friendId: string): boolean {
  return Object.prototype.hasOwnProperty.call(readGrantFile(agentRoot, REPLAY_GRANT_HOLDERS_FILE, validHolder).grants, friendId)
}
