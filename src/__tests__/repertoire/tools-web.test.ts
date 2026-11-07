import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const lookupMock = vi.hoisted(() => vi.fn())
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }))

import { baseToolDefinitions, type ToolContext } from "../../repertoire/tools-base"
import { htmlToText, isPrivateAddress } from "../../repertoire/tools-web"

const def = baseToolDefinitions.find((d) => d.tool.function.name === "fetch_url")!
const run = (args: Record<string, unknown>, ctx?: ToolContext) => Promise.resolve(def.handler(args as any, ctx)) as Promise<string>

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } })
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } })

describe("fetch_url", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    lookupMock.mockReset()
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }])
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("is a base tool with a short description", () => {
    expect(def.tool.function.description!.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
  })

  it("turns HTML into readable text", async () => {
    fetchMock.mockResolvedValue(html(`<html><head><title>My &amp; Page</title><style>p{}</style></head><body><nav>menu</nav><script>evil()</script><h1>Hello</h1><p>One &lt;two&gt; &#65; &#x42; &bogus; &#99999999;</p><div>three<br>four</div><!-- c --></body></html>`))
    const out = await run({ url: "https://example.com/" })
    expect(out).toBe("My & Page\n\nHello\n\nOne <two> A B &bogus; &#99999999;\n\nthree\nfour")
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" })
  })

  it("htmlToText copes with a page with no title", () => {
    expect(htmlToText("<p>just text</p>")).toBe("just text")
    expect(htmlToText("<title>T</title><p>body</p>")).toBe("T\n\nbody")
  })

  it("returns JSON and plain text as they are, and an unknown content type as text/plain", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{\"a\": 1}", { headers: { "content-type": "application/json" } }))
    expect(await run({ url: "https://example.com/x.json" })).toBe("{\"a\": 1}")
    fetchMock.mockResolvedValueOnce(new Response("plain", { headers: { "content-type": "text/plain" } }))
    expect(await run({ url: "https://example.com/x.txt" })).toBe("plain")
    fetchMock.mockResolvedValueOnce(new Response(new TextEncoder().encode("no header")))
    expect(await run({ url: "https://example.com/y" })).toBe("no header")
  })

  it("does not show binary content types", async () => {
    fetchMock.mockResolvedValue(new Response("x", { headers: { "content-type": "image/png" } }))
    expect(await run({ url: "https://example.com/a.png" })).toBe("[content type image/png; not shown]")
  })

  it("caps output at 30,000 characters and reads on with offset", async () => {
    fetchMock.mockImplementation(async () => new Response("a".repeat(30_000) + "b".repeat(5_000), { headers: { "content-type": "text/plain" } }))
    const first = await run({ url: "https://example.com/big" })
    expect(first).toBe("a".repeat(30_000) + "\n[characters 0-30000 of 35000; read on with offset=30000]")
    expect(await run({ url: "https://example.com/big", offset: 30_000 })).toBe("b".repeat(5_000))
    expect(await run({ url: "https://example.com/big", offset: "junk" })).toContain("[characters 0-30000")
  })

  it("stops downloading at 2 MB and says so", async () => {
    fetchMock.mockImplementation(async () => new Response("c".repeat(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } }))
    const out = await run({ url: "https://example.com/huge" })
    expect(out).toContain("[characters 0-30000 of 2097152; read on with offset=30000]")
    expect(out.endsWith("[download cut at 2 MB]")).toBe(true)
  })

  it("follows redirects, resolving relative locations", async () => {
    fetchMock.mockResolvedValueOnce(redirect("/next")).mockResolvedValueOnce(html("<p>landed</p>"))
    expect(await run({ url: "https://example.com/start" })).toBe("landed")
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://example.com/next")
  })

  it("gives up after 5 redirects", async () => {
    fetchMock.mockImplementation(async () => redirect("/again"))
    expect(await run({ url: "https://example.com/loop" })).toContain("more than 5 redirects")
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it("reports HTTP errors and a redirect with no location", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 404 }))
    expect(await run({ url: "https://example.com/missing" })).toBe("error: HTTP 404 fetching https://example.com/missing")
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }))
    expect(await run({ url: "https://example.com/m2" })).toContain("HTTP 302")
  })

  it("refuses non-http schemes and bad URLs", async () => {
    expect(await run({ url: "file:///etc/passwd" })).toContain("only http and https")
    expect(await run({ url: "ftp://example.com/x" })).toContain("only http and https")
    expect(await run({ url: "not a url" })).toContain("not a valid URL")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe("private addresses", () => {
    it.each(["http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://169.254.169.254/", "http://100.64.0.1/", "http://[::1]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/"])("refuses %s", async (url) => {
      const out = await run({ url })
      expect(out).toContain("error: refused")
      expect(out).toContain("private or local address")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("refuses a name that resolves to a private address (any of several)", async () => {
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.1.2.3", family: 4 }])
      expect(await run({ url: "http://sneaky.example.com/" })).toContain("(10.1.2.3)")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("refuses a redirect that lands on a private address, naming the hop", async () => {
      fetchMock.mockResolvedValueOnce(redirect("http://192.168.0.10/admin"))
      const out = await run({ url: "https://example.com/go" })
      expect(out).toContain("error: refused: 192.168.0.10")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("refuses a redirect to a name that resolves privately", async () => {
      lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      fetchMock.mockResolvedValueOnce(redirect("http://internal.example.com/"))
      expect(await run({ url: "https://example.com/go" })).toContain("(127.0.0.1)")
    })

    it("allows a family human to fetch inside the house, but not an agent peer", async () => {
      fetchMock.mockImplementation(async () => html("<p>admin</p>"))
      const friend = (extra: object) => ({ signin: async () => undefined, context: { friend: { id: "f", name: "F", trustLevel: "family", ...extra } } }) as unknown as ToolContext
      expect(await run({ url: "http://192.168.1.1/" }, friend({}))).toBe("admin")
      expect(await run({ url: "http://192.168.1.1/" }, friend({ agentMeta: { a2a: {} } }))).toContain("error: refused")
      expect(await run({ url: "http://192.168.1.1/" }, friend({ trustLevel: "friend" }))).toContain("error: refused")
    })

    it("classifies addresses", () => {
      for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "2001:db8:1:2:3:4:5:6", "::ffff:808:808", "64:ff9b::808:808"]) expect(isPrivateAddress(ip), ip).toBe(false)
      for (const ip of ["0.1.2.3", "224.0.0.1", "172.31.255.255", "::", "::1", "ff02::1", "64:ff9b::7f00:1", "fe80::1%eth0", "::ffff:a00:1"]) expect(isPrivateAddress(ip), ip).toBe(true)
    })
  })

  it("times out", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }))
    expect(await run({ url: "https://slow.example.com/" })).toBe("error: timed out after 20 seconds fetching https://slow.example.com/")
  })

  it("passes a 20 second timeout signal to fetch", async () => {
    fetchMock.mockResolvedValue(html("ok"))
    const spy = vi.spyOn(AbortSignal, "timeout")
    await run({ url: "https://example.com/" })
    expect(spy).toHaveBeenCalledWith(20_000)
    spy.mockRestore()
  })

  it("reports other failures, including non-Error throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))
    expect(await run({ url: "https://example.com/" })).toBe("error: could not fetch https://example.com/: ECONNRESET")
    fetchMock.mockRejectedValueOnce("weird")
    expect(await run({ url: "https://example.com/" })).toBe("error: could not fetch https://example.com/: weird")
  })
})
