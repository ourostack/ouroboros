import { randomUUID } from "node:crypto"
import * as net from "node:net"
import { shepherdRepairHint, type CmuxConnection } from "../../heart/shepherd-config"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * A small client for cmux's documented control socket (docs/cli-contract.md, docs/events.md):
 * one newline-terminated request per line, `auth <password>` first in password mode, and the
 * `_cmux_capability_v1 <token> ` envelope on every line when a capability token is used. Each
 * call opens its own connection, so a slow answer can never be mistaken for the next request's.
 */
export type CmuxErrorCode = "auth" | "unavailable" | "timeout" | "protocol" | "command_failed" | string

export class CmuxSocketError extends Error {
  constructor(readonly code: CmuxErrorCode, message: string) {
    super(message)
    this.name = "CmuxSocketError"
  }
}

export interface CmuxStreamHandlers {
  onFrame: (frame: Record<string, unknown>) => void
  /** Called exactly once: `undefined` for a clean close, an error otherwise. */
  onClose: (error?: CmuxSocketError) => void
}

export interface CmuxClient {
  call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  command: (line: string) => Promise<string>
  stream: (params: Record<string, unknown>, handlers: CmuxStreamHandlers) => { close: () => void }
}

const ACCESS_REFUSED = /access denied|authentication required|invalid password|not authorized|unauthori[sz]ed/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

export function createCmuxClient(
  connection: CmuxConnection,
  options: { timeoutMs?: number; agentName?: string } = {},
): CmuxClient {
  const timeoutMs = options.timeoutMs ?? 5_000
  const repair = shepherdRepairHint(options.agentName ?? "<agent>")

  const wrap = (line: string): string => connection.auth.kind === "capability"
    ? `_cmux_capability_v1 ${connection.auth.token} ${line}`
    : line

  const refusal = (text: string): CmuxSocketError | null => text.startsWith("ERROR:") && ACCESS_REFUSED.test(text)
    ? new CmuxSocketError("auth", `cmux refused the socket connection (${text.slice(0, 200)}); ${repair}`)
    : null

  const connectError = (error: NodeJS.ErrnoException): CmuxSocketError => new CmuxSocketError(
    "unavailable",
    `cmux socket is not reachable at ${connection.socketPath} (${String(error.code)}); is cmux running?`,
  )

  /** Opens a connection, runs the password handshake when needed, and hands back a line reader. */
  function open(onLine: (line: string) => void, onEnd: (error?: CmuxSocketError) => void): Promise<net.Socket> {
    return new Promise((resolve) => {
      const socket = net.createConnection(connection.socketPath)
      let buffer = ""
      let handshake = connection.auth.kind === "password"
      socket.setEncoding("utf-8")
      socket.on("error", (error: NodeJS.ErrnoException) => onEnd(connectError(error)))
      socket.on("close", () => onEnd())
      socket.on("data", (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf("\n")
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf("\n")
          if (!line) continue
          if (handshake) {
            handshake = false
            if (line.startsWith("ERROR:") && !line.includes("Unknown command 'auth'")) {
              socket.destroy()
              onEnd(new CmuxSocketError("auth", `cmux rejected the socket password (${line.slice(0, 200)}); ${repair}`))
              continue
            }
            resolve(socket)
            continue
          }
          onLine(line)
        }
      })
      socket.on("connect", () => {
        if (connection.auth.kind === "password") socket.write(`auth ${connection.auth.password}\n`)
        else resolve(socket)
      })
    })
  }

  function request(line: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      let socket: net.Socket | null = null
      const finish = (error: CmuxSocketError | null, value?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket?.destroy()
        if (error) reject(error)
        else resolve(value!)
      }
      const timer = setTimeout(() => finish(new CmuxSocketError("timeout", `cmux did not answer within ${timeoutMs} ms`)), timeoutMs)
      void open(
        (response) => finish(refusal(response), response),
        (error) => finish(error ?? new CmuxSocketError("unavailable", "cmux closed the socket before answering")),
      ).then((opened) => {
        socket = opened
        opened.write(`${wrap(line)}\n`)
      })
    })
  }

  const v2Line = (method: string, params: Record<string, unknown>): string => JSON.stringify({ id: randomUUID(), method, params })

  function parseV2(text: string): Record<string, unknown> {
    const parsed = parseRecord(text)
    if (!parsed) throw new CmuxSocketError(text.startsWith("ERROR:") ? "command_failed" : "protocol", `unexpected cmux response: ${text.slice(0, 200)}`)
    if (parsed.ok === true) return isRecord(parsed.result) ? parsed.result : {}
    const error = isRecord(parsed.error) ? parsed.error : {}
    throw new CmuxSocketError(
      typeof error.code === "string" ? error.code : "error",
      typeof error.message === "string" && error.message ? error.message : "cmux error",
    )
  }

  return {
    async call(method, params = {}) {
      const text = await request(v2Line(method, params))
      const result = parseV2(text)
      emitNervesEvent({ component: "senses", event: "senses.shepherd_call", message: "cmux socket call answered", meta: { method } })
      return result
    },

    async command(line) {
      const text = await request(line)
      if (text.startsWith("ERROR:")) throw new CmuxSocketError("command_failed", text.slice(0, 500))
      return text
    },

    stream(params, handlers) {
      let closed = false
      let socket: net.Socket | null = null
      const end = (error?: CmuxSocketError): void => {
        if (closed) return
        closed = true
        socket?.destroy()
        handlers.onClose(error)
      }
      void open((line) => {
        if (closed) return
        const refused = refusal(line)
        if (refused) return end(refused)
        const frame = parseRecord(line)
        if (!frame) return end(new CmuxSocketError("protocol", `unexpected cmux event frame: ${line.slice(0, 200)}`))
        if (frame.ok === false) {
          try {
            parseV2(line)
          } catch (error) {
            return end(error as CmuxSocketError)
          }
        }
        handlers.onFrame(frame)
      }, end).then((opened) => {
        socket = opened
        if (closed) opened.destroy()
        else opened.write(`${wrap(v2Line("events.stream", params))}\n`)
      })
      return { close: () => end() }
    },
  }
}
