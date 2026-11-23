import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { emitNervesEvent } = vi.hoisted(() => ({ emitNervesEvent: vi.fn() }))

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent }))

import { installSenseShutdown, SENSE_SHUTDOWN_GRACE_MS } from "../../senses/sense-shutdown"

function fakeProcess() {
  const emitter = new EventEmitter()
  const exit = vi.fn()
  return {
    emitter,
    exit,
    target: {
      once: emitter.once.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      exit,
    } as unknown as Pick<NodeJS.Process, "once" | "removeListener" | "exit">,
  }
}

function eventNames(): string[] {
  return emitNervesEvent.mock.calls.map(([event]) => (event as { event: string }).event)
}

describe("installSenseShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    emitNervesEvent.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("stops the sense on SIGTERM and exits cleanly once stop resolves", async () => {
    const fake = fakeProcess()
    const stop = vi.fn(async () => undefined)
    installSenseShutdown({ sense: "test-sense", stop, process: fake.target })

    fake.emitter.emit("SIGTERM", "SIGTERM")
    await vi.advanceTimersByTimeAsync(0)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(fake.exit).toHaveBeenCalledWith(0)
    expect(eventNames()).toEqual(["senses.shutdown_started", "senses.shutdown_complete"])
    expect(fake.emitter.listenerCount("SIGTERM")).toBe(0)
    expect(fake.emitter.listenerCount("SIGINT")).toBe(0)
  })

  it("exits after the grace period when stop never finishes", async () => {
    const fake = fakeProcess()
    installSenseShutdown({ sense: "test-sense", stop: () => new Promise(() => undefined), process: fake.target })

    fake.emitter.emit("SIGINT", "SIGINT")
    await vi.advanceTimersByTimeAsync(SENSE_SHUTDOWN_GRACE_MS - 1)
    expect(fake.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fake.exit).toHaveBeenCalledWith(1)
    expect(eventNames()).toContain("senses.shutdown_grace_expired")
  })

  it("exits with a failure when stop throws", async () => {
    const fake = fakeProcess()
    installSenseShutdown({
      sense: "test-sense",
      stop: () => { throw new Error("stop broke") },
      graceMs: 50,
      process: fake.target,
    })

    fake.emitter.emit("SIGTERM", "SIGTERM")
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.exit).toHaveBeenCalledWith(1)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.shutdown_error",
      meta: expect.objectContaining({ error: "stop broke" }),
    }))
  })

  it("reports a non-Error stop failure as text", async () => {
    const fake = fakeProcess()
    installSenseShutdown({
      sense: "test-sense",
      stop: () => Promise.reject("plain failure"),
      graceMs: 50,
      process: fake.target,
    })

    fake.emitter.emit("SIGTERM", "SIGTERM")
    await vi.advanceTimersByTimeAsync(0)

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.shutdown_error",
      meta: expect.objectContaining({ error: "plain failure" }),
    }))
  })

  it("runs stop once when both signals arrive", async () => {
    const fake = fakeProcess()
    const stop = vi.fn(async () => undefined)
    installSenseShutdown({ sense: "test-sense", stop, process: fake.target })

    fake.emitter.emit("SIGTERM", "SIGTERM")
    fake.emitter.emit("SIGINT", "SIGINT")
    await vi.advanceTimersByTimeAsync(0)

    expect(stop).toHaveBeenCalledTimes(1)
    expect(fake.exit).toHaveBeenCalledTimes(1)
  })

  it("can be uninstalled before any signal", () => {
    const fake = fakeProcess()
    const uninstall = installSenseShutdown({ sense: "test-sense", stop: vi.fn(), process: fake.target })

    uninstall()

    expect(fake.emitter.listenerCount("SIGTERM")).toBe(0)
    expect(fake.emitter.listenerCount("SIGINT")).toBe(0)
  })

  it("defaults to the real process", () => {
    const before = process.listenerCount("SIGTERM")
    const uninstall = installSenseShutdown({ sense: "test-sense", stop: vi.fn() })
    expect(process.listenerCount("SIGTERM")).toBe(before + 1)
    uninstall()
    expect(process.listenerCount("SIGTERM")).toBe(before)
  })
})
