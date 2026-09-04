import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { FrontendSessionService } from "../../../heart/frontend-session-service"
import { withTurnExecutionLease } from "../../../heart/turn-execution-lease"

function socketPath(name: string): string {
  return path.join("/tmp", `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function connect(target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  })
}

function frames(socket: net.Socket): any[] {
  const result: any[] = []
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) result.push(JSON.parse(line))
    }
  })
  return result
}

async function waitForFrame(items: any[], predicate: (frame: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = items.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("frontend frame did not arrive")
}

function sendLegacy(target: string, command: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    let response = ""
    socket.once("connect", () => socket.write(JSON.stringify(command)))
    socket.on("data", (chunk) => { response += chunk.toString("utf8") })
    socket.once("error", reject)
    socket.once("end", () => resolve(JSON.parse(response)))
  })
}

function daemonDeps() {
  return {
    processManager: {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    },
    scheduler: {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async () => ({ ok: true, message: "" })),
      reconcile: vi.fn(async () => undefined),
    },
    healthMonitor: { runChecks: vi.fn(async () => []) },
    router: {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-09-03T00:00:00.000Z" })),
      pollInbox: vi.fn(() => []),
    },
    senseManager: {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    },
    mailboxServerFactory: vi.fn(async () => ({
      origin: "http://127.0.0.1:0",
      broadcast: vi.fn(),
      stop: vi.fn(async () => undefined),
    })),
  }
}

describe("daemon frontend socket integration", () => {
  it("keeps the legacy socket responsive while another client cancels a frontend turn", async () => {
    const turnEntered = Promise.withResolvers<void>()
    const service = new FrontendSessionService({
      runner: async (input) => withTurnExecutionLease(async () => {
        turnEntered.resolve()
        await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }))
        return {
          response: "",
          ponderDeferred: false,
          deliveries: [],
          deliveryFailures: [],
          turnOutcome: "aborted",
        }
      }),
    })
    const { OuroDaemon } = await import("../../../heart/daemon/daemon")
    const commandSocket = socketPath("daemon-frontend-integration")
    const frontendSocket = `${commandSocket}.frontend`
    const bundlesRoot = fs.mkdtempSync(path.join("/tmp", "daemon-frontend-integration-"))
    const daemon = new OuroDaemon({
      socketPath: commandSocket,
      bundlesRoot,
      frontendSessionService: service,
      ...daemonDeps(),
    } as any)

    await daemon.start()
    let first: net.Socket | null = null
    let second: net.Socket | null = null
    try {
      expect(fs.existsSync(frontendSocket)).toBe(true)
      first = await connect(frontendSocket)
      second = await connect(frontendSocket)
      const firstFrames = frames(first)
      const secondFrames = frames(second)
      first.write('{"protocolVersion":1,"id":"sub","method":"session.subscribe","params":{"sessionKey":"session-1"}}\n')
      await waitForFrame(firstFrames, (frame) => frame.id === "sub")
      first.write('{"protocolVersion":1,"id":"start","method":"turn.start","params":{"turnId":"turn-1","agent":"boss","friendId":"friend-1","channel":"mcp","sessionKey":"session-1","message":"hello"}}\n')
      await turnEntered.promise

      await expect(sendLegacy(commandSocket, { kind: "daemon.status" })).resolves.toMatchObject({ ok: true })
      second.write('{"protocolVersion":1,"id":"cancel","method":"turn.cancel","params":{"turnId":"turn-1"}}\n')
      await waitForFrame(secondFrames, (frame) => frame.id === "cancel")
      await waitForFrame(firstFrames, (frame) => frame.event === "turn.cancelled")
    } finally {
      first?.destroy()
      second?.destroy()
      await daemon.stop()
      fs.rmSync(bundlesRoot, { recursive: true, force: true })
    }
    expect(fs.existsSync(commandSocket)).toBe(false)
    expect(fs.existsSync(frontendSocket)).toBe(false)
  })
})
