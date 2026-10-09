import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import * as nerves from "../../../nerves/runtime"
import { installVoiceProcessGuards } from "../../../senses/voice/process-guards"

function fakeProcess() {
  const proc = new EventEmitter() as unknown as NodeJS.Process
  const exit = vi.fn()
  ;(proc as unknown as { exit: typeof exit }).exit = exit
  return { proc, exit }
}

describe("voice process guards", () => {
  it("logs an unhandled rejection and keeps the process running", () => {
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const { proc, exit } = fakeProcess()
    installVoiceProcessGuards(proc)

    proc.emit("unhandledRejection", new Error("call handler blew up"))
    proc.emit("unhandledRejection", "plain string")

    const logged = events.mock.calls.map(([event]) => event as { event: string; level?: string; meta?: Record<string, string> })
    expect(logged.filter((event) => event.event === "senses.voice_process_error")).toHaveLength(2)
    expect(logged[0]!.level).toBe("error")
    expect(logged[0]!.meta).toMatchObject({ kind: "unhandledRejection" })
    expect(logged[0]!.meta!.error).toContain("call handler blew up")
    expect(logged[1]!.meta!.error).toBe("plain string")
    expect(exit).not.toHaveBeenCalled()
    events.mockRestore()
  })

  it("logs an uncaught exception and keeps the process running", () => {
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const { proc, exit } = fakeProcess()
    installVoiceProcessGuards(proc)

    proc.emit("uncaughtException", new Error("socket exploded"))

    const logged = events.mock.calls.map(([event]) => event as { event: string; meta?: Record<string, string> })
    expect(logged).toContainEqual(expect.objectContaining({
      event: "senses.voice_process_error",
      meta: expect.objectContaining({ kind: "uncaughtException" }),
    }))
    expect(exit).not.toHaveBeenCalled()
    events.mockRestore()
  })

  it("logs the message when an error has no stack", () => {
    const events = vi.spyOn(nerves, "emitNervesEvent")
    const { proc } = fakeProcess()
    installVoiceProcessGuards(proc)
    const error = new Error("stackless")
    delete error.stack

    proc.emit("uncaughtException", error)

    const logged = events.mock.calls.map(([event]) => event as { meta?: Record<string, string> })
    expect(logged[0]!.meta!.error).toBe("stackless")
    events.mockRestore()
  })

  it("exits for a supervisor restart once more than the budget of uncaught exceptions land inside the window", () => {
    const { proc, exit } = fakeProcess()
    let now = 0
    installVoiceProcessGuards(proc, { limit: 3, windowMs: 1000, exit, now: () => now })

    for (let i = 0; i < 3; i++) {
      now += 100
      proc.emit("uncaughtException", new Error(`boom ${i}`))
    }
    expect(exit).not.toHaveBeenCalled()
    now += 100
    proc.emit("uncaughtException", new Error("boom 3"))
    expect(exit).toHaveBeenCalledWith(1)
  })

  it("forgets uncaught exceptions that fall outside the window", () => {
    const { proc, exit } = fakeProcess()
    let now = 0
    installVoiceProcessGuards(proc, { limit: 2, windowMs: 1000, exit, now: () => now })

    for (let i = 0; i < 10; i++) {
      now += 600
      proc.emit("uncaughtException", new Error(`slow ${i}`))
    }
    expect(exit).not.toHaveBeenCalled()
  })

  it("defaults to five exceptions per minute and process.exit", () => {
    const { proc, exit } = fakeProcess()
    installVoiceProcessGuards(proc)
    for (let i = 0; i < 6; i++) proc.emit("uncaughtException", new Error(`d${i}`))
    expect(exit).toHaveBeenCalledWith(1)
  })
})
