/**
 * The Butler's agent names: `butler`, and `sanctuary` from before the rename (M2). Every check that picks Butler behaviour
 * asks this, so an install runs the same whichever name its bundle has.
 */
export const BUTLER_AGENT_NAMES: readonly string[] = ["butler", "sanctuary"]

/** Whether this agent is the Butler, under its name or its name from before the rename. */
export function isButlerAgent(agentName: string | undefined | null): boolean {
  return typeof agentName === "string" && BUTLER_AGENT_NAMES.includes(agentName)
}
