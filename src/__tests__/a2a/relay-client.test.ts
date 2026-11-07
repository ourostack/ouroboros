import { describe, expect, it, vi } from "vitest"
import { RelayHttpError, relayAck, relayDeregister, relayPull, relayRegister, relaySend } from "../../a2a/relay-client"

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(status: number, payload: unknown, calls: Call[] = [], raw?: string): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method),
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return new Response(raw ?? JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
}

const message = { messageId: "m", role: "agent", parts: [] }

describe("relay client", () => {
  it("registers with the invite token and returns the grant", async () => {
    const calls: Call[] = []
    const grant = await relayRegister({
      url: "https://relay.example/",
      handle: "h1",
      did: "did:key:zMe",
      agentCard: { name: "me" },
      inviteToken: "inv",
      fetchImpl: fakeFetch(200, { handle: "h1", inboxAuth: "ia", sendCredential: "sc" }, calls),
    })
    expect(grant).toEqual({ handle: "h1", inboxAuth: "ia", sendCredential: "sc" })
    expect(calls[0]).toMatchObject({ url: "https://relay.example/register", method: "POST" })
    expect(calls[0].body).toEqual({ handle: "h1", did: "did:key:zMe", agentCard: { name: "me" }, inviteToken: "inv" })
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it("registers without an invite token on an open relay", async () => {
    const calls: Call[] = []
    await relayRegister({ url: "https://relay.example", handle: "h1", did: "d", agentCard: {}, fetchImpl: fakeFetch(200, { inboxAuth: "ia", sendCredential: "sc" }, calls) })
    expect(calls[0].body).toEqual({ handle: "h1", did: "d", agentCard: {} })
  })

  it("rejects a grant with missing credentials", async () => {
    await expect(relayRegister({ url: "https://r", handle: "h", did: "d", agentCard: {}, fetchImpl: fakeFetch(200, { inboxAuth: "ia" }) }))
      .rejects.toThrow(/relay registration returned no credentials/)
  })

  it("sends the exact message to the encoded handle with the send credential", async () => {
    const calls: Call[] = []
    const taskId = await relaySend({ url: "https://relay.example", handle: "a/b", sendCredential: "sc", message, fetchImpl: fakeFetch(202, { taskId: "q1", state: "submitted" }, calls) })
    expect(taskId).toBe("q1")
    expect(calls[0]).toMatchObject({ url: "https://relay.example/a2a/a%2Fb", method: "POST" })
    expect(calls[0].headers.authorization).toBe("Bearer sc")
    expect(calls[0].body).toEqual(message)
  })

  it("refuses a 2xx answer that carries no queue id (a captive portal or proxy page)", async () => {
    await expect(relaySend({ url: "https://r", handle: "h", sendCredential: "sc", message, fetchImpl: fakeFetch(200, {}) }))
      .rejects.toThrow(/did not confirm the message was queued/)
  })

  it("pulls the inbox and acks one message", async () => {
    const calls: Call[] = []
    const queued = [{ queueId: "q1", message }]
    expect(await relayPull({ url: "https://r", handle: "h", inboxAuth: "ia", fetchImpl: fakeFetch(200, { messages: queued }, calls) })).toEqual(queued)
    expect(calls[0]).toMatchObject({ url: "https://r/inbox/h", method: "GET", body: undefined })
    expect(calls[0].headers.authorization).toBe("Bearer ia")
    await relayAck({ url: "https://r", handle: "h", inboxAuth: "ia", queueId: "q 1", fetchImpl: fakeFetch(200, { acked: true }, calls) })
    expect(calls[1]).toMatchObject({ url: "https://r/inbox/h/ack/q%201", method: "POST" })
  })

  it("deregisters a handle with the inbox auth", async () => {
    const calls: Call[] = []
    await relayDeregister({ url: "https://r/", handle: "h/1", inboxAuth: "ia", fetchImpl: fakeFetch(200, { ok: true }, calls) })
    expect(calls[0]).toMatchObject({ url: "https://r/register/h%2F1", method: "DELETE", body: undefined })
    expect(calls[0].headers.authorization).toBe("Bearer ia")
    await expect(relayDeregister({ url: "https://r", handle: "h", inboxAuth: "bad", fetchImpl: fakeFetch(401, { error: "unauthorized" }) })).rejects.toMatchObject({ status: 401, code: "unauthorized" })
  })

  it("skips pulled entries without a queue id, logging no payload, and keeps the rest of the queue", async () => {
    const nerves = vi.spyOn(await import("../../nerves/runtime"), "emitNervesEvent")
    const good = { queueId: "q2", message }
    const pulled = [null, "x", { message: { secret: "payload" } }, { queueId: 7, message }, { queueId: "", message }, good]
    expect(await relayPull({ url: "https://r", handle: "h", inboxAuth: "ia", fetchImpl: fakeFetch(200, { messages: pulled }) })).toEqual([good])
    const skipped = nerves.mock.calls.map(([event]) => event).filter((event) => event.event === "channel.a2a_relay_entry_skipped")
    expect(skipped).toHaveLength(5)
    expect(JSON.stringify(skipped)).not.toContain("payload")
    expect(skipped[0]).toMatchObject({ level: "warn", meta: { relayUrl: "https://r", position: 0 } })
    nerves.mockRestore()
  })

  it("treats a pull with no message list as empty", async () => {
    expect(await relayPull({ url: "https://r", handle: "h", inboxAuth: "ia", fetchImpl: fakeFetch(200, {}) })).toEqual([])
  })

  it("throws a typed error with the relay's status and code", async () => {
    const error = await relaySend({ url: "https://r", handle: "h", sendCredential: "bad", message, fetchImpl: fakeFetch(403, { error: "bad_send_credential" }) })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RelayHttpError)
    expect(error).toMatchObject({ status: 403, code: "bad_send_credential", message: "relay 403 bad_send_credential" })
  })

  it("names a non-JSON error body as error", async () => {
    const error = await relayPull({ url: "https://r", handle: "h", inboxAuth: "ia", fetchImpl: fakeFetch(502, null, [], "<html>bad gateway</html>") })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 502, code: "error" })
  })

  it("uses the global fetch when none is injected", async () => {
    const original = globalThis.fetch
    const calls: Call[] = []
    globalThis.fetch = fakeFetch(200, { messages: [] }, calls)
    try {
      await relayPull({ url: "https://r", handle: "h", inboxAuth: "ia" })
    } finally {
      globalThis.fetch = original
    }
    expect(calls).toHaveLength(1)
  })
})
