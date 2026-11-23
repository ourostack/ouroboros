import { emitNervesEvent } from "../../nerves/runtime"

/**
 * BlueBubbles acts as whichever Apple ID is signed in to the macOS account its
 * server runs under, wherever Ouro itself runs. Before anything that acts as
 * that Apple ID (sending, editing, typing, read receipts), confirm the server
 * reports the agent's declared host account; the inbound webhook and its
 * registration are gated the same way, so the agent neither speaks nor listens
 * as another account's Apple ID. BlueBubbles server info reports `computer_id`
 * as `<macOS username>@<hostname>`. Anything unconfirmed fails closed.
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
  /** Ignore a recent confirmation and ask the server again (used before every send). */
  fresh?: boolean
  /**
   * When the server doesn't answer server info, accept a confirmation this recent instead of refusing. Only for work
   * that can't be asked for again, like an incoming webhook; a mismatch since then always refuses.
   */
  recentConfirmationGraceMs?: number
}

const VERIFIED_TTL_MS = 60_000
const verifiedAt = new Map<string, number>()
/** The last time each server confirmed the account; only a mismatch forgets it. */
const confirmedAt = new Map<string, number>()

/** Test seam: forget cached verifications. */
export function resetBlueBubblesServerAccountCache(): void {
  verifiedAt.clear()
  confirmedAt.clear()
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

/** What a fresh server info call says beyond the account: whether its Private API helper can send right now. */
export interface BlueBubblesServerFacts {
  readonly privateApiReady: boolean
}

async function readServerInfo(input: BlueBubblesServerAccountInput): Promise<{ username: string; facts: BlueBubblesServerFacts } | null> {
  try {
    const response = await (input.fetchImpl ?? fetch)(serverInfoUrl(input.serverUrl, input.password), {
      method: "GET",
      signal: AbortSignal.timeout(input.requestTimeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json() as { data?: { computer_id?: unknown; private_api?: unknown; helper_connected?: unknown } }
    const computerId = body?.data?.computer_id
    if (typeof computerId !== "string") return null
    const at = computerId.indexOf("@")
    const username = at > 0 ? computerId.slice(0, at) : ""
    if (!username) return null
    return { username, facts: { privateApiReady: body.data?.private_api === true && body.data?.helper_connected === true } }
  } catch {
    return null
  }
}

/**
 * Confirms the server runs under the agent's host account, and returns what that server info call said about its
 * Private API helper. A recent confirmation reused without a call returns nothing.
 */
export async function verifyBlueBubblesServerAccount(input: BlueBubblesServerAccountInput): Promise<BlueBubblesServerFacts | undefined> {
  const { agent, hostUsername, serverUrl } = input
  if (hostUsername === undefined) {
    refuse(
      `BlueBubbles refused for agent "${agent}": no host account is declared (senses.bluebubbles.hostUsername), so Ouro cannot tell whose Apple ID this is. `
      + "Not acting. Fix: a human sets senses.bluebubbles.hostUsername in agent.json to the macOS account signed in to the agent's own Apple ID.",
      { agent, reason: "unset" },
    )
  }
  const now = (input.now ?? Date.now)()
  const key = `${serverUrl}\u0000${hostUsername}`
  const cached = verifiedAt.get(key)
  if (!input.fresh && cached !== undefined && now - cached < VERIFIED_TTL_MS) return undefined

  const info = await readServerInfo(input)
  if (info === null) {
    verifiedAt.delete(key)
    const confirmed = confirmedAt.get(key)
    const grace = input.recentConfirmationGraceMs
    if (grace !== undefined && confirmed !== undefined && now - confirmed < grace) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_host_account_recent_confirmation_used",
        message: "BlueBubbles server info did not answer, so a recent confirmation of the host account was used",
        meta: { agent, hostUsername, confirmedMsAgo: now - confirmed },
      })
      return undefined
    }
    refuse(
      `BlueBubbles refused for agent "${agent}": could not confirm which macOS account the BlueBubbles server at ${serverUrl} runs under. Not acting.`,
      { agent, reason: "unconfirmed", hostUsername },
    )
  }
  const serverUsername = info.username
  if (serverUsername !== hostUsername) {
    verifiedAt.delete(key)
    confirmedAt.delete(key)
    refuse(
      `BlueBubbles refused for agent "${agent}": the BlueBubbles server at ${serverUrl} runs under macOS account "${serverUsername}", `
      + `but the agent's iMessage host is "${hostUsername}". Not acting, so the agent neither speaks nor listens as "${serverUsername}"'s Apple ID. `
      + `Fix: run BlueBubbles under "${hostUsername}" and point bluebubbles.serverUrl at it. Changing senses.bluebubbles.hostUsername is a human decision, because it chooses whose Apple ID the agent speaks as.`,
      { agent, reason: "mismatch", hostUsername, serverUsername },
    )
  }
  verifiedAt.set(key, now)
  confirmedAt.set(key, now)
  return info.facts
}
