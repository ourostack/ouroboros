import { emitNervesEvent } from "../nerves/runtime"
import type { LegacyRsvpAllGuestRow, LegacyRsvpGuestRow } from "./snapshot"

export const AISLEPLANNER_API_VERSION = "2019-06-10" as const
export const AISLEPLANNER_DEFAULT_BASE_URL = "https://www.aisleplanner.com" as const
export const AISLEPLANNER_DEFAULT_TIMEOUT_MS = 30_000

export type AislePlannerFailureReason =
  | "auth_denied"
  | "mfa_or_captcha"
  | "missing_xsrf"
  | "schema_drift"
  | "rate_limited"
  | "network_timeout"
  | "network_error"
  | "http_error"

export interface AislePlannerFailure {
  reason: AislePlannerFailureReason
  actor: "agent-runnable" | "human-required"
  message: string
  httpStatus?: number
}

export interface AislePlannerCredentials {
  username: string
  password: string
}

export interface AislePlannerStaleFallback {
  snapshotId: string
  fetchedAt: string
  guests: Record<string, LegacyRsvpGuestRow>
  allGuests: Record<string, LegacyRsvpAllGuestRow>
}

export interface FetchAislePlannerRsvpsInput {
  agent: string
  weddingId: string
  eventId: string
  credentials: AislePlannerCredentials
  baseUrl?: string
  timeoutMs?: number
  fetchedAt?: string
  fetchFn?: typeof fetch
  staleFallback?: AislePlannerStaleFallback
}

export type AislePlannerFetchResult =
  | {
    ok: true
    source: "live"
    fetchedAt: string
    guests: Record<string, LegacyRsvpGuestRow>
    allGuests: Record<string, LegacyRsvpAllGuestRow>
  }
  | {
    ok: true
    source: "stale-fallback"
    fetchedAt: string
    staleSnapshotId: string
    liveFailure: AislePlannerFailure
    guests: Record<string, LegacyRsvpGuestRow>
    allGuests: Record<string, LegacyRsvpAllGuestRow>
  }
  | ({ ok: false } & AislePlannerFailure)

type JsonRecord = Record<string, unknown>

interface CookieJar {
  setFromResponse(response: Response): void
  get(name: string): string | undefined
  header(): string
}

interface RequestFailure {
  ok: false
  failure: AislePlannerFailure
}

interface RequestSuccess {
  ok: true
  response: Response
  body: unknown
}

type RequestResult = RequestSuccess | RequestFailure

function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>()
  return {
    setFromResponse(response: Response): void {
      for (const header of setCookieHeaders(response.headers)) {
        const pair = header.split(";", 1)[0].trim()
        const separator = pair.indexOf("=")
        if (separator <= 0) continue
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
      }
    },
    get(name: string): string | undefined {
      return cookies.get(name)
    },
    header(): string {
      return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ")
    },
  }
}

function setCookieHeaders(headers: Headers): string[] {
  const combined = headers.get("set-cookie")
  return combined ? splitCombinedSetCookie(combined) : []
}

function splitCombinedSetCookie(header: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < header.length; index += 1) {
    if (header[index] !== ",") continue
    const remainder = header.slice(index + 1)
    if (/^\s*[^=;,\s]+=/.test(remainder)) {
      parts.push(header.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(header.slice(start).trim())
  return parts.filter(Boolean)
}

function decodedCookie(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function baseUrlFor(input: FetchAislePlannerRsvpsInput): string {
  const base = input.baseUrl ?? AISLEPLANNER_DEFAULT_BASE_URL
  return base.endsWith("/") ? base : `${base}/`
}

function apiUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), baseUrl).toString()
}

function requestHeaders(jar: CookieJar, xsrfToken: string, json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-Requested-With": "XMLHttpRequest",
    "X-AP-API-Version": AISLEPLANNER_API_VERSION,
    "X-XSRF-TOKEN": xsrfToken,
    Cookie: jar.header(),
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function bodyText(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body)
}

function hasMfaOrCaptcha(body: unknown): boolean {
  return /captcha|mfa|multi-factor|additional verification/i.test(bodyText(body))
}

