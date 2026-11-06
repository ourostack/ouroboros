import { randomBytes } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { RelayHttpError, relayAck, relayDeregister, relayPull, relayRegister, type RelayQueuedMessage } from "./relay-client"
import type { A2AJsonRpcRequest, A2AJsonRpcResponse, A2AMessage } from "./types"

/**
 * This agent's own friends-relay inbox: where peers queue sealed messages while it is offline. The relay is untrusted
 * and content-blind; every message it hands back runs through the same in-process `message/send` path as a direct POST,
 * so unsealing, signature, pinned-key, replay and friend checks are unchanged.
 *
 * The registration lives in the machine runtime config (the vault), under `a2a.relay`:
 *   url                    the relay to use (set by the operator)
 *   inviteToken            a one-time invite (set by the operator, cleared once used)
 *   registration           { relayUrl, handle, inboxAuth, sendCredential }, written here
 *   pendingRegistration    { relayUrl, handle } of an attempt in progress, so a retry reuses the handle
 *   previousRegistration   the registration on a relay the operator moved away from, kept until drained and removed
 */
export interface RelayRegistration {
  relayUrl: string
  handle: string
  inboxAuth: string
  sendCredential: string
}

export interface RelayConfig {
  url?: string
  inviteToken?: string
  registration?: RelayRegistration
  pendingRegistration?: { relayUrl: string; handle: string }
  previousRegistration?: RelayRegistration
}

/** Reads and patches `a2a.relay`. A patch merges into the stored object; a key set to `undefined` is removed. */
export interface RelayConfigStore {
  read(): Promise<RelayConfig>
  write(patch: { [K in keyof RelayConfig]?: RelayConfig[K] | undefined }): Promise<void>
}

export const RELAY_POLL_INTERVAL_MS = 30_000
export const RELAY_MAX_BACKOFF_MS = 5 * 60_000
export const RELAY_MAX_PER_TICK = 20

function errorText(error: unknown): string {
  /* v8 ignore next -- the relay client and the vault only throw Error instances @preserve */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Make sure this agent holds a registration on the configured relay, registering when there is none, when the relay
 * URL changed, or when the operator supplied an invite token. Returns the registration to poll, or null.
 */
export async function ensureRelayRegistration(input: {
  config: RelayConfigStore
  did: string
  agentName: string
  fetchImpl?: typeof fetch
}): Promise<RelayRegistration | null> {
  const config = await input.config.read()
  const url = config.url
  const current = config.registration
  if (!url) return null
  if (current && current.relayUrl === url && !config.inviteToken) return current
  // One move at a time: while an older relay still holds mail, moving again would forget it.
  if (current && current.relayUrl !== url && config.previousRegistration) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_move_waiting", message: "not moving to the new relay yet: the relay before the current one is still being drained; restart once it is retired", meta: { relayUrl: url, current: current.relayUrl, previous: config.previousRegistration.relayUrl } })
    return current
  }

  const handle = config.pendingRegistration?.relayUrl === url
    ? config.pendingRegistration.handle
    : current?.relayUrl === url ? current.handle : randomBytes(16).toString("hex")
  try {
    await input.config.write({ pendingRegistration: { relayUrl: url, handle } })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_config_write_failed", message: "could not record the pending relay registration; a retry may pick a new handle", meta: { handle, error: errorText(error) } })
  }

  let grant
  try {
    grant = await relayRegister({ url, handle, did: input.did, agentCard: { name: input.agentName, did: input.did }, inviteToken: config.inviteToken, fetchImpl: input.fetchImpl })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_register_failed", message: "relay registration failed; offline messages wait until it succeeds", meta: { relayUrl: url, error: errorText(error) } })
    // Keep using a registration that still exists (the old relay, or the same relay before a rotation).
    return current ?? null
  }

  const registration: RelayRegistration = { relayUrl: url, handle, inboxAuth: grant.inboxAuth, sendCredential: grant.sendCredential }
  try {
    // Re-read so an invite token the operator set meanwhile survives.
    const latest = await input.config.read()
    await input.config.write({
      registration,
      pendingRegistration: undefined,
      ...(latest.inviteToken !== undefined && latest.inviteToken === config.inviteToken ? { inviteToken: undefined } : {}),
      ...(current && current.relayUrl !== url ? { previousRegistration: current } : {}),
    })
  } catch (error) {
    emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_relay_config_write_failed", message: "registered at the relay but could not save the credentials; they last only until this process stops", meta: { relayUrl: url, handle, error: errorText(error) } })
  }
  return registration
}

