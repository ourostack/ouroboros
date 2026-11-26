/**
 * The Butler's agent names: `butler`, and `sanctuary` from before the rename (M2). Every check that picks Butler behaviour
 * asks this, so an install runs the same whichever name its bundle has.
 */
export const BUTLER_AGENT_NAMES = ["butler", "sanctuary"] as const

/** One of the Butler's names. Saved state written before the rename says `sanctuary`; readers accept either. */
export type ButlerAgentName = typeof BUTLER_AGENT_NAMES[number]

/** Whether this agent (or a saved record's `agent` field) is the Butler, under its name or its name from before the rename. */
export function isButlerAgent(agentName: unknown): agentName is ButlerAgentName {
  return typeof agentName === "string" && (BUTLER_AGENT_NAMES as readonly string[]).includes(agentName)
}
