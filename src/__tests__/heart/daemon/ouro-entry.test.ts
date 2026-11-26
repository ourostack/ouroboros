import { afterEach, describe, expect, it, vi } from "vitest"

describe("ouro CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("keeps owner administration machine-scoped before owner validation", async () => {
    vi.resetModules()
    const runOuroCli = vi.fn(async () => "ok")
    const emitNervesEvent = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "ouro-entry.js", "shepherd", "status", "--agent", "missing"])
    await import("../../../heart/daemon/ouro-entry")
    await vi.dynamicImportSettled()
    await Promise.resolve()
    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("ouro", { machine: true })
    expect(runOuroCli).toHaveBeenCalledWith(["shepherd", "status", "--agent", "missing"])
  })

  it("refuses a command other people see without --why, and runs nothing", async () => {
    vi.resetModules()
    const runOuroCli = vi.fn(async () => "ok")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "ouro-entry.js", "msg", "--to", "inbox-agent", "hello"])
    const exitCode = process.exitCode
    await import("../../../heart/daemon/ouro-entry")
    await vi.dynamicImportSettled()
    await Promise.resolve()
    expect(runOuroCli).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("needs --why"))
    // The line ends with the code the command's Ouro AX card names, so an agent can find its fix.
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/ \(code: needs-why\)\n$/))
    expect(process.exitCode).toBe(1)
    process.exitCode = exitCode
  })

  it("previews a command other people see under --dry-run, and runs nothing", async () => {
    vi.resetModules()
    const runOuroCli = vi.fn(async () => "ok")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))
    vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "ouro-entry.js",
      "msg",
      "--to",
      "inbox-agent",
      "hello",
      "--why",
      "they asked",
      "--dry-run",
    ])
    await import("../../../heart/daemon/ouro-entry")
    await vi.dynamicImportSettled()
    await Promise.resolve()
    expect(runOuroCli).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Other people will see this"))
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
    await vi.dynamicImportSettled()
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
    await vi.dynamicImportSettled()
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

  it("ends a failure that carries a code with that code, and records it", async () => {
    vi.resetModules()
    const runOuroCli = vi.fn(async () => {
      throw Object.assign(new Error("daemon unavailable"), { code: "daemon-down" })
    })
    const emitNervesEvent = vi.fn()
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code as never) as any)
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger: vi.fn() }))
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "ouro-entry.js", "mailbox"])

    await import("../../../heart/daemon/ouro-entry")
    await vi.dynamicImportSettled()
    await Promise.resolve()
    await Promise.resolve()

    expect(stderrSpy).toHaveBeenCalledWith("daemon unavailable (code: daemon-down)\n")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.cli_entry_error",
      meta: { error: "daemon unavailable", code: "daemon-down" },
    }))
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
    await vi.dynamicImportSettled()
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

  it("answers the per-tool hook without loading the CLI", async () => {
    vi.resetModules()
    const runOuroCli = vi.fn(async () => "ok")
    const runPostToolUseHook = vi.fn(async () => "quiet")
    const deps = { stand: "in" }
    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))
    vi.doMock("../../../heart/daemon/hook-post-tool-use", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../../heart/daemon/hook-post-tool-use")>()),
      runPostToolUseHook, defaultPostToolUseDeps: () => deps,
    }))
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "ouro-entry.js", "hook", "post-tool-use", "--agent", "hook-standin"])
    await import("../../../heart/daemon/ouro-entry")
    await vi.dynamicImportSettled()
    expect(runPostToolUseHook).toHaveBeenCalledWith("hook-standin", deps)
    expect(runOuroCli).not.toHaveBeenCalled()
  })
})
