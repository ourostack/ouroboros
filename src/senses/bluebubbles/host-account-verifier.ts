import { emitNervesEvent } from "../../nerves/runtime"

/**
 * BlueBubbles acts as whichever Apple ID is signed in to the macOS account its
 * server runs under, wherever Ouro itself runs. Before anything that acts as
 * that Apple ID (sending, editing, typing, read receipts), confirm the server
 * reports the agent's declared host account. BlueBubbles server info reports
 * `computer_id` as `<macOS username>@<hostname>`. Anything unconfirmed fails
 * closed.
 */

export class BlueBubblesHostAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BlueBubblesHostAccountError"
  }
}

export interface BlueBubblesServerAccountInput {
  agent: string
  hostUsername: string | undefined
  serverUrl: string
  password: string
  requestTimeoutMs: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const VERIFIED_TTL_MS = 60_000
const verifiedAt = new Map<string, number>()

/** Test seam: forget cached verifications. */
export function resetBlueBubblesServerAccountCache(): void {
  verifiedAt.clear()
}

function refuse(message: string, meta: Record<string, unknown>): never {
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.bluebubbles_host_account_refused",
    message: "refused BlueBubbles action outside the agent's declared host account",
    meta,
  })
  throw new BlueBubblesHostAccountError(message)
}

function serverInfoUrl(serverUrl: string, password: string): string {
  const root = serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`
  const url = new URL("api/v1/server/info", root)
  url.searchParams.set("password", password)
  return url.toString()
}

async function readServerUsername(input: BlueBubblesServerAccountInput): Promise<string | null> {
  try {
    const response = await (input.fetchImpl ?? fetch)(serverInfoUrl(input.serverUrl, input.password), {
      method: "GET",
      signal: AbortSignal.timeout(input.requestTimeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json() as { data?: { computer_id?: unknown } }
    const computerId = body?.data?.computer_id
    if (typeof computerId !== "string") return null
    const at = computerId.indexOf("@")
    const username = at > 0 ? computerId.slice(0, at) : ""
    return username || null
  } catch {
    return null
  }
}

export async function verifyBlueBubblesServerAccount(input: BlueBubblesServerAccountInput): Promise<void> {
  const { agent, hostUsername, serverUrl } = input
  if (hostUsername === undefined) {
    refuse(
      `BlueBubbles refused for agent "${agent}": no host account is declared (senses.bluebubbles.hostUsername), so Ouro cannot tell whose Apple ID would send. `
      + "Not sending. Fix: a human sets senses.bluebubbles.hostUsername in agent.json to the macOS account signed in to the agent's own Apple ID.",
      { agent, reason: "unset" },
    )
  }
  const now = (input.now ?? Date.now)()
  const key = `${serverUrl}\u0000${hostUsername}`
  const cached = verifiedAt.get(key)
  if (cached !== undefined && now - cached < VERIFIED_TTL_MS) return

  const serverUsername = await readServerUsername(input)
  if (serverUsername === null) {
    verifiedAt.delete(key)
    refuse(
      `BlueBubbles refused for agent "${agent}": could not confirm which macOS account the BlueBubbles server at ${serverUrl} runs under. Not sending.`,
      { agent, reason: "unconfirmed", hostUsername },
    )
  }
  if (serverUsername !== hostUsername) {
    verifiedAt.delete(key)
    refuse(
      `BlueBubbles refused for agent "${agent}": the BlueBubbles server at ${serverUrl} runs under macOS account "${serverUsername}", `
      + `but the agent's iMessage host is "${hostUsername}". Not sending, so the agent cannot speak from "${serverUsername}"'s Apple ID. `
      + `Fix: run BlueBubbles under "${hostUsername}" and point bluebubbles.serverUrl at it. Changing senses.bluebubbles.hostUsername is a human decision, because it chooses whose Apple ID the agent speaks as.`,
      { agent, reason: "mismatch", hostUsername, serverUsername },
    )
  }
  verifiedAt.set(key, now)
}
