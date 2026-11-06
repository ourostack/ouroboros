import { emitNervesEvent } from "../nerves/runtime"

/**
 * The four friends-relay calls the harness makes (ourostack/friends-relay `src/server/http.ts`): register a handle,
 * send an opaque sealed message to a handle, pull a handle's inbox and ack one queued message. The relay is untrusted
 * and content-blind: it only ever carries the sealed A2A message, byte for byte. Every non-2xx answer throws a
 * `RelayHttpError` carrying the relay's status and error code.
 */
export class RelayHttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(`relay ${status} ${code}`)
    this.status = status
    this.code = code
  }
}

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
}

async function relayRequest(input: RelayCall & { method: string; path: string; bearer?: string; body?: unknown }): Promise<Record<string, unknown>> {
  const fetchImpl = input.fetchImpl ?? fetch
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (input.bearer) headers.authorization = `Bearer ${input.bearer}`
  const response = await fetchImpl(`${input.url.replace(/\/+$/, "")}${input.path}`, {
    method: input.method,
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  const parsed: unknown = await response.json().catch(() => undefined)
  const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "error"
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_http_error", message: "the A2A relay refused a request", meta: { path: input.path.split("/")[1], status: response.status, code } })
    throw new RelayHttpError(response.status, code)
  }
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
  emitNervesEvent({ component: "channels", event: "channel.a2a_relay_sent", message: "queued a sealed A2A message at the relay", meta: { relayUrl: input.url } })
  return String(result.taskId)
}

/** The queued messages in `handle`'s inbox (still sealed). */
export async function relayPull(input: RelayCall & { handle: string; inboxAuth: string }): Promise<RelayQueuedMessage[]> {
  const result = await relayRequest({ ...input, method: "GET", path: `/inbox/${encodeURIComponent(input.handle)}`, bearer: input.inboxAuth })
  return Array.isArray(result.messages) ? result.messages as RelayQueuedMessage[] : []
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
