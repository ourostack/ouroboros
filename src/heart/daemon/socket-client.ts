import * as fs from "fs"
import * as net from "net"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonCommand, DaemonResponse } from "./daemon"

export const DEFAULT_DAEMON_SOCKET_PATH = "/tmp/ouroboros-daemon.sock"

export function sendDaemonCommand(socketPath: string, command: DaemonCommand): Promise<DaemonResponse> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.socket_command_start",
    message: "sending daemon command over socket",
    meta: { socketPath, kind: command.kind },
  })

  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let raw = ""

    client.on("connect", () => {
      client.write(JSON.stringify(command) + "\n")
      client.end()
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("error", (error) => {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.socket_command_error",
        message: "daemon socket command failed",
        meta: {
          socketPath,
          kind: command.kind,
          error: error.message,
        },
      })
      reject(error)
    })
    client.on("end", () => {
      const trimmed = raw.trim()
      if (trimmed.length === 0 && command.kind === "daemon.stop") {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.socket_command_end",
          message: "daemon socket command completed",
          meta: { socketPath, kind: command.kind, ok: true },
        })
        resolve({ ok: true, message: "daemon stopped" })
        return
      }
      if (trimmed.length === 0) {
        const error = new Error("Daemon returned empty response.")
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.socket_command_error",
          message: "daemon socket command returned empty response",
          meta: {
            socketPath,
            kind: command.kind,
            error: error.message,
          },
        })
        reject(error)
        return
      }
      try {
        const parsed = JSON.parse(trimmed) as DaemonResponse
        emitNervesEvent({
          component: "daemon",
          event: "daemon.socket_command_end",
          message: "daemon socket command completed",
          meta: {
            socketPath,
            kind: command.kind,
            ok: parsed.ok,
          },
        })
        resolve(parsed)
      } catch (error) {
        emitNervesEvent({
          level: "error",
          component: "daemon",
          event: "daemon.socket_command_error",
          message: "daemon socket command returned invalid JSON",
          meta: {
            socketPath,
            kind: command.kind,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        reject(error)
      }
    })
  })
}

export function checkDaemonSocketAlive(socketPath: string): Promise<boolean> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.socket_alive_check_start",
    message: "checking daemon socket health",
    meta: { socketPath },
  })

  return new Promise((resolve) => {
    const client = net.createConnection(socketPath)
    let raw = ""
    let done = false

    const finalize = (alive: boolean) => {
      if (done) return
      done = true
      emitNervesEvent({
        component: "daemon",
        event: "daemon.socket_alive_check_end",
        message: "daemon socket health check completed",
        meta: { socketPath, alive },
      })
      resolve(alive)
    }

    if ("setTimeout" in client && typeof client.setTimeout === "function") {
      client.setTimeout(800, () => {
        client.destroy()
        finalize(false)
      })
    }

    client.on("connect", () => {
      client.write(JSON.stringify({ kind: "daemon.status" } satisfies DaemonCommand))
      client.end()
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("error", () => finalize(false))
    client.on("end", () => {
      if (raw.trim().length === 0) {
        finalize(false)
        return
      }
      try {
        JSON.parse(raw)
        finalize(true)
      } catch {
        finalize(false)
      }
    })
  })
}

export async function requestInnerWake(
  agent: string,
  socketPath = DEFAULT_DAEMON_SOCKET_PATH,
): Promise<DaemonResponse | null> {
  const socketAvailable = fs.existsSync(socketPath)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.inner_wake_request",
    message: "requesting daemon-managed inner wake",
    meta: {
      agent,
      socketPath,
      socketAvailable,
    },
  })

  if (!socketAvailable) {
    return null
  }

  return sendDaemonCommand(socketPath, { kind: "inner.wake", agent })
}