function classifyHttpFailure(response: Response, body: unknown, context: "signin" | "read"): AislePlannerFailure {
  if (hasMfaOrCaptcha(body)) {
    return {
      reason: "mfa_or_captcha",
      actor: "human-required",
      message: "AislePlanner requires human verification before API access can continue",
      httpStatus: response.status,
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      reason: "auth_denied",
      actor: "human-required",
      message: "AislePlanner rejected the configured credentials",
      httpStatus: response.status,
    }
  }
  if (response.status === 429) {
    return {
      reason: "rate_limited",
      actor: "agent-runnable",
      message: "AislePlanner rate limited the RSVP fetch",
      httpStatus: response.status,
    }
  }
  return {
    reason: "http_error",
    actor: "agent-runnable",
    message: `AislePlanner ${context} request failed with HTTP ${response.status}`,
    httpStatus: response.status,
  }
}

function classifyThrown(error: unknown): AislePlannerFailure {
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : String(error)
  if (/AbortError|TimeoutError|timed out|aborted/i.test(`${name} ${message}`)) {
    return {
      reason: "network_timeout",
      actor: "agent-runnable",
      message: "AislePlanner request timed out",
    }
  }
  return {
    reason: "network_error",
    actor: "agent-runnable",
    message: "AislePlanner request failed before a response was received",
  }
}

async function request(
  fetchFn: typeof fetch,
  jar: CookieJar,
  url: string,
  init: RequestInit,
  context: "signin" | "read",
): Promise<RequestResult> {
  try {
    const response = await fetchFn(url, init)
    jar.setFromResponse(response)
    const body = await readBody(response)
    if (!response.ok) {
      return { ok: false, failure: classifyHttpFailure(response, body, context) }
    }
    return { ok: true, response, body }
  } catch (error) {
    return { ok: false, failure: classifyThrown(error) }
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function readGroupId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null
}

function idString(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const id = String(value).trim()
    if (id) return id
  }
  return null
}

function normalizeGuestRows(body: unknown): Record<string, LegacyRsvpAllGuestRow> | null {
  if (!Array.isArray(body)) return null
  const guests: Record<string, LegacyRsvpAllGuestRow> = {}
  for (const entry of body) {
    const row = asRecord(entry)
    const id = idString(row?.id)
    if (!row || !id) return null
    guests[id] = {
      first_name: readString(row.first_name),
      last_name: readString(row.last_name),
      group_id: readGroupId(row.group_id),
    }
  }
  return guests
}

function normalizeEventGuestRows(body: unknown): Map<string, string | null> | null {
  if (!Array.isArray(body)) return null
  const eventGuests = new Map<string, string | null>()
  for (const entry of body) {
    const row = asRecord(entry)
    const id = idString(row?.wedding_guest_id)
    const status = row?.attending_status
    if (!row || !id || !(status === undefined || status === null || typeof status === "string")) return null
    eventGuests.set(id, status ?? null)
  }
  return eventGuests
}

function joinGuests(
  allGuests: Record<string, LegacyRsvpAllGuestRow>,
  eventGuests: Map<string, string | null>,
): Record<string, LegacyRsvpGuestRow> | null {
  const guests: Record<string, LegacyRsvpGuestRow> = {}
  for (const [id, status] of eventGuests) {
    const guest = allGuests[id]
    if (!guest) return null
    guests[id] = {
      first_name: guest.first_name,
      last_name: guest.last_name,
      group_id: guest.group_id,
      attending_status: status,
    }
  }
  return guests
}

function canUseStaleFallback(reason: AislePlannerFailureReason): boolean {
  return ["network_timeout", "network_error", "rate_limited"].includes(reason)
}

function withStaleFallback(input: FetchAislePlannerRsvpsInput, liveFailure: AislePlannerFailure): AislePlannerFetchResult | null {
  if (!input.staleFallback || !canUseStaleFallback(liveFailure.reason)) return null
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.aisleplanner_stale_fallback",
    message: "using stale RSVP snapshot after live AislePlanner fetch failure",
    meta: {
      agent: input.agent,
      reason: liveFailure.reason,
      staleSnapshotId: input.staleFallback.snapshotId,
    },
  })
  return {
    ok: true,
    source: "stale-fallback",
    fetchedAt: input.staleFallback.fetchedAt,
    staleSnapshotId: input.staleFallback.snapshotId,
    liveFailure,
    guests: input.staleFallback.guests,
    allGuests: input.staleFallback.allGuests,
  }
}

