import { afterEach, describe, expect, it, vi } from "vitest"

describe("bluebubbles entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the BlueBubbles sense when --agent is present", async () => {
    vi.resetModules()

    const startBlueBubblesApp = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")

    expect(configureDaemonRuntimeLogger).toHaveBeenCalledWith("bluebubbles")
    await vi.waitFor(() => {
      expect(startBlueBubblesApp).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("fails fast when --agent is missing", async () => {
    vi.resetModules()

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
    ])

    await import("../../../senses/bluebubbles/entry")
    await Promise.resolve()

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Missing required --agent"),
    )

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })
})
