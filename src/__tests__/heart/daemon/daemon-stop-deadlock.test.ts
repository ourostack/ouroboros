import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"

import { OuroDaemon } from "../../../heart/daemon/daemon"
import { setRuntimeLogger } from "../../../nerves/runtime"

vi.mock("fs", { spy: true })

/**
 * Regression test for the daemon.stop deadlock observed live on
 * 2026-04-08:
 *
 *   - alpha.270 ouro up sent daemon.stop to a running alpha.268 daemon
 *     because of a version drift detected by ensureDaemonRunning
 *   - daemon's command handler ran stop()
 *   - stop() awaited server.close()
 *   - server.close() waits for ALL open connections to close
 *   - the calling client's connection was still open — its
 *     flushResponse() was awaiting THIS function call
 *   - DEADLOCK: both processes sat in kevent forever
 *
 * The deadlock was masked for weeks by the half-close behavior in
 * socket-client. Removing client.end() in #303/#334/#339 (to fix
 * agent.senseTurn dropping its long-running response) exposed it.
 *
 * Fix: stop() must NOT await server.close(). Fire it and let it
 * complete asynchronously after the command handler returns and
 * flushResponse calls connection.end(response).
 */

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function makeDaemon(
  socketPath: string,
  options?: {
    senseStopAll?: () => Promise<void>
  },
) {
  const processManager = {
    listAgentSnapshots: vi.fn(() => []),
    startAutoStartAgents: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    sendToAgent: vi.fn(),
  }
  const scheduler = {
    listJobs: vi.fn(() => []),
    triggerJob: vi.fn(async () => ({ ok: true, message: "triggered" })),
    reconcile: vi.fn(async () => undefined),
    stop: vi.fn(),
  }
  const healthMonitor = { runChecks: vi.fn(async () => []) }
  const router = {
    send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-04-08T00:00:00.000Z" })),
    pollInbox: vi.fn(() => []),
  }
  const senseManager = {
    startAutoStartSenses: vi.fn(async () => undefined),
    stopAll: vi.fn(options?.senseStopAll ?? (async () => undefined)),
    listSenseRows: vi.fn(() => []),
    listManagedPids: vi.fn(() => []),
  }
  return new OuroDaemon({
    socketPath,
    processManager,
    scheduler,
    healthMonitor,
    router,
    senseManager,
    mode: "dev",
  } as any)
}

