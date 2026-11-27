import * as path from "path"
import type { Channel } from "@ouro.bot/friends"
import { getAgentRoot } from "./identity"

// Where a sense keeps a session's file. Kept apart from heart/config and senses/shared-turn, which load far more, so code
// that only needs the path (the Butler's root-host tool, which every process on its image loads) stays light.

/** A session key as a file name: slashes and colons become underscores. */
export function sanitizeKey(key: string): string {
  return key.replace(/[/:]/g, "_")
}

/** One session's file: under the agent's state/sessions, by friend, channel and sanitized key. */
export function getSenseSessionPath(agentName: string, friendId: string, channel: Channel, sessionKey: string, agentRootOverride?: string): string {
  return path.join(agentRootOverride ?? getAgentRoot(agentName), "state", "sessions", friendId, channel, `${sanitizeKey(sessionKey)}.json`)
}