function finalizeFailure(input: FetchAislePlannerRsvpsInput, liveFailure: AislePlannerFailure): AislePlannerFetchResult {
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.aisleplanner_fetch_error",
    message: "AislePlanner RSVP fetch failed",
    meta: {
      agent: input.agent,
      reason: liveFailure.reason,
      httpStatus: liveFailure.httpStatus ?? null,
    },
  })
  return withStaleFallback(input, liveFailure) ?? { ok: false, ...liveFailure }
}

export async function fetchAislePlannerRsvps(input: FetchAislePlannerRsvpsInput): Promise<AislePlannerFetchResult> {
  const fetchFn = input.fetchFn ?? fetch
  const timeoutMs = input.timeoutMs ?? AISLEPLANNER_DEFAULT_TIMEOUT_MS
  const baseUrl = baseUrlFor(input)
  const jar = createCookieJar()

  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.aisleplanner_fetch_start",
    message: "fetching RSVP state from AislePlanner",
    meta: {
      agent: input.agent,
      weddingId: input.weddingId,
      eventId: input.eventId,
    },
  })

  const signinPage = await request(fetchFn, jar, apiUrl(baseUrl, "/signin"), {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  }, "signin")
  if (!signinPage.ok) return finalizeFailure(input, signinPage.failure)

  const initialXsrf = decodedCookie(jar.get("XSRF-TOKEN"))
  if (!initialXsrf) {
    return finalizeFailure(input, {
      reason: "missing_xsrf",
      actor: "agent-runnable",
      message: "AislePlanner signin did not return an XSRF token",
      httpStatus: signinPage.response.status,
    })
  }

  const signin = await request(fetchFn, jar, apiUrl(baseUrl, "/api/account/signin"), {
    method: "POST",
    headers: requestHeaders(jar, initialXsrf, true),
    body: JSON.stringify({
      username: input.credentials.username,
      password: input.credentials.password,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, "signin")
  if (!signin.ok) return finalizeFailure(input, signin.failure)

  const liveXsrf = decodedCookie(jar.get("XSRF-TOKEN")) ?? initialXsrf
  const guestsResponse = await request(fetchFn, jar, apiUrl(baseUrl, `/api/wedding/${input.weddingId}/guests`), {
    method: "GET",
    headers: requestHeaders(jar, liveXsrf),
    signal: AbortSignal.timeout(timeoutMs),
  }, "read")
  if (!guestsResponse.ok) return finalizeFailure(input, guestsResponse.failure)

  const allGuests = normalizeGuestRows(guestsResponse.body)
  if (!allGuests) {
    return finalizeFailure(input, {
      reason: "schema_drift",
      actor: "agent-runnable",
      message: "AislePlanner guest payload no longer matches the expected schema",
    })
  }

  const eventGuestsResponse = await request(fetchFn, jar, apiUrl(baseUrl, `/api/wedding/${input.weddingId}/events/${input.eventId}/guests`), {
    method: "GET",
    headers: requestHeaders(jar, liveXsrf),
    signal: AbortSignal.timeout(timeoutMs),
  }, "read")
  if (!eventGuestsResponse.ok) return finalizeFailure(input, eventGuestsResponse.failure)

  const eventGuests = normalizeEventGuestRows(eventGuestsResponse.body)
  if (!eventGuests) {
    return finalizeFailure(input, {
      reason: "schema_drift",
      actor: "agent-runnable",
      message: "AislePlanner event guest payload no longer matches the expected schema",
    })
  }
  const guests = joinGuests(allGuests, eventGuests)
  if (!guests) {
    return finalizeFailure(input, {
      reason: "schema_drift",
      actor: "agent-runnable",
      message: "AislePlanner event guest payload references guests absent from the wedding guest list",
    })
  }

  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.aisleplanner_fetch_end",
    message: "fetched RSVP state from AislePlanner",
    meta: {
      agent: input.agent,
      weddingId: input.weddingId,
      eventId: input.eventId,
      guestCount: Object.keys(guests).length,
      allGuestCount: Object.keys(allGuests).length,
    },
  })

  return {
    ok: true,
    source: "live",
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    guests,
    allGuests,
  }
}
