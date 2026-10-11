import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

/**
 * A fake cmux control socket for tests. It speaks the real wire shape: one request line per
 * connection turn, optional `auth <password>` handshake, optional `_cmux_capability_v1 <token> `
 * envelope, and newline-delimited JSON responses. `events.stream` keeps the connection open and
 * the test pushes frames with `push()`.
 */
export interface FakeCmux {
  socketPath: string
  lines: string[]
  methods: Array<{ method: string; params: Record<string, unknown> }>
  respond: (method: string, handler: (params: Record<string, unknown>) => unknown) => void
  v1: (handler: (line: string) => string) => void
  push: (frame: unknown) => void
  pushRaw: (text: string) => void
  endStreams: () => void
  streamCount: () => number
  close: () => Promise<void>
}

export async function startFakeCmux(options: { password?: string; capability?: string; denyAll?: boolean } = {}): Promise<FakeCmux> {
  const dir = fs.mkdtempSync("/tmp/cmx-")
  const socketPath = path.join(dir, "s.sock")
  const lines: string[] = []
  const methods: Array<{ method: string; params: Record<string, unknown> }> = []
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  let v1Handler: (line: string) => string = () => "OK"
  const streams = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    let buffer = ""
    let authed = !options.password
    socket.on("error", () => undefined)
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8")
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
        lines.push(line)
        if (options.denyAll) {
          socket.write("ERROR: Access denied — only processes started inside cmux can connect\n")
          continue
        }
        if (options.password && line.startsWith("auth ")) {
          authed = line.slice(5) === options.password
          socket.write(authed ? "OK: authenticated\n" : "ERROR: Invalid password\n")
          continue
        }
        if (options.capability) {
          const prefix = `_cmux_capability_v1 ${options.capability} `
          if (!line.startsWith(prefix)) {
            socket.write("ERROR: Access denied — only processes started inside cmux can connect\n")
            continue
          }
          line = line.slice(prefix.length)
        }
        if (!authed) {
          socket.write("ERROR: Authentication required\n")
          continue
        }
        if (!line.startsWith("{")) {
          socket.write(`${v1Handler(line)}\n`)
          continue
        }
        const request = JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> }
        methods.push({ method: request.method, params: request.params ?? {} })
        if (request.method === "events.stream") {
          streams.add(socket)
          socket.on("close", () => streams.delete(socket))
          const handler = handlers.get("events.stream")
          if (handler) socket.write(`${JSON.stringify(handler(request.params ?? {}))}\n`)
          continue
        }
        const handler = handlers.get(request.method)
        if (!handler) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: "method_not_found", message: `Unknown method ${request.method}` } })}\n`)
          continue
        }
        try {
          const result = handler(request.params ?? {}) as { __raw?: string; __silent?: boolean } | undefined
          if (result?.__silent) continue
          if (typeof result?.__raw === "string") {
            socket.write(`${result.__raw}\n`)
            continue
          }
          socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
        } catch (error) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: { code: "invalid_params", message: (error as Error).message } })}\n`)
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    lines,
    methods,
    respond: (method, handler) => { handlers.set(method, handler) },
    v1: (handler) => { v1Handler = handler },
    push: (frame) => { for (const socket of streams) socket.write(`${JSON.stringify(frame)}\n`) },
    pushRaw: (text) => { for (const socket of streams) socket.write(text) },
    endStreams: () => { for (const socket of streams) socket.destroy() },
    streamCount: () => streams.size,
    close: async () => {
      for (const socket of streams) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function ackFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ack",
    protocol: "cmux-events",
    version: 1,
    boot_id: "BOOT-1",
    resume: { after_seq: null, gap: false, latest_seq: 10, oldest_seq: 1, next_seq: 11 },
    ...overrides,
  }
}
