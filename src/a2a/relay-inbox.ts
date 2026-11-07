import { createHash, randomBytes } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import { RelayHttpError, relayAck, relayDeregister, relayPull, relayRegister, type RelayQueuedMessage } from "./relay-client"
import { isRetryableReceiveRefusal } from "./refusals"
import { ENVELOPE_MAX_AGE_MS } from "./seen-ledger"
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
 *   previousRegistrations  registrations on relays the operator moved away from, each kept until it is drained and
 *                          removed, or found gone (see `retirePreviousRegistrations`)
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
  previousRegistrations?: RelayRegistration[]
}

/** Reads and patches `a2a.relay`. A patch merges into the stored object; a key set to `undefined` is removed. */
export interface RelayConfigStore {
  read(): Promise<RelayConfig>
  write(patch: { [K in keyof RelayConfig]?: RelayConfig[K] | undefined }): Promise<void>
}

/** What this agent remembers about retiring one previous registration. */
export interface RelayRetirementRecord {
  /** When an attempt on the old relay first failed with no successful pull or deregistration since (ms since the epoch). */
  firstFailedAt?: number
  /** Done at the relay (deregistered, or found gone); only its removal from the vault is left. */
  retired?: true
}

/**
 * The retirement record of each previous registration. The server keeps them on disk (`relay-retirements.ts`) so the
 * failure clock and a retirement waiting only for its vault write survive a restart. `write` throws when the record
 * cannot be saved.
 */
export interface RelayRetirements {
  read(registration: RelayRegistration): RelayRetirementRecord
  write(registration: RelayRegistration, record: RelayRetirementRecord): void
  clear(registration: RelayRegistration): void
}

const registrationKey = (registration: RelayRegistration): string => `${registration.relayUrl}\n${registration.handle}`
const sameRegistration = (a: RelayRegistration, b: RelayRegistration): boolean => registrationKey(a) === registrationKey(b)

/** Retirement records kept in memory only (the default, and for tests). */
export function memoryRelayRetirements(): RelayRetirements {
  const records = new Map<string, RelayRetirementRecord>()
  return {
    read: (registration) => ({ ...records.get(registrationKey(registration)) }),
    write: (registration, record) => { records.set(registrationKey(registration), { ...record }) },
    clear: (registration) => { records.delete(registrationKey(registration)) },
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
}): Promise<RelayRegistration | null> {
  const config = await input.config.read()
  const url = config.url
  const current = config.registration
  if (!url) return null
  if (current && current.relayUrl === url && !config.inviteToken) return current

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
  const moved = current !== undefined && current.relayUrl !== url
  try {
    // Re-read so an invite token the operator set meanwhile survives. A move never waits for older relays: each one
    // moved away from joins the list and is retired on its own.
    const latest = await input.config.read()
    await input.config.write({
      registration,
      pendingRegistration: undefined,
      ...(latest.inviteToken !== undefined && latest.inviteToken === config.inviteToken ? { inviteToken: undefined } : {}),
      ...(moved ? { previousRegistrations: [...(latest.previousRegistrations ?? []).filter((r) => !sameRegistration(r, current)), current] } : {}),
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
      emitNervesEvent({ level: "error", component: "channels", event: "channel.a2a_relay_unauthorized", message: "the relay no longer accepts this agent's inbox credential; polling stopped. To register again, set a new a2a.relay.inviteToken and restart the A2A sense", meta: { relayUrl: registration.relayUrl } })
      return "stop"
    }
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_pull_failed", message: "could not pull the relay inbox", meta: { relayUrl: registration.relayUrl, error: errorText(error) } })
    return "backoff"
  }
  try {
    return await deliverQueued(call, queued, input)
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_ack_failed", message: "could not ack a relayed message; it may be delivered again and is then refused as a replay", meta: { relayUrl: registration.relayUrl, error: errorText(error) } })
    return "backoff"
  }
}

/** Run up to `RELAY_MAX_PER_TICK` pulled messages through `handle`, acking each one done. A failed ack throws. */
async function deliverQueued(
  call: { url: string; handle: string; inboxAuth: string; fetchImpl?: typeof fetch },
  queued: RelayQueuedMessage[],
  input: { handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>; seen: (nonce: string) => boolean },
): Promise<"ok" | "backoff"> {
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
  return "ok"
}

/** The relay itself (its own JSON error) says it does not know this registration: it was deregistered or lost. */
function forgottenByRelay(error: unknown): error is RelayHttpError {
  return error instanceof RelayHttpError && error.fromRelay && (error.status === 401 || error.status === 404)
}

function attempt(what: string, fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_retirement_record_failed", message: `could not ${what} the local record of a relay retirement`, meta: { error: errorText(error) } })
    return false
  }
}

