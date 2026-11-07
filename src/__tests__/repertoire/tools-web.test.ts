import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"

const lookupMock = vi.hoisted(() => vi.fn())
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }))

// A scripted stand-in for node:http. With no script set, the real module runs.
const fake = vi.hoisted(() => ({ current: undefined as undefined | ((url: URL, options: any) => any) }))
const wrapRequest = vi.hoisted(() => (actual: any) => ({ ...actual, default: actual, request: (url: URL, options: any, cb: any) => fake.current ? fake.current(url, options, cb) : actual.request(url, options, cb) }))
vi.mock("node:http", async (importOriginal) => wrapRequest(await importOriginal()))
vi.mock("node:https", async (importOriginal) => wrapRequest(await importOriginal()))

import { baseToolDefinitions, type ToolContext } from "../../repertoire/tools-base"
import { htmlToText, isPrivateAddress, webTestHooks } from "../../repertoire/tools-web"

const def = baseToolDefinitions.find((d) => d.tool.function.name === "fetch_url")!
const run = (args: Record<string, unknown>, ctx?: ToolContext) => Promise.resolve(def.handler(args as any, ctx)) as Promise<string>

type Reply = { status?: number; headers?: Record<string, string>; body?: string | Buffer | (() => Readable) }
const html = (body: string): Reply => ({ headers: { "content-type": "text/html; charset=utf-8" }, body })
const redirect = (to: string, status = 302): Reply => ({ status, headers: { location: to } })

