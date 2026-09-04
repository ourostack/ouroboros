import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import * as readline from "node:readline"

import type { Channel } from "@ouro.bot/friends"

import type { FrontendSessionService, FrontendTurnRequest } from "./frontend-session-service"

const PROTOCOL_VERSION = 1
const MAX_SOCKET_PATH_BYTES = 100

type FrontendFrame = Record<string, unknown> & { protocolVersion: 1 }

export function frontendSocketPathForDaemon(commandSocketPath: string): string {
  const candidate = `${commandSocketPath}.frontend`
  if (Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES) return candidate
  const digest = createHash("sha256").update(path.resolve(commandSocketPath)).digest("hex").slice(0, 16)
  return `/tmp/ouro-frontend-${digest}.sock`
}

interface FrameSocket {
  write(chunk: string): boolean
  once(event: "drain", listener: () => void): unknown
  end(): void
}

export class FrontendFrameWriter {
  private readonly socket: FrameSocket
  private readonly maxQueuedFrames: number
  private readonly queued: string[] = []
  private backpressured = false
  private closeAfterDrain = false
  private lastSequence = 0

  constructor(socket: FrameSocket, maxQueuedFrames: number) {
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
      throw new Error("maxQueuedFrames must be a positive integer")
    }
    this.socket = socket
    this.maxQueuedFrames = maxQueuedFrames
  }

  send(frame: FrontendFrame): void {
    const sequence = typeof frame.sequence === "number" ? frame.sequence : null
    const encoded = `${JSON.stringify(frame)}\n`
    if (this.backpressured) {
      if (this.closeAfterDrain) return
      if (this.queued.length >= this.maxQueuedFrames) {
        this.queued.splice(0, this.queued.length, `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          event: "replay_required",
          lastSequence: this.lastSequence,
        })}\n`)
        this.closeAfterDrain = true
        return
      }
      this.queued.push(encoded)
      return
    }
    if (sequence !== null) this.lastSequence = sequence
    if (!this.socket.write(encoded)) {
      this.backpressured = true
      this.socket.once("drain", () => this.flush())
    }
  }

  private flush(): void {
    this.backpressured = false
    while (this.queued.length > 0) {
      const encoded = this.queued.shift()!
      if (!this.socket.write(encoded)) {
        this.backpressured = true
        this.socket.once("drain", () => this.flush())
        return
      }
    }
    if (this.closeAfterDrain) this.socket.end()
  }
}

interface FrontendClient {
  socket: net.Socket
  writer: FrontendFrameWriter
  subscriptions: Set<string>
}

export interface FrontendSocketServer {
  socketPath: string
  publish(sessionKey: string, event: string, data?: Record<string, unknown>): void
  stop(): Promise<void>
}

function response(id: string | null, result: Record<string, unknown>): FrontendFrame {
  return { protocolVersion: PROTOCOL_VERSION, id, ok: true, result }
}

function errorResponse(id: string | null, code: string, message: string): FrontendFrame {
  return { protocolVersion: PROTOCOL_VERSION, id, ok: false, error: { code, message } }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("params must be an object")
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function removeSocket(socketPath: string): void {
  if (!fs.existsSync(socketPath)) return
  const stat = fs.lstatSync(socketPath)
  if (!stat.isSocket()) throw new Error(`frontend socket path is not a socket: ${socketPath}`)
  fs.unlinkSync(socketPath)
}

export async function startFrontendSocketServer(options: {
  socketPath: string
  service: FrontendSessionService
  maxQueuedFrames?: number
}): Promise<FrontendSocketServer> {
  const socketPath = options.socketPath
  const maxQueuedFrames = options.maxQueuedFrames ?? 64
  const clients = new Set<FrontendClient>()
  const sequences = new Map<string, number>()
  let stopped = false
  removeSocket(socketPath)

  function publish(sessionKey: string, event: string, data: Record<string, unknown> = {}): void {
    const sequence = (sequences.get(sessionKey) ?? 0) + 1
    sequences.set(sessionKey, sequence)
    const frame: FrontendFrame = { protocolVersion: PROTOCOL_VERSION, event, sessionKey, sequence, ...data }
    for (const client of clients) {
      if (client.subscriptions.has(sessionKey)) client.writer.send(frame)
    }
  }

  async function handleRequest(client: FrontendClient, raw: unknown): Promise<void> {
    const request = record(raw)
    const id = typeof request.id === "string" ? request.id : null
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      client.writer.send(errorResponse(id, "unsupported_version", "protocolVersion must be 1"))
      return
    }
    const method = requiredString(request.method, "method")
    const params = record(request.params ?? {})

    if (method === "session.subscribe" || method === "session.unsubscribe") {
      const sessionKey = requiredString(params.sessionKey, "sessionKey")
      if (method === "session.subscribe") client.subscriptions.add(sessionKey)
      else client.subscriptions.delete(sessionKey)
      client.writer.send(response(id, { subscribed: client.subscriptions.has(sessionKey) }))
      return
    }

    if (method === "turn.cancel") {
      const turnId = requiredString(params.turnId, "turnId")
      client.writer.send(response(id, { cancelled: options.service.cancelTurn(turnId) }))
      return
    }

    if (method === "turn.start") {
      const turnRequest: FrontendTurnRequest = {
        turnId: requiredString(params.turnId, "turnId"),
        agent: requiredString(params.agent, "agent"),
        friendId: requiredString(params.friendId, "friendId"),
        channel: requiredString(params.channel, "channel") as Channel,
        sessionKey: requiredString(params.sessionKey, "sessionKey"),
        message: requiredString(params.message, "message"),
      }
      const running = options.service.runTurn(turnRequest)
      client.writer.send(response(id, { accepted: true, turnId: turnRequest.turnId }))
      void running.then(
        (result) => publish(turnRequest.sessionKey, "turn.completed", { turnId: turnRequest.turnId, result }),
        (error) => publish(turnRequest.sessionKey, "turn.failed", {
          turnId: turnRequest.turnId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return
    }

    client.writer.send(errorResponse(id, "method_not_found", `unknown frontend method: ${method}`))
  }

  const server = net.createServer((socket) => {
    const client: FrontendClient = {
      socket,
      writer: new FrontendFrameWriter(socket, maxQueuedFrames),
      subscriptions: new Set(),
    }
    clients.add(client)
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    let dispatch = Promise.resolve()
    lines.on("line", (line) => {
      dispatch = dispatch.then(async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          client.writer.send(errorResponse(null, "parse_error", "invalid JSON frame"))
          return
        }
        try {
          await handleRequest(client, parsed)
        } catch (error) {
          const id = parsed && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string"
            ? (parsed as { id: string }).id
            : null
          client.writer.send(errorResponse(id, "invalid_params", error instanceof Error ? error.message : String(error)))
        }
      })
    })
    socket.on("close", () => {
      clients.delete(client)
      lines.close()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })
  fs.chmodSync(socketPath, 0o600)

  return {
    socketPath,
    publish,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      for (const client of clients) client.socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      removeSocket(socketPath)
    },
  }
}