/** The single DataPart of a queued message, rebuilt into a fresh message so nothing else the relay added survives. */
export function rebuildRelayedMessage(queued: unknown): { message: A2AMessage; nonce?: string } | null {
  const raw = queued as { messageId?: unknown; parts?: unknown } | null
  if (!raw || typeof raw !== "object" || typeof raw.messageId !== "string" || !Array.isArray(raw.parts) || raw.parts.length !== 1) return null
  const part = raw.parts[0] as { kind?: unknown; data?: unknown } | null
  if (!part || part.kind !== "data" || !part.data || typeof part.data !== "object") return null
  const nonce = (part.data as { sealed?: { n?: unknown } }).sealed?.n
  return {
    message: { kind: "message", role: "agent", messageId: raw.messageId, parts: [{ kind: "data", data: part.data as Record<string, unknown> }] } as unknown as A2AMessage,
    ...(typeof nonce === "string" ? { nonce } : {}),
  }
}

export type RelayDrainResult = "ok" | "backoff" | "stop"

/**
 * Pull up to `RELAY_MAX_PER_TICK` queued messages and run each through `handle`, one at a time. A message is acked
 * once handled or refused for good; it stays queued after a retryable refusal, and after a throw that came before
 * friends verified it (its seal nonce is not in the seen ledger). A throw ends the pass and asks for back-off.
 */
export async function drainRelayInbox(input: {
  registration: RelayRegistration
  handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>
  seen: (nonce: string) => boolean
  fetchImpl?: typeof fetch
}): Promise<RelayDrainResult> {
  const { registration } = input
  const call = { url: registration.relayUrl, handle: registration.handle, inboxAuth: registration.inboxAuth, fetchImpl: input.fetchImpl }
  let queued: RelayQueuedMessage[]
  try {
    queued = await relayPull(call)
  } catch (error) {
    if (error instanceof RelayHttpError && error.status === 401) {
      emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_relay_unauthorized", message: "the relay no longer accepts this agent's inbox credential; polling stopped (set a2a.relay.inviteToken to register again)", meta: { relayUrl: registration.relayUrl } })
      return "stop"
    }
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_pull_failed", message: "could not pull the relay inbox", meta: { relayUrl: registration.relayUrl, error: errorText(error) } })
    return "backoff"
  }
  try {
    for (const item of queued.slice(0, RELAY_MAX_PER_TICK)) {
      const rebuilt = rebuildRelayedMessage(item.message)
      if (!rebuilt) {
        emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_message_dropped", message: "dropped a relayed message that is not a single sealed data part", meta: { queueId: item.queueId } })
        await relayAck({ ...call, queueId: item.queueId })
        continue
      }
      let response: A2AJsonRpcResponse
      try {
        response = await input.handle({ jsonrpc: "2.0", id: item.queueId, method: "message/send", params: { message: rebuilt.message } })
      } catch (error) {
        const verified = rebuilt.nonce !== undefined && input.seen(rebuilt.nonce)
        emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_message_failed", message: verified ? "a relayed message failed after it was verified; it cannot run again, so it is acked" : "a relayed message failed before it was verified; it stays queued", meta: { queueId: item.queueId, error: errorText(error) } })
        if (verified) await relayAck({ ...call, queueId: item.queueId })
        return "backoff"
      }
      const refusal = "error" in response ? response.error.message : undefined
      // A refusal that can pass on a later try (refusals.ts marks it retry, such as a copy another process is handling)
      // stays queued; any other answer is final and is acked.
      if ("error" in response && (response.error.data as { retry?: unknown } | undefined)?.retry === true) {
        emitNervesEvent({ component: "channels", event: "channel.a2a_relay_message_deferred", message: "a relayed message was refused for now; it stays queued", meta: { queueId: item.queueId, refusal } })
        continue
      }
      await relayAck({ ...call, queueId: item.queueId })
      emitNervesEvent({ component: "channels", event: "channel.a2a_relay_message_delivered", message: refusal ? "a relayed message was refused and acked" : "delivered a relayed message", meta: { queueId: item.queueId, ...(refusal ? { refusal } : {}) } })
    }
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_ack_failed", message: "could not ack a relayed message; it may be delivered again and is then refused as a replay", meta: { relayUrl: registration.relayUrl, error: errorText(error) } })
    return "backoff"
  }
  return "ok"
}

