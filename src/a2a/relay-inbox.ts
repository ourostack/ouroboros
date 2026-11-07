import { createHash, randomBytes } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { RelayHttpError, relayAck, relayDeregister, relayPull, relayRegister, type RelayQueuedMessage } from "./relay-client"
import { isRetryableReceiveRefusal } from "./refusals"
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
 *                          (or found gone)
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

/**
 * Retirements of a previous registration that are finished at the relay (drained and deregistered, or found gone) but
 * whose removal from the vault failed. A pending retirement is finished by the vault write alone, and it never holds
 * up a move to another relay. The server keeps them on disk (`relay-retirements.ts`) so they survive a restart.
 */
export interface RelayRetirements {
  isPending(registration: RelayRegistration): boolean
  markPending(registration: RelayRegistration): void
  clear(registration: RelayRegistration): void
}

/** Retirements kept in memory only (the default, and for tests). */
export function memoryRelayRetirements(): RelayRetirements {
  const pending = new Set<string>()
  const key = (registration: RelayRegistration): string => `${registration.relayUrl}\n${registration.handle}`
  return {
    isPending: (registration) => pending.has(key(registration)),
    markPending: (registration) => { pending.add(key(registration)) },
    clear: (registration) => { pending.delete(key(registration)) },
  }
}

/** Sends the owner a notice (the A2A sense passes its owner-notice channel). The id makes a repeat of the same notice a no-op. */
export type RelayOwnerNotifier = (notice: { noticeId: string; text: string }) => Promise<void>

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
  retirements?: RelayRetirements
}): Promise<RelayRegistration | null> {
  return (await ensureRelayRegistrationAndMove(input)).registration
}

