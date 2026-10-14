import { afterEach, describe, expect, it, vi } from "vitest"
import { ShepherdComposer, selectShepherdTarget } from "../../../senses/shepherd/composer"
import type { FrontendProtocolClient } from "../../../heart/frontend-socket-client"
import { runShepherdComposer, composerTerminalTty } from "../../../senses/shepherd/composer"
import { PassThrough } from "node:stream"
import * as surface from "../../../senses/shepherd/surface"
import * as frontend from "../../../heart/frontend-socket-client"
import * as readline from "node:readline"
import * as childProcess from "node:child_process"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

vi.mock("node:readline", async original => {
  const actual = await original<typeof import("node:readline")>()
  return { ...actual, createInterface: vi.fn(actual.createInterface) }
})
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

const first = { id: "11111111-1111-4111-8111-111111111111", host: "cmux" as const, label: "Copilot / repo-a / work / tab-a" }
const second = { id: "22222222-2222-4222-8222-222222222222", host: "cmux" as const, label: "Codex / repo-b / work / tab-b" }

function transport() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let event: (frame: Record<string, any>) => void = () => {}
  let closed: (error?: Error) => void = () => {}
  let startError = false
  let status: any = { state: "unknown", events: [] }
  let errorMessage = "ack lost"
  const client: FrontendProtocolClient = {
    async request(method, params) {
      calls.push({ method, params })
      if (method === "turn.start" && startError) throw new Error(errorMessage)
      if (method === "turn.status") return status
      if (method === "turn.cancel") return { cancelled: true }
      if (method === "shepherd.targets") return { targets: [first, second] }
      return { accepted: true }
    },
    onEvent(fn) { event = fn; return () => { event = () => {} } },
    onClose(fn) { closed = fn; return () => { closed = () => {} } },
    close() {},
  }
  return { client, calls, emit: (frame: any) => event(frame), disconnect: () => closed(new Error("disconnected")),
    loseAck: (value: any, message = "ack lost") => { startError = true; status = value; errorMessage = message } }
}

