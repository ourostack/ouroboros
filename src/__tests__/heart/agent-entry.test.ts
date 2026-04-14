import { afterEach, describe, expect, it, vi } from "vitest"

describe("agent entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts unified agent runtime when --agent is present", async () => {
    vi.resetModules()

    const startInnerDialogWorker = vi.fn(async () => undefined)
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../senses/inner-dialog-worker", () => ({ startInnerDialogWorker }))
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    expect(configureCliRuntimeLogger).toHaveBeenCalledWith("self")
    await vi.waitFor(() => {
      expect(startInnerDialogWorker).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("fails fast when --agent is missing", async () => {
    vi.resetModules()

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "agent-entry.js"])

    await import("../../heart/agent-entry")
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required --agent"),
      )
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("prints worker startup errors and exits", async () => {
    vi.resetModules()

    const startInnerDialogWorker = vi.fn(async () => {
      throw new Error("worker failed")
    })
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../senses/inner-dialog-worker", () => ({ startInnerDialogWorker }))
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("worker failed")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("stringifies non-Error worker startup failures", async () => {
    vi.resetModules()

    const startInnerDialogWorker = vi.fn(async () => {
      throw "worker string failure"
    })
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../senses/inner-dialog-worker", () => ({ startInnerDialogWorker }))
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("worker string failure")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })
})