async function sendDaemonCommandOverRealSocket(
  socketPath: string,
  command: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ raw: string; endedAt: number }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const client = net.createConnection(socketPath)
    let raw = ""
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error(`daemon.stop did not respond within ${timeoutMs}ms — DEADLOCK regression`))
    }, timeoutMs)

    client.on("connect", () => {
      client.write(JSON.stringify(command) + "\n")
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("end", () => {
      clearTimeout(timer)
      resolve({ raw, endedAt: Date.now() - startedAt })
    })
    client.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function sendDaemonStopOverRealSocket(socketPath: string, timeoutMs: number): Promise<{ raw: string; endedAt: number }> {
  return sendDaemonCommandOverRealSocket(socketPath, { kind: "daemon.stop" }, timeoutMs)
}

describe("daemon.stop deadlock regression", () => {
  let daemons: OuroDaemon[] = []
  let socketPath: string
  let releaseBlockedSenseStop: (() => void) | null = null

  afterEach(async () => {
    releaseBlockedSenseStop?.()
    releaseBlockedSenseStop = null
    setRuntimeLogger(null)
    vi.restoreAllMocks()
    for (const daemon of daemons.reverse()) {
      // Best-effort: if a test left the daemon up, try to stop it.
      try { await daemon.stop() } catch { /* already stopped */ }
    }
    daemons = []
  })

  it("daemon.stop sent over a real socket completes within 2s and does not deadlock", async () => {
    socketPath = tmpSocketPath("daemon-stop-deadlock")
    const daemon = makeDaemon(socketPath)
    daemons.push(daemon)
    await daemon.start()

    // Send daemon.stop and wait for the server to close the connection.
    // With the deadlock present, the server is stuck in `await server.close()`
    // (which is waiting for THIS connection to close), so flushResponse
    // never runs `connection.end(response)`, so the client never sees `end`,
    // so this promise hangs until the timeout fires.
    const result = await sendDaemonStopOverRealSocket(socketPath, 2_000)

    // The connection should have closed cleanly (response may be either an
    // empty close or a valid JSON response — the socket-client treats both
    // as success for daemon.stop).
    expect(result.endedAt).toBeLessThan(2_000)
  })

  it("daemon.stop responds to back-to-back daemon.status + daemon.stop without hanging", async () => {
    // Mirrors the real `ouro up` flow: it sends daemon.status to detect
    // version drift, then daemon.stop to replace the running daemon.
    socketPath = tmpSocketPath("daemon-status-then-stop")
    const daemon = makeDaemon(socketPath)
    daemons.push(daemon)
    await daemon.start()

    // First: status request, completes normally.
    const statusResult = await new Promise<string>((resolve, reject) => {
      const client = net.createConnection(socketPath)
      let raw = ""
      const timer = setTimeout(() => { client.destroy(); reject(new Error("status timeout")) }, 2_000)
      client.on("connect", () => client.write(JSON.stringify({ kind: "daemon.status" }) + "\n"))
      client.on("data", (chunk) => { raw += chunk.toString("utf-8") })
      client.on("end", () => { clearTimeout(timer); resolve(raw) })
      client.on("error", (err) => { clearTimeout(timer); reject(err) })
    })
    expect(statusResult.length).toBeGreaterThan(0)

    // Then: stop request, must not deadlock.
    const stopResult = await sendDaemonStopOverRealSocket(socketPath, 2_000)
    expect(stopResult.endedAt).toBeLessThan(2_000)
  })

  it("removes the socket path when this daemon still owns it during stop", async () => {
    socketPath = tmpSocketPath("daemon-stop-owned-socket")
    const daemon = makeDaemon(socketPath)
    daemons.push(daemon)
    fs.writeFileSync(socketPath, "owned-daemon-socket", "utf-8")
    const stats = fs.lstatSync(socketPath)
    ;(daemon as any).socketIdentity = { dev: stats.dev, ino: stats.ino, ctimeMs: stats.ctimeMs }

    await daemon.stop()

    expect(fs.existsSync(socketPath)).toBe(false)
  })

  it("an older daemon stop path does not unlink a replacement path entry after releasing the original socket", async () => {
    socketPath = tmpSocketPath("daemon-stop-socket-race")

    let markSenseStopBlocked: (() => void) | null = null
    const senseStopBlocked = new Promise<void>((resolve) => {
      markSenseStopBlocked = resolve
    })
    const daemonA = makeDaemon(socketPath, {
      senseStopAll: async () => {
        await new Promise<void>((resolve) => {
          releaseBlockedSenseStop = resolve
          markSenseStopBlocked?.()
        })
      },
    })
    daemons.push(daemonA)
    await daemonA.start()

    const daemonAStop = daemonA.stop()
    await senseStopBlocked

    // The bug is pathname ownership, not socket protocol. While daemon A is
    // still stopping, a newer daemon takes over the pathname; that newer entry
    // must be preserved. Using a plain file makes the race deterministic while
    // still proving the old daemon never deletes a path it no longer owns.
    fs.unlinkSync(socketPath)
    fs.writeFileSync(socketPath, "replacement-daemon-socket", "utf-8")
    expect(fs.existsSync(socketPath)).toBe(true)
    const replacementStats = fs.lstatSync(socketPath)

    const warn = vi.fn()
    setRuntimeLogger({
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    })

    releaseBlockedSenseStop?.()
    releaseBlockedSenseStop = null
    await daemonAStop

    expect(fs.existsSync(socketPath)).toBe(true)
    expect(fs.readFileSync(socketPath, "utf-8")).toBe("replacement-daemon-socket")
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.socket_cleanup_skipped",
      meta: expect.objectContaining({
        socketPath,
        actualDev: replacementStats.dev,
        actualIno: replacementStats.ino,
        actualCtimeMs: replacementStats.ctimeMs,
      }),
    }))
  })

  it("still starts when capturing socket identity throws", async () => {
    socketPath = tmpSocketPath("daemon-start-socket-identity-failure")
    const daemon = makeDaemon(socketPath)
    daemons.push(daemon)

    const originalLstatSync = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation(((targetPath: fs.PathLike, options?: fs.StatOptions & { bigint?: false }) => {
      if (String(targetPath) === socketPath) {
        throw new Error("simulated socket identity read failure")
      }
      return originalLstatSync(targetPath, options)
    }) as typeof fs.lstatSync)

    await daemon.start()

    const statusResult = await sendDaemonCommandOverRealSocket(socketPath, { kind: "daemon.status" }, 2_000)
    expect(statusResult.raw).toContain('"ok":true')
  })
})
