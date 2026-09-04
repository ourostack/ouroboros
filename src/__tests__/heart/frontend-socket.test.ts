import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RunSenseTurnResult } from "../../senses/shared-turn"

function socketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function settledResult(response = "ok"): RunSenseTurnResult {
  return {
    response,
    ponderDeferred: false,
    deliveries: [],
    deliveryFailures: [],
    turnOutcome: "settled",
  }
}

function connect(target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target)
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  })
}

function collectFrames(socket: net.Socket) {
  const frames: any[] = []
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) frames.push(JSON.parse(line))
    }
  })
  return frames
}

async function waitForFrame(frames: any[], predicate: (frame: any) => boolean): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = frames.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("frontend frame did not arrive")
}

describe("frontend socket", () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()!()
  })

  it("derives a stable frontend path within the Unix socket limit", async () => {
    const { frontendSocketPathForDaemon } = await import("../../heart/frontend-socket")
    expect(frontendSocketPathForDaemon("/tmp/ouro.sock")).toBe("/tmp/ouro.sock.frontend")

    const longCommandPath = path.join(os.tmpdir(), `${"long-".repeat(30)}daemon.sock`)
    const first = frontendSocketPathForDaemon(longCommandPath)
    const second = frontendSocketPathForDaemon(longCommandPath)
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(100)
    expect(first).toBe(second)
    expect(frontendSocketPathForDaemon(`${longCommandPath}-other`)).not.toBe(first)
  })

  it("buffers partial frames and accepts multiple newline-delimited requests", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-frames")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner: async () => settledResult() }),
    })
    cleanup.push(() => server.stop())
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('{"protocolVersion":1,"id":"one","method":"session.subscribe","params":{"sessionKey":"sess')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(frames).toEqual([])
    socket.write('-1"}}\n{"protocolVersion":1,"id":"two","method":"session.unsubscribe","params":{"sessionKey":"sess-1"}}\n')

    await waitForFrame(frames, (frame) => frame.id === "two")
    expect(frames.filter((frame) => frame.id === "one" || frame.id === "two")).toEqual([
      { protocolVersion: 1, id: "one", ok: true, result: { subscribed: true } },
      { protocolVersion: 1, id: "two", ok: true, result: { subscribed: false } },
    ])
    socket.destroy()
  })

  it("starts and cancels an exact turn while publishing its terminal event", async () => {
    const runner = vi.fn(async (input: any) => {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { ...settledResult(""), turnOutcome: "aborted" as const }
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-cancel")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner }),
    })
    cleanup.push(() => server.stop())
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('{"protocolVersion":1,"id":"sub","method":"session.subscribe","params":{"sessionKey":"session-1"}}\n')
    await waitForFrame(frames, (frame) => frame.id === "sub")
    socket.write('{"protocolVersion":1,"id":"start","method":"turn.start","params":{"turnId":"turn-1","agent":"boss","friendId":"friend-1","channel":"mcp","sessionKey":"session-1","message":"hello"}}\n')
    await waitForFrame(frames, (frame) => frame.id === "start")
    socket.write('{"protocolVersion":1,"id":"cancel","method":"turn.cancel","params":{"turnId":"turn-1"}}\n')

    expect(await waitForFrame(frames, (frame) => frame.id === "cancel")).toMatchObject({
      ok: true,
      result: { cancelled: true },
    })
    expect(await waitForFrame(frames, (frame) => frame.event === "turn.cancelled")).toMatchObject({
      protocolVersion: 1,
      event: "turn.cancelled",
      sessionKey: "session-1",
      sequence: 3,
      turnId: "turn-1",
      result: { outcome: "aborted" },
    })
    socket.destroy()
  })

  it("returns typed errors for malformed and unsupported requests", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-errors")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner: async () => settledResult() }),
    })
    cleanup.push(() => server.stop())
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('not-json\n')
    socket.write('[]\n')
    socket.write('{"protocolVersion":2,"id":"version","method":"session.subscribe","params":{"sessionKey":"session-1"}}\n')
    socket.write('{"protocolVersion":1,"id":"unknown","method":"nope","params":{}}\n')
    socket.write('{"protocolVersion":1,"id":"invalid","method":"turn.start","params":{"turnId":""}}\n')
    socket.write('{"protocolVersion":1,"id":7,"method":"session.subscribe"}\n')

    await waitForFrame(frames, (frame) => frame.error?.message === "sessionKey must be a non-empty string")
    expect(frames).toEqual([
      { protocolVersion: 1, id: null, ok: false, error: { code: "parse_error", message: "invalid JSON frame" } },
      { protocolVersion: 1, id: null, ok: false, error: { code: "invalid_params", message: "params must be an object" } },
      { protocolVersion: 1, id: "version", ok: false, error: { code: "unsupported_version", message: "protocolVersion must be 1" } },
      { protocolVersion: 1, id: "unknown", ok: false, error: { code: "method_not_found", message: "unknown frontend method: nope" } },
      { protocolVersion: 1, id: "invalid", ok: false, error: { code: "invalid_params", message: "turnId must be a non-empty string" } },
      { protocolVersion: 1, id: null, ok: false, error: { code: "invalid_params", message: "sessionKey must be a non-empty string" } },
    ])
    socket.destroy()
  })

  it("publishes ordered events only to subscribed sessions", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-publish")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner: async () => settledResult() }),
    })
    cleanup.push(() => server.stop())
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('{"protocolVersion":1,"id":"sub","method":"session.subscribe","params":{"sessionKey":"session-1"}}\n')
    await waitForFrame(frames, (frame) => frame.id === "sub")
    server.publish("other-session", "ignored")
    server.publish("session-1", "snapshot")
    server.publish("session-1", "snapshot", { value: 2 })

    await waitForFrame(frames, (frame) => frame.sequence === 2)
    expect(frames.filter((frame) => frame.event)).toEqual([
      { protocolVersion: 1, event: "snapshot", sessionKey: "session-1", sequence: 1 },
      { protocolVersion: 1, event: "snapshot", sessionKey: "session-1", sequence: 2, value: 2 },
    ])
    socket.destroy()
  })

  it("loads journal history through the framed protocol", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-socket-load-"))
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const journal = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    journal.append({ agent: "boss", friendId: "friend-1", sessionId: "session-1" }, {
      turnId: "turn-1",
      type: "turn_started",
      data: {},
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-load")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner: async () => settledResult(), journal }),
    })
    cleanup.push(async () => {
      await server.stop()
      fs.rmSync(root, { recursive: true, force: true })
    })
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('{"protocolVersion":1,"id":"load","method":"session.load","params":{"agent":"boss","friendId":"friend-1","sessionKey":"session-1","afterSequence":0,"limit":10}}\n')

    expect(await waitForFrame(frames, (frame) => frame.id === "load")).toMatchObject({
      protocolVersion: 1,
      ok: true,
      result: {
        events: [expect.objectContaining({ type: "turn_started", sequence: 1 })],
        lastSequence: 1,
        hasMore: false,
        degraded: false,
      },
    })
    socket.destroy()
  })

  it("publishes failed turns and reports unknown cancellation", async () => {
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockRejectedValueOnce("transport gone")
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-failure")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner }),
    })
    cleanup.push(() => server.stop())
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('{"protocolVersion":1,"id":"sub","method":"session.subscribe","params":{"sessionKey":"session-1"}}\n')
    await waitForFrame(frames, (frame) => frame.id === "sub")
    socket.write('{"protocolVersion":1,"id":"cancel","method":"turn.cancel","params":{"turnId":"missing"}}\n')
    socket.write('{"protocolVersion":1,"id":"one","method":"turn.start","params":{"turnId":"turn-1","agent":"boss","friendId":"friend-1","channel":"mcp","sessionKey":"session-1","message":"hello"}}\n')
    socket.write('{"protocolVersion":1,"id":"two","method":"turn.start","params":{"turnId":"turn-2","agent":"boss","friendId":"friend-1","channel":"mcp","sessionKey":"session-1","message":"hello"}}\n')

    expect(await waitForFrame(frames, (frame) => frame.id === "cancel")).toMatchObject({ result: { cancelled: false } })
    await waitForFrame(frames, (frame) => frame.event === "turn.failed" && frame.turnId === "turn-2")
    expect(frames.filter((frame) => frame.event === "turn.failed")).toEqual([
      { protocolVersion: 1, event: "turn.failed", sessionKey: "session-1", sequence: 3, turnId: "turn-1", journalSequence: null, error: "provider down" },
      { protocolVersion: 1, event: "turn.failed", sessionKey: "session-1", sequence: 6, turnId: "turn-2", journalSequence: null, error: "transport gone" },
    ])
    socket.destroy()
  })

  it("replaces an overflowing event queue with replay-required and closes after drain", async () => {
    class FakeSocket extends EventEmitter {
      writes: string[] = []
      ended = false

      write(chunk: string): boolean {
        this.writes.push(chunk)
        return this.writes.length !== 1
      }

      end(): void {
        this.ended = true
      }
    }

    const { FrontendFrameWriter } = await import("../../heart/frontend-socket")
    const socket = new FakeSocket()
    const writer = new FrontendFrameWriter(socket as any, 1)
    writer.send({ protocolVersion: 1, event: "one", sessionKey: "session-1", sequence: 1 })
    writer.send({ protocolVersion: 1, event: "two", sessionKey: "session-1", sequence: 2 })
    writer.send({ protocolVersion: 1, event: "three", sessionKey: "session-1", sequence: 3 })
    writer.send({ protocolVersion: 1, event: "four", sessionKey: "session-1", sequence: 4 })
    socket.emit("drain")

    expect(socket.writes.map((line) => JSON.parse(line))).toEqual([
      { protocolVersion: 1, event: "one", sessionKey: "session-1", sequence: 1 },
      { protocolVersion: 1, event: "replay_required", lastSequence: 1 },
    ])
    expect(socket.ended).toBe(true)
  })

  it("flushes queued frames across repeated backpressure", async () => {
    class FakeSocket extends EventEmitter {
      writes: string[] = []
      outcomes = [false, false, true]

      write(chunk: string): boolean {
        this.writes.push(chunk)
        return this.outcomes.shift() ?? true
      }

      end(): void {}
    }

    const { FrontendFrameWriter } = await import("../../heart/frontend-socket")
    const socket = new FakeSocket()
    const writer = new FrontendFrameWriter(socket as any, 2)
    writer.send({ protocolVersion: 1, event: "one", sessionKey: "session-1", sequence: 1 })
    writer.send({ protocolVersion: 1, event: "two", sessionKey: "session-1", sequence: 2 })
    socket.emit("drain")
    writer.send({ protocolVersion: 1, event: "three", sessionKey: "session-1", sequence: 3 })
    socket.emit("drain")

    expect(socket.writes.map((line) => JSON.parse(line).event)).toEqual(["one", "two", "three"])
  })

  it("rejects an invalid queue bound and a pre-existing non-socket path", async () => {
    const { FrontendFrameWriter, startFrontendSocketServer } = await import("../../heart/frontend-socket")
    expect(() => new FrontendFrameWriter(new EventEmitter() as any, 0)).toThrow("positive integer")

    const target = socketPath("frontend-not-socket")
    fs.writeFileSync(target, "not a socket")
    cleanup.push(async () => { fs.rmSync(target, { force: true }) })
    await expect(startFrontendSocketServer({
      socketPath: target,
      service: {} as any,
    })).rejects.toThrow("not a socket")
  })

  it("replaces a stale Unix socket and translates a hostile dependency throw", async () => {
    const target = socketPath("frontend-stale-socket")
    const stale = net.createServer()
    await new Promise<void>((resolve, reject) => {
      stale.once("error", reject)
      stale.listen(target, resolve)
    })
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: {
        subscribe: () => () => undefined,
        cancelTurn: () => { throw "hostile failure" },
      } as any,
    })
    cleanup.push(async () => {
      await server.stop()
      await new Promise<void>((resolve) => stale.close(() => resolve()))
    })
    const socket = await connect(target)
    const frames = collectFrames(socket)

    socket.write('{"protocolVersion":1,"id":"cancel","method":"turn.cancel","params":{"turnId":"turn-1"}}\n')

    expect(await waitForFrame(frames, (frame) => frame.id === "cancel")).toEqual({
      protocolVersion: 1,
      id: "cancel",
      ok: false,
      error: { code: "invalid_params", message: "hostile failure" },
    })
    socket.destroy()
  })

  it("removes its Unix socket on stop", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const { startFrontendSocketServer } = await import("../../heart/frontend-socket")
    const target = socketPath("frontend-stop")
    const server = await startFrontendSocketServer({
      socketPath: target,
      service: new FrontendSessionService({ runner: async () => settledResult() }),
    })

    expect(fs.existsSync(target)).toBe(true)
    await server.stop()
    expect(fs.existsSync(target)).toBe(false)
    await expect(server.stop()).resolves.toBeUndefined()
  })
})
