import * as http from "node:http"
import type { AddressInfo } from "node:net"

/**
 * An in-process stand-in for ourostack/friends-relay's HTTP surface (`src/server/http.ts`), with its semantics for
 * the routes the harness uses: register (same handle rotates both credentials), send (bearer send credential, the
 * DataPart recipientDid must equal the registered DID, 202), pull and ack (bearer inbox auth) and deregister.
 * `failNext` makes the next request on a route answer with a chosen status. Tests read `inbox` to see what the relay
 * holds.
 */
export interface FakeRelay {
  url: string
  inbox: Map<string, Array<{ queueId: string; message: unknown }>>
  registrations: Map<string, { did: string; inboxAuth: string; sendCredential: string; agentCard: unknown }>
  requests: Array<{ method: string; path: string; body: unknown }>
  failNext(route: "register" | "send" | "pull" | "ack" | "deregister", status: number, error?: string): void
  close(): Promise<void>
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const inbox = new Map<string, Array<{ queueId: string; message: unknown }>>()
  const registrations = new Map<string, { did: string; inboxAuth: string; sendCredential: string; agentCard: unknown }>()
  const requests: FakeRelay["requests"] = []
  const failures = new Map<string, { status: number; error: string }>()
  let counter = 0

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString("utf8")
    const body: unknown = raw ? JSON.parse(raw) : undefined
    const url = new URL(req.url ?? "/", "http://relay")
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "")
    requests.push({ method: req.method ?? "", path: url.pathname, body })
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(payload))
    }
    const route = req.method === "POST" && url.pathname === "/register" ? "register"
      : req.method === "POST" && url.pathname.startsWith("/a2a/") ? "send"
        : req.method === "GET" && url.pathname.startsWith("/inbox/") ? "pull"
          : req.method === "POST" && url.pathname.includes("/ack/") ? "ack"
            : req.method === "DELETE" ? "deregister" : "unknown"
    const failure = failures.get(route)
    if (failure) {
      failures.delete(route)
      reply(failure.status, { error: failure.error })
      return
    }
    const segments = url.pathname.split("/").map((s) => decodeURIComponent(s))
    if (route === "register") {
      const { handle, did, agentCard } = body as { handle: string; did: string; agentCard: unknown }
      counter += 1
      const grant = { did, agentCard, inboxAuth: `ia-${counter}`, sendCredential: `sc-${counter}` }
      registrations.set(handle, grant)
      if (!inbox.has(handle)) inbox.set(handle, [])
      reply(200, { handle, inboxAuth: grant.inboxAuth, sendCredential: grant.sendCredential, relayCard: {} })
      return
    }
    if (route === "send") {
      const handle = segments[2]
      const reg = registrations.get(handle)
      if (!reg) return reply(404, { error: "unknown_handle" })
      if (bearer !== reg.sendCredential) return reply(403, { error: "bad_send_credential" })
      const recipientDid = (body as { parts?: Array<{ data?: { recipientDid?: string } }> }).parts?.[0]?.data?.recipientDid
      if (recipientDid !== reg.did) return reply(400, { error: "recipient_mismatch" })
      counter += 1
      const queueId = `q-${counter}`
      inbox.get(handle)!.push({ queueId, message: body })
      return reply(202, { taskId: queueId, state: "submitted" })
    }
    const handle = segments[2]
    const reg = registrations.get(handle)
    if (!reg || bearer !== reg.inboxAuth) return reply(401, { error: "unauthorized" })
    if (route === "pull") return reply(200, { messages: inbox.get(handle) ?? [] })
    if (route === "ack") {
      const queueId = segments[4]
      const queue = inbox.get(handle) ?? []
      const before = queue.length
      inbox.set(handle, queue.filter((m) => m.queueId !== queueId))
      return reply(200, { acked: inbox.get(handle)!.length < before })
    }
    if (route === "deregister") {
      registrations.delete(handle)
      inbox.delete(handle)
      return reply(200, { ok: true })
    }
    reply(404, { error: "not_found" })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    inbox,
    registrations,
    requests,
    failNext(route, status, error = "injected") {
      failures.set(route, { status, error })
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
