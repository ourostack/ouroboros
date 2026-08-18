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
})
