/** Channels an agent can reach a person on outside a live conversation. */
export const REACH_CHANNELS = ["bluebubbles", "teams"] as const
export type ReachChannel = typeof REACH_CHANNELS[number]