const ENVELOPE_MAX_AGE_DAYS = ENVELOPE_MAX_AGE_MS / (24 * 60 * 60 * 1000)

interface RetireInput {
  handle: (rpc: A2AJsonRpcRequest) => Promise<A2AJsonRpcResponse>
  seen: (nonce: string) => boolean
  fetchImpl?: typeof fetch
  relayTimeoutMs?: number
  notifyOwner?: RelayOwnerNotifier
}

async function tellOwnerLost(previous: RelayRegistration, why: string, input: RetireInput): Promise<void> {
  if (!input.notifyOwner) return
  const noticeId = `a2a-relay-gone-${createHash("sha256").update(registrationKey(previous)).digest("hex").slice(0, 16)}`
  const text = `I moved to a new relay for messages that arrive while I'm offline, but ${why}, so any messages still waiting there are lost. Anyone who sent one will need to send it again; new messages reach me through the new relay or directly.`
  await input.notifyOwner({ noticeId, text }).catch((error: unknown) => {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_owner_notice_failed", message: "could not tell the owner that the previous relay was gone", meta: { relayUrl: previous.relayUrl, error: errorText(error) } })
  })
}

/**
 * One previous registration at its relay: drain the old inbox until a pull comes back empty, then deregister
 * (deregistering deletes whatever is still queued). Returns "retired" once that is done or the relay is gone, and
 * "kept" to try again at the next start.
 *
 * Gone means either the relay's own JSON 401 or 404 (it no longer knows this registration), or attempts failing in any
 * other way (refused connection, DNS, 5xx, TLS, timeout, an answer that is not the relay's) with no successful pull or
 * deregistration for longer than `ENVELOPE_MAX_AGE_MS`: anything queued there that long could no longer be accepted
 * anyway. A successful pull or deregistration restarts that clock. The owner is told messages were lost only when
 * this run saw the old inbox holding messages it could not drain, or the relay stayed unreachable past the window.
 */
async function retireAtRelay(previous: RelayRegistration, input: RetireInput, retirements: RelayRetirements, now: number): Promise<"kept" | "retired"> {
  let record: RelayRetirementRecord = {}
  attempt("read", () => { record = retirements.read(previous) })
  if (record.retired) return "retired"
  const save = (next: RelayRetirementRecord): void => {
    record = next
    attempt("save", () => retirements.write(previous, next))
  }
  const inbox = { url: previous.relayUrl, handle: previous.handle, inboxAuth: previous.inboxAuth, fetchImpl: input.fetchImpl, timeoutMs: input.relayTimeoutMs }
  const progressed = (): void => { if (record.firstFailedAt !== undefined) save({}) }
  let holding = false
  try {
    let queued = await relayPull(inbox)
    progressed()
    while (queued.length > 0) {
      holding = true
      if (await deliverQueued(inbox, queued, input) === "backoff") return "kept"
      const after = await relayPull(inbox)
      if (after.length >= queued.length) {
        emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_kept", message: "the previous relay still holds messages this agent cannot handle yet; it is kept and tried again at the next start", meta: { relayUrl: previous.relayUrl, queued: after.length } })
        return "kept"
      }
      queued = after
    }
    holding = false
    await relayDeregister(inbox)
    save({ retired: true })
    return "retired"
  } catch (error) {
    if (forgottenByRelay(error)) {
      // Recorded before the owner is told, so a crash after the notice does not send it twice.
      save({ retired: true })
      emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_gone", message: "the previous relay no longer knows this agent; its registration is retired", meta: { relayUrl: previous.relayUrl, reason: error.message, lost: holding } })
      if (holding) await tellOwnerLost(previous, `my old relay (${new URL(previous.relayUrl).host}) no longer knows me`, input)
      return "retired"
    }
    const firstFailedAt = record.firstFailedAt ?? now
    if (record.firstFailedAt === undefined) save({ firstFailedAt })
    if (now - firstFailedAt > ENVELOPE_MAX_AGE_MS) {
      save({ retired: true })
      emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_gone", message: `the previous relay has failed every attempt for more than ${ENVELOPE_MAX_AGE_DAYS} days; its registration is retired, and anything still queued there is lost`, meta: { relayUrl: previous.relayUrl, reason: errorText(error), lost: true, firstFailedAt: new Date(firstFailedAt).toISOString() } })
      await tellOwnerLost(previous, `my old relay (${new URL(previous.relayUrl).host}) couldn't be reached for more than ${ENVELOPE_MAX_AGE_DAYS} days`, input)
      return "retired"
    }
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_retire_failed", message: `could not retire the registration on the previous relay this time; it is tried again at each start, and retired anyway once attempts have failed for more than ${ENVELOPE_MAX_AGE_DAYS} days in a row`, meta: { relayUrl: previous.relayUrl, error: errorText(error), firstFailedAt: new Date(firstFailedAt).toISOString() } })
    return "kept"
  }
}

