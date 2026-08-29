import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { createApprovedUnraidRestartExecutor, SANCTUARY_RESTART_MUTATION } from "../../repertoire/unraid-restart"

const running = (id = "Docker:abc", name = "calibre-web") => ({
  ok: true as const,
  data: { containers: [{ id, name, autostart: true, state: "running" as const, exitCode: null, degraded: false, status: "Up 2 hours" }], truncated: false },
})

const routineAuthority = (key: string, expectedPolicyVersion: number, receiptId = "relationship-1", profileVersion = 7) => ({
  key,
  expectedPolicyVersion,
  reauthorize: async () => ({ allowed: true as const, receiptId, profileVersion }),
})

describe("approved Unraid restart executor", () => {
  it("binds routine authority after exact double resolution and records every effect boundary", async () => {
    const reserveRoutineAction = vi.fn().mockReturnValue({ id: "receipt-1" })
    const transitionRoutineAction = vi.fn()
    const persistAttempt = vi.fn()
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } })
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      persistAttempt,
      reserveRoutineAction,
      transitionRoutineAction,
      now: () => new Date("2026-08-29T17:00:00.000Z"),
    })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("unraid.restart:calibre-web", 3, "relationship-1", 9) })).resolves.toMatchObject({ ok: true })
    expect(reserveRoutineAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: "unraid.restart:calibre-web", action: "unraid.container.restart", target: "calibre-web", expectedBeforeState: "running", resolvedTarget: { id: "Docker:abc", name: "calibre-web" }, effect: { operation: "restart", targetId: "Docker:abc" }, attemptId: expect.any(String), authorizationReceiptId: "relationship-1", authorizationVersion: 9 }))
    expect(transitionRoutineAction.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ id: "receipt-1", expectedState: "reserved", state: "attempting" }),
      expect.objectContaining({ id: "receipt-1", expectedState: "attempting", state: "effect_acknowledged", effectReceipt: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
      expect.objectContaining({ id: "receipt-1", expectedState: "effect_acknowledged", state: "verified", verifiedAfterState: "running" }),
    ])
    expect(mutate).toHaveBeenCalledOnce()
  })

  it("revalidates the central relationship capability after the second exact resolution and binds only the fresh receipt", async () => {
    const order: string[] = []
    const reserveRoutineAction = vi.fn((input) => { order.push("reserve"); return { id: "receipt-1", input } })
    const mutate = vi.fn(async () => { order.push("mutate"); return { docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } } })
    const reauthorize = vi.fn(async () => {
      order.push("reauthorize")
      return { allowed: true as const, receiptId: "relationship-fresh", profileVersion: 11 }
    })
    const listContainers = vi.fn(async () => { order.push("resolve"); return running() })
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      persistAttempt: vi.fn(),
      reserveRoutineAction,
      transitionRoutineAction: vi.fn(),
      now: () => new Date("2026-08-29T17:00:00.000Z"),
    })

    await expect(restart({ container: "calibre-web" }, { routine: {
      key: "unraid.restart:calibre-web",
      expectedPolicyVersion: 3,
      reauthorize,
    } })).resolves.toMatchObject({ ok: true })

    expect(order.slice(0, 4)).toEqual(["resolve", "resolve", "reauthorize", "reserve"])
    expect(reserveRoutineAction).toHaveBeenCalledWith(expect.objectContaining({ authorizationReceiptId: "relationship-fresh", authorizationVersion: 11 }))
    expect(mutate).toHaveBeenCalledOnce()
  })

  it("does not reserve or mutate when the live relationship capability is lost after exact target resolution", async () => {
    const reserveRoutineAction = vi.fn()
    const mutate = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      reserveRoutineAction,
      transitionRoutineAction: vi.fn(),
    })

    await expect(restart({ container: "calibre-web" }, { routine: {
      key: "unraid.restart:calibre-web",
      expectedPolicyVersion: 3,
      reauthorize: async () => ({ allowed: false as const, reason: "relationship capability revoked" }),
    } })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("revoked") } })
    expect(reserveRoutineAction).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    [async () => { throw new Error("relationship store offline") }, "unavailable"],
    [async () => ({ allowed: true as const, receiptId: "", profileVersion: 7 }), "versioned"],
    [async () => ({ allowed: true as const, receiptId: "receipt", profileVersion: 0 }), "versioned"],
  ])("fails closed without reservation or mutation when fresh relationship evidence is invalid", async (reauthorize, reason) => {
    const reserveRoutineAction = vi.fn()
    const mutate = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: async () => "key", createClient: () => ({ mutate }), reserveRoutineAction, transitionRoutineAction: vi.fn() })

    await expect(restart({ container: "calibre-web" }, { routine: { key: "restart", expectedPolicyVersion: 1, reauthorize } })).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining(reason) } })
    expect(reserveRoutineAction).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it("never mutates when routine reservation fails after exact resolution", async () => {
    const mutate = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      reserveRoutineAction: vi.fn(() => { throw new Error("routine action policy version changed") }),
      transitionRoutineAction: vi.fn(),
    })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("unraid.restart:calibre-web", 3, "relationship-1", 9) })).resolves.toMatchObject({ ok: false, error: { code: "stale_target", message: expect.stringContaining("policy") } })
    expect(mutate).not.toHaveBeenCalled()
  })

  it("freezes indeterminate routine effects without blind retry", async () => {
    const transitionRoutineAction = vi.fn()
    const mutate = vi.fn().mockRejectedValue(new Error("connection reset"))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      reserveRoutineAction: vi.fn().mockReturnValue({ id: "receipt-1" }),
      transitionRoutineAction,
      sleep: async () => undefined,
      observationTimeoutMs: 0,
    })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("unraid.restart:calibre-web", 3, "relationship-1", 9) })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("not retried") } })
    expect(mutate).toHaveBeenCalledOnce()
    expect(transitionRoutineAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "receipt-1", state: "indeterminate", recoveryState: { state: "manual_inspection_required", compensation: "none" } }))
  })

  it("propagates a durable-ledger crash without retrying the mutation", async () => {
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } })
    const transitionRoutineAction = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw new Error("disk full after effect") })
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn().mockResolvedValue(running()), loadWriteApiKey: async () => "key", createClient: () => ({ mutate }), reserveRoutineAction: vi.fn().mockReturnValue({ id: "receipt-1" }), transitionRoutineAction })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 1) })).rejects.toThrow("receipt persistence failed")
    expect(mutate).toHaveBeenCalledOnce()
  })

  it("records an observed restarting transition as the external receipt", async () => {
    const transitionRoutineAction = vi.fn()
    const listings = [running(), running(), { ...running(), data: { ...running().data, containers: [{ ...running().data.containers[0], state: "restarting" as const }] } }, running()]
    const restart = createApprovedUnraidRestartExecutor({ endpoint: "https://host/graphql", listContainers: vi.fn(async () => listings.shift()!), loadWriteApiKey: async () => "key", createClient: () => ({ mutate: vi.fn().mockResolvedValue({}) }), reserveRoutineAction: vi.fn().mockReturnValue({ id: "receipt-1" }), transitionRoutineAction, sleep: async () => undefined })
    await expect(restart({ container: "calibre-web" }, { routine: routineAuthority("restart", 1) })).resolves.toMatchObject({ ok: true })
    expect(transitionRoutineAction).toHaveBeenNthCalledWith(2, expect.objectContaining({ state: "effect_acknowledged", effectReceipt: expect.stringMatching(/^[0-9a-f]{64}$/u) }))
  })
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

  it("terminalizes an attempted mutation when post-mutation observation throws", async () => {
    const persistAttempt = vi.fn()
    const listContainers = vi.fn()
      .mockResolvedValueOnce(running())
      .mockResolvedValueOnce(running())
      .mockRejectedValueOnce(new Error("observation transport failed"))
    const mutate = vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } })
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers,
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate }),
      persistAttempt,
    })

    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("not retried") } })
    expect(mutate).toHaveBeenCalledOnce()
    expect(persistAttempt.mock.calls.map(([attempt]) => attempt.state)).toEqual(["attempt_not_started", "attempting", "attempted_or_indeterminate"])
  })

  it("does not retry or mask ambiguity when terminal receipt persistence fails", async () => {
    const persistAttempt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("disk full")
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValueOnce(running()).mockResolvedValueOnce(running()).mockRejectedValueOnce(new Error("offline")),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
      persistAttempt,
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous", message: expect.stringContaining("not retried") } })
    expect(persistAttempt).toHaveBeenCalledTimes(3)
  })

  it("fails closed when a proven restart terminal receipt cannot be persisted", async () => {
    const persistAttempt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"))
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
      persistAttempt,
    })

    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({
      ok: false,
      error: { code: "ambiguous", message: expect.stringContaining("terminal receipt") },
    })
    expect(persistAttempt).toHaveBeenCalledTimes(3)
  })

  it("binds optional acceptance coordinates and rejects changed approved arguments", async () => {
    const argumentDigest = createHash("sha256").update(JSON.stringify({ container: "calibre-web" })).digest("hex")
    const persistAttempt = vi.fn()
    const restart = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: async () => "key",
      acceptanceScenarioHandleDigest: () => "a".repeat(64),
      acceptanceApproval: () => ({ approvalId: "approval-1", argumentDigest }),
      persistAttempt,
      createClient: () => ({ mutate: vi.fn().mockResolvedValue({ docker: { restart: { id: "Docker:abc", names: ["/calibre-web"] } } }) }),
    })
    await expect(restart({ container: "calibre-web" })).resolves.toMatchObject({ ok: true })
    expect(persistAttempt).toHaveBeenCalledWith(expect.objectContaining({ scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1" }))

    const rejected = createApprovedUnraidRestartExecutor({
      endpoint: "https://host/graphql",
      listContainers: vi.fn().mockResolvedValue(running()),
      loadWriteApiKey: vi.fn(),
      acceptanceApproval: () => ({ approvalId: "approval-2", argumentDigest: "b".repeat(64) }),
    })
    await expect(rejected({ container: "calibre-web" })).resolves.toMatchObject({ ok: false, error: { code: "stale_target" } })
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
