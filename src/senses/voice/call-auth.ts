import * as crypto from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import type { TwilioPhoneConversationEngine } from "./twilio-phone"

/**
 * Who is on a call, as known by this server. Network sessions receive an identity only from a
 * record the signed webhook wrote (`PendingVoiceCalls`), never from client-supplied stream or SIP
 * parameters. `from` is the remote party; `to` is the Ouro line (for outbound calls too).
 */
export type LocalAudioMode = "conversation"

/**
 * Who and what a local audio session is, as the join request stated it. Set only by the in-process
 * local transport's constructor; `PendingVoiceCalls` never stores it, so a network stream cannot
 * claim it.
 */
export interface LocalAudioCallInfo {
  mode: LocalAudioMode
  participants?: string
  occasion?: string
  /** The join said the room is the owner alone; only then may the session run above acquaintance. */
  ownerAlone: boolean
  ownerName?: string
  disclosure: "spoken" | "silent"
  /** The owner's statement that participants consented, required (and recorded) for a silent join. */
  consentStatement?: string
}

export interface VoiceCallIdentity {
  callSid: string
  agentName: string
  direction: "inbound" | "outbound"
  from: string
  to: string
  outboundId?: string
  friendId?: string
  reason?: string
  initialAudio?: string
  greetingJobId?: string
  engine?: TwilioPhoneConversationEngine
  stirVerstat?: string
  local?: LocalAudioCallInfo
}

export type VoiceCallTokenPurpose = "stream" | "sip"

export const DEFAULT_VOICE_CALL_TOKEN_TTL_MS = 60_000
export const DEFAULT_PENDING_VOICE_CALL_TTL_MS = 120_000
export const DEFAULT_PENDING_VOICE_CALL_MAX_ENTRIES = 256

const TOKEN_KEY_DOMAIN = "ouro-voice-stream-v1"

export function newVoiceCallNonce(): string {
  return crypto.randomBytes(16).toString("hex")
}

function signingKey(secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(TOKEN_KEY_DOMAIN).digest()
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac("sha256", signingKey(secret)).update(payload).digest("base64url")
}

interface VoiceCallTokenClaims {
  v: 1
  p: VoiceCallTokenPurpose
  a: string
  c: string
  d: string
  e: number
  n: string
  o?: string
  f?: string
  t?: string
}