export type RelayRetireResult = "none" | "kept" | "pending" | "retired"

/**
 * Retire each registration on a relay the operator moved away from (see `retireAtRelay`), then remove the retired ones
 * from the vault. Returns "pending" when that vault write failed (the records say they are retired, so the next try
 * repeats only the write), "kept" when some registration is still waiting, "retired" when all are gone from the vault,
 * and "none" when there were none. `finishOnly` skips the relays and repeats only the vault write. Never throws.
 */
export async function retirePreviousRegistrations(input: RetireInput & {
  config: RelayConfigStore
  retirements?: RelayRetirements
  /** Clock seam for tests. */
  now?: () => number
  finishOnly?: boolean
}): Promise<RelayRetireResult> {
  const retirements = input.retirements ?? memoryRelayRetirements()
  let previous: RelayRegistration[]
  try {
    previous = (await input.config.read()).previousRegistrations ?? []
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_read_failed", message: "could not read the relay settings, so previous relays are not retired this time; the relay inbox keeps running, and retiring is tried again at the next start", meta: { error: errorText(error) } })
    return "kept"
  }
  if (previous.length === 0) return "none"

  const now = (input.now ?? Date.now)()
  const done: RelayRegistration[] = []
  for (const registration of previous) {
    let finished = false
    if (input.finishOnly) attempt("read", () => { finished = retirements.read(registration).retired === true })
    else finished = await retireAtRelay(registration, input, retirements, now) === "retired"
    if (finished) done.push(registration)
  }
  if (done.length === 0) return "kept"

  try {
    const latest = (await input.config.read()).previousRegistrations ?? []
    const remaining = latest.filter((registration) => !done.some((gone) => sameRegistration(gone, registration)))
    await input.config.write({ previousRegistrations: remaining.length > 0 ? remaining : undefined })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_previous_retire_pending", message: "a previous relay registration is retired, but removing it from the vault failed; the vault write is tried again at the next poll and at each start", meta: { relayUrls: done.map((registration) => registration.relayUrl), error: errorText(error) } })
    return "pending"
  }
  for (const registration of done) {
    attempt("remove", () => retirements.clear(registration))
    emitNervesEvent({ component: "channels", event: "channel.a2a_relay_previous_retired", message: "removed the registration on a previous relay", meta: { relayUrl: registration.relayUrl } })
  }
  return done.length < previous.length ? "kept" : "retired"
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

/** Register (moving to a new relay when the operator set one), retire the relays moved away from, then poll every 30 s, backing off (doubling to 5 minutes) after a failure. */
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
  /** Where retirement records are kept; defaults to memory. */
  retirements?: RelayRetirements
  /** Tells the owner when a previous relay was gone with messages possibly still on it. */
  notifyOwner?: RelayOwnerNotifier
  /** Clock seam for tests. */
  now?: () => number
  relayTimeoutMs?: number
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
  const retire = async (finishOnly: boolean): Promise<void> => {
    retirePending = await retirePreviousRegistrations({ ...input, retirements, finishOnly }) === "pending"
  }

  const tick = (): Promise<RelayDrainResult> => {
    // One pass at a time: a manual tick during a timed pass waits for it instead of handling the same messages twice.
    running ??= (async () => {
      if (retirePending) await retire(true)
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
    // Register first: a move never waits for the relays before it, which are then retired, each on its own clock.
    try {
      registration = await ensureRelayRegistration(input)
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_start_failed", message: "could not read the relay configuration; the relay inbox is off", meta: { error: errorText(error) } })
      registration = null
    }
    await retire(false)
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
