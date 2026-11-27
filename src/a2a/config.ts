import { createHash } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { productFor } from "../heart/product/active"

export const A2A_DEFAULT_PROTOCOL_VERSION = "1.0"
export const A2A_DEFAULT_HOST = "127.0.0.1"
export const A2A_DEFAULT_PATH = "/a2a"

export function defaultA2APort(agentName: string): number {
  // A product's agent keeps the port its first name gave, whatever it is called now: peers saved its agent card at that
  // port, so a rename must not move it. Its names run current first, so the first name is the last one listed.
  const portKey = productFor(agentName)?.agents.at(-1) ?? agentName
  const digest = createHash("sha256").update(portKey).digest()
  const port = 18920 + (digest[0] % 60)
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_default_port",
    message: "computed default A2A port",
    meta: { agentName, port },
  })
  return port
}

export function normalizeA2APath(value: string | undefined): string {
  const trimmed = value?.trim()
  const normalized = !trimmed
    ? A2A_DEFAULT_PATH
    : trimmed.startsWith("/")
      ? trimmed
      : `/${trimmed}`
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_path_normalized",
    message: "normalized A2A path",
    meta: { normalized },
  })
  return normalized
}

export function a2aEndpointFromBaseUrl(baseUrl: string, a2aPath = A2A_DEFAULT_PATH): string {
  const url = new URL(baseUrl)
  url.pathname = normalizeA2APath(a2aPath)
  url.search = ""
  url.hash = ""
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_endpoint_built",
    message: "built A2A endpoint URL",
    meta: { endpoint: url.toString() },
  })
  return url.toString()
}
