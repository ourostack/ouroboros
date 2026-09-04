import * as net from "node:net"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { SocketFrontendClient } from "../../heart/frontend-socket-client"

function socketPath(name: string): string {
  return path.join("/tmp", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

async function listen(target: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer(onConnection)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(target, resolve)
  })
  return server
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe("frontend socket client", () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()!()
  })

  it("reuses one connection, parses partial responses, and publishes events", async () => {
    const target = socketPath("frontend-client")
    let connectionCount = 0
    const server = await listen(target, (socket) => {
      connectionCount += 1
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        for (;;) {
          const newline = buffer.indexOf("\n")
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const request = JSON.parse(line)
          socket.write("\n")
          socket.write('{"protocolVersion":1,"id":"missing","ok":true,"result":{}}\n')
          socket.write('{}\n')
          socket.write('{"protocolVersion":1,"event":"snapshot","sessionKey":"session-1","sequence":1}\n')
          const response = `${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result: { method: request.method } })}\n`
          socket.write(response.slice(0, 10))
          socket.write(response.slice(10))
        }
      })
    })
    cleanup.push(() => close(server))
    const client = new SocketFrontendClient(target)
    const events: any[] = []
    const unsubscribe = client.onEvent((event) => events.push(event))

    const [first, second] = await Promise.all([
      client.request("one", {}),
      client.request("two", {}),
    ])
    expect(first).toEqual({ method: "one" })
    expect(second).toEqual({ method: "two" })
    expect(connectionCount).toBe(1)
    expect(events).toContainEqual(expect.objectContaining({ event: "snapshot", sequence: 1 }))

    unsubscribe()
    await expect(client.request("three", {})).resolves.toEqual({ method: "three" })
    expect(events).toHaveLength(2)
    client.close()
  })

  it("rejects frontend error responses with explicit and fallback messages", async () => {
    const target = socketPath("frontend-client-errors")
    let count = 0
    const server = await listen(target, (socket) => {
      socket.on("data", (chunk) => {
        for (const line of chunk.toString("utf8").trim().split("\n")) {
          const request = JSON.parse(line)
          count += 1
          socket.write(`${JSON.stringify({
            protocolVersion: 1,
            id: request.id,
            ok: false,
            error: count === 1 ? { message: "denied" } : {},
          })}\n`)
        }
      })
    })
    cleanup.push(() => close(server))
    const client = new SocketFrontendClient(target)

    await expect(client.request("one", {})).rejects.toThrow("denied")
    await expect(client.request("two", {})).rejects.toThrow("frontend request failed")
    client.close()
  })

  it("rejects pending work on invalid data and socket close", async () => {
    const target = socketPath("frontend-client-invalid")
    let connection = 0
    const server = await listen(target, (socket) => {
      connection += 1
      socket.once("data", () => {
        if (connection === 1) socket.write("not-json\n")
        else socket.destroy()
      })
    })
    cleanup.push(() => close(server))
    const client = new SocketFrontendClient(target)

    await expect(client.request("invalid", {})).rejects.toThrow("invalid frontend socket response")
    client.close()
    await expect(client.request("closed", {})).rejects.toThrow("frontend socket closed")
    client.close()
  })

  it("rejects pending work on a connected socket error", async () => {
    const target = socketPath("frontend-client-socket-error")
    let accepted: net.Socket | null = null
    const server = await listen(target, (socket) => { accepted = socket })
    cleanup.push(() => close(server))
    const client = new SocketFrontendClient(target)
    const pending = client.request("wait", {})
    await new Promise((resolve) => setTimeout(resolve, 10))

    ;(client as any).socket.emit("error", new Error("transport error"))

    await expect(pending).rejects.toThrow("transport error")
    client.close()
    accepted?.destroy()
  })

  it("can reconnect after an initial connection failure", async () => {
    const target = socketPath("frontend-client-retry")
    const client = new SocketFrontendClient(target)
    await expect(client.request("before", {})).rejects.toThrow()

    const server = await listen(target, (socket) => {
      socket.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8").trim())
        socket.end(`${JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result: { retried: true } })}\n`)
      })
    })
    cleanup.push(() => close(server))

    await expect(client.request("after", {})).resolves.toEqual({ retried: true })
    client.close()
  })
})
