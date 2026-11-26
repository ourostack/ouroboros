import { afterEach, describe, expect, it, vi } from "vitest"
import * as net from "net"
import * as os from "os"
import * as path from "path"

import { MAX_SOCKET_COMMAND_BYTES, OuroDaemon, socketCommandComplete } from "../../../heart/daemon/daemon"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function makeDaemon(socketPath: string) {
  return new OuroDaemon({
    socketPath,
    processManager: {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    },
    scheduler: { listJobs: vi.fn(() => []), triggerJob: vi.fn(async () => ({ ok: true, message: "ok" })), reconcile: vi.fn(async () => undefined) },
    healthMonitor: { runChecks: vi.fn(async () => []) },
    router: { send: vi.fn(async () => ({ id: "m", queuedAt: "x" })), pollInbox: vi.fn(() => []) },
    senseManager: { startAutoStartSenses: vi.fn(async () => undefined), stopAll: vi.fn(async () => undefined), listSenseRows: vi.fn(() => []) },
  } as any)
}

/** Sends the pieces as separate writes, a tick apart, and returns the daemon's whole answer. */
function exchange(socketPath: string, pieces: Buffer[], end = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let answer = ""
    client.on("data", (chunk) => { answer += chunk.toString("utf8") })
    client.on("end", () => resolve(answer))
    client.on("error", reject)
    client.on("connect", async () => {
      for (const piece of pieces) {
        client.write(piece)
        await new Promise((tick) => setTimeout(tick, 20))
      }
      if (end) client.end()
    })
  })
}

describe("daemon socket framing", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reads a command sent in two writes, split inside a UTF-8 character, as one command", async () => {
    const socketPath = tmpSocketPath("daemon-framing-split")
    const daemon = makeDaemon(socketPath)
    const handled = vi.spyOn(daemon, "handleRawPayload")
    await daemon.start()
    try {
      const whole = Buffer.from(`${JSON.stringify({ kind: "daemon.status", note: "é".repeat(6000) })}\n`, "utf8")
      // Cut one byte into a two-byte "é", so the first piece ends mid-character.
      const cut = whole.indexOf(Buffer.from("é", "utf8")) + 1
      const answer = await exchange(socketPath, [whole.subarray(0, cut + 9000), whole.subarray(cut + 9000)])
      expect(JSON.parse(answer).ok).toBe(true)
      expect(handled).toHaveBeenCalledTimes(1)
      expect(handled.mock.calls[0]![0]).toBe(whole.toString("utf8"))
    } finally {
      await daemon.stop()
    }
  })

  it("answers a command without a newline once its JSON is whole, and on end", async () => {
    const socketPath = tmpSocketPath("daemon-framing-bare")
    const daemon = makeDaemon(socketPath)
    await daemon.start()
    try {
      const bare = await exchange(socketPath, [Buffer.from('{"kind":'), Buffer.from('"daemon.status"}')])
      expect(JSON.parse(bare).ok).toBe(true)
      const ended = await exchange(socketPath, [Buffer.from('{"kind":"daemon.status"')], true)
      expect(JSON.parse(ended).ok).toBe(false)
    } finally {
      await daemon.stop()
    }
  })

  it("refuses a command over the size cap without reading it on", async () => {
    const socketPath = tmpSocketPath("daemon-framing-cap")
    const daemon = makeDaemon(socketPath)
    const handled = vi.spyOn(daemon, "handleRawPayload")
    await daemon.start()
    try {
      const answer = await exchange(socketPath, [Buffer.alloc(MAX_SOCKET_COMMAND_BYTES + 1, "a")])
      expect(JSON.parse(answer)).toEqual({ ok: false, error: `The daemon command is larger than ${MAX_SOCKET_COMMAND_BYTES} bytes.` })
      expect(handled).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })

  it("knows a whole command by its newline or by JSON that parses on its own", () => {
    expect(socketCommandComplete('{"kind":"x"}\n')).toBe(true)
    expect(socketCommandComplete('{"kind":"x"}  ')).toBe(true)
    expect(socketCommandComplete('{"kind":"x"')).toBe(false)
    expect(socketCommandComplete('{"kind":"}')).toBe(false)
    expect(socketCommandComplete("")).toBe(false)
  })
})
