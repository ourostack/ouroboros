import { afterEach, describe, expect, it, vi } from "vitest"
import { request as httpRequest } from "node:http"
import * as http from "node:http"
import type { FrontendProtocolClient } from "../../../heart/frontend-socket-client"
import { startShepherdAttention } from "../../../senses/shepherd/attention"

const first = { id: "11111111-1111-4111-8111-111111111111", host: "cmux", label: "/private/repo [UUID]", displayLabel: "Ship attention", selected: true }
const second = { ...first, id: "22222222-2222-4222-8222-222222222222", displayLabel: "Fix tests", selected: false }
const cleanups: Array<() => Promise<void>> = []
vi.mock("node:http", async original => {
  const actual = await original<typeof import("node:http")>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks() })

async function start(displayName = "Ouro") {
  const events = new Set<(frame: Record<string, unknown>) => void>()
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "shepherd.targets") return { targets: [first, second] }
    if (method === "turn.cancel") return { cancelled: true }
    return {}
  })
  const client = (): FrontendProtocolClient => ({
    request, onEvent: listener => { events.add(listener); return () => { events.delete(listener) } },
    onClose: () => () => {}, close: () => {},
  })
  const app = await startShepherdAttention({ agent: "ouro", displayName, socketPath: "/unused", resolveOwner: async () => "owner", client })
  cleanups.push(app.close)
  const url = new URL(app.url)
  const origin = url.origin
  const token = url.hash.slice(1)
  const api = (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${route}`, {
    method: body ? "POST" : "GET", headers: { "X-Ouro-Attention": token, ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { app, api, request, origin, event: (frame: Record<string, unknown>) => { for (const event of events) event(frame) } }
}

describe("compact independent attention entry", () => {
  it("serves the explicit agent identity through the real HTTP entry and configured address route", async () => {
    const { origin, api, request } = await start("Orchid One")
    const html = await (await fetch(origin)).text()
    expect(html).toContain("<h1>Orchid One</h1>")
    const id = crypto.randomUUID()
    expect((await api("/send", { id, message: "@Orchid One inspect this session" })).status).toBe(202)
    await vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === "turn.start")).toBe(true))
    expect(request.mock.calls.find(([method]) => method === "turn.start")?.[1]).toMatchObject({
      agent: "ouro", message: "inspect this session",
    })
  })

  it("serves a graphical composer and publishes short labels, not diagnostic paths", async () => {
    const { origin, api } = await start()
    const page = await fetch(origin)
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
    const html = await page.text()
    expect(html).toContain("<textarea")
    expect(html).toContain("About")
    expect(html).not.toContain(first.label)
    const state = await (await api("/state")).json()
    expect(state.targets).toEqual([{ id: first.id, label: "Ship attention" }, { id: second.id, label: "Fix tests" }])
    expect(state.target).toBe(first.id)
    expect(JSON.stringify(state)).not.toContain("/private")
  })

  it("rejects unauthenticated reads, cross-origin posts and DNS-rebinding hosts", async () => {
    const { origin, api, request } = await start()
    expect((await fetch(`${origin}/state`)).status).toBe(403)
    expect((await api("/send", { id: crypto.randomUUID(), message: "hello" }, { Origin: "https://attacker.example" })).status).toBe(403)
    const rebinding = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${origin}/state`, { headers: { Host: "attacker.example" } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on("error", reject)
      request.end()
    })
    expect(rebinding).toBe(403)
    expect(request.mock.calls.filter(([method]) => method === "turn.start")).toHaveLength(0)
  })

  it("requires an explicit choice when the key window has no coding session", async () => {
    const request = vi.fn(async () => ({ targets: [{ ...first, selected: false }, second] }))
    const app = await startShepherdAttention({ agent: "ouro", socketPath: "/unused", resolveOwner: async () => "owner",
      client: () => ({ request, onEvent: () => () => {}, onClose: () => () => {}, close: () => {} }) })
    cleanups.push(app.close)
    const url = new URL(app.url)
    const headers = { "X-Ouro-Attention": url.hash.slice(1) }
    expect((await (await fetch(`${url.origin}/state`, { headers })).json()).target).toBeNull()
    expect((await fetch(`${url.origin}/send`, { method: "POST", headers: { ...headers, Origin: url.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), message: "continue" }) })).status).toBe(409)
    expect(request.mock.calls).toHaveLength(1)
  })

  it("pins each turn, rejects retargeting while active, and never repeats a browser request", async () => {
    const { api, request, event } = await start()
    const id = crypto.randomUUID()
    const message = { id, message: "@ouro continue this session" }
    expect((await api("/send", message)).status).toBe(202)
    expect((await api("/send", { id: crypto.randomUUID(), message: "another message" })).status).toBe(409)
    await vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === "turn.start")).toBe(true))
    expect((await api("/select", { target: second.id })).status).toBe(409)
    expect((await api("/send", message)).status).toBe(202)
    expect((await api("/send", { ...message, message: "different" })).status).toBe(409)
    expect(request.mock.calls.filter(([method]) => method === "turn.start")).toHaveLength(1)
    const turn = request.mock.calls.find(([method]) => method === "turn.start")![1]
    expect(turn.shepherdSession).toEqual(first)
    expect(turn.message).toBe("continue this session")
    event({ event: "assistant.delivery", turnId: turn.turnId, sessionKey: `shepherd:${first.id}`, text: "I am continuing.", journalSequence: 1 })
    event({ event: "turn.completed", turnId: turn.turnId, sessionKey: `shepherd:${first.id}`, result: {}, journalSequence: 2 })
    await vi.waitFor(async () => {
      const state = await (await api("/state")).json()
      expect(state.active).toBe(false)
      expect(state.messages.at(-1)).toEqual({ role: "ouro", text: "I am continuing." })
    })
    expect((await api("/select", { target: second.id })).status).toBe(200)
    expect(request.mock.calls.some(([method]) => method === "chat.connect")).toBe(false)
  })

  it("keeps separately opened browser conversations and replies isolated", async () => {
    const { api, request, event } = await start()
    const a = { "X-Ouro-View": crypto.randomUUID() }
    const b = { "X-Ouro-View": crypto.randomUUID() }
    expect((await api("/select", { target: second.id }, b)).status).toBe(200)
    await api("/send", { id: crypto.randomUUID(), message: "first session" }, a)
    await api("/send", { id: crypto.randomUUID(), message: "second session" }, b)
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === "turn.start")).toHaveLength(2))
    const turns = request.mock.calls.filter(([method]) => method === "turn.start")
    const firstTurn = turns.find(([, params]) => params.sessionKey === `shepherd:${first.id}`)![1]
    event({ event: "turn.completed", turnId: firstTurn.turnId, sessionKey: firstTurn.sessionKey, result: { response: "reply only to first" } })
    const firstView = await (await api("/state", undefined, a)).json()
    const secondView = await (await api("/state", undefined, b)).json()
    expect(firstView.target).toBe(first.id)
    expect(firstView.messages.at(-1).text).toBe("reply only to first")
    expect(secondView.target).toBe(second.id)
    expect(secondView.active).toBe(true)
    expect(JSON.stringify(secondView)).not.toContain("reply only to first")
  })

  it("captures a fresh advisory current session once and does not follow later focus changes", async () => {
    const { api, request } = await start()
    request.mockResolvedValue({ targets: [{ ...first, selected: false }, { ...second, selected: true }] })
    const selected = await (await api("/select", { target: "current" })).json()
    expect(selected.target).toBe(second.id)
    request.mockResolvedValue({ targets: [first, second] })
    expect((await (await api("/state")).json()).target).toBe(second.id)
  })

  it("refreshes target availability without changing the bound UUID or conversation", async () => {
    const { api, request } = await start()
    request.mockResolvedValue({ targets: [second] })
    const refreshed = await api("/targets", {})
    expect(refreshed.status).toBe(200)
    const state = await refreshed.json()
    expect(state.targets).toEqual([{ id: second.id, label: "Fix tests" }])
    expect(state.target).toBe(first.id)
  })

  it("acknowledges only the original view and target, and refuses a pending target mismatch", async () => {
    const { api } = await start()
    const id = crypto.randomUUID()
    const message = { id, target: first.id, message: "receipt bound here" }
    expect((await api("/send", message)).status).toBe(202)
    const receipt = await (await api("/state", undefined, { "X-Ouro-Pending": id })).json()
    expect(receipt.acknowledged).toEqual({ id, target: first.id })
    const other = await (await api("/state", undefined, { "X-Ouro-Pending": id, "X-Ouro-View": crypto.randomUUID() })).json()
    expect(other.acknowledged).toBeNull()
    expect((await api("/send", { ...message, target: second.id })).status).toBe(409)
  })

  it("preserves a UTF-8 message split across HTTP chunks while enforcing the raw byte limit", async () => {
    const { origin, app, request } = await start()
    const url = new URL(app.url)
    const message = "Keep 界 readable."
    const body = Buffer.from(JSON.stringify({ id: crypto.randomUUID(), message }))
    const split = body.indexOf(Buffer.from("界")) + 1
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const sending = httpRequest(`${origin}/send`, { method: "POST", headers: {
        "X-Ouro-Attention": url.hash.slice(1), Origin: origin, "Content-Type": "application/json",
      } }, response => { response.resume(); resolve(response.statusCode) })
      sending.on("error", reject)
      sending.write(body.subarray(0, split))
      setTimeout(() => sending.end(body.subarray(split)), 10)
    })
    expect(status).toBe(202)
    await vi.waitFor(() => expect(request.mock.calls.find(([method]) => method === "turn.start")![1].message).toBe(message))
  })

  it("does not retarget if a send begins during the asynchronous target refresh", async () => {
    const { api, request } = await start()
    const refresh = Promise.withResolvers<{ targets: typeof first[] }>()
    request.mockImplementation(async method => method === "shepherd.targets" ? refresh.promise : { cancelled: true })
    const selecting = api("/select", { target: second.id })
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === "shepherd.targets")).toHaveLength(2))
    await api("/send", { id: crypto.randomUUID(), message: "stay here" })
    refresh.resolve({ targets: [first, second] })
    expect((await selecting).status).toBe(409)
    expect((await (await api("/state")).json()).target).toBe(first.id)
    expect(request.mock.calls.find(([method]) => method === "turn.start")![1].shepherdSession).toEqual(first)
  })

  it("cancels only the current Ouro turn and reconciles errors without making another start", async () => {
    const { api, request, event } = await start()
    expect((await (await api("/cancel", {})).json()).cancelled).toBe(false)
    expect((await api("/recover", {})).status).toBe(200)
    await api("/send", { id: crypto.randomUUID(), message: "first" })
    await vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === "turn.start")).toBe(true))
    const turn = request.mock.calls.find(([method]) => method === "turn.start")![1]
    expect((await (await api("/cancel", {})).json()).cancelled).toBe(true)
    expect(request.mock.calls.find(([method]) => method === "turn.cancel")![1]).toEqual({ turnId: turn.turnId })
    event({ event: "turn.cancelled", turnId: turn.turnId, sessionKey: turn.sessionKey })
    await vi.waitFor(async () => expect((await (await api("/state")).json()).active).toBe(false))
    expect(JSON.stringify((await (await api("/state")).json()).messages)).toContain("cancelled")
    expect(request.mock.calls.filter(([method]) => method === "turn.start")).toHaveLength(1)
  })

  it("fails malformed and oversized requests explicitly without starting a turn", async () => {
    const { api, origin, app, request } = await start()
    expect((await api("/send", { id: "wrong", message: "hello" })).status).toBe(400)
    expect((await api("/send", { id: crypto.randomUUID(), message: "@ouro " })).status).toBe(400)
    expect((await api("/select", {})).status).toBe(400)
    expect((await api("/select", { target: second.id.replace(/^2/, "3") })).status).toBe(400)
    expect((await api("/send", [] )).status).toBe(400)
    expect((await api("/send", { id: crypto.randomUUID(), message: "x".repeat(17_000) })).status).toBe(413)
    expect((await api("/state", undefined, { "X-Ouro-View": "surface:1" })).status).toBe(400)
    expect((await api("/missing", {})).status).toBe(404)
    const token = new URL(app.url).hash.slice(1)
    expect((await fetch(`${origin}/send`, { method: "POST", headers: { "X-Ouro-Attention": token, Origin: origin, "Content-Type": "application/json" }, body: "{" })).status).toBe(400)
    expect((await api("/send", {} , { "Content-Type": "text/plain" })).status).toBe(403)
    expect(request.mock.calls.some(([method]) => method === "turn.start")).toBe(false)
  })

  it("shows disconnect notices and journal recovery without replaying an unresolved turn", async () => {
    const { api, request, event } = await start()
    request.mockImplementation(async method => method === "turn.status"
      ? { state: "unknown", events: [] } : {})
    await api("/send", { id: crypto.randomUUID(), message: "keep this request" })
    event({ event: "replay_required" })
    await vi.waitFor(async () => expect(JSON.stringify((await (await api("/state")).json()).messages)).toContain("unresolved"))
    expect((await api("/recover", {})).status).toBe(400)
    expect(request.mock.calls.filter(([method]) => method === "turn.start")).toHaveLength(1)
    const turn = request.mock.calls.find(([method]) => method === "turn.start")![1]
    event({ event: "turn.completed", turnId: turn.turnId, sessionKey: turn.sessionKey, result: { response: "recovered authoritative reply" }, journalSequence: 2 })
    request.mockImplementation(async method => method === "turn.status" ? { state: "completed", events: [
      { type: "turn_completed", data: { result: { response: "recovered authoritative reply" } }, sequence: 2 },
    ] } : {})
    expect((await api("/recover", {})).status).toBe(200)
    expect(JSON.stringify((await (await api("/state")).json()).messages)).toContain("recovered authoritative reply")
  })

  it("bounds retained view state without changing any existing conversation", async () => {
    const { api } = await start()
    for (let index = 0; index < 64; index++) {
      expect((await api("/state", undefined, { "X-Ouro-View": crypto.randomUUID() })).status).toBe(200)
    }
    const overflow = await api("/state", undefined, { "X-Ouro-View": crypto.randomUUID() })
    expect(overflow.status).toBe(409)
    expect((await overflow.json()).error).toContain("view limit")
  })

  it("reuses the fixed composer for sequential messages and bounds its deduplication ledger", async () => {
    const { api, request, event } = await start()
    request.mockImplementation(async (method, params) => {
      if (method === "turn.start") event({ event: "turn.completed", turnId: params.turnId, sessionKey: params.sessionKey, result: { response: "ok" } })
      return {}
    })
    for (let index = 0; index < 2_000; index++) {
      const result = await api("/send", { id: crypto.randomUUID(), message: String(index) })
      expect(result.status).toBe(202)
    }
    const overflow = await api("/send", { id: crypto.randomUUID(), message: "one more" })
    expect(overflow.status).toBe(409)
    expect((await overflow.json()).error).toContain("message limit")
    expect((await (await api("/state")).json()).messages).toHaveLength(40)
    expect(request.mock.calls.filter(([method]) => method === "turn.start")).toHaveLength(2_000)
  }, 30_000)

  it("closes an invalid binding and rejects a second close explicitly", async () => {
    const actual = await vi.importActual<typeof import("node:http")>("node:http")
    vi.mocked(http.createServer).mockImplementationOnce((...args: Parameters<typeof http.createServer>) => {
      const server = actual.createServer(...args)
      vi.spyOn(server, "address").mockReturnValue(null)
      return server
    })
    await expect(start()).rejects.toThrow("loopback port")
    const { app } = await start()
    cleanups.pop()
    await app.close()
    await expect(app.close()).rejects.toThrow("not running")
  })

  it.each([new Error("owned response write fault"), "owned non-error write fault"])("aborts a response rather than returning a success-shaped empty page after a write failure %j", async error => {
    const actual = await vi.importActual<typeof import("node:http")>("node:http")
    vi.mocked(http.createServer).mockImplementationOnce((listener: http.RequestListener) => actual.createServer((request, response) => {
      response.end = () => { throw error }
      listener(request, response)
    }))
    const { origin } = await start()
    await expect(fetch(origin)).rejects.toThrow()
  })
})
