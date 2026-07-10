import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  fetchAislePlannerRsvps,
  type AislePlannerFetchResult,
} from "../../rsvp/aisleplanner-client"

const nervesEvents: Array<Record<string, unknown>> = []

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

function textResponse(text: string, init: ResponseInit = {}): Response {
  return new Response(text, init)
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

function cookieResponse(cookie: string): Response {
  return textResponse("<html>signin</html>", {
    status: 200,
    headers: { "set-cookie": cookie },
  })
}

function baseInput(fetchFn: typeof fetch) {
  return {
    agent: "slugger",
    weddingId: "484532",
    eventId: "2081539",
    credentials: {
      username: "ari@example.com",
      password: "super-secret",
    },
    fetchFn,
    timeoutMs: 1234,
    fetchedAt: "2026-07-09T17:30:00.000Z",
  }
}

function fetchCall(fetchFn: ReturnType<typeof vi.fn>, index: number): { url: URL; init: RequestInit } {
  const [rawUrl, init] = fetchFn.mock.calls[index] as [string, RequestInit]
  return { url: new URL(rawUrl), init }
}

describe("AislePlanner RSVP read adapter", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    nervesEvents.length = 0
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function authedFetch(guestResponse: Response, eventGuestResponse = jsonResponse([])): ReturnType<typeof vi.fn> {
    return vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token-two; Path=/"))
      .mockResolvedValueOnce(guestResponse)
      .mockResolvedValueOnce(eventGuestResponse)
  }

  it("authenticates with XSRF cookies, fetches read-only guest endpoints, and joins event RSVP rows", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token%2Bone; Path=/; HttpOnly, ap_session=session-one; Path=/; HttpOnly"))
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token%2Btwo; Path=/; HttpOnly, ap_session=session-two; Path=/; HttpOnly"))
      .mockResolvedValueOnce(jsonResponse([
        { id: 1, first_name: "Ari", last_name: "Mendelow", group_id: 7 },
        { id: 2, first_name: "Rachel", last_name: "Example", group_id: 7 },
        { id: 3, first_name: "Unassigned", last_name: "Guest", group_id: 9 },
      ]))
      .mockResolvedValueOnce(jsonResponse([
        { wedding_guest_id: 1, attending_status: "attending" },
        { wedding_guest_id: 2, attending_status: null },
      ]))

    const result = await fetchAislePlannerRsvps(baseInput(fetchFn as unknown as typeof fetch))

    expect(result).toMatchObject({
      ok: true,
      source: "live",
      fetchedAt: "2026-07-09T17:30:00.000Z",
      guests: {
        "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "attending" },
        "2": { first_name: "Rachel", last_name: "Example", group_id: 7, attending_status: null },
      },
      allGuests: {
        "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7 },
        "2": { first_name: "Rachel", last_name: "Example", group_id: 7 },
        "3": { first_name: "Unassigned", last_name: "Guest", group_id: 9 },
      },
    })

    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(fetchCall(fetchFn, 0).url.toString()).toBe("https://www.aisleplanner.com/signin")

    const signin = fetchCall(fetchFn, 1)
    expect(signin.url.toString()).toBe("https://www.aisleplanner.com/api/account/signin")
    expect(signin.init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-AP-API-Version": "2019-06-10",
        "X-XSRF-TOKEN": "token+one",
        Cookie: expect.stringContaining("ap_session=session-one"),
      }),
      signal: expect.any(AbortSignal),
    })
    expect(JSON.parse(signin.init.body as string)).toEqual({
      username: "ari@example.com",
      password: "super-secret",
    })

    const guests = fetchCall(fetchFn, 2)
    expect(guests.url.toString()).toBe("https://www.aisleplanner.com/api/wedding/484532/guests")
    expect(guests.init).toMatchObject({
      method: "GET",
      headers: expect.objectContaining({
        "X-XSRF-TOKEN": "token+two",
        Cookie: expect.stringContaining("ap_session=session-two"),
      }),
      signal: expect.any(AbortSignal),
    })

    const eventGuests = fetchCall(fetchFn, 3)
    expect(eventGuests.url.toString()).toBe("https://www.aisleplanner.com/api/wedding/484532/events/2081539/guests")
    expect(eventGuests.init.method).toBe("GET")

    expect(nervesEvents).toContainEqual(expect.objectContaining({
      component: "rsvp",
      event: "rsvp.aisleplanner_fetch_start",
      meta: expect.objectContaining({ agent: "slugger", weddingId: "484532", eventId: "2081539" }),
    }))
    expect(nervesEvents).toContainEqual(expect.objectContaining({
      component: "rsvp",
      event: "rsvp.aisleplanner_fetch_end",
      meta: expect.objectContaining({ agent: "slugger", guestCount: 2, allGuestCount: 3 }),
    }))
    expect(JSON.stringify(nervesEvents)).not.toContain("super-secret")
  })

  it("hard-fails without attempting signin when AislePlanner does not issue an XSRF cookie", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(textResponse("<html>signin</html>", { status: 200 }))

    const result = await fetchAislePlannerRsvps(baseInput(fetchFn as unknown as typeof fetch))

    expect(result).toEqual({
      ok: false,
      reason: "missing_xsrf",
      actor: "agent-runnable",
      message: "AislePlanner signin did not return an XSRF token",
      httpStatus: 200,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("classifies auth denial and MFA/captcha as human-required without leaking credentials", async () => {
    const authDeniedFetch = vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(jsonResponse({ error: "bad username or password" }, { status: 401 }))

    const denied = await fetchAislePlannerRsvps(baseInput(authDeniedFetch as unknown as typeof fetch))

    expect(denied).toMatchObject({
      ok: false,
      reason: "auth_denied",
      actor: "human-required",
      httpStatus: 401,
    })

    const captchaFetch = vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(textResponse("additional verification captcha required", { status: 403 }))

    const captcha = await fetchAislePlannerRsvps(baseInput(captchaFetch as unknown as typeof fetch))

    expect(captcha).toMatchObject({
      ok: false,
      reason: "mfa_or_captcha",
      actor: "human-required",
      httpStatus: 403,
    })
    expect(JSON.stringify([denied, captcha, nervesEvents])).not.toContain("super-secret")
  })

  it("returns typed rate-limit and schema-drift failures", async () => {
    const rateLimitedFetch = vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, { status: 429 }))

    await expect(fetchAislePlannerRsvps(baseInput(rateLimitedFetch as unknown as typeof fetch))).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      actor: "agent-runnable",
      httpStatus: 429,
    })

    const schemaDriftFetch = vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(jsonResponse([{ id: 1, first_name: "Ari" }]))
      .mockResolvedValueOnce(jsonResponse([{ wedding_guest_id: {}, attending_status: "attending" }]))

    await expect(fetchAislePlannerRsvps(baseInput(schemaDriftFetch as unknown as typeof fetch))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      actor: "agent-runnable",
      message: "AislePlanner event guest payload no longer matches the expected schema",
    })
  })

  it("classifies network timeouts and can return an explicitly stale fallback", async () => {
    const timeout = new Error("operation timed out")
    timeout.name = "AbortError"
    const timeoutFetch = vi.fn().mockRejectedValue(timeout)

    await expect(fetchAislePlannerRsvps(baseInput(timeoutFetch as unknown as typeof fetch))).resolves.toMatchObject({
      ok: false,
      reason: "network_timeout",
      actor: "agent-runnable",
    })

    const staleResult = await fetchAislePlannerRsvps({
      ...baseInput(timeoutFetch as unknown as typeof fetch),
      staleFallback: {
        snapshotId: "rsvp_previous",
        fetchedAt: "2026-07-08T10:00:00.000Z",
        guests: {
          "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "pending" },
        },
        allGuests: {
          "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7 },
        },
      },
    })

    expect(staleResult).toMatchObject({
      ok: true,
      source: "stale-fallback",
      staleSnapshotId: "rsvp_previous",
      liveFailure: {
        reason: "network_timeout",
        actor: "agent-runnable",
      },
      guests: {
        "1": { first_name: "Ari", last_name: "Mendelow", group_id: 7, attending_status: "pending" },
      },
    } satisfies Partial<Extract<AislePlannerFetchResult, { ok: true }>>)

    const networkFetch = vi.fn().mockRejectedValue("socket closed")
    await expect(fetchAislePlannerRsvps(baseInput(networkFetch as unknown as typeof fetch))).resolves.toMatchObject({
      ok: false,
      reason: "network_error",
      actor: "agent-runnable",
    })
  })

  it("uses default fetch/options and survives cookie/body normalization quirks", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(cookieResponse("not-a-cookie; Path=/, XSRF-TOKEN=bad%GG; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, ap_session=session-one; Path=/"))
      .mockResolvedValueOnce(textResponse("", {
        status: 200,
        headers: { "set-cookie": "XSRF-TOKEN=; Path=/" },
      }))
      .mockResolvedValueOnce(jsonResponse([
        { id: " 1 ", first_name: 42, last_name: null, group_id: { bad: true } },
      ]))
      .mockResolvedValueOnce(jsonResponse([
        { wedding_guest_id: "1" },
      ]))
    globalThis.fetch = fetchFn as unknown as typeof fetch

    const result = await fetchAislePlannerRsvps({
      agent: "slugger",
      weddingId: "484532",
      eventId: "2081539",
      baseUrl: "https://ap.test/",
      credentials: {
        username: "ari@example.com",
        password: "super-secret",
      },
    })

    expect(result).toMatchObject({
      ok: true,
      source: "live",
      guests: {
        "1": { first_name: "", last_name: "", group_id: null, attending_status: null },
      },
      allGuests: {
        "1": { first_name: "", last_name: "", group_id: null },
      },
    })
    if (result.ok) expect(Number.isFinite(Date.parse(result.fetchedAt))).toBe(true)

    const signin = fetchCall(fetchFn, 1)
    expect(signin.url.toString()).toBe("https://ap.test/api/account/signin")
    expect(signin.init.headers).toEqual(expect.objectContaining({
      "X-XSRF-TOKEN": "bad%GG",
      Cookie: expect.stringContaining("ap_session=session-one"),
    }))
    const guests = fetchCall(fetchFn, 2)
    expect(guests.init.headers).toEqual(expect.objectContaining({
      "X-XSRF-TOKEN": "bad%GG",
    }))
  })

  it("reports read HTTP errors and every schema boundary without using stale data for human failures", async () => {
    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(textResponse("server sad", { status: 500 })) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "http_error",
      actor: "agent-runnable",
      httpStatus: 500,
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse({ data: [] })) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner guest payload no longer matches the expected schema",
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([null])) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner guest payload no longer matches the expected schema",
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([{ id: "   " }])) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner guest payload no longer matches the expected schema",
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([{ id: 1 }]), jsonResponse({ data: [] })) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner event guest payload no longer matches the expected schema",
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([{ id: 1 }]), textResponse("event server sad", { status: 500 })) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "http_error",
      actor: "agent-runnable",
      httpStatus: 500,
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([{ id: 1 }]), jsonResponse([null])) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner event guest payload no longer matches the expected schema",
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([{ id: 1 }]), jsonResponse([{ wedding_guest_id: 1, attending_status: { bad: true } }])) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner event guest payload no longer matches the expected schema",
    })

    await expect(fetchAislePlannerRsvps(baseInput(
      authedFetch(jsonResponse([{ id: 1 }]), jsonResponse([{ wedding_guest_id: 2, attending_status: "attending" }])) as unknown as typeof fetch,
    ))).resolves.toMatchObject({
      ok: false,
      reason: "schema_drift",
      message: "AislePlanner event guest payload references guests absent from the wedding guest list",
    })

    const deniedWithFallbackFetch = vi.fn()
      .mockResolvedValueOnce(cookieResponse("XSRF-TOKEN=token; Path=/"))
      .mockResolvedValueOnce(jsonResponse({ error: "bad username or password" }, { status: 401 }))
    await expect(fetchAislePlannerRsvps({
      ...baseInput(deniedWithFallbackFetch as unknown as typeof fetch),
      staleFallback: {
        snapshotId: "rsvp_previous",
        fetchedAt: "2026-07-08T10:00:00.000Z",
        guests: {},
        allGuests: {},
      },
    })).resolves.toMatchObject({
      ok: false,
      reason: "auth_denied",
      actor: "human-required",
    })
  })
})
