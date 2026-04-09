import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import * as http from "node:http"

import { createHttpHealthProbe } from "../../../heart/daemon/http-health-probe"

function startTestServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{
  port: number
  server: http.Server
}> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr !== null ? addr.port : 0
      resolve({ port, server })
    })
  })
}

describe("createHttpHealthProbe", () => {
  const servers: http.Server[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close()
    }
  })

  it("returns ok: true when server responds 200 with status ok", async () => {
    const { port, server } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", uptime: 42 }))
    })
    servers.push(server)

    const probe = createHttpHealthProbe("bluebubbles", port)
    const result = await probe.check()

    expect(result).toEqual({ ok: true })
    expect(probe.name).toBe("bluebubbles")
  })

  it("returns ok: false with detail when server responds non-200", async () => {
    const { port, server } = await startTestServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Internal Server Error" }))
    })
    servers.push(server)

    const probe = createHttpHealthProbe("bluebubbles", port)
    const result = await probe.check()

    expect(result.ok).toBe(false)
    expect(result.detail).toContain("500")
  })

  it("returns ok: false when server responds 200 but status is not ok", async () => {
    const { port, server } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "degraded", uptime: 42 }))
    })
    servers.push(server)

    const probe = createHttpHealthProbe("bluebubbles", port)
    const result = await probe.check()

    expect(result.ok).toBe(false)
    expect(result.detail).toContain("degraded")
  })

  it("returns ok: false with detail when connection is refused (server down)", async () => {
    // Use a port that is extremely unlikely to have a listener
    const probe = createHttpHealthProbe("bluebubbles", 19999, 2000)
    const result = await probe.check()

    expect(result.ok).toBe(false)
    expect(result.detail).toBeDefined()
  })

  it("returns ok: false with timeout detail when request exceeds timeout", async () => {
    const { port, server } = await startTestServer((_req, _res) => {
      // Intentionally never respond -- simulate hang
    })
    servers.push(server)

    const probe = createHttpHealthProbe("bluebubbles", port, 200)
    const result = await probe.check()

    expect(result.ok).toBe(false)
    expect(result.detail).toContain("timeout")
  })

  it("returns ok: false when server returns invalid JSON", async () => {
    const { port, server } = await startTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("not json")
    })
    servers.push(server)

    const probe = createHttpHealthProbe("bluebubbles", port)
    const result = await probe.check()

    expect(result.ok).toBe(false)
    expect(result.detail).toBeDefined()
  })
})
