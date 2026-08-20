import { describe, expect, it, vi } from "vitest"

import { createApprovedUnraidRestartExecutor, SANCTUARY_RESTART_MUTATION } from "../../repertoire/unraid-restart"

const running = (id = "Docker:abc", name = "calibre-web") => ({
  ok: true as const,
  data: { containers: [{ id, name, autostart: true, state: "running" as const, exitCode: null, degraded: false, status: "Up 2 hours" }], truncated: false },
})

describe("approved Unraid restart executor", () => {
  it("loads the write credential only inside execution and sends one exact mutation", async () => {
    const listContainers = vi.fn().mockResolvedValue(running())
    const loadWriteApiKey = vi.fn().mockResolvedValue("secret-write-key")
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"], state: "RUNNING", status: "Up Less than a second" } } })
    const createClient = vi.fn().mockReturnValue({ mutate })
    const persistAttempt = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "http://sanctuary/graphql", listContainers, loadWriteApiKey, createClient, persistAttempt })

    expect(loadWriteApiKey).not.toHaveBeenCalled()
    const result = await restart({ container: "calibre-web" })

    expect(loadWriteApiKey).toHaveBeenCalledTimes(1)
    expect(createClient).toHaveBeenCalledWith({ endpoint: "http://sanctuary/graphql", apiKey: "secret-write-key" })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(SANCTUARY_RESTART_MUTATION, { id: "Docker:abc" })
    expect(listContainers).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ ok: true, data: { container: { id: "Docker:abc", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } })
    expect(persistAttempt.mock.calls.map(([entry]) => entry.state)).toEqual(["attempt_not_started", "attempting", "succeeded"])
  })

  it("fails closed on exact name-to-id drift without mutation", async () => {
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running("Docker:abc"))
      .mockResolvedValueOnce(running("Docker:def"))
    const mutate = vi.fn()
    const loadWriteApiKey = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "http://sanctuary/graphql",
      listContainers,
      loadWriteApiKey,
      createClient: () => ({ mutate }),
    })

    const result = await restart({ container: "calibre-web" })
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "stale_target" }) }))
    expect(loadWriteApiKey).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("never retries an ambiguous mutation transport failure", async () => {
    const listContainers = vi.fn().mockResolvedValue(running())
    const mutate = vi.fn().mockRejectedValue(Object.assign(new Error("transport failed"), { ambiguous: true }))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "http://sanctuary/graphql",
      listContainers,
      loadWriteApiKey: async () => "secret-write-key",
      createClient: () => ({ mutate }),
      sleep: vi.fn().mockResolvedValue(undefined),
      observationTimeoutMs: 0,
    })

    const result = await restart({ container: "calibre-web" })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "ambiguous" }) }))
  })

  it.each([
    ["", "invalid_response"],
    ["x".repeat(129), "invalid_response"],
    ["bad\uFFFDname", "invalid_response"],
  ])("rejects invalid exact container argument %j before reading", async (container, code) => {
    const listContainers = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: vi.fn(),
    })
    await expect(restart({ container })).resolves.toMatchObject({ ok: false, error: { code } })
    expect(listContainers).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, error: { code: "transport", message: "offline", degraded: true } }, "invalid_response"],
    [{ ok: true, data: { containers: [], truncated: false } }, "not_found"],
    [{ ok: true, data: { containers: [running().data.containers[0], running("Docker:def").data.containers[0]], truncated: false } }, "ambiguous"],
  ] as const)("fails closed when target resolution is not exact", async (listing, code) => {
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(listing),
      loadWriteApiKey: vi.fn(),
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code } })
  })

  it("fails closed when the write credential is blank after persisting the pre-attempt state", async () => {
    const persistAttempt = vi.fn()
    const createClient = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: vi.fn().mockResolvedValue("   "),
      createClient,
      persistAttempt,
      now: () => new Date("2026-08-20T00:00:00Z"),
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    expect(createClient).not.toHaveBeenCalled()
    expect(persistAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      container: { id: "Docker:abc", name: "calibre-web" },
      beforeState: "running",
      observedAt: "2026-08-20T00:00:00.000Z",
      state: "attempt_not_started",
      actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      argumentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      attemptId: expect.any(String),
      mutationAcknowledged: false,
      afterState: null,
    }))
  })

  it.each([
    [{}, false],
    [{ docker: [] }, false],
    [{ docker: { restart: [] } }, false],
    [{ docker: { restart: { id: "Docker:def", names: ["/calibre-web"] } } }, false],
    [{ docker: { restart: { id: "Docker:abc", names: "calibre-web" } } }, false],
    [{ docker: { restart: { id: "Docker:abc", names: ["/calibre-web", "/other"] } } }, false],
    [{ docker: { restart: { id: "Docker:abc", names: ["/other"] } } }, false],
  ] as const)("treats malformed mutation acknowledgement as indeterminate", async (mutation) => {
    const mutate = vi.fn().mockResolvedValue(mutation)
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      sleep: async () => undefined,
      observationTimeoutMs: 0,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
    expect(mutate).toHaveBeenCalledExactlyOnceWith(SANCTUARY_RESTART_MUTATION, { id: "Docker:abc" })
  })

  it("requires either acknowledgement or an observed restarting transition", async () => {
    const listings = [running(), running(), running(), {
      ok: true as const,
      data: { containers: [{ ...running().data.containers[0], state: "restarting" as const }], truncated: false },
    }, running()]
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn(async () => listings.shift()!),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({}) }),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: (() => {
        let tick = 0
        return () => new Date(tick++ * 1_000)
      })(),
      observationTimeoutMs: 10_000,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: true, data: { observedRestart: true } })
  })

  it("reports post-attempt identity drift and persists the indeterminate state", async () => {
    const persistAttempt = vi.fn()
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running("Docker:def"))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
      persistAttempt,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("identity changed") } })
    expect(persistAttempt.mock.calls.at(-1)?.[0].state).toBe("attempted_or_indeterminate")
  })

  it("returns a fresh-resolution failure before loading credentials", async () => {
    const loadWriteApiKey = vi.fn()
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce({ ok: true, data: { containers: [], truncated: false } })
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers, loadWriteApiKey })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(loadWriteApiKey).not.toHaveBeenCalled()
  })

  it("continues polling when an observation cannot resolve the target", async () => {
    const listings = [running(), running(), { ok: true as const, data: { containers: [], truncated: false } }]
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn(async () => listings.shift()!),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({}) }),
      sleep: vi.fn(),
      observationTimeoutMs: 0,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
  })

  it("invokes the default client and polling sleep adapters", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({
        method: "POST",
        headers: { "x-api-key": "key", "Content-Type": "application/json" },
        body: JSON.stringify({ query: SANCTUARY_RESTART_MUTATION, variables: { id: "Docker:abc" } }),
      })
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetch)
    try {
      const restart = createApprovedUnraidRestartExecutor({
        endpoint: "https://host/graphql",
        listContainers: vi.fn().mockResolvedValue(running()),
        loadWriteApiKey: async () => "key",
        observationTimeoutMs: 1_000,
      })
      const pending = restart({ container: "calibre-web" })
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it("constructs the executor with its default adapters", () => {
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn(),
      loadWriteApiKey: vi.fn(),
    })
    expect(restart).toBeTypeOf("function")
  })
})