export function mintVoiceCallToken(input: {
  secret: string
  purpose: VoiceCallTokenPurpose
  agentName: string
  callSid: string
  direction: string
  outboundId?: string
  from?: string
  to?: string
  nowMs: number
  ttlMs?: number
  nonce?: string
}): string {
  const claims: VoiceCallTokenClaims = {
    v: 1,
    p: input.purpose,
    a: input.agentName,
    c: input.callSid,
    d: input.direction,
    e: input.nowMs + (input.ttlMs ?? DEFAULT_VOICE_CALL_TOKEN_TTL_MS),
    n: input.nonce ?? newVoiceCallNonce(),
    ...(input.outboundId ? { o: input.outboundId } : {}),
    ...(input.from ? { f: input.from } : {}),
    ...(input.to ? { t: input.to } : {}),
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${payload}.${sign(input.secret, payload)}`
}

export type VoiceCallTokenFailure = "missing" | "malformed" | "bad_signature" | "expired" | "wrong_agent" | "wrong_call" | "wrong_purpose"

export type VoiceCallTokenVerification =
  | { ok: true; nonce: string; direction: string; outboundId?: string; from?: string; to?: string }
  | { ok: false; reason: VoiceCallTokenFailure }

function parseClaims(payload: string): VoiceCallTokenClaims | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const claims = parsed as Record<string, unknown>
  if (
    claims.v !== 1
    || (claims.p !== "stream" && claims.p !== "sip")
    || typeof claims.a !== "string"
    || typeof claims.c !== "string"
    || typeof claims.d !== "string"
    || typeof claims.e !== "number"
    || typeof claims.n !== "string"
  ) return null
  return claims as unknown as VoiceCallTokenClaims
}

export function verifyVoiceCallToken(input: {
  secret: string
  purpose: VoiceCallTokenPurpose
  token: string
  agentName: string
  callSid: string
  nowMs: number
}): VoiceCallTokenVerification {
  const token = input.token.trim()
  if (!token) return { ok: false, reason: "missing" }
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" }
  const [payload, signature] = parts as [string, string]
  const expected = Buffer.from(sign(input.secret, payload))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad_signature" }
  }
  const claims = parseClaims(payload)
  if (!claims) return { ok: false, reason: "malformed" }
  if (input.nowMs > claims.e) return { ok: false, reason: "expired" }
  if (claims.p !== input.purpose) return { ok: false, reason: "wrong_purpose" }
  if (claims.a !== input.agentName) return { ok: false, reason: "wrong_agent" }
  if (claims.c !== input.callSid) return { ok: false, reason: "wrong_call" }
  return {
    ok: true,
    nonce: claims.n,
    direction: claims.d,
    ...(claims.o ? { outboundId: claims.o } : {}),
    ...(claims.f ? { from: claims.f } : {}),
    ...(claims.t ? { to: claims.t } : {}),
  }
}

interface PendingEntry {
  identity: VoiceCallIdentity
  nonces: Set<string>
  expiresAtMs: number
}

/**
 * Bounded, TTL'd, in-memory record of calls the signed webhooks have admitted, keyed by CallSid.
 * A call can hold several nonces at once (Twilio may retry the webhook while a greeting is being
 * prepared); the first successful consume removes the whole entry, so the call connects once.
 */
export class PendingVoiceCalls {
  private readonly entries = new Map<string, PendingEntry>()
  private readonly connected = new Map<string, number>()
  private readonly rejected = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PENDING_VOICE_CALL_TTL_MS
    this.maxEntries = options.maxEntries ?? DEFAULT_PENDING_VOICE_CALL_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  record(candidate: VoiceCallIdentity, nonce: string): void {
    // The network registry never carries local-audio identity; only the local transport sets it.
    const { local: _local, ...identity } = candidate
    const existing = this.live(identity.callSid)
    const nonces = existing?.nonces ?? new Set<string>()
    nonces.add(nonce)
    // Re-insert so the Map's insertion order is least-recently-recorded first.
    this.entries.delete(identity.callSid)
    this.entries.set(identity.callSid, { identity, nonces, expiresAtMs: this.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const evicted = this.entries.keys().next().value as string
      this.entries.delete(evicted)
      // An evicted call's stream will be refused, so make the pressure visible.
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_pending_call_evicted",
        message: "evicted a pending voice call before its stream started",
        meta: { callSid: evicted, maxEntries: this.maxEntries },
      })
    }
  }

  consume(callSid: string, nonce: string): VoiceCallIdentity | null {
    const entry = this.live(callSid)
    if (!entry || !entry.nonces.has(nonce)) return null
    this.entries.delete(callSid)
    this.remember(this.connected, callSid)
    return entry.identity
  }

  /**
   * Remember that a stream for this call was refused, so the call's end can say so. Ignored for a
   * call that already connected: a replayed token must not turn a good call into a failure.
   */
  markRejected(callSid: string): void {
    if (this.recalls(this.connected, callSid)) return
    this.remember(this.rejected, callSid)
  }

  /**
   * Called when the stream's `<Connect>` ends. Returns true when the call never connected to a
   * session (still waiting, or its stream was refused); forgets everything known about the call.
   */
  settle(callSid: string): boolean {
    const failed = this.live(callSid) !== undefined || this.recalls(this.rejected, callSid)
    this.entries.delete(callSid)
    this.connected.delete(callSid)
    this.rejected.delete(callSid)
    return failed
  }

  has(callSid: string): boolean {
    return this.live(callSid) !== undefined
  }

  discard(callSid: string): boolean {
    return this.entries.delete(callSid)
  }

  size(): number {
    return this.entries.size
  }

  private remember(marks: Map<string, number>, callSid: string): void {
    marks.delete(callSid)
    marks.set(callSid, this.now() + this.ttlMs)
    while (marks.size > this.maxEntries) marks.delete(marks.keys().next().value as string)
  }

  private recalls(marks: Map<string, number>, callSid: string): boolean {
    const expiresAtMs = marks.get(callSid)
    if (expiresAtMs === undefined) return false
    if (this.now() > expiresAtMs) {
      marks.delete(callSid)
      return false
    }
    return true
  }

  private live(callSid: string): PendingEntry | undefined {
    const entry = this.entries.get(callSid)
    if (!entry) return undefined
    if (this.now() > entry.expiresAtMs) {
      this.entries.delete(callSid)
      return undefined
    }
    return entry
  }
}

/** Bounded, TTL'd "have I seen this id" set, used to ignore replayed or duplicate webhooks. */
export class RecentIds {
  private readonly seen = new Map<string, number>()

  constructor(private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {}

  /** Returns true when the id is new (and remembers it), false when it was already seen. */
  add(id: string): boolean {
    const now = (this.options.now ?? Date.now)()
    const expiresAtMs = this.seen.get(id)
    if (expiresAtMs !== undefined && now <= expiresAtMs) return false
    this.seen.delete(id)
    this.seen.set(id, now + (this.options.ttlMs ?? 600_000))
    while (this.seen.size > (this.options.maxEntries ?? 1_024)) {
      this.seen.delete(this.seen.keys().next().value as string)
    }
    return true
  }
}
