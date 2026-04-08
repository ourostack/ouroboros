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
 *
 * HARDENING (cross-file leak protection): the bypass flag lives on globalThis
 * and is process-wide. With vitest's default `fileParallelism: true`,
 * concurrently-running test files in the same worker can have the bypass on
 * even though they didn't ask for it — and any test that uses
 * `name: "testagent"` and exercises a code path through this module will
 * leak `inner.wake testagent` to the production daemon socket. We saw this
 * cause a real outage on 2026-04-08 (daemon SIGTERMed mid-validation).
 *
 * Defense: even when the bypass flag is set, we ALWAYS hard-block calls that
 * target the production daemon socket path. Test files that legitimately
 * exercise the real socket-client code paths use a synthetic socket path like
 * `/tmp/daemon.sock` or `/tmp/some-real-daemon.sock` — those keep working.
 * Calls to `/tmp/ouroboros-daemon.sock` (DEFAULT_DAEMON_SOCKET_PATH) under
 * vitest are unconditionally blocked, regardless of bypass state. This makes
 * the cross-file leak vector impossible without restricting legitimate
 * socket-client unit tests.
 */
const BYPASS_KEY = "__ouro_socket_client_bypass_vitest_guard__"

/** ONLY for socket-client.test.ts. Do not call from any other test or production code. */
export function __bypassVitestGuardForTests(bypass: boolean): void {
  ;(globalThis as Record<string, unknown>)[BYPASS_KEY] = bypass
}

function isVitestProcess(): boolean {
  /* v8 ignore next -- defensive: process and process.argv always exist in node @preserve */
  if (typeof process === "undefined" || !Array.isArray(process.argv)) return false
  return process.argv.some((arg) => typeof arg === "string" && arg.includes("vitest"))
}

function isProductionDaemonSocket(socketPath: string): boolean {
  return socketPath === DEFAULT_DAEMON_SOCKET_PATH
}

/**
 * Returns true when this socket call should be converted into a safe no-op
 * because we're under vitest and the call would otherwise leak into a real
 * daemon. The bypass flag short-circuits the guard for non-production socket
 * paths only — production socket paths are ALWAYS blocked under vitest.
 */
function shouldSuppressSocketCall(socketPath: string): boolean {
  if (!isVitestProcess()) return false
  if (isProductionDaemonSocket(socketPath)) return true
  return (globalThis as Record<string, unknown>)[BYPASS_KEY] !== true
}

export function sendDaemonCommand(socketPath: string, command: DaemonCommand): Promise<DaemonResponse> {
  if (shouldSuppressSocketCall(socketPath)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.socket_command_test_blocked",
      message: "blocked socket command from leaking into real daemon under vitest",
      meta: { socketPath, kind: command.kind, isProductionSocket: isProductionDaemonSocket(socketPath) },
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
      // Write the command + newline delimiter. DO NOT call client.end()
      // afterwards — the server closes the connection once it has written
      // its response, which triggers our on("end") handler with the full
      // response in `raw`.
      //
      // Calling client.end() here half-closes the TCP connection. The
      // daemon server uses net.createServer() with the default
      // allowHalfOpen: false, so when the server sees the client's FIN it
      // auto-closes its own writable side — and any response the server
      // tries to write after processing a long-running command (like
      // agent.senseTurn, which runs a full LLM turn) gets dropped on the
      // floor. Verified via repro: with client.end(), agent.senseTurn
      // returns empty in ~149ms; without it, the same call returns the real
      // response in ~5.8s. This is a regression of the fix in #303 that
      // was silently reverted by 253e4b1f (commit titled "socket half-close
      // fix" but actually *added* the half-close back).
      client.write(JSON.stringify(command) + "\n")
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
  if (shouldSuppressSocketCall(socketPath)) {
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
      // Same half-close rationale as sendDaemonCommand: do NOT call
      // client.end() here. The server closes after responding and that
      // triggers the on("end") handler below.
      client.write(JSON.stringify({ kind: "daemon.status" } satisfies DaemonCommand) + "\n")
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
  if (shouldSuppressSocketCall(socketPath)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.inner_wake_test_blocked",
      message: "blocked inner wake from leaking into real daemon under vitest",
      meta: { agent, socketPath, isProductionSocket: isProductionDaemonSocket(socketPath) },
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
