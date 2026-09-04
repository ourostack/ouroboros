import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import * as readline from "node:readline"

import type { Channel } from "@ouro.bot/friends"

import type { FrontendSessionService, FrontendTurnRequest } from "./frontend-session-service"
import type { RuntimeMcpServers } from "../repertoire/mcp-manager"

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
  private readonly onReplayRequired: () => void
  private readonly queued: string[] = []
  private backpressured = false
  private closeAfterDrain = false
  private overflowed = false
  private lastSequence = 0

  constructor(socket: FrameSocket, maxQueuedFrames: number, onReplayRequired: () => void) {
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
      throw new Error("maxQueuedFrames must be a positive integer")
    }
    this.socket = socket
    this.maxQueuedFrames = maxQueuedFrames
    this.onReplayRequired = onReplayRequired
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
        this.overflowed = true
        this.onReplayRequired()
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

  get replayRequired(): boolean {
    return this.overflowed
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
  ownedTurnIds: Set<string>
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

function requiredExecutable(value: unknown, field: string): string {
  const executable = requiredString(value, field)
  if (!path.isAbsolute(executable)) throw new Error(`${field} must be absolute`)
  try {
    if (!fs.statSync(executable).isFile()) throw new Error("not a file")
    fs.accessSync(executable, fs.constants.X_OK)
  } catch {
    throw new Error(`${field} must be executable`)
  }
  return executable
}

function validatedRuntimeMcpEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) {
    throw new Error("runtimeMcpServers.ouro_workbench.env requires exactly BUN_BIN, CMUX_BUNDLED_CLI_PATH, CMUX_SOCKET_PATH, CMUX_SOCKET_CAPABILITY")
  }
  const env = record(value)
  const keys = [
    "BUN_BIN",
    "CMUX_BUNDLED_CLI_PATH",
    "CMUX_SOCKET_PATH",
    "CMUX_SOCKET_CAPABILITY",
  ]
  if (Object.keys(env).length !== keys.length || Object.keys(env).some((key) => !keys.includes(key))) {
    throw new Error(`runtimeMcpServers.ouro_workbench.env requires exactly ${keys.join(", ")}`)
  }
  const socketPath = requiredString(env.CMUX_SOCKET_PATH, "runtimeMcpServers.ouro_workbench.env.CMUX_SOCKET_PATH")
  if (!path.isAbsolute(socketPath)) {
    throw new Error("runtimeMcpServers.ouro_workbench.env.CMUX_SOCKET_PATH must be absolute")
  }
  try {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error("not a socket")
  } catch {
    throw new Error("runtimeMcpServers.ouro_workbench.env.CMUX_SOCKET_PATH must be a live Unix socket")
  }
  const capability = requiredString(
    env.CMUX_SOCKET_CAPABILITY,
    "runtimeMcpServers.ouro_workbench.env.CMUX_SOCKET_CAPABILITY",
  )
  if (capability.length > 2_048 || /\s/u.test(capability)) {
    throw new Error("runtimeMcpServers.ouro_workbench.env.CMUX_SOCKET_CAPABILITY is invalid")
  }
  return {
    BUN_BIN: requiredExecutable(env.BUN_BIN, "runtimeMcpServers.ouro_workbench.env.BUN_BIN"),
    CMUX_BUNDLED_CLI_PATH: requiredExecutable(
      env.CMUX_BUNDLED_CLI_PATH,
      "runtimeMcpServers.ouro_workbench.env.CMUX_BUNDLED_CLI_PATH",
    ),
    CMUX_SOCKET_PATH: socketPath,
    CMUX_SOCKET_CAPABILITY: capability,
  }
}

