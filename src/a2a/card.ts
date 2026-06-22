import { emitNervesEvent } from "../nerves/runtime"
import { A2A_DEFAULT_PATH, A2A_DEFAULT_PROTOCOL_VERSION, a2aEndpointFromBaseUrl } from "./config"
import type { A2AAgentCard } from "./types"

export interface BuildA2AAgentCardOptions {
  agentName: string
  baseUrl: string
  description?: string
  path?: string
  /** The agent's `did:key`. When present, served as top-level `card.did` so a
   * friends peer can verify the card↔DID binding (`verifyCardDidBinding`). Absent
   * ⇒ the card omits `did` (legacy/no-identity, backward-compatible). */
  did?: string
}

export function buildA2AAgentCard(options: BuildA2AAgentCardOptions): A2AAgentCard {
  const endpoint = a2aEndpointFromBaseUrl(options.baseUrl, options.path ?? A2A_DEFAULT_PATH)
  const card: A2AAgentCard = {
    name: options.agentName,
    description: options.description ?? `Ouroboros agent ${options.agentName}`,
    protocolVersion: A2A_DEFAULT_PROTOCOL_VERSION,
    ...(options.did ? { did: options.did } : {}),
    url: endpoint,
    preferredTransport: "JSONRPC",
    supportedInterfaces: [{
      url: endpoint,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_DEFAULT_PROTOCOL_VERSION,
    }],
    additionalInterfaces: [{
      url: endpoint,
      transport: "JSONRPC",
    }],
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "ouro-message",
        name: "Message Ouro Agent",
        description: "Send a message or task request through the Ouro A2A sense.",
        tags: ["ouro", "agent", "work"],
        examples: ["Ask this Ouro agent to continue or complete a delegated task."],
        inputModes: ["text/plain"],
        outputModes: ["text/plain", "application/json"],
      },
    ],
    metadata: {
      ouro: {
        sense: "a2a",
        agentName: options.agentName,
      },
    },
  }

  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_card_built",
    message: "built A2A agent card",
    meta: { agentName: options.agentName, endpoint, ...(options.did ? { did: options.did } : {}) },
  })

  return card
}
