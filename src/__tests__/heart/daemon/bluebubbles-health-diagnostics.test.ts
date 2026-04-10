import { describe, expect, it, vi } from "vitest"
import {
  formatBlueBubblesHealthcheckFailure,
  probeBlueBubblesHealth,
  redactBlueBubblesHealthDetailForNerves,
  stringifyBlueBubblesHealthError,
} from "../../../heart/daemon/bluebubbles-health-diagnostics"

describe("bluebubbles health diagnostics", () => {
  it("probes the message count endpoint and returns a reachable result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))

    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local/",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://bluebubbles.local/api/v1/message/count?password=pw",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    )
    expect(result).toEqual({
      ok: true,
      detail: "upstream reachable",
      reason: null,
      status: 200,
      classification: null,
    })
  })

  it("classifies fetch rejections as network failures with serverUrl guidance", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"))

    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.classification).toBe("network-error")
    expect(result.status).toBeNull()
    expect(result.reason).toBe("fetch failed")
    expect(result.detail).toContain("Cannot reach BlueBubbles at http://bluebubbles.local")
    expect(result.detail).toContain("Check `bluebubbles.serverUrl`")
  })

  it("classifies unauthorized HTTP responses as password failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }))

    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local",
      password: "bad",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.classification).toBe("auth-failure")
    expect(result.status).toBe(401)
    expect(result.reason).toBe("unauthorized")
    expect(result.detail).toContain("BlueBubbles auth failed at http://bluebubbles.local (HTTP 401)")
    expect(result.detail).toContain("Check `bluebubbles.password`")
  })

  it("classifies upstream 5xx responses as server failures even when the body cannot be read", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: vi.fn().mockRejectedValue(new Error("body closed")),
    } as unknown as Response)

    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.classification).toBe("server-error")
    expect(result.status).toBe(502)
    expect(result.reason).toBe("unknown")
    expect(result.detail).toContain("BlueBubbles upstream returned HTTP 502")
    expect(result.detail).toContain("Check the BlueBubbles app/server logs")
  })

  it("classifies non-Error fetch rejections without losing the raw reason", async () => {
    const fetchImpl = vi.fn().mockRejectedValue("bare upstream failure")

    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.classification).toBe("unknown")
    expect(result.reason).toBe("bare upstream failure")
    expect(result.detail).toContain("http://bluebubbles.local")
    expect(result.detail).toContain("Raw error: bare upstream failure")
  })

  it("turns malformed server URLs into actionable probe failures instead of throwing", async () => {
    const fetchImpl = vi.fn()

    const result = await probeBlueBubblesHealth({
      serverUrl: " ",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.classification).toBe("unknown")
    expect(result.status).toBeNull()
    expect(result.detail).toContain("configured BlueBubbles server")
    expect(result.detail).toContain("Check `bluebubbles.serverUrl`")
  })

  it("keeps generic HTTP failures actionable without pretending they are auth or server errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("too many", { status: 418 }))

    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(result.ok).toBe(false)
    expect(result.classification).toBe("unknown")
    expect(result.status).toBe(418)
    expect(result.detail).toContain("BlueBubbles health check failed at http://bluebubbles.local (HTTP 418)")
    expect(result.detail).toContain("Check `bluebubbles.serverUrl`")
  })

  it("stringifies empty Error messages and empty primitive reasons safely", async () => {
    const namelessError = new Error("")
    namelessError.name = ""

    expect(stringifyBlueBubblesHealthError(new Error(""))).toBe("Error")
    expect(stringifyBlueBubblesHealthError(namelessError)).toBe("unknown")
    expect(formatBlueBubblesHealthcheckFailure(" ", "")).toContain("Raw error: unknown")
    expect(redactBlueBubblesHealthDetailForNerves("Check `bluebubbles.password` in secrets.json")).toContain(
      "bluebubbles credential",
    )

    const fetchImpl = vi.fn().mockRejectedValue(new Error(""))
    const result = await probeBlueBubblesHealth({
      serverUrl: "http://bluebubbles.local",
      password: "pw",
      requestTimeoutMs: 1234,
      fetchImpl,
    })

    expect(result.reason).toBe("Error")
    expect(result.detail).toContain("Raw error: Error")
  })
})