async function ensureRelayRegistrationAndMove(input: {
  config: RelayConfigStore
  did: string
  agentName: string
  fetchImpl?: typeof fetch
  retirements?: RelayRetirements
}): Promise<{ registration: RelayRegistration | null; moved: boolean }> {
  const config = await input.config.read()
  const url = config.url
  const current = config.registration
  if (!url) return { registration: null, moved: false }
  if (current && current.relayUrl === url && !config.inviteToken) return { registration: current, moved: false }
  // One move at a time: while an older relay still holds mail, moving again would forget it. A previous registration
  // that is already retired at its relay (only its removal from the vault is pending) holds nothing, so it does not wait.
  const previous = config.previousRegistration
  const previousPending = previous !== undefined && input.retirements?.isPending(previous) === true
  if (current && current.relayUrl !== url && previous && !previousPending) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_move_waiting", message: "not moving to the new relay yet: the relay before the current one still holds messages this agent could not handle yet (see the relay warnings before this one). The move happens at the first start after they are handled, or after that relay is gone", meta: { relayUrl: url, current: current.relayUrl, previous: previous.relayUrl } })
    return { registration: current, moved: false }
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
    return { registration: current ?? null, moved: false }
  }

  const registration: RelayRegistration = { relayUrl: url, handle, inboxAuth: grant.inboxAuth, sendCredential: grant.sendCredential }
  const moved = current !== undefined && current.relayUrl !== url
  try {
    // Re-read so an invite token the operator set meanwhile survives.
    const latest = await input.config.read()
    await input.config.write({
      registration,
      pendingRegistration: undefined,
      ...(latest.inviteToken !== undefined && latest.inviteToken === config.inviteToken ? { inviteToken: undefined } : {}),
      ...(moved ? { previousRegistration: current } : {}),
    })
    // The move replaced a previous registration whose retirement was only waiting for this vault write.
    if (moved && previousPending) input.retirements!.clear(previous!)
  } catch (error) {
    emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_relay_config_write_failed", message: "registered at the relay but could not save the credentials; they last only until this process stops", meta: { relayUrl: url, handle, error: errorText(error) } })
  }
  return { registration, moved }
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
      emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_relay_unauthorized", message: "the relay no longer accepts this agent's inbox credential; polling stopped. To register again, set a new a2a.relay.inviteToken and restart the A2A sense", meta: { relayUrl: registration.relayUrl } })
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
      // A receive refusal that can pass on a later try (refusals.ts marks it retry: a copy being handled right now) stays
      // queued. Any other answer is final and is acked, including errors that merely carry `retry` (a delegated-command
      // refusal is already marked seen, so a retry could only come back as a replay).
      if ("error" in response && isRetryableReceiveRefusal(response.error.data)) {
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

/** Failures that mean the old relay is gone: it refused the connection, its name no longer resolves, or it answered
 * 401 or 404 (it no longer knows this registration). A temporary DNS failure (EAI_AGAIN) or a busy relay is not gone. */
const GONE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND"])

function goneReason(error: unknown): string | undefined {
  if (error instanceof RelayHttpError) return error.status === 401 || error.status === 404 ? error.message : undefined
  /* v8 ignore next -- the relay client only throws Error instances @preserve */
  if (!(error instanceof Error)) return undefined
  const cause = error.cause as { code?: unknown; errors?: Array<{ code?: unknown }> } | undefined
  const codes = [cause?.code, ...(cause?.errors ?? []).map((inner) => inner.code)].filter((code): code is string => typeof code === "string")
  return codes.length > 0 && codes.every((code) => GONE_CODES.has(code)) ? `${error.message} (${codes[0]})` : undefined
}

type RetireAtRelay = { state: "kept" } | { state: "retired" } | { state: "gone"; reason: string; maybeLost: boolean }

/** Drain the old inbox until a pull comes back empty, then deregister. Deregistering deletes whatever is still queued. */
async function drainAndDeregister(previous: RelayRegistration, input: { handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>; seen: (nonce: string) => boolean; fetchImpl?: typeof fetch }): Promise<RetireAtRelay> {
  const inbox = { url: previous.relayUrl, handle: previous.handle, inboxAuth: previous.inboxAuth, fetchImpl: input.fetchImpl }
  let emptied = false
  try {
    let left = (await relayPull(inbox)).length
    while (left > 0) {
      const result = await drainRelayInbox({ registration: previous, handle: input.handle, seen: input.seen, fetchImpl: input.fetchImpl })
      // "stop" is a 401 on the pull: the relay no longer knows this registration.
      if (result === "stop") return { state: "gone", reason: "relay 401 unauthorized", maybeLost: true }
      if (result !== "ok") return { state: "kept" }
      const after = (await relayPull(inbox)).length
      if (after >= left) {
        emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_kept", message: "the previous relay still holds messages this agent cannot handle yet; it is kept and tried again at the next start", meta: { relayUrl: previous.relayUrl, queued: after } })
        return { state: "kept" }
      }
      left = after
    }
    emptied = true
    await relayDeregister(inbox)
    return { state: "retired" }
  } catch (error) {
    const reason = goneReason(error)
    if (reason) return { state: "gone", reason, maybeLost: !emptied }
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_retire_failed", message: "could not retire the registration on the previous relay this time (a failure that can pass, such as a busy relay); it is tried again at the next start, and retired anyway once that relay is gone", meta: { relayUrl: previous.relayUrl, error: errorText(error) } })
    return { state: "kept" }
  }
}

function attempt(what: string, fn: () => void): void {
  try {
    fn()
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_retirement_record_failed", message: `could not ${what} the local record of a relay retirement`, meta: { error: errorText(error) } })
  }
}

export type RelayRetireResult = "none" | "kept" | "pending" | "retired"

/**
 * Drain and then remove the registration on a relay the operator moved away from. Kept and tried again at each start
 * while the old inbox holds messages that cannot be handled yet or the relay fails in a way that can pass. A relay that
 * is gone (see `goneReason`) is retired anyway: a warning, and one plain-words notice to the owner when messages may
 * have been waiting there. When the relay side is done but the vault write fails, the retirement is recorded as
 * pending; the next try (the next poll, or the next start) only repeats the vault write. Never throws.
 */
export async function retirePreviousRegistration(input: {
  config: RelayConfigStore
  handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>
  seen: (nonce: string) => boolean
  fetchImpl?: typeof fetch
  retirements?: RelayRetirements
  notifyOwner?: RelayOwnerNotifier
}): Promise<RelayRetireResult> {
  const retirements = input.retirements ?? memoryRelayRetirements()
  let previous: RelayRegistration | undefined
  try {
    previous = (await input.config.read()).previousRegistration
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_read_failed", message: "could not read the relay settings, so the previous relay is not retired this time; the relay inbox keeps running, and retiring is tried again at the next start", meta: { error: errorText(error) } })
    return "kept"
  }
  if (!previous) return "none"

  if (!retirements.isPending(previous)) {
    const outcome = await drainAndDeregister(previous, input)
    if (outcome.state === "kept") return "kept"
    // Recorded before the owner is told, so a crash after the notice does not send it twice.
    attempt("save", () => retirements.markPending(previous))
    if (outcome.state === "gone") {
      emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_gone", message: "the previous relay cannot be reached or no longer knows this agent; its registration is retired anyway, and anything still queued there is lost", meta: { relayUrl: previous.relayUrl, reason: outcome.reason, maybeLost: outcome.maybeLost } })
      if (outcome.maybeLost && input.notifyOwner) {
        const noticeId = `a2a-relay-gone-${createHash("sha256").update(`${previous.relayUrl}\n${previous.handle}`).digest("hex").slice(0, 16)}`
        const text = `I moved to a new relay for messages that arrive while I'm offline, but my old relay (${new URL(previous.relayUrl).host}) couldn't be reached, so any messages still waiting there are lost. Anyone who sent one will need to send it again; new messages reach me through the new relay or directly.`
        await input.notifyOwner({ noticeId, text }).catch((error: unknown) => {
          emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_owner_notice_failed", message: "could not tell the owner that the previous relay was gone", meta: { relayUrl: previous.relayUrl, error: errorText(error) } })
        })
      }
    }
  }

  try {
    await input.config.write({ previousRegistration: undefined })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_retire_pending", message: "the previous relay registration is retired, but removing it from the vault failed; the vault write is tried again at the next poll and at each start, and it does not hold up a move to another relay", meta: { relayUrl: previous.relayUrl, error: errorText(error) } })
    return "pending"
  }
  attempt("remove", () => retirements.clear(previous))
  emitNervesEvent({ component: "channels", event: "channel.a2a_relay_previous_retired", message: "removed the registration on the previous relay", meta: { relayUrl: previous.relayUrl } })
  return "retired"
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

/** Retire a previous relay, register (and retire the relay a move left behind), then poll every 30 s, backing off (doubling to 5 minutes) after a failure. */
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
  /** Where pending retirements are kept; defaults to memory. */
  retirements?: RelayRetirements
  /** Tells the owner when a previous relay was gone with messages possibly still on it. */
  notifyOwner?: RelayOwnerNotifier
}): RelayInboxHandle {
  const interval = input.intervalMs ?? RELAY_POLL_INTERVAL_MS
  const timers = input.timers ?? DEFAULT_TIMERS
  const retirements = input.retirements ?? memoryRelayRetirements()
  let registration: RelayRegistration | null = null
  let stopped = false
  let delay = interval
  let timer: unknown
  let running: Promise<RelayDrainResult> | undefined
  let retirePending = false
  const retire = async (): Promise<void> => {
    retirePending = await retirePreviousRegistration({ ...input, retirements }) === "pending"
  }

  const tick = (): Promise<RelayDrainResult> => {
    // One pass at a time: a manual tick during a timed pass waits for it instead of handling the same messages twice.
    running ??= (async () => {
      if (retirePending) await retire()
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
    // Retire first, so a relay that is gone or already drained does not hold up a move the operator asked for; then
    // retire the relay this start moved away from.
    await retire()
    try {
      const ensured = await ensureRelayRegistrationAndMove({ ...input, retirements })
      registration = ensured.registration
      if (ensured.moved) await retire()
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
