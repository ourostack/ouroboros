import * as net from "node:net"
import { emitNervesEvent } from "../nerves/runtime"

export interface FrontendProtocolClient {
  request(method: string, params: Record<string, unknown>): Promise<any>
  onEvent(listener: (event: Record<string, any>) => void): () => void
  onClose(listener: (error?: Error) => void): () => void
  close(): void
}

export class SocketFrontendClient implements FrontendProtocolClient {
  private readonly socketPath: string
  private readonly pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly listeners = new Set<(event: Record<string, any>) => void>()
  private readonly closeListeners = new Set<(error?: Error) => void>()
  private socket: net.Socket | null = null
  private connecting: Promise<void> | null = null
  private nextId = 1
  private buffer = ""

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async request(method: string, params: Record<string, unknown>): Promise<any> {
    await this.connect()
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket!.write(`${JSON.stringify({ protocolVersion: 1, id, method, params })}\n`)
    })
  }

  onEvent(listener: (event: Record<string, any>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    this.failPending(new Error("frontend socket closed"))
    this.socket?.destroy()
    this.socket = null
  }

  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
      const fail = (error: Error) => {
        this.connecting = null
        reject(error)
      }
      socket.once("error", fail)
      socket.once("connect", () => {
        socket.removeListener("error", fail)
        socket.on("error", (error) => {
          this.failPending(error)
          for (const listener of this.closeListeners) listener(error)
        })
        socket.on("data", (chunk) => this.handleData(chunk.toString("utf8")))
        socket.on("close", () => {
          const error = new Error("frontend socket closed")
          this.failPending(error)
          for (const listener of this.closeListeners) listener(error)
          if (this.socket === socket) this.socket = null
        })
        this.socket = socket
        this.connecting = null
        emitNervesEvent({
          component: "heart",
          event: "heart.frontend_socket_client_connected",
          message: "frontend socket client connected",
        })
        resolve()
      })
    })
    return this.connecting
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let frame: Record<string, any>
      try {
        frame = JSON.parse(line)
      } catch {
        this.failPending(new Error("invalid frontend socket response"))
        continue
      }
      if (typeof frame.id === "string") {
        const pending = this.pending.get(frame.id)
        if (!pending) continue
        this.pending.delete(frame.id)
        if (frame.ok === false) {
          pending.reject(new Error(String(frame.error?.message ?? "frontend request failed")))
        } else {
          pending.resolve(frame.result)
        }
      } else if (typeof frame.event === "string") {
        for (const listener of this.listeners) listener(frame)
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