/** Drain and then remove the registration on a relay the operator moved away from. Retried at each start until done. */
export async function retirePreviousRegistration(input: {
  config: RelayConfigStore
  handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>
  seen: (nonce: string) => boolean
  fetchImpl?: typeof fetch
}): Promise<void> {
  const previous = (await input.config.read()).previousRegistration
  if (!previous) return
  const inbox = { url: previous.relayUrl, handle: previous.handle, inboxAuth: previous.inboxAuth, fetchImpl: input.fetchImpl }
  try {
    // Deregistering deletes whatever is still queued, so drain until a pull comes back empty. A pass that leaves as
    // many messages as before (refused for now) keeps the registration until the next start.
    let left = (await relayPull(inbox)).length
    while (left > 0) {
      if (await drainRelayInbox({ registration: previous, handle: input.handle, seen: input.seen, fetchImpl: input.fetchImpl }) !== "ok") return
      const after = (await relayPull(inbox)).length
      if (after >= left) {
        emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_kept", message: "the previous relay still holds messages that cannot be handled yet; it is kept and retried at the next start", meta: { relayUrl: previous.relayUrl, queued: after } })
        return
      }
      left = after
    }
    await relayDeregister({ url: previous.relayUrl, handle: previous.handle, inboxAuth: previous.inboxAuth, fetchImpl: input.fetchImpl })
    await input.config.write({ previousRegistration: undefined })
    emitNervesEvent({ component: "channels", event: "channel.a2a_relay_previous_retired", message: "drained and removed the registration on the previous relay", meta: { relayUrl: previous.relayUrl } })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_retire_failed", message: "could not remove the registration on the previous relay; it is retried at the next start", meta: { relayUrl: previous.relayUrl, error: errorText(error) } })
  }
}

/** How the poller waits between passes; the default never keeps the process alive on its own. */
export interface RelayTimers {
  set(fn: () => void, ms: number): unknown
  clear(timer: unknown): void
}

const DEFAULT_TIMERS: RelayTimers = {
  set: (fn, ms) => setTimeout(fn, ms).unref(),
  clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
}

export interface RelayInboxHandle {
  /** Resolves once registration and the first pass have run. */
  ready: Promise<void>
  /** The registration being polled, if any (relay/contact hands out its url, handle and send credential). */
  registration(): RelayRegistration | null
  /** Run one pass now (tests). */
  tick(): Promise<RelayDrainResult>
  stop(): void
}

/** Register, retire a previous relay, then poll every 30 s, backing off (doubling to 5 minutes) after a failure. */
export function startRelayInbox(input: {
  config: RelayConfigStore
  did: string
  agentName: string
  handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>
  seen: (nonce: string) => boolean
  fetchImpl?: typeof fetch
  intervalMs?: number
  /** Timer seam for tests; defaults to the global setTimeout and clearTimeout. */
  timers?: RelayTimers
}): RelayInboxHandle {
  const interval = input.intervalMs ?? RELAY_POLL_INTERVAL_MS
  const timers = input.timers ?? DEFAULT_TIMERS
  let registration: RelayRegistration | null = null
  let stopped = false
  let delay = interval
  let timer: unknown
  let running: Promise<RelayDrainResult> | undefined

  const tick = (): Promise<RelayDrainResult> => {
    // One pass at a time: a manual tick during a timed pass waits for it instead of handling the same messages twice.
    running ??= (async () => {
      if (!registration) return "stop" as const
      const result = await drainRelayInbox({ registration, handle: input.handle, seen: input.seen, fetchImpl: input.fetchImpl })
      if (result === "stop") registration = null
      return result
    })().finally(() => { running = undefined })
    return running
  }
  const schedule = (): void => {
    if (stopped || !registration) return
    timer = timers.set(() => {
      void tick().then((result) => {
        delay = result === "backoff" ? Math.min(Math.max(delay, interval) * 2, RELAY_MAX_BACKOFF_MS) : interval
        schedule()
      })
    }, delay)
  }

  const ready = (async () => {
    try {
      registration = await ensureRelayRegistration(input)
      await retirePreviousRegistration(input)
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_start_failed", message: "could not read the relay configuration; the relay inbox is off", meta: { error: errorText(error) } })
      registration = null
    }
    if (!registration || stopped) return
    emitNervesEvent({ component: "channels", event: "channel.a2a_relay_inbox_started", message: "polling the A2A relay inbox", meta: { relayUrl: registration.relayUrl, intervalMs: interval } })
    const first = await tick()
    delay = first === "backoff" ? interval * 2 : interval
    schedule()
  })()

  return {
    ready,
    registration: () => registration,
    tick,
    stop: () => {
      stopped = true
      if (timer !== undefined) timers.clear(timer)
    },
  }
}