function validatedRuntimeMcpServers(value: unknown): RuntimeMcpServers | undefined {
  if (value === undefined) return undefined
  const servers = record(value)
  const names = Object.keys(servers)
  if (names.length === 0) return undefined
  if (names.length !== 1 || names[0] !== "ouro_workbench") {
    throw new Error("runtimeMcpServers supports only ouro_workbench")
  }
  const config = record(servers.ouro_workbench)
  if (Object.keys(config).some((key) => key !== "command" && key !== "args" && key !== "env")) {
    throw new Error("runtimeMcpServers.ouro_workbench supports only command, args, and env")
  }
  const command = requiredExecutable(config.command, "runtimeMcpServers.ouro_workbench.command")
  const args = config.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string") || args.length > 0) {
    throw new Error("runtimeMcpServers.ouro_workbench.args must be an empty string array")
  }
  return {
    ouro_workbench: {
      command,
      args: [],
      env: validatedRuntimeMcpEnvironment(config.env),
    },
  }
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
  const unsubscribeFromService = options.service.subscribe((event) => {
    publish(event.sessionKey, event.type.replaceAll("_", "."), {
      turnId: event.turnId,
      journalSequence: event.journalSequence,
      ...event.data,
    })
    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      for (const client of clients) {
        client.ownedTurnIds.delete(event.turnId)
        if (event.ephemeral) client.subscriptions.delete(event.sessionKey)
      }
      if (event.ephemeral) sequences.delete(event.sessionKey)
    }
  })

  async function handleRequest(client: FrontendClient, raw: unknown): Promise<void> {
    const request = record(raw)
    const id = typeof request.id === "string" ? request.id : null
    if (request.protocolVersion !== PROTOCOL_VERSION) {
      client.writer.send(errorResponse(id, "unsupported_version", "protocolVersion must be 1"))
      return
    }
    const method = requiredString(request.method, "method")
    const params = record(request.params ?? {})

    if (method === "session.load") {
      const result = options.service.loadSession({
        agent: requiredString(params.agent, "agent"),
        friendId: requiredString(params.friendId, "friendId"),
        sessionKey: requiredString(params.sessionKey, "sessionKey"),
      }, {
        ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence as number } : {}),
        ...(params.limit !== undefined ? { limit: params.limit as number } : {}),
      })
      client.writer.send(response(id, result as unknown as Record<string, unknown>))
      return
    }

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

    if (method === "permission.resolve") {
      const requestId = requiredString(params.requestId, "requestId")
      const optionId = requiredString(params.optionId, "optionId")
      client.writer.send(response(id, { resolved: options.service.resolvePermission(requestId, optionId) }))
      return
    }

    if (method === "turn.start" || method === "turn.start.observe-only") {
      const observeOnly = method === "turn.start.observe-only"
      if (params.toolMode !== undefined) {
        throw new Error("toolMode is unsupported; use turn.start.observe-only")
      }
      if (observeOnly && params.runtimeMcpServers !== undefined) {
        throw new Error("turn.start.observe-only cannot include runtimeMcpServers")
      }
      const runtimeMcpServers = validatedRuntimeMcpServers(params.runtimeMcpServers)
      const turnRequest: FrontendTurnRequest = {
        turnId: requiredString(params.turnId, "turnId"),
        agent: requiredString(params.agent, "agent"),
        friendId: requiredString(params.friendId, "friendId"),
        channel: requiredString(params.channel, "channel") as Channel,
        sessionKey: requiredString(params.sessionKey, "sessionKey"),
        message: requiredString(params.message, "message"),
        ...(observeOnly ? { disableTools: true, ephemeral: true } : {}),
        ...(runtimeMcpServers ? { runtimeMcpServers } : {}),
      }
      const prepared = options.service.prepareTurn(turnRequest)
      client.ownedTurnIds.add(turnRequest.turnId)
      client.writer.send(response(id, { accepted: true, turnId: turnRequest.turnId }))
      queueMicrotask(() => {
        void options.service.runPreparedTurn(prepared).catch(() => undefined)
      })
      return
    }

    client.writer.send(errorResponse(id, "method_not_found", `unknown frontend method: ${method}`))
  }

  const server = net.createServer((socket) => {
    const ownedTurnIds = new Set<string>()
    const client: FrontendClient = {
      socket,
      writer: new FrontendFrameWriter(socket, maxQueuedFrames, ownedTurnIds.clear.bind(ownedTurnIds)),
      subscriptions: new Set(),
      ownedTurnIds,
    }
    clients.add(client)
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity })
    let cleanedUp = false
    const cleanupClient = () => {
      if (cleanedUp) return
      cleanedUp = true
      for (const turnId of client.ownedTurnIds) options.service.cancelTurn(turnId)
      clients.delete(client)
      lines.close()
    }
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
    socket.on("error", () => {
      cleanupClient()
      socket.destroy()
    })
    lines.on("error", () => {
      cleanupClient()
      socket.destroy()
    })
    socket.on("close", cleanupClient)
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
      unsubscribeFromService()
      for (const client of clients) client.socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      removeSocket(socketPath)
    },
  }
}
