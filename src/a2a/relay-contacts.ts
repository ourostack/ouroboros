import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { DidKeyIdentity } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import { callOutboxMethod } from "./outbox-client"

/**
 * The relay contacts this agent has been given by its peers: where and with which send credential to queue a sealed
 * message for a peer that is offline. A peer hands its contact only to an active friend, over the sealed
 * `relay/contact` method. An entry without `contact` records that the peer has no relay, so it is asked again at
 * most once a day. Several processes run tools (the A2A sense, the CLI and the chat senses), so each peer has its own
 * file, written to a temporary name and renamed into place.
 */
export interface RelayContact {
  url: string
  handle: string
  sendCredential: string
}

export interface RelayContactEntry {
  did: string
  fetchedAt: string
  contact?: RelayContact
  /** Set when the relay refused the contact (401, 403 or 404); the next successful direct send refreshes it. */
  stale?: boolean
  /** When a refresh last failed while a contact was kept; it waits a day like a fetch, so a peer is asked once a day. */
  attemptedAt?: string
}

export const RELAY_CONTACT_REFRESH_MS = 24 * 60 * 60 * 1000

function contactFile(agentRoot: string, did: string): string {
  return path.join(agentRoot, "state", "a2a", "relay-contacts", `${createHash("sha256").update(did).digest("hex")}.json`)
}

function isContact(value: unknown): value is RelayContact {
  const c = value as Partial<RelayContact> | null
  return !!c && typeof c === "object" && typeof c.url === "string" && typeof c.handle === "string" && typeof c.sendCredential === "string"
}

export function readRelayContact(agentRoot: string, did: string): RelayContactEntry | null {
  let parsed: Partial<RelayContactEntry> | null
  try {
    parsed = JSON.parse(fs.readFileSync(contactFile(agentRoot, did), "utf8")) as Partial<RelayContactEntry> | null
  } catch {
    return null
  }
  if (!parsed || parsed.did !== did || typeof parsed.fetchedAt !== "string") return null
  return {
    did,
    fetchedAt: parsed.fetchedAt,
    ...(isContact(parsed.contact) ? { contact: { url: parsed.contact.url, handle: parsed.contact.handle, sendCredential: parsed.contact.sendCredential } } : {}),
    ...(parsed.stale === true ? { stale: true } : {}),
    ...(typeof parsed.attemptedAt === "string" ? { attemptedAt: parsed.attemptedAt } : {}),
  }
}

export function writeRelayContact(agentRoot: string, entry: RelayContactEntry): void {
  const file = contactFile(agentRoot, entry.did)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  emitNervesEvent({ component: "channels", event: "channel.a2a_relay_contact_saved", message: "saved a peer's A2A relay contact", meta: { peerDid: entry.did, hasRelay: entry.contact !== undefined, stale: entry.stale === true } })
}

export function markRelayContactStale(agentRoot: string, did: string): void {
  const entry = readRelayContact(agentRoot, did)
  if (!entry) return
  // A new refusal asks again at the next direct send, even if a refresh failed earlier today.
  writeRelayContact(agentRoot, { did: entry.did, fetchedAt: entry.fetchedAt, ...(entry.contact ? { contact: entry.contact } : {}), stale: true })
}

/** True when the entry is missing, or its last fetch or failed attempt is more than a day old (at once when stale and not yet retried). */
export function relayContactNeedsRefresh(entry: RelayContactEntry | null, now: number): boolean {
  if (!entry) return true
  const attemptedAt = entry.attemptedAt === undefined ? Number.NaN : Date.parse(entry.attemptedAt)
  if (entry.stale && !Number.isFinite(attemptedAt)) return true
  const fetchedAt = Date.parse(entry.fetchedAt)
  const last = Math.max(Number.isFinite(fetchedAt) ? fetchedAt : -Infinity, Number.isFinite(attemptedAt) ? attemptedAt : -Infinity)
  return now - last > RELAY_CONTACT_REFRESH_MS
}

export const RELAY_CONTACT_FETCH_TIMEOUT_MS = 10_000

/**
 * Ask a peer, over the sealed `relay/contact` method, where to queue messages for it while it is offline, and cache the
 * answer. Runs after a successful direct send (the peer is online then), at most once a day per peer. A failure never
 * throws: it keeps a contact already cached and records when it tried, and otherwise records "no relay", so either
 * way the peer is not asked again today (a peer on an older harness answers "unknown method").
 */
export async function refreshRelayContact(input: {
  agentRoot: string
  peerDid: string
  cardUrl: string
  identity: DidKeyIdentity
  fetchImpl?: typeof fetch
  now?: number
}): Promise<void> {
  const fetchedAt = new Date(input.now ?? Date.now()).toISOString()
  const baseFetch = input.fetchImpl ?? fetch
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => baseFetch(url, { ...init, signal: AbortSignal.timeout(RELAY_CONTACT_FETCH_TIMEOUT_MS) })) as typeof fetch
  try {
    const result = await callOutboxMethod({ cardUrl: input.cardUrl, method: "relay/contact", params: {}, identity: input.identity, fetchImpl, expectedDid: input.peerDid })
    writeRelayContact(input.agentRoot, { did: input.peerDid, fetchedAt, ...(isContact(result.contact) ? { contact: { url: result.contact.url, handle: result.contact.handle, sendCredential: result.contact.sendCredential } } : {}) })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "channels", event: "channel.a2a_relay_contact_refresh_failed", message: "could not fetch a peer's relay contact", meta: { peerDid: input.peerDid, error: error instanceof Error ? error.message : /* v8 ignore next -- the outbox client only throws Error instances @preserve */ String(error) } })
    // Keep a cached contact (it may still work) but record the attempt, so a failing peer is asked at most once a day.
    const existing = readRelayContact(input.agentRoot, input.peerDid)
    writeRelayContact(input.agentRoot, existing?.contact ? { ...existing, attemptedAt: fetchedAt } : { did: input.peerDid, fetchedAt })
  }
}
