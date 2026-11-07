import { emitNervesEvent } from "../nerves/runtime"

/**
 * The four friends-relay calls the harness makes (ourostack/friends-relay `src/server/http.ts`): register a handle,
 * send an opaque sealed message to a handle, pull a handle's inbox and ack one queued message. The relay is untrusted
 * and content-blind: it only ever carries the sealed A2A message, byte for byte. Every non-2xx answer throws a
 * `RelayHttpError` carrying the relay's status and error code. A 2xx answer that is not a JSON object (the relay
 * always answers one), and a request with no answer within `RELAY_REQUEST_TIMEOUT_MS`, throw too.
 */
export class RelayHttpError extends Error {
  readonly status: number
  readonly code: string
  /** The answer was the relay's own JSON error (`{ error: "<code>" }`), not a proxy's or a load balancer's page. */
  readonly fromRelay: boolean
  constructor(status: number, code: string, fromRelay = false) {
    super(`relay ${status} ${code}`)
    this.status = status
    this.code = code
    this.fromRelay = fromRelay
  }
}

export const RELAY_REQUEST_TIMEOUT_MS = 30_000

export interface RelayGrant {
  handle: string
  inboxAuth: string
  sendCredential: string
}

export interface RelayQueuedMessage {
  queueId: string
  message: unknown
}

interface RelayCall {
  url: string
  fetchImpl?: typeof fetch
  /** How long to wait for the whole answer; defaults to `RELAY_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number
}

async function relayRequest(input: RelayCall & { method: string; path: string; bearer?: string; body?: unknown }): Promise<Record<string, unknown>> {
  const fetchImpl = input.fetchImpl ?? fetch
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (input.bearer) headers.authorization = `Bearer ${input.bearer}`
  const response = await fetchImpl(`${input.url.replace(/\/+$/, "")}${input.path}`, {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(input.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS),
  })
  const parsed: unknown = await response.json().catch(() => undefined)
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  if (!response.ok) {
    const fromRelay = typeof payload?.error === "string"
    const code = fromRelay ? payload!.error as string : "error"
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_http_error", message: "the A2A relay refused a request", meta: { path: input.path.split("/")[1], status: response.status, code } })
    throw new RelayHttpError(response.status, code, fromRelay)
  }
  if (!payload) throw new Error(`the relay answered ${response.status} without its JSON body`)
  return payload
}

/** Register (or re-register, which rotates both credentials) `handle` for `did`. */
export async function relayRegister(input: RelayCall & { handle: string; did: string; agentCard: Record<string, unknown>; inviteToken?: string }): Promise<RelayGrant> {
  const grant = await relayRequest({
    ...input,
    method: "POST",
    path: "/register",
    body: { handle: input.handle, did: input.did, agentCard: input.agentCard, ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}) },
  })
  if (typeof grant.inboxAuth !== "string" || typeof grant.sendCredential !== "string") throw new Error("relay registration returned no credentials")
  emitNervesEvent({ component: "channels", event: "channel.a2a_relay_registered", message: "registered an A2A relay inbox", meta: { relayUrl: input.url } })
  return { handle: input.handle, inboxAuth: grant.inboxAuth, sendCredential: grant.sendCredential }
}

/** Queue `message` (already sealed and signed) in `handle`'s inbox. Returns the relay's queue id. */
export async function relaySend(input: RelayCall & { handle: string; sendCredential: string; message: unknown }): Promise<string> {
  const result = await relayRequest({ ...input, method: "POST", path: `/a2a/${encodeURIComponent(input.handle)}`, bearer: input.sendCredential, body: input.message })
  // Something other than the relay (a captive portal, a proxy) can answer 2xx; only a queue id means it was queued.
  if (typeof result.taskId !== "string") throw new Error("the relay did not confirm the message was queued")
  emitNervesEvent({ component: "channels", event: "channel.a2a_relay_sent", message: "queued a sealed A2A message at the relay", meta: { relayUrl: input.url } })
  return result.taskId
}

/**
 * The queued messages in `handle`'s inbox (still sealed). An answer with no message list throws: it is not the relay's,
 * so it says nothing about the inbox. An entry without a queue id cannot be acked, so it is logged
 * (without its content) and skipped, and the rest of the queue is still handled. The relay has no way to drop an entry
 * without its id, so a skipped entry stays queued until the relay's own expiry removes it.
 */
export async function relayPull(input: RelayCall & { handle: string; inboxAuth: string }): Promise<RelayQueuedMessage[]> {
  const result = await relayRequest({ ...input, method: "GET", path: `/inbox/${encodeURIComponent(input.handle)}`, bearer: input.inboxAuth })
  if (!Array.isArray(result.messages)) throw new Error("the relay's inbox answer has no message list")
  const entries: unknown[] = result.messages
  const valid: RelayQueuedMessage[] = []
  entries.forEach((entry, position) => {
    const queueId = (entry as { queueId?: unknown } | null)?.queueId
    if (entry && typeof entry === "object" && typeof queueId === "string" && queueId.length > 0) {
      valid.push({ queueId, message: (entry as { message?: unknown }).message })
      return
    }
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_entry_skipped", message: "skipped a relay inbox entry with no queue id; it cannot be acked and stays at the relay until it expires", meta: { relayUrl: input.url, position } })
  })
  return valid
}

/** Remove one delivered message from `handle`'s inbox. Re-acking is harmless. */
export async function relayAck(input: RelayCall & { handle: string; inboxAuth: string; queueId: string }): Promise<void> {
  await relayRequest({ ...input, method: "POST", path: `/inbox/${encodeURIComponent(input.handle)}/ack/${encodeURIComponent(input.queueId)}`, bearer: input.inboxAuth })
}

/** Remove `handle` and its queue from the relay (used when the agent moves to another relay). */
export async function relayDeregister(input: RelayCall & { handle: string; inboxAuth: string }): Promise<void> {
  await relayRequest({ ...input, method: "DELETE", path: `/register/${encodeURIComponent(input.handle)}`, bearer: input.inboxAuth })
  emitNervesEvent({ component: "channels", event: "channel.a2a_relay_deregistered", message: "deregistered an A2A relay inbox", meta: { relayUrl: input.url } })
}
