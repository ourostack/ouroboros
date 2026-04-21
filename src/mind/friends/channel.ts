// Channel capabilities -- hardcoded const map keyed by channel identifier.
// Pure lookup, no I/O, cannot fail. Unknown channel gets minimal defaults.

import { emitNervesEvent } from "../../nerves/runtime"
import type { ChannelCapabilities, Channel } from "./types"

export type Facing = "human" | "agent"

const AGENT_FACING_CHANNELS: ReadonlySet<string> = new Set(["inner", "mcp"])

export function channelToFacing(channel?: Channel | string): Facing {
  const facing: Facing = channel && AGENT_FACING_CHANNELS.has(channel) ? "agent" : "human"
  emitNervesEvent({
    component: "channels",
    event: "channel.facing_lookup",
    message: "channel facing lookup",
    meta: { channel: channel ?? "undefined", facing },
  })
  return facing
}

const CHANNEL_CAPABILITIES: Record<string, ChannelCapabilities> = {
  cli: {
    channel: "cli",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
  teams: {
    channel: "teams",
    senseType: "closed",
    availableIntegrations: ["ado", "graph", "github"],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: true,
    maxMessageLength: Infinity,
  },
  bluebubbles: {
    channel: "bluebubbles",
    senseType: "open",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
  mail: {
    channel: "mail",
    senseType: "open",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
  inner: {
    channel: "inner",
    senseType: "internal",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
  mcp: {
    channel: "mcp",
    senseType: "local",
    availableIntegrations: [],
    supportsMarkdown: true,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
}

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  channel: "cli",
  senseType: "local",
  availableIntegrations: [],
  supportsMarkdown: false,
  supportsStreaming: false,
  supportsRichCards: false,
  maxMessageLength: Infinity,
}

export function getChannelCapabilities(channel: string): ChannelCapabilities {
  emitNervesEvent({
    component: "channels",
    event: "channel.capabilities_lookup",
    message: "channel capabilities lookup",
    meta: { channel },
  })
  return CHANNEL_CAPABILITIES[channel] ?? DEFAULT_CAPABILITIES
}

/** Whether the channel is remote (open or closed) vs local/internal. */
export function isRemoteChannel(capabilities?: ChannelCapabilities): boolean {
  const senseType = capabilities?.senseType
  return senseType !== undefined && senseType !== "local" && senseType !== "internal"
}

/**
 * Returns channel names whose senseType is "open" or "closed" -- i.e. channels
 * that are always-on (daemon-managed) rather than interactive or internal.
 */
export function getAlwaysOnSenseNames(): string[] {
  emitNervesEvent({
    component: "channels",
    event: "channel.always_on_lookup",
    message: "always-on sense names lookup",
    meta: {},
  })
  return Object.entries(CHANNEL_CAPABILITIES)
    .filter(([, cap]) => cap.senseType === "open" || cap.senseType === "closed")
    .map(([channel]) => channel)
}
