import { describe, expect, it, vi } from "vitest"
import {
  BLUEBUBBLES_WEBHOOK_RECONCILE_INTERVAL_MS,
  blueBubblesWebhookOwnerToken,
  buildBlueBubblesWebhookCallbackUrl,
  createBlueBubblesWebhookReconciler,
  inspectBlueBubblesWebhookRegistration,
  reconcileBlueBubblesWebhookRegistration,
  sanitizeBlueBubblesWebhookText,
  type BlueBubblesWebhookRegistrationInput,
} from "../../../senses/bluebubbles/webhook-registration"

const input: BlueBubblesWebhookRegistrationInput = {
  serverUrl: "http://bluebubbles.local:1234",
  password: "super-secret",
  callbackPort: 18790,
  callbackPath: "/bluebubbles-webhook",
  agentName: "slugger",
  machineId: "machine_test",
  requestTimeoutMs: 1_234,
  listenerReady: true,
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

function hook(id: number, url: string, events: string[] = ["*"]) {
  return { id, url, events, created: "2026-08-17T00:00:00.000Z" }
}

function desiredUrl(overrides: Partial<BlueBubblesWebhookRegistrationInput> = {}): string {
  return buildBlueBubblesWebhookCallbackUrl({ ...input, ...overrides })
}

function requestShape(call: unknown[]) {
  return {
    url: String(call[0]),
    init: call[1] as RequestInit,
  }
}

describe("BlueBubbles webhook registration", () => {
  it("builds a stable agent-and-machine owner token and local callback URL", () => {
    const token = blueBubblesWebhookOwnerToken("slugger", "machine_test")

    expect(token).toMatch(/^v1_[0-9a-f]{32}$/)
    expect(blueBubblesWebhookOwnerToken("slugger", "machine_test")).toBe(token)
    expect(blueBubblesWebhookOwnerToken("other", "machine_test")).not.toBe(token)
    expect(blueBubblesWebhookOwnerToken("slugger", "machine_other")).not.toBe(token)
    expect(desiredUrl()).toBe(
      `http://127.0.0.1:18790/bluebubbles-webhook?password=super-secret&ouroWebhook=${token}`,
    )
    expect(desiredUrl({ callbackPath: "plain-path" })).toContain(":18790/plain-path?")
  })

  it("inspects an exact owned registration with one bounded GET", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [hook(7, desiredUrl())] }))

    const result = await inspectBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: true, state: "exact", ownedCount: 1, exactCount: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = requestShape(fetchImpl.mock.calls[0])
    expect(request.url).toBe("http://bluebubbles.local:1234/api/v1/webhook?password=super-secret")
    expect(request.init).toMatchObject({ method: "GET", signal: expect.any(AbortSignal) })
    expect(JSON.stringify(result)).not.toContain("super-secret")
    expect(JSON.stringify(result)).not.toContain("ouroWebhook")
  })

  it("classifies missing registration without mutating", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [] }))

    await expect(inspectBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      ok: false,
      state: "missing",
      ownedCount: 0,
      exactCount: 0,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("classifies owned drift while ignoring malformed unrelated URL text", async () => {
    const stale = desiredUrl({ callbackPort: 18789 })
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [hook(3, stale), hook(4, "not a URL")] }))

    await expect(inspectBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      ok: false,
      state: "drifted",
      ownedCount: 1,
      exactCount: 0,
    })
  })

  it("creates a missing registration with exact outbound POST shape then verifies it", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: hook(8, desiredUrl()) }))
      .mockResolvedValueOnce(json({ data: [hook(8, desiredUrl())] }))

    const result = await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: true, state: "exact", changed: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const post = requestShape(fetchImpl.mock.calls[1])
    expect(post.url).toBe("http://bluebubbles.local:1234/api/v1/webhook?password=super-secret")
    expect(post.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: desiredUrl(), events: ["*"] }),
      signal: expect.any(AbortSignal),
    })
  })

  it("creates desired before deleting a stale owned registration", async () => {
    const stale = desiredUrl({ callbackPort: 18789 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [hook(3, stale)] }))
      .mockResolvedValueOnce(json({ data: hook(4, desiredUrl()) }))
      .mockResolvedValueOnce(json({ data: null }))
      .mockResolvedValueOnce(json({ data: [hook(4, desiredUrl())] }))

    const result = await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: true, state: "exact", changed: true })
    expect(fetchImpl.mock.calls.map((call) => requestShape(call).init.method)).toEqual(["GET", "POST", "DELETE", "GET"])
    const deletion = requestShape(fetchImpl.mock.calls[2])
    expect(deletion.url).toBe("http://bluebubbles.local:1234/api/v1/webhook/3?password=super-secret")
    expect(deletion.init).toEqual({
      method: "DELETE",
      signal: expect.any(AbortSignal),
    })
  })

  it("removes duplicate owned registrations but preserves unrelated hooks", async () => {
    const other = "http://127.0.0.1:9999/elsewhere?password=other"
    const ownedDuplicate = `${desiredUrl()}&duplicate=1`
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [hook(1, desiredUrl()), hook(2, ownedDuplicate), hook(99, other)] }))
      .mockResolvedValueOnce(json({ data: null }))
      .mockResolvedValueOnce(json({ data: [hook(1, desiredUrl()), hook(99, other)] }))

    const result = await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: true, state: "exact", changed: true })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(requestShape(fetchImpl.mock.calls[1]).url).toContain("/api/v1/webhook/2?")
    expect(fetchImpl.mock.calls.some((call) => requestShape(call).url.includes("/99?"))).toBe(false)
  })

  it("adopts one exact unmarked callback by creating owned desired before deleting it", async () => {
    const unmarked = new URL(desiredUrl())
    unmarked.searchParams.delete("ouroWebhook")
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [hook(5, unmarked.toString())] }))
      .mockResolvedValueOnce(json({ data: hook(6, desiredUrl()) }))
      .mockResolvedValueOnce(json({ data: null }))
      .mockResolvedValueOnce(json({ data: [hook(6, desiredUrl())] }))

    await expect(reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      ok: true,
      state: "exact",
      changed: true,
    })
    expect(fetchImpl.mock.calls.map((call) => requestShape(call).init.method)).toEqual(["GET", "POST", "DELETE", "GET"])
    expect(requestShape(fetchImpl.mock.calls[2]).url).toContain("/api/v1/webhook/5?")
  })

  it("ignores malformed unowned URL text while creating the desired registration", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [hook(5, "not a URL")] }))
      .mockResolvedValueOnce(json({ data: hook(6, desiredUrl()) }))
      .mockResolvedValueOnce(json({ data: [hook(5, "not a URL"), hook(6, desiredUrl())] }))

    await expect(reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      ok: true,
      state: "exact",
      changed: true,
    })
    expect(fetchImpl.mock.calls.map((call) => requestShape(call).init.method)).toEqual(["GET", "POST", "GET"])
  })

  it("leaves all prior hooks untouched when desired creation fails", async () => {
    const stale = desiredUrl({ callbackPort: 18789 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [hook(3, stale)] }))
      .mockResolvedValueOnce(json({ error: "create failed" }, 500))

    const result = await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: false, state: "drifted", changed: false })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.some((call) => requestShape(call).init.method === "DELETE")).toBe(false)
  })

  it("reports missing when first creation fails without prior owned state", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockRejectedValueOnce("transport refused")

    await expect(reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      ok: false,
      state: "missing",
      changed: false,
      detail: expect.stringContaining("transport refused"),
    })
  })

  it("reports degraded drift when stale owned deletion fails", async () => {
    const stale = desiredUrl({ callbackPort: 18789 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [hook(3, stale), hook(4, desiredUrl())] }))
      .mockResolvedValueOnce(json({ error: "delete failed" }, 500))

    const result = await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: false, state: "drifted", changed: false })
    expect(result.detail).toContain("could not remove 1 stale owned registration")
  })

  it("sanitizes Error failures from mutation transport", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockRejectedValueOnce(new Error(`POST ${desiredUrl()} failed`))

    const result = await reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })
    expect(result).toMatchObject({ state: "missing", changed: false })
    expect(JSON.stringify(result)).not.toContain("super-secret")
  })

  it.each([401, 403])("classifies HTTP %s as auth-failed", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: "no" }, status))

    const result = await inspectBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: false, state: "auth-failed" })
    expect(JSON.stringify(result)).not.toContain("super-secret")
  })

  it("classifies non-auth HTTP and non-Error transport failures", async () => {
    await expect(inspectBlueBubblesWebhookRegistration(input, {
      fetchImpl: vi.fn().mockResolvedValue(json({ error: "down" }, 503)),
    })).resolves.toMatchObject({ state: "api-unreachable", detail: expect.stringContaining("503") })
    await expect(inspectBlueBubblesWebhookRegistration(input, {
      fetchImpl: vi.fn().mockRejectedValue("offline"),
    })).resolves.toMatchObject({ state: "api-unreachable", detail: "offline" })
  })

  it("classifies transport failure as API-unreachable and redacts every secret-bearing URL", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(
      `fetch ${desiredUrl()} and http://bluebubbles.local/api/v1/webhook?password=super-secret failed`,
    ))

    const result = await inspectBlueBubblesWebhookRegistration(input, { fetchImpl })

    expect(result).toMatchObject({ ok: false, state: "api-unreachable" })
    expect(JSON.stringify(result)).not.toContain("super-secret")
    expect(JSON.stringify(result)).not.toContain(blueBubblesWebhookOwnerToken("slugger", "machine_test"))
    expect(sanitizeBlueBubblesWebhookText(desiredUrl(), input)).toBe("http://127.0.0.1:18790/bluebubbles-webhook?[redacted]")
  })

  it.each([
    ["invalid JSON", new Response("not json", { status: 200 })],
    ["null payload", json(null)],
    ["missing data", json({ nope: [] })],
    ["null row", json({ data: [null] })],
    ["invalid row", json({ data: [{ id: "x", url: 4, events: null }] })],
  ])("classifies malformed API response: %s", async (_label, response) => {
    const result = await inspectBlueBubblesWebhookRegistration(input, {
      fetchImpl: vi.fn().mockResolvedValue(response),
    })

    expect(result).toMatchObject({ ok: false, state: "malformed" })
  })

  it("reports listener-not-ready without calling BlueBubbles", async () => {
    const fetchImpl = vi.fn()

    const result = await inspectBlueBubblesWebhookRegistration({ ...input, listenerReady: false }, { fetchImpl })

    expect(result).toMatchObject({ ok: false, state: "listener-not-ready" })
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(reconcileBlueBubblesWebhookRegistration({ ...input, listenerReady: false }, { fetchImpl })).resolves.toMatchObject({
      state: "listener-not-ready",
    })
  })

  it("preserves changed truth when post-mutation verification fails", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: hook(8, desiredUrl()) }))
      .mockResolvedValueOnce(json({ error: "verify unavailable" }, 503))

    await expect(reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      state: "api-unreachable",
      changed: true,
    })
  })

  it("returns initial reconciliation diagnostics without mutation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: "no" }, 401))
    await expect(reconcileBlueBubblesWebhookRegistration(input, { fetchImpl })).resolves.toMatchObject({
      state: "auth-failed",
      changed: false,
    })
  })

  it("runs one immediate and periodic single-flight reconciliation and cancels its timer", async () => {
    let resolveFetch!: (response: Response) => void
    let activeSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve
      activeSignal = init?.signal ?? undefined
      activeSignal?.addEventListener("abort", () => reject(activeSignal?.reason ?? new Error("aborted")), { once: true })
    }))
    let timerCallback!: () => void
    const setIntervalImpl = vi.fn((callback: () => void, intervalMs: number) => {
      timerCallback = callback
      expect(intervalMs).toBe(180_000)
      return { timer: 1 }
    })
    const clearIntervalImpl = vi.fn()

    const reconciler = createBlueBubblesWebhookReconciler(input, {
      fetchImpl,
      setIntervalImpl,
      clearIntervalImpl,
    })
    const first = reconciler.reconcileNow()
    const second = reconciler.reconcileNow()
    timerCallback()

    expect(BLUEBUBBLES_WEBHOOK_RECONCILE_INTERVAL_MS).toBe(180_000)
    expect(first).toBe(second)
    expect(fetchImpl).toHaveBeenCalledOnce()
    resolveFetch(json({ data: [hook(1, desiredUrl())] }))
    await expect(first).resolves.toMatchObject({ ok: true, state: "exact" })

    timerCallback()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const periodic = reconciler.reconcileNow()
    reconciler.close()
    reconciler.close()
    expect(clearIntervalImpl).toHaveBeenCalledWith({ timer: 1 })
    expect(activeSignal?.aborted).toBe(true)
    await expect(periodic).resolves.toMatchObject({ ok: false, state: "api-unreachable" })
    await expect(reconciler.reconcileNow()).resolves.toMatchObject({ ok: false, state: "listener-not-ready" })
  })

  it("uses the default fetch and timer adapters and records a degraded immediate outcome", async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: "offline" }, 503))
    vi.stubGlobal("fetch", fetchImpl)
    try {
      const reconciler = createBlueBubblesWebhookReconciler(input)
      await vi.runAllTicks()
      await Promise.resolve()
      expect(fetchImpl).toHaveBeenCalledOnce()
      reconciler.close()

      fetchImpl.mockClear()
      await expect(inspectBlueBubblesWebhookRegistration(input)).resolves.toMatchObject({ state: "api-unreachable" })
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