describe("fetch_url", () => {
  const seen: Array<{ url: string; connectedTo?: string; destroyed?: boolean }> = []
  let replies: Array<Reply | Error | "hang">
  let responses: Readable[]

  // Behaves like Node: IP literals skip lookup; names go through options.lookup, whose answer is the socket address.
  function install() {
    fake.current = (url: URL, options: any, cb: any) => {
      const req: any = new EventEmitter()
      const entry: (typeof seen)[number] = { url: url.href }
      seen.push(entry)
      options.signal.addEventListener("abort", () => req.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" })))
      req.end = () => {
        const respond = () => {
          const reply = replies.shift() ?? { body: "" }
          if (reply === "hang") return
          if (reply instanceof Error) return req.emit("error", reply)
          const body = typeof reply.body === "function" ? reply.body() : Readable.from(reply.body === undefined ? [] : [Buffer.from(reply.body)])
          const res: any = Object.assign(body, { statusCode: reply.status ?? 200, headers: { "content-type": "text/plain", ...(reply.headers ?? {}) } })
          const destroy = res.destroy.bind(res)
          res.destroy = (...a: any[]) => { entry.destroyed = true; return destroy(...a) }
          responses.push(res)
          cb(res)
        }
        if (/^[\d.]+$|^\[/.test(url.hostname)) return respond()
        options.lookup(url.hostname, {}, (err: Error | null, address: string) => {
          if (err) return req.emit("error", err)
          entry.connectedTo = address
          respond()
        })
      }
      return req
    }
  }

  beforeEach(() => {
    seen.length = 0
    responses = []
    replies = []
    lookupMock.mockReset()
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }])
    webTestHooks.timeoutMs = 20_000
    install()
  })
  afterEach(() => { fake.current = undefined })

  it("is a base tool with a short description", () => {
    expect(def.tool.function.description!.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
  })

  it("turns HTML into readable text", async () => {
    replies.push(html(`<html><head><title>My &amp; Page</title><style>p{}</style></head><body><nav>menu</nav><script>evil()</script><h1>Hello</h1><p>One &lt;two&gt; &#65; &#x42; &bogus; &#99999999;</p><div>three<br>four</div><!-- c --></body></html>`))
    expect(await run({ url: "https://example.com/" })).toBe("My & Page\n\nHello\n\nOne <two> A B &bogus; &#99999999;\n\nthree\nfour")
  })

  it("htmlToText copes with a page with no title, and a title outside head", () => {
    expect(htmlToText("<p>just text</p>")).toBe("just text")
    expect(htmlToText("<title>T</title><p>body</p>")).toBe("T\n\nbody")
  })

  it("returns JSON and plain text as they are, and an unknown content type as text/plain", async () => {
    replies.push({ headers: { "content-type": "application/json" }, body: "{\"a\": 1}" })
    expect(await run({ url: "https://example.com/x.json" })).toBe("{\"a\": 1}")
    replies.push({ body: "plain" })
    expect(await run({ url: "https://example.com/x.txt" })).toBe("plain")
  })

  it("assumes text/plain when the server names no content type", async () => {
    replies.push({ body: "no header" })
    fake.current = ((inner) => (u: URL, o: any, cb: any) => inner(u, o, (res: any) => { delete res.headers["content-type"]; cb(res) }))(fake.current!)
    expect(await run({ url: "https://example.com/y" })).toBe("no header")
  })

  it("does not show binary content types, and releases the connection", async () => {
    replies.push({ headers: { "content-type": "image/png" }, body: "x" })
    expect(await run({ url: "https://example.com/a.png" })).toBe("[content type image/png; not shown]")
    expect(seen[0].destroyed).toBe(true)
  })

  it("says plainly when a server returns 204", async () => {
    replies.push({ status: 204 })
    expect(await run({ url: "https://example.com/empty" })).toBe("(no content: HTTP 204)")
    expect(seen[0].destroyed).toBe(true)
  })

  it("caps output at 30,000 characters and reads on with offset", async () => {
    const big = "a".repeat(30_000) + "b".repeat(5_000)
    replies.push({ body: big }, { body: big }, { body: big })
    expect(await run({ url: "https://example.com/big" })).toBe("a".repeat(30_000) + "\n[characters 0-30000 of 35000; read on with offset=30000]")
    expect(await run({ url: "https://example.com/big", offset: 30_000 })).toBe("b".repeat(5_000))
    expect(await run({ url: "https://example.com/big", offset: "junk" })).toContain("[characters 0-30000")
  })

  it("stops downloading at 2 MB and says so", async () => {
    replies.push({ body: Buffer.alloc(3 * 1024 * 1024, "c") })
    const out = await run({ url: "https://example.com/huge" })
    expect(out).toContain("[characters 0-30000 of 2097152; read on with offset=30000]")
    expect(out.endsWith("[download cut at 2 MB]")).toBe(true)
  })

  it("follows redirects, resolving relative locations, and releases each redirect response", async () => {
    replies.push(redirect("/next"), html("<p>landed</p>"))
    expect(await run({ url: "https://example.com/start" })).toBe("landed")
    expect(seen.map((s) => s.url)).toEqual(["https://example.com/start", "https://example.com/next"])
    expect(seen[0].destroyed).toBe(true)
  })

  it("gives up after 5 redirects", async () => {
    for (let i = 0; i < 7; i++) replies.push(redirect("/again"))
    expect(await run({ url: "https://example.com/loop" })).toContain("more than 5 redirects")
    expect(seen).toHaveLength(6)
  })

  it("reports HTTP errors and a redirect with no location, releasing the response", async () => {
    replies.push({ status: 404, body: "no" }, { status: 302 })
    expect(await run({ url: "https://example.com/missing" })).toBe("error: HTTP 404 fetching https://example.com/missing")
    expect(seen[0].destroyed).toBe(true)
    expect(await run({ url: "https://example.com/m2" })).toContain("HTTP 302")
  })

  it("refuses non-http schemes and bad URLs", async () => {
    expect(await run({ url: "file:///etc/passwd" })).toContain("only http and https")
    expect(await run({ url: "ftp://example.com/x" })).toContain("only http and https")
    expect(await run({ url: "not a url" })).toContain("not a valid URL")
    expect(seen).toHaveLength(0)
  })

  describe("private addresses", () => {
    it.each(["http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://169.254.169.254/", "http://100.64.0.1/", "http://198.18.0.1/", "http://192.0.0.8/", "http://[::1]/", "http://[fe80::1]/", "http://[fec0::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/"])("refuses %s", async (url) => {
      const out = await run({ url })
      expect(out).toContain("error: refused")
      expect(out).toContain("private or local address")
      expect(seen).toHaveLength(0)
    })

    it("hands the socket the address that was checked, not a second lookup", async () => {
      lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValue([{ address: "10.0.0.9", family: 4 }])
      replies.push(html("ok"))
      expect(await run({ url: "http://rebind.example.com/" })).toBe("ok")
      expect(seen[0].connectedTo).toBe("93.184.216.34")
      expect(lookupMock).toHaveBeenCalledTimes(1)
    })

    it("answers options.all lookups with every checked record", async () => {
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }])
      const options: any = (await captureLookup())
      const answer = await new Promise((resolve) => options("x.example.com", { all: true }, (_e: unknown, a: unknown) => resolve(a)))
      expect(answer).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }])
    })

    // The real node:http runs here: the refusal comes from the lookup the socket uses, at connect time.
    it("refuses, at connect time, a name whose lookup returns a private address", async () => {
      fake.current = undefined
      lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.1.2.3", family: 4 }])
      expect(await run({ url: "http://sneaky.example.com/" })).toBe("error: refused: sneaky.example.com resolves to a private or local address (10.1.2.3)")
    })

    it("refuses a private answer even when the first lookup was fine and a redirect names a new host", async () => {
      lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      replies.push(redirect("http://internal.example.com/"))
      expect(await run({ url: "https://example.com/go" })).toContain("(127.0.0.1)")
    })

    it("refuses a redirect that lands on a private literal, naming the hop, and releases the response", async () => {
      replies.push(redirect("http://192.168.0.10/admin"))
      const out = await run({ url: "https://example.com/go" })
      expect(out).toContain("error: refused: 192.168.0.10")
      expect(seen).toHaveLength(1)
      expect(seen[0].destroyed).toBe(true)
    })

    it("reports a failed lookup", async () => {
      lookupMock.mockRejectedValue(new Error("ENOTFOUND nope.example.com"))
      expect(await run({ url: "http://nope.example.com/" })).toContain("ENOTFOUND")
    })

    it("allows only a human family friend to fetch inside the house", async () => {
      const friend = (extra: object) => ({ signin: async () => undefined, context: { friend: { id: "f", name: "F", trustLevel: "family", kind: "human", ...extra } } }) as unknown as ToolContext
      replies.push(html("admin"), html("admin"))
      expect(await run({ url: "http://192.168.1.1/" }, friend({}))).toBe("admin")
      lookupMock.mockResolvedValue([{ address: "10.0.0.7", family: 4 }])
      expect(await run({ url: "http://nas.example.com/" }, friend({}))).toBe("admin")
      for (const extra of [{ kind: "agent" }, { kind: undefined }, { trustLevel: "friend" }]) {
        expect(await run({ url: "http://192.168.1.1/" }, friend(extra))).toContain("error: refused")
      }
    })

    it("classifies addresses", () => {
      for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "198.20.0.1", "192.0.2.1", "2606:4700::1111", "2001:db8:1:2:3:4:5:6", "::ffff:808:808", "64:ff9b::808:808"]) expect(isPrivateAddress(ip), ip).toBe(false)
      for (const ip of ["0.1.2.3", "224.0.0.1", "172.31.255.255", "198.19.255.255", "192.0.0.1", "::", "::1", "ff02::1", "fec0::1", "64:ff9b::7f00:1", "fe80::1%eth0", "::ffff:a00:1"]) expect(isPrivateAddress(ip), ip).toBe(true)
    })
  })

  it("times out a request that never answers, using the real abort path", async () => {
    webTestHooks.timeoutMs = 30
    replies.push("hang")
    const started = Date.now()
    expect(await run({ url: "https://slow.example.com/" })).toBe("error: timed out after 0.03 seconds fetching https://slow.example.com/")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("times out while reading a body that stalls", async () => {
    webTestHooks.timeoutMs = 30
    replies.push({ body: () => new Readable({ read() { /* never ends */ } }) })
    fake.current = ((inner) => (u: URL, o: any, cb: any) => inner(u, o, (res: any) => { o.signal.addEventListener("abort", () => res.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }))); cb(res) }))(fake.current!)
    expect(await run({ url: "https://slow.example.com/body" })).toContain("timed out")
  })

  it("uses a 20 second deadline by default", () => {
    expect(webTestHooks.timeoutMs).toBe(20_000)
  })

  it("reports other failures, including non-Error throws", async () => {
    replies.push(new Error("ECONNRESET"), "boom" as never)
    expect(await run({ url: "https://example.com/" })).toBe("error: could not fetch https://example.com/: ECONNRESET")
    fake.current = () => { throw "weird" }
    expect(await run({ url: "https://example.com/" })).toBe("error: could not fetch https://example.com/: weird")
  })

  async function captureLookup() {
    let captured: any
    fake.current = (_u: URL, options: any) => { captured = options.lookup; const req: any = new EventEmitter(); req.end = () => {}; return req }
    webTestHooks.timeoutMs = 50 // the request is never answered; let the call settle
    void run({ url: "http://capture.example.com/" })
    await vi.waitFor(() => expect(captured).toBeDefined())
    return captured
  }
})
