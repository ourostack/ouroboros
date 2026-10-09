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
})
