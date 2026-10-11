import { afterEach, describe, expect, it, vi } from "vitest"

import { CmuxSocketError, createCmuxClient } from "../../../senses/cmux/client"
import { startFakeCmux, type FakeCmux } from "./fake-cmux"

const fakes: FakeCmux[] = []
async function fake(options?: Parameters<typeof startFakeCmux>[0]): Promise<FakeCmux> {
  const server = await startFakeCmux(options)
  fakes.push(server)
  return server
}

afterEach(async () => {
  for (const server of fakes.splice(0)) await server.close()
})

describe("cmux socket client", () => {
  it("wraps every request in the capability envelope and returns the v2 result", async () => {
    const server = await fake({ capability: "v1.tok.sig" })
    server.respond("workspace.list", (params) => ({ workspaces: [{ id: "WS-1" }], echo: params }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.tok.sig" } })

    await expect(client.call("workspace.list", { window_id: "W" })).resolves.toEqual({ workspaces: [{ id: "WS-1" }], echo: { window_id: "W" } })
    expect(server.lines[0]).toMatch(/^_cmux_capability_v1 v1\.tok\.sig \{"id":"[^"]+","method":"workspace.list","params":\{"window_id":"W"\}\}$/)
  })

  it("authenticates with the socket password before the request", async () => {
    const server = await fake({ password: "pw" })
    server.respond("system.ping", () => ({ pong: true }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "password", password: "pw" } })

    await expect(client.call("system.ping")).resolves.toEqual({ pong: true })
    expect(server.lines[0]).toBe("auth pw")
  })

  it("sends plain lines in automation mode and v1 commands as text", async () => {
    const server = await fake()
    server.v1((line) => line.startsWith("set_status") ? "OK" : "ERROR: Unknown command")
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } })

    await expect(client.command("set_status ouro \"hi\" --tab=WS-1")).resolves.toBe("OK")
    await expect(client.command("nope")).rejects.toMatchObject({ code: "command_failed", message: "ERROR: Unknown command" })
  })

  it("turns an access refusal into an auth error that carries the repair hint", async () => {
    const server = await fake({ denyAll: true })
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } }, { agentName: "ouroboros" })

    const error = await client.call("system.ping").catch((caught: unknown) => caught) as CmuxSocketError
    expect(error).toBeInstanceOf(CmuxSocketError)
    expect(error.code).toBe("auth")
    expect(error.message).toContain("Access denied")
    expect(error.message).toContain("ouro vault config set --agent ouroboros --scope machine --key cmux.socketCapability")
  })

  it("reports a wrong password as an auth error", async () => {
    const server = await fake({ password: "right" })
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "password", password: "wrong" } })

    await expect(client.call("system.ping")).rejects.toMatchObject({ code: "auth" })
  })

  it("tolerates a cmux build without the auth command", async () => {
    const server = await fake()
    server.v1(() => "ERROR: Unknown command 'auth'")
    server.respond("system.ping", () => ({ pong: true }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "password", password: "pw" } })

    await expect(client.call("system.ping")).resolves.toEqual({ pong: true })
  })

  it("surfaces v2 errors with their code and treats a missing result as empty", async () => {
    const server = await fake()
    server.respond("feed.permission.reply", () => { throw new Error("feed.permission.reply requires request_id") })
    server.respond("notification.create", () => undefined)
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } })

    await expect(client.call("feed.permission.reply", {})).rejects.toMatchObject({ code: "invalid_params", message: "feed.permission.reply requires request_id" })
    await expect(client.call("unknown.method")).rejects.toMatchObject({ code: "method_not_found" })
    await expect(client.call("notification.create")).resolves.toEqual({})
  })

  it("rejects unparseable and malformed v2 responses", async () => {
    const server = await fake()
    server.respond("text", () => ({ __raw: "not json" }))
    server.respond("array", () => ({ __raw: "[1]" }))
    server.respond("bare", () => ({ __raw: JSON.stringify({ ok: false }) }))
    server.respond("scalar", () => "text")
    server.respond("failed", () => ({ __raw: "ERROR: Surface not found" }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } })

    await expect(client.call("text")).rejects.toMatchObject({ code: "protocol" })
    await expect(client.call("array")).rejects.toMatchObject({ code: "protocol" })
    await expect(client.call("bare")).rejects.toMatchObject({ code: "error", message: "cmux error" })
    await expect(client.call("scalar")).resolves.toEqual({})
    await expect(client.call("failed")).rejects.toMatchObject({ code: "command_failed" })
  })

  it("reports a missing socket as unavailable with the path", async () => {
    const client = createCmuxClient({ socketPath: "/tmp/does-not-exist-cmux.sock", auth: { kind: "none" } })

    await expect(client.call("system.ping")).rejects.toMatchObject({ code: "unavailable" })
    await expect(client.call("system.ping")).rejects.toThrow("/tmp/does-not-exist-cmux.sock")
  })

  it("times out when cmux never answers", async () => {
    const server = await fake()
    server.respond("slow", () => ({ __silent: true }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } }, { timeoutMs: 50 })

    await expect(client.call("slow")).rejects.toMatchObject({ code: "timeout" })
  })

  it("streams frames line by line and reports the close once", async () => {
    const server = await fake({ capability: "v1.a.b" })
    server.respond("events.stream", () => ({ type: "ack", boot_id: "B" }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.a.b" } })
    const frames: unknown[] = []
    const onClose = vi.fn()

    client.stream({ after_seq: 5, categories: ["feed"] }, { onFrame: (frame) => frames.push(frame), onClose })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    server.pushRaw("{\"type\":\"event\",\"seq\":6}\n{\"type\":\"heart")
    server.pushRaw("beat\"}\n\n")
    await vi.waitFor(() => expect(frames).toHaveLength(3))
    expect(frames).toEqual([{ type: "ack", boot_id: "B" }, { type: "event", seq: 6 }, { type: "heartbeat" }])
    expect(server.methods.at(-1)).toEqual({ method: "events.stream", params: { after_seq: 5, categories: ["feed"] } })

    server.endStreams()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onClose).toHaveBeenCalledWith(undefined)
  })

  it("closes a stream with an error for refusals, error responses and bad frames", async () => {
    const denied = await fake({ denyAll: true })
    const deniedClient = createCmuxClient({ socketPath: denied.socketPath, auth: { kind: "none" } })
    const deniedClose = vi.fn()
    deniedClient.stream({}, { onFrame: vi.fn(), onClose: deniedClose })
    await vi.waitFor(() => expect(deniedClose).toHaveBeenCalledWith(expect.objectContaining({ code: "auth" })))

    const server = await fake()
    server.respond("events.stream", () => ({ ok: false, error: { code: "slow_consumer", message: "fell behind" } }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } })
    const onClose = vi.fn()
    client.stream({}, { onFrame: vi.fn(), onClose })
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: "slow_consumer", message: "fell behind" })))

    server.respond("events.stream", () => ({ type: "ack" }))
    const badClose = vi.fn()
    const handle = client.stream({}, { onFrame: vi.fn(), onClose: badClose })
    await vi.waitFor(() => expect(server.streamCount()).toBeGreaterThan(0))
    const frames: unknown[] = []
    const arrayClose = vi.fn()
    client.stream({}, { onFrame: (frame) => frames.push(frame), onClose: arrayClose })
    await vi.waitFor(() => expect(server.streamCount()).toBe(2))
    server.pushRaw("[1]\n{\"type\":\"event\"}\n")
    await vi.waitFor(() => expect(arrayClose).toHaveBeenCalledWith(expect.objectContaining({ code: "protocol" })))
    await vi.waitFor(() => expect(badClose).toHaveBeenCalledWith(expect.objectContaining({ code: "protocol" })))
    handle.close()
    expect(badClose).toHaveBeenCalledTimes(1)
    expect(frames).toEqual([{ type: "ack" }])
  })

  it("closes quietly when the caller closes the stream", async () => {
    const server = await fake()
    server.respond("events.stream", () => ({ type: "ack" }))
    const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } })
    const onClose = vi.fn()
    const handle = client.stream({}, { onFrame: vi.fn(), onClose })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    handle.close()
    handle.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(undefined)

    const early = vi.fn()
    client.stream({}, { onFrame: vi.fn(), onClose: early }).close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(early).toHaveBeenCalledTimes(1)
    expect(server.methods.filter((entry) => entry.method === "events.stream")).toHaveLength(1)

    const missing = createCmuxClient({ socketPath: "/tmp/does-not-exist-cmux.sock", auth: { kind: "none" } })
    const missingClose = vi.fn()
    missing.stream({}, { onFrame: vi.fn(), onClose: missingClose })
    await vi.waitFor(() => expect(missingClose).toHaveBeenCalledWith(expect.objectContaining({ code: "unavailable" })))
  })
})
