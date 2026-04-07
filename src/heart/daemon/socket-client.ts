import * as fs from "fs"
import * as net from "net"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonCommand, DaemonResponse } from "./daemon"

export const DEFAULT_DAEMON_SOCKET_PATH = "/tmp/ouroboros-daemon.sock"

/**
 * Defense-in-depth: detect if we're running under vitest. Tests that forget
 * to `vi.mock("../../heart/daemon/socket-client")` would otherwise leak real
 * `inner.wake` commands (with whatever literal agent name the test uses,
 * commonly "testagent") into whichever real daemon happens to be running on
 * the developer's machine. That has caused real outages when test loops
 * flooded the production-on-localhost daemon.
 *
 * We detect vitest via `process.argv` (not env vars — the project bans those)
 * and convert all socket operations into safe no-ops. Individual tests are
 * still expected to vi.mock this module so they can assert on call counts,
 * but this guard guarantees that "I forgot to mock" can never again take
 * down the daemon.
 *
 * The socket-client's OWN tests (which exercise the real functions against a
 * test socket) call `__bypassVitestGuardForTests(true)` to opt out of the
 * guard. We persist that flag on globalThis so it survives `vi.resetModules`
 * (which clears the module cache between tests).
 */
const BYPASS_KEY = "__ouro_socket_client_bypass_vitest_guard__"

/** ONLY for socket-client.test.ts. Do not call from any other test or production code. */
export function __bypassVitestGuardForTests(bypass: boolean): void {
  ;(globalThis as Record<string, unknown>)[BYPASS_KEY] = bypass
}

function isUnderVitest(): boolean {
  if ((globalThis as Record<string, unknown>)[BYPASS_KEY] === true) return false
  /* v8 ignore next -- defensive: process and process.argv always exist in node @preserve */
  if (typeof process === "undefined" || !Array.isArray(process.argv)) return false
  return process.argv.some((arg) => typeof arg === "string" && arg.includes("vitest"))
}

export function sendDaemonCommand(socketPath: string, command: DaemonCommand): Promise<DaemonResponse> {
  if (isUnderVitest()) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.socket_command_test_blocked",
      message: "blocked socket command from leaking into real daemon under vitest",
      meta: { socketPath, kind: command.kind },
    })
    return Promise.resolve({ ok: true, message: "test mode: socket call suppressed" })
  }

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
  if (isUnderVitest()) {
    return Promise.resolve(false)
  }

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
  if (isUnderVitest()) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.inner_wake_test_blocked",
      message: "blocked inner wake from leaking into real daemon under vitest",
      meta: { agent, socketPath },
    })
    return null
  }

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
