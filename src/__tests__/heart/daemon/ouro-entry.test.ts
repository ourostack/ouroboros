import { afterEach, describe, expect, it, vi } from "vitest"

describe("ouro CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("invokes runOuroCli with argv args and emits startup event", async () => {
    vi.resetModules()

    const runOuroCli = vi.fn(async () => "ok")
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()

    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-entry.js",
      "status",
    ])

    await import("../../../heart/daemon/ouro-entry")
    await Promise.resolve()

    expect(runOuroCli).toHaveBeenCalledWith(["status"])
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro")
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daemon.cli_entry_start" }),
    )

    argvSpy.mockRestore()
  })

  it("emits error and exits on failure", async () => {
    vi.resetModules()

    const runOuroCli = vi.fn(async () => {
      throw new Error("fail")
    })
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-entry.js",
      "status",
    ])

    await import("../../../heart/daemon/ouro-entry")
    await Promise.resolve()
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "daemon.cli_entry_error" }),
    )
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro")
    expect(stderrSpy).toHaveBeenCalledWith("fail\n")
    expect(exitSpy).toHaveBeenCalledWith(1)

    argvSpy.mockRestore()
  })

  it("handles non-Error rejection values", async () => {
    vi.resetModules()

    const runOuroCli = vi.fn(async () => {
      throw "string-failure"
    })
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-entry.js",
      "status",
    ])

    await import("../../../heart/daemon/ouro-entry")
    await Promise.resolve()
    await Promise.resolve()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "daemon.cli_entry_error",
        meta: expect.objectContaining({ error: "string-failure" }),
      }),
    )
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro")
    expect(stderrSpy).toHaveBeenCalledWith("string-failure\n")
    expect(exitSpy).toHaveBeenCalledWith(1)

    argvSpy.mockRestore()
  })
})
