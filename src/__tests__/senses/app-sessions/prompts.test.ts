import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type WebSocket from "ws"

import { applyFrame, startPromptTracker } from "../../../senses/app-sessions/prompts"
import { readPending, writePending, type PendingRequest } from "../../../senses/app-sessions/store"

const NOW = Date.parse("2026-11-10T03:00:00Z")
const AT = new Date(NOW).toISOString()
let stateDir: string
let agentRoot: string

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-"))
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-agent-"))
  fs.mkdirSync(path.join(stateDir, "run"))
  fs.writeFileSync(path.join(stateDir, "run", "ws.port"), `51234\n${process.pid}\n`)
  fs.writeFileSync(path.join(stateDir, "run", "ws.token"), "tok\n")
})
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

describe("applying a frame", () => {
  it("records a question with its choices, and a plan with its actions", () => {
    const pending: Record<string, PendingRequest> = {}
    expect(applyFrame(pending, { type: "user_input_request", session_id: "s1", request_id: "q", question: "Which?", choices: ["a", 3], allow_freeform: false }, AT)).toBe(true)
    expect(pending.s1).toEqual({ kind: "input", requestId: "q", at: AT, question: "Which?", choices: ["a"], allowFreeform: false })
    expect(applyFrame(pending, { type: "user_input_request", session_id: "s2", request_id: "q2" }, AT)).toBe(true)
    expect(pending.s2).toEqual({ kind: "input", requestId: "q2", at: AT })
    expect(applyFrame(pending, { type: "exit_plan_mode_request", session_id: "s3", request_id: "p", summary: "Do", actions: ["go", 1] }, AT)).toBe(true)
    expect(pending.s3).toEqual({ kind: "plan", requestId: "p", at: AT, summary: "Do", actions: ["go"] })
    expect(applyFrame(pending, { type: "exit_plan_mode_request", session_id: "s4", request_id: "p4" }, AT)).toBe(true)
  })

  it("drops a request when it is resolved, but not another request's resolution", () => {
    const pending: Record<string, PendingRequest> = { s1: { kind: "input", requestId: "q", at: AT } }
    expect(applyFrame(pending, { type: "user_input_resolved", session_id: "s1", request_id: "other" }, AT)).toBe(false)
    expect(applyFrame(pending, { type: "user_input_resolved", session_id: "s1", request_id: "q" }, AT)).toBe(true)
    expect(pending).toEqual({})
    expect(applyFrame(pending, { type: "exit_plan_mode_resolved", session_id: "s1", request_id: "q" }, AT)).toBe(false)
  })

  it("ignores frames without a session or request, and other kinds", () => {
    expect(applyFrame({}, { type: "user_input_request", request_id: "q" }, AT)).toBe(false)
    expect(applyFrame({}, { type: "user_input_request", session_id: "s1" }, AT)).toBe(false)
    expect(applyFrame({}, { type: "other", session_id: "s1", request_id: "q" }, AT)).toBe(false)
  })
})

describe("the tracker", () => {
  function harness() {
    const sockets: Array<EventEmitter & { close(): void; closed: boolean }> = []
    const retries: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
    return {
      sockets, retries,
      openSocket: (): WebSocket => {
        const socket = Object.assign(new EventEmitter(), { closed: false, close() { this.closed = true } })
        sockets.push(socket)
        return socket as unknown as WebSocket
      },
      schedule: (fn: () => void, ms: number) => {
        const task = { fn, ms, cancelled: false }
        retries.push(task)
        return () => { task.cancelled = true }
      },
    }
  }
  const frame = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value))

  it("records what the app announces, forgets what is resolved, ignores everything else, and keeps old state only for a day", () => {
    writePending(agentRoot, { old: { kind: "input", requestId: "o", at: new Date(NOW - 25 * 3_600_000).toISOString() }, kept: { kind: "input", requestId: "k", at: new Date(NOW - 3_600_000).toISOString() } })
    const h = harness()
    const tracker = startPromptTracker({ agentRoot, stateDir, openSocket: h.openSocket, schedule: h.schedule, now: () => NOW })
    const socket = h.sockets[0]!
    socket.emit("open")
    socket.emit("message", frame({ type: "server_hello" }))
    socket.emit("message", frame('{"type":"user_input_request",broken'))
    socket.emit("message", frame({ type: "user_input_request", session_id: "s1", request_id: "q", question: "Why?" }))
    expect(Object.keys(readPending(agentRoot)).sort()).toEqual(["kept", "s1"])
    socket.emit("message", frame({ type: "user_input_resolved", session_id: "s1", request_id: "q" }))
    expect(Object.keys(readPending(agentRoot))).toEqual(["kept"])
    socket.emit("message", frame({ type: "user_input_resolved", session_id: "none", request_id: "q" }))
    socket.emit("error", new Error("reset"))
    tracker.stop()
    expect(socket.closed).toBe(true)
  })

  it("reconnects with a growing wait after the connection drops, resets it once open, and stops when asked", () => {
    const h = harness()
    const tracker = startPromptTracker({ agentRoot, stateDir, openSocket: h.openSocket, schedule: h.schedule, now: () => NOW })
    h.sockets[0]!.emit("close")
    h.sockets[0]!.emit("close")
    expect(h.retries.map(task => task.ms)).toEqual([1_000])
    h.retries[0]!.fn()
    expect(h.sockets).toHaveLength(2)
    h.sockets[1]!.emit("close")
    expect(h.retries[1]!.ms).toBe(2_000)
    h.retries[1]!.fn()
    h.sockets[2]!.emit("open")
    h.sockets[2]!.emit("close")
    expect(h.retries[2]!.ms).toBe(1_000)
    tracker.stop()
    expect(h.retries[2]!.cancelled).toBe(true)
    h.sockets[2]!.emit("close")
    expect(h.retries).toHaveLength(3)
  })

  it("caps the wait, and retries when the app cannot be reached at all", () => {
    const h = harness()
    fs.rmSync(path.join(stateDir, "run"), { recursive: true })
    const tracker = startPromptTracker({ agentRoot, stateDir, openSocket: h.openSocket, schedule: h.schedule })
    for (let index = 0; index < 6; index += 1) h.retries.at(-1)!.fn()
    expect(h.retries.map(task => task.ms)).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000])
    expect(h.sockets).toHaveLength(0)
    tracker.stop()
  })

  it("stops cleanly before it ever connected", () => {
    fs.rmSync(path.join(stateDir, "run"), { recursive: true })
    const h = harness()
    startPromptTracker({ agentRoot, stateDir, openSocket: h.openSocket, schedule: h.schedule }).stop()
    expect(h.retries[0]!.cancelled).toBe(true)
  })

  it("uses a real socket and timer by default", async () => {
    fs.writeFileSync(path.join(stateDir, "run", "ws.port"), "1\n1\n")
    const tracker = startPromptTracker({ agentRoot, stateDir })
    startPromptTracker({ agentRoot, schedule: () => () => {}, openSocket: () => new EventEmitter() as unknown as WebSocket }).stop()
    await new Promise(resolve => setTimeout(resolve, 100))
    tracker.stop()
  })
})
