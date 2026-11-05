import { afterEach, describe, expect, it, vi } from "vitest"
import { checkShepherdConnectivity } from "../../../senses/shepherd/sense"

afterEach(() => vi.unstubAllGlobals())

describe("Shepherd connectivity evidence", () => {
  it("confirms online only when both independent HTTPS endpoints succeed without redirects or credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(null, { status: 204 })
    })
    expect(await checkShepherdConnectivity()).toBe("online")
    expect(requests.map(request => request.url)).toEqual(["https://api.github.com/", "https://registry.npmjs.org/"])
    for (const request of requests) {
      expect(request.init).toMatchObject({ method: "HEAD", redirect: "error", credentials: "omit" })
      expect(request.init!.signal).toBeInstanceOf(AbortSignal)
      expect(request.init).not.toHaveProperty("headers")
    }
  })

  it("confirms offline only when both independent probes fail on the network", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("fetch failed") })
    expect(await checkShepherdConnectivity()).toBe("offline")
  })

  it.each(["partial", "http", "unexpected"])("keeps %s evidence unknown rather than claiming a transition", async failure => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (failure === "http") return new Response(null, { status: 503 })
      if (failure === "unexpected") throw new Error("Unexpected local configuration error")
      if (url.includes("github")) throw new Error("fetch failed")
      return new Response(null, { status: 200 })
    })
    expect(await checkShepherdConnectivity()).toBe("unknown")
  })
})
