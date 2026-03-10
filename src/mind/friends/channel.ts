// Channel capabilities -- hardcoded const map keyed by channel identifier.
// Pure lookup, no I/O, cannot fail. Unknown channel gets minimal defaults.

import { emitNervesEvent } from "../../nerves/runtime"
import type { ChannelCapabilities } from "./types"

const CHANNEL_CAPABILITIES: Record<string, ChannelCapabilities> = {
  cli: {
    channel: "cli",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
  teams: {
    channel: "teams",
    availableIntegrations: ["ado", "graph", "github"],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: true,
    maxMessageLength: Infinity,
  },
  bluebubbles: {
    channel: "bluebubbles",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
  inner: {
    channel: "inner",
    availableIntegrations: [],
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  },
}

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  channel: "cli",
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
