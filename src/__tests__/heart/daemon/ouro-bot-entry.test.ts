import { afterEach, describe, expect, it, vi } from "vitest"

describe("ouro.bot entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("invokes wrapper with argv args and emits startup event", async () => {
    vi.resetModules()

    const runOuroBotWrapper = vi.fn(async () => "ok")
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()

    vi.doMock("../../../heart/versioning/ouro-bot-wrapper", () => ({ runOuroBotWrapper }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-bot-entry.js",
      "hatch",
      "--agent",
      "Sprout",
    ])

    await import("../../../heart/daemon/ouro-bot-entry")
    await Promise.resolve()

    expect(runOuroBotWrapper).toHaveBeenCalledWith(["hatch", "--agent", "Sprout"])
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro-bot")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daemon.ouro_bot_entry_start" }),
    )

    argvSpy.mockRestore()
  })

  it("emits error and exits on failure", async () => {
    vi.resetModules()

    const runOuroBotWrapper = vi.fn(async () => {
      throw new Error("fail")
    })
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)

    vi.doMock("../../../heart/versioning/ouro-bot-wrapper", () => ({ runOuroBotWrapper }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-bot-entry.js",
    ])

    await import("../../../heart/daemon/ouro-bot-entry")
    await Promise.resolve()
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daemon.ouro_bot_entry_error" }),
    )
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro-bot")
    expect(exitSpy).toHaveBeenCalledWith(1)

    argvSpy.mockRestore()
  })

  it("handles non-Error rejection values", async () => {
    vi.resetModules()

    const runOuroBotWrapper = vi.fn(async () => {
      throw "string-failure"
    })
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)

    vi.doMock("../../../heart/versioning/ouro-bot-wrapper", () => ({ runOuroBotWrapper }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-bot-entry.js",
      "status",
    ])

    await import("../../../heart/daemon/ouro-bot-entry")
    await Promise.resolve()
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.ouro_bot_entry_error",
        meta: expect.objectContaining({ error: "string-failure" }),
      }),
    )
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro-bot")
    expect(exitSpy).toHaveBeenCalledWith(1)

    argvSpy.mockRestore()
  })
})