describe("Shepherd composer", () => {
  afterEach(() => vi.restoreAllMocks())
  it("excludes its own terminal TTY instead of capturing focus as the target", () => {
    expect(composerTerminalTty(false)).toBeUndefined()
    vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: "/dev/ttys009\n" } as any)
    expect(composerTerminalTty(true)).toBe("/dev/ttys009")
    expect(childProcess.spawnSync).toHaveBeenCalledWith("/usr/bin/tty", [], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] })
    vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 1, stdout: "not a tty\n" } as any)
    expect(() => composerTerminalTty(true)).toThrow("own terminal")
    vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: undefined } as any)
    expect(() => composerTerminalTty(true)).toThrow("own terminal")
    vi.mocked(childProcess.spawnSync).mockReturnValue({ status: 0, stdout: "untrusted device" } as any)
    expect(() => composerTerminalTty(true)).toThrow("own terminal")
  })
  it("requires a named picker for ambiguity and never treats focus as a target", () => {
    expect(selectShepherdTarget([first, second])).toBeNull()
    expect(selectShepherdTarget([first])).toEqual(first)
    expect(selectShepherdTarget([first, second], second.id)).toEqual(second)
    expect(() => selectShepherdTarget([first], second.id)).toThrow("unavailable")
    expect(() => selectShepherdTarget([])).toThrow("No eligible")
  })

  it("pins the UUID and per-surface key while preserving natural input", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      const wire = transport()
      const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "local-owner", target: first, composerTty: "/dev/ttys009" })
      const sending = composer.submit("  hello coding friend  ")
      await Promise.resolve()
      await Promise.resolve()
      const start = wire.calls.find(call => call.method === "turn.start")!
      expect(start.params).toMatchObject({ agent: "ouro", friendId: "local-owner", channel: "cli",
        sessionKey: `shepherd:${first.id}`, message: "  hello coding friend  ", shepherdSession: { id: first.id } })
      expect(start.params.turnId).toMatch(/^[0-9a-f-]{36}$/)
      expect(start.params.composerTty).toBe("/dev/ttys009")
      wire.emit({ event: "text.delta", turnId: start.params.turnId, sessionKey: `shepherd:${first.id}`, text: "preliminary" })
      wire.emit({ event: "assistant.delivery", turnId: "other", sessionKey: `shepherd:${first.id}`, text: "wrong" })
      wire.emit({ event: "assistant.delivery", turnId: start.params.turnId, sessionKey: "other", text: "wrong" })
      wire.emit({ event: "assistant.delivery", turnId: start.params.turnId, sessionKey: `shepherd:${first.id}`, text: "authoritative" })
      wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: `shepherd:${first.id}`, result: { response: "preliminary plus answer" } })
      await expect(sending).resolves.toBe("authoritative")
      expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_composer_turn_submitted", meta: { agent: "ouro", session: first.id, turnId: start.params.turnId } }))
      expect(JSON.stringify(events)).not.toContain("hello coding friend")
      composer.close()
    } finally { unregister() }
  })

  it("reconciles a lost first acknowledgement from status without resubmitting", async () => {
    const wire = transport()
    wire.loseAck({ state: "completed", events: [
      { type: "assistant_delivery", data: { text: "one authoritative answer" } },
      { type: "turn_completed", data: { result: { response: "not duplicated" } } },
    ] })
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    await expect(composer.submit("@ouro tell me")).resolves.toBe("one authoritative answer")
    expect(wire.calls.filter(call => call.method === "turn.start")).toHaveLength(1)
    expect(wire.calls.find(call => call.method === "turn.start")!.params.message).toBe("tell me")
    expect(wire.calls.find(call => call.method === "turn.status")!.params).toMatchObject({ friendId: "owner", sessionKey: `shepherd:${first.id}` })
    composer.close()
  })

  it("fails plainly when a lost acknowledgement cannot be reconciled", async () => {
    const wire = transport()
    wire.loseAck({ state: "unknown", events: [] })
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    await expect(composer.submit("hello")).rejects.toThrow("unknown")
    await expect(composer.submit("hello again")).rejects.toThrow("active")
    await expect(composer.recover()).rejects.toThrow("unknown")
    expect(wire.calls.filter(call => call.method === "turn.start")).toHaveLength(1)
    composer.close()
  })

  it("preserves the explicit disappearance error instead of silently falling back", async () => {
    const wire = transport()
    wire.loseAck({ state: "unknown", events: [] }, "selected Shepherd terminal is unavailable")
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    await expect(composer.submit("hello")).rejects.toThrow("terminal is unavailable")
    composer.close()
  })

  it("rejects empty input, cancels only its own UUID and accepts a final-only answer", async () => {
    const wire = transport()
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    await expect(composer.cancel()).resolves.toBe(false)
    await expect(composer.submit("@ouro")).rejects.toThrow("empty")
    const pending = composer.submit("hello")
    await Promise.resolve(); await Promise.resolve()
    await expect(composer.submit("another")).rejects.toThrow("active")
    const start = wire.calls.find(call => call.method === "turn.start")!
    await expect(composer.cancel()).resolves.toBe(true)
    expect(wire.calls.find(call => call.method === "turn.cancel")!.params).toEqual({ turnId: start.params.turnId })
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, result: { response: "final-only" } })
    await expect(pending).resolves.toBe("final-only")
    composer.close()
  })

  it("cancels locally during pending subscription and never dispatches the cancelled turn", async () => {
    const wire = transport()
    const subscription = Promise.withResolvers<void>()
    const original = wire.client.request
    wire.client.request = async (method, params) => {
      const result = await original(method, params)
      if (method === "session.subscribe") await subscription.promise
      return method === "turn.cancel" ? { cancelled: false } : result
    }
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("must not dispatch")
    void pending.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    const cancelled = await composer.cancel()
    subscription.resolve()
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")
    if (start) wire.emit({ event: "turn.cancelled", turnId: start.params.turnId, sessionKey: composer.sessionKey })
    await expect(pending).rejects.toThrow("cancelled")
    expect(cancelled).toBe(true)
    expect(wire.calls.filter(call => call.method === "turn.start" || call.method === "turn.cancel")).toEqual([])
    composer.close()
  })

  it("does not dispatch when the composer exits before subscription acknowledges", async () => {
    const wire = transport()
    const subscription = Promise.withResolvers<void>()
    const original = wire.client.request
    wire.client.request = async (method, params) => {
      const result = await original(method, params)
      if (method === "session.subscribe") await subscription.promise
      return result
    }
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("must not dispatch")
    void pending.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    composer.close()
    subscription.resolve()
    await expect(pending).rejects.toThrow("closed")
    expect(wire.calls.filter(call => call.method === "turn.start")).toEqual([])
  })

  it("does not reconcile a newer turn when an earlier cancelled subscription rejects", async () => {
    const wire = transport()
    const subscription = Promise.withResolvers<void>()
    const original = wire.client.request
    let subscriptions = 0
    wire.client.request = async (method, params) => {
      const result = await original(method, params)
      if (method === "session.subscribe" && ++subscriptions === 1) await subscription.promise
      return result
    }
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const cancelled = composer.submit("old turn")
    void cancelled.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    await composer.cancel()
    const current = composer.submit("new turn")
    await new Promise(resolve => setImmediate(resolve))
    subscription.reject(new Error("old subscription failed"))
    await expect(cancelled).rejects.toThrow("cancelled")
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, result: { response: "new answer" } })
    await expect(current).resolves.toBe("new answer")
    expect(wire.calls.filter(call => call.method === "turn.start")).toHaveLength(1)
    expect(wire.calls.filter(call => call.method === "turn.status")).toEqual([])
    composer.close()
  })

  it.each(["disconnect", "replay_required"])("does not apply late %s recovery failure to a newer turn after local cancellation", async event => {
    const wire = transport()
    const subscription = Promise.withResolvers<void>()
    const status = Promise.withResolvers<any>()
    const original = wire.client.request
    let subscriptions = 0
    wire.client.request = async (method, params) => {
      const result = await original(method, params)
      if (method === "session.subscribe" && ++subscriptions === 1) await subscription.promise
      if (method === "turn.status") return status.promise
      return result
    }
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const old = composer.submit("old turn")
    void old.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    if (event === "disconnect") wire.disconnect()
    else wire.emit({ event })
    await new Promise(resolve => setImmediate(resolve))
    await composer.cancel()
    const current = composer.submit("current turn")
    void current.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    status.reject(new Error("old recovery failed"))
    subscription.resolve()
    await expect(old).rejects.toThrow("cancelled")
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, result: { response: "current answer" } })
    await expect(current).resolves.toBe("current answer")
    composer.close()
  })

  it.each(["turn.failed", "turn.cancelled"])("shows terminal failure %s plainly", async event => {
    const wire = transport()
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("hello")
    await Promise.resolve(); await Promise.resolve()
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.emit({ event, turnId: start.params.turnId, sessionKey: composer.sessionKey })
    await expect(pending).rejects.toThrow(/failed|cancelled/)
    composer.close()
  })

  it("replays only unseen authoritative deliveries after a disconnect and still waits for an active turn", async () => {
    const wire = transport()
    wire.loseAck({ state: "active", events: [{ type: "assistant_delivery", sequence: 4, data: { text: "answer" } }] })
    const notices: string[] = []
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first, notice: text => notices.push(text) })
    const pending = composer.submit("hello")
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.disconnect()
    await new Promise(resolve => setImmediate(resolve))
    wire.emit({ event: "assistant.delivery", turnId: start.params.turnId, sessionKey: composer.sessionKey, journalSequence: 4, text: "answer" })
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, result: { response: "final" } })
    await expect(pending).resolves.toBe("answer")
    expect(notices.join("\n")).toContain("disconnected")
    composer.close()
  })

  it("offers named selection then preserves the chosen UUID through subsequent turns", async () => {
    const wire = transport()
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ""
    output.on("data", chunk => { text += chunk.toString() })
    const running = runShepherdComposer({ agent: "ouro", socketPath: "/unused", client: wire.client, input, output, resolveOwner: async () => "owner", composerTty: "/dev/ttys009" })
    await new Promise(resolve => setImmediate(resolve))
    expect(text).toContain(first.label)
    expect(text).toContain(second.label)
    expect(wire.calls.find(call => call.method === "shepherd.targets")!.params.composerTty).toBe("/dev/ttys009")
    input.write("99\n2\nhello\n")
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    expect(start.params.shepherdSession).toEqual(second)
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: `shepherd:${second.id}`, result: { response: "selected answer" } })
    await new Promise(resolve => setImmediate(resolve))
    expect(text).toContain("Ouro: selected answer")
    input.write("/quit\n")
    await running
  })

  it.each(["errored", "aborted"])("does not present a failed final outcome %s as an answer", async outcome => {
    const wire = transport()
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("hello")
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, result: { outcome, response: "not an answer" } })
    await expect(pending).rejects.toThrow(outcome)
    composer.close()
  })

  it("displays an empty final without preliminary text and ignores later events", async () => {
    const wire = transport()
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("hello")
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.emit({ event: "assistant.delivery", turnId: start.params.turnId, sessionKey: composer.sessionKey, text: null })
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey })
    await expect(pending).resolves.toBe("")
    wire.emit({ event: "text.delta", turnId: start.params.turnId, sessionKey: composer.sessionKey, text: "late" })
    await composer.recover()
    composer.close()
  })

  it("recovers overflow through the journal and preserves unresolved identity across another disconnect", async () => {
    const wire = transport()
    const notices: string[] = []
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first, notice: value => notices.push(value) })
    const pending = composer.submit("hello")
    await new Promise(resolve => setImmediate(resolve))
    wire.emit({ event: "replay_required" })
    await expect(pending).rejects.toThrow("unknown")
    wire.disconnect()
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.loseAck({ state: "completed", events: [
      { type: "assistant_delivery", sequence: 3, data: { text: "recovered answer" } },
      { type: "turn_completed", sequence: 4, data: { result: { response: "discarded final" } } },
      { type: "text_delta", sequence: 5, data: { text: "not an answer" } },
    ] })
    await composer.recover()
    expect(notices.join("\n")).toContain("Ouro: recovered answer")
    expect(wire.calls.filter(call => call.method === "turn.start")).toHaveLength(1)
    expect(start.params.turnId).toMatch(/^[0-9a-f-]{36}$/)
    composer.close()
  })

  it("ignores a stale recovery response after a final event won the race", async () => {
    const wire = transport()
    const response = Promise.withResolvers<any>()
    const original = wire.client.request
    wire.client.request = (method, params) => method === "turn.status" ? response.promise : original(method, params)
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("hello")
    await new Promise(resolve => setImmediate(resolve))
    const recovery = composer.recover()
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, result: { response: "winner" } })
    response.resolve({ state: "unknown", events: [] })
    await recovery
    await expect(pending).resolves.toBe("winner")
    composer.close()
  })

  it("defers live completion until journal deliveries merge in sequence order without duplicates", async () => {
    const wire = transport()
    const status = Promise.withResolvers<any>()
    const original = wire.client.request
    wire.client.request = (method, params) => method === "turn.status" ? status.promise : original(method, params)
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    let settled = false
    const pending = composer.submit("hello").then(answer => { settled = true; return answer })
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    const recovering = composer.recover()
    await new Promise(resolve => setImmediate(resolve))
    wire.emit({ event: "assistant.delivery", turnId: start.params.turnId, sessionKey: composer.sessionKey,
      journalSequence: 4, text: "second delivery" })
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey,
      journalSequence: 5, result: { response: "final fallback" } })
    await new Promise(resolve => setImmediate(resolve))
    const settledBeforeJournal = settled
    status.resolve({ state: "completed", events: [
      { type: "assistant_delivery", sequence: 4, data: { text: "second delivery" } },
      { type: "assistant_delivery", sequence: 3, data: { text: "first delivery" } },
      { type: "turn_completed", sequence: 5, data: { result: { response: "final fallback" } } },
    ] })
    await recovering
    await expect(pending).resolves.toBe("first delivery\nsecond delivery")
    expect(settledBeforeJournal).toBe(false)
    composer.close()
  })

  it.each(["resolved", "rejected"])("does not reanimate an exited turn when its recovery request is %s", async disposition => {
    const wire = transport()
    wire.loseAck({ state: "active", events: [] })
    const status = Promise.withResolvers<any>()
    const original = wire.client.request
    wire.client.request = (method, params) => method === "turn.status" ? status.promise : original(method, params)
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("hello")
    void pending.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    composer.close()
    if (disposition === "resolved") status.resolve({ state: "completed", events: [] })
    else status.reject(new Error("late recovery failure"))
    await expect(pending).rejects.toThrow("closed")
    expect(wire.calls.filter(call => call.method === "turn.start")).toHaveLength(1)
  })

  it("waits for overlapping journal reconciliations before finalizing the ordered answer", async () => {
    const wire = transport()
    const one = Promise.withResolvers<any>()
    const two = Promise.withResolvers<any>()
    const original = wire.client.request
    let requests = 0
    wire.client.request = (method, params) => method === "turn.status"
      ? (++requests === 1 ? one.promise : two.promise) : original(method, params)
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    let settled = false
    const pending = composer.submit("hello").then(answer => { settled = true; return answer })
    await new Promise(resolve => setImmediate(resolve))
    const recoveryOne = composer.recover().then(() => null, error => error)
    const recoveryTwo = composer.recover()
    await new Promise(resolve => setImmediate(resolve))
    one.resolve({ state: "completed", events: [
      { type: "assistant_delivery", sequence: 4, data: { text: "second" } },
      { type: "turn_completed", sequence: 5, data: { result: { response: "fallback" } } },
    ] })
    const firstResult = await recoveryOne
    const settledBeforeSecondJournal = settled
    two.resolve({ state: "completed", events: [
      { type: "assistant_delivery", sequence: 3, data: { text: "first" } },
      { type: "assistant_delivery", sequence: 4, data: { text: "second" } },
      { type: "turn_completed", sequence: 5, data: { result: { response: "fallback" } } },
    ] })
    await recoveryTwo
    await expect(pending).resolves.toBe("first\nsecond")
    expect(settledBeforeSecondJournal).toBe(false)
    expect(firstResult).toBeNull()
    composer.close()
  })

  it("keeps live completion deferred after a failed journal request until reconciliation succeeds", async () => {
    const wire = transport()
    const status = Promise.withResolvers<any>()
    const original = wire.client.request
    let requests = 0
    wire.client.request = (method, params) => method === "turn.status" && ++requests === 1
      ? status.promise : original(method, params)
    const notices: string[] = []
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first, notice: value => notices.push(value) })
    const pending = composer.submit("hello")
    void pending.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    const start = wire.calls.find(call => call.method === "turn.start")!
    wire.disconnect()
    await new Promise(resolve => setImmediate(resolve))
    wire.emit({ event: "assistant.delivery", turnId: start.params.turnId, sessionKey: composer.sessionKey, journalSequence: 4, text: "second" })
    status.reject(new Error("journal unavailable"))
    await expect(pending).rejects.toThrow("journal unavailable")
    wire.emit({ event: "turn.completed", turnId: start.params.turnId, sessionKey: composer.sessionKey, journalSequence: 5, result: { response: "fallback" } })
    expect(notices.filter(value => value.startsWith("Ouro:"))).toEqual([])
    wire.loseAck({ state: "completed", events: [
      { type: "assistant_delivery", sequence: 3, data: { text: "first" } },
      { type: "assistant_delivery", sequence: 4, data: { text: "second" } },
      { type: "turn_completed", sequence: 5, data: { result: { response: "fallback" } } },
    ] })
    await composer.recover()
    expect(notices.filter(value => value.startsWith("Ouro:"))).toEqual(["Ouro: first\nsecond"])
    composer.close()
  })

  it("reports non-Error transport failures without losing the pinned turn", async () => {
    const wire = transport()
    const original = wire.client.request
    wire.client.request = (method, params) => method === "turn.status" ? Promise.reject("transport string failure") : original(method, params)
    const composer = new ShepherdComposer({ client: wire.client, agent: "ouro", friendId: "owner", target: first })
    const pending = composer.submit("hello")
    await new Promise(resolve => setImmediate(resolve))
    wire.disconnect()
    await expect(pending).rejects.toThrow("transport string failure")
    await expect(composer.submit("again")).rejects.toThrow("active")
    composer.close()
  })

  it("uses default local-owner/socket wiring and explicit target without touching operator streams", async () => {
    const wire = transport()
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ""
    output.on("data", chunk => { text += chunk.toString() })
    vi.spyOn(surface, "localShepherdFriendStore").mockReturnValue({} as any)
    vi.spyOn(surface, "resolveExistingLocalOwner").mockResolvedValue("owner")
    vi.spyOn(frontend, "SocketFrontendClient").mockImplementation(function () { return wire.client } as any)
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as any)
    vi.spyOn(process, "stdout", "get").mockReturnValue(output as any)
    const running = runShepherdComposer({ agent: "ouro", session: first.id, socketPath: "/unused" })
    await new Promise(resolve => setImmediate(resolve))
    input.write("\n/cancel\n/recover\n@ouro\nhello\n")
    await new Promise(resolve => setImmediate(resolve))
    expect(text).toContain("no cancellable turn")
    expect(text).toContain("empty")
    input.write("/cancel\n")
    await new Promise(resolve => setImmediate(resolve))
    expect(text).toContain("cancellation requested")
    input.write("/quit\n")
    await running
  })

  it("closes the unselected picker on an interrupt and disposes its connection", async () => {
    const wire = transport()
    const input = new PassThrough()
    const output = new PassThrough()
    let ui: readline.Interface | undefined
    const create = (await vi.importActual<typeof readline>("node:readline")).createInterface
    vi.spyOn(readline, "createInterface").mockImplementation((...args: any[]) => { ui = (create as any)(...args); return ui! })
    const close = vi.spyOn(wire.client, "close")
    const running = runShepherdComposer({ agent: "ouro", socketPath: "/unused", input, output, client: wire.client, resolveOwner: async () => "owner" })
    await new Promise(resolve => setImmediate(resolve))
    input.write("not a number\n")
    ui!.emit("SIGINT")
    await running
    expect(close).toHaveBeenCalledOnce()
  })

  it("shows command/interrupt/close transport failures instead of touching the coding agent", async () => {
    const wire = transport()
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ""
    let ui: readline.Interface | undefined
    output.on("data", chunk => { text += chunk.toString() })
    const create = (await vi.importActual<typeof readline>("node:readline")).createInterface
    vi.spyOn(readline, "createInterface").mockImplementation((...args: any[]) => { ui = (create as any)(...args); return ui! })
    const original = wire.client.request
    wire.client.request = (method, params) => method === "turn.cancel" || method === "turn.status" ? Promise.reject(new Error("offline")) : original(method, params)
    const running = runShepherdComposer({ agent: "ouro", session: first.id, socketPath: "/unused", input, output, client: wire.client, resolveOwner: async () => "owner" })
    await new Promise(resolve => setImmediate(resolve))
    input.write("hello\n")
    await new Promise(resolve => setImmediate(resolve))
    input.write("/cancel\n/recover\n")
    ui!.emit("SIGINT")
    await new Promise(resolve => setImmediate(resolve))
    expect(text).toContain("offline")
    input.write("/quit\n")
    await running
    expect(text).toContain("disconnected while closing")
  })

  it("handles the process SIGINT used by non-raw readline and removes its own handler on exit", async () => {
    const wire = transport()
    const input = new PassThrough()
    const output = new PassThrough()
    const before = process.listenerCount("SIGINT")
    const running = runShepherdComposer({ agent: "ouro", session: first.id, socketPath: "/unused", input, output, client: wire.client, resolveOwner: async () => "owner" })
    await new Promise(resolve => setImmediate(resolve))
    input.write("hello\n")
    await new Promise(resolve => setImmediate(resolve))
    process.emit("SIGINT")
    await new Promise(resolve => setImmediate(resolve))
    expect(wire.calls.filter(call => call.method === "turn.cancel")).toHaveLength(1)
    input.write("/quit\n")
    await running
    expect(process.listenerCount("SIGINT")).toBe(before)
  })
})
