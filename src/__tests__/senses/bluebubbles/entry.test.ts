import { afterEach, describe, expect, it, vi } from "vitest"

function mockMachineIdentity(machineId = "machine_test"): void {
  vi.doMock("../../../heart/machine-identity", () => ({
    loadOrCreateMachineIdentity: vi.fn(() => ({ machineId })),
  }))
}

function mockRuntimeCredentials(overrides: Record<string, unknown> = {}): void {
  vi.doMock("../../../heart/runtime-credentials", () => ({
    waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
    readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
    refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    refreshMachineRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    ...overrides,
  }))
}

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
    mockMachineIdentity()
    mockRuntimeCredentials()

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

  it("continues startup when runtime config refresh is unavailable", async () => {
    vi.resetModules()

    const startBlueBubblesApp = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault locked")
    })
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    mockMachineIdentity()
    mockRuntimeCredentials({
      refreshRuntimeCredentialConfig,
    })

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")

    await vi.waitFor(() => {
      expect(startBlueBubblesApp).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
    })
    argvSpy.mockRestore()
  })

  it("continues startup when machine runtime config refresh is unavailable", async () => {
    vi.resetModules()

    const startBlueBubblesApp = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const refreshMachineRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("machine vault locked")
    })
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    mockMachineIdentity("machine_entry")
    mockRuntimeCredentials({
      refreshMachineRuntimeCredentialConfig,
    })

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")

    await vi.waitFor(() => {
      expect(refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", "machine_entry", { preserveCachedOnFailure: true })
      expect(startBlueBubblesApp).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("waits for machine runtime config before starting when bootstrap is unavailable", async () => {
    vi.resetModules()

    let resolveMachineRefresh: (value: { ok: false; reason: "missing" }) => void = () => undefined
    const startBlueBubblesApp = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const refreshMachineRuntimeCredentialConfig = vi.fn(() => new Promise<{ ok: false; reason: "missing" }>((resolve) => {
      resolveMachineRefresh = resolve
    }))
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    mockMachineIdentity("machine_entry")
    mockRuntimeCredentials({
      refreshMachineRuntimeCredentialConfig,
    })

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")

    await vi.waitFor(() => {
      expect(refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", "machine_entry", { preserveCachedOnFailure: true })
    })
    expect(startBlueBubblesApp).not.toHaveBeenCalled()

    resolveMachineRefresh({ ok: false, reason: "missing" })

    await vi.waitFor(() => {
      expect(startBlueBubblesApp).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("uses daemon-bootstrap machine config without blocking on vault refresh", async () => {
    vi.resetModules()

    const startBlueBubblesApp = vi.fn()
    const configureDaemonRuntimeLogger = vi.fn()
    const waitForRuntimeCredentialBootstrap = vi.fn(async () => true)
    const refreshMachineRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    mockMachineIdentity("machine_entry")
    mockRuntimeCredentials({
      waitForRuntimeCredentialBootstrap,
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, config: { bluebubbles: { serverUrl: "http://localhost", password: "pw" } } })),
      refreshMachineRuntimeCredentialConfig,
    })

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")

    await vi.waitFor(() => {
      expect(waitForRuntimeCredentialBootstrap).toHaveBeenCalledWith("slugger")
      expect(startBlueBubblesApp).toHaveBeenCalledTimes(1)
    })
    expect(refreshMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
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

  it("prints BlueBubbles startup errors and exits", async () => {
    vi.resetModules()

    const startBlueBubblesApp = vi.fn(async () => {
      throw new Error("bluebubbles failed")
    })
    const configureDaemonRuntimeLogger = vi.fn()
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    mockMachineIdentity()
    mockRuntimeCredentials()

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("bluebubbles failed")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("stringifies non-Error BlueBubbles startup failures", async () => {
    vi.resetModules()

    const startBlueBubblesApp = vi.fn(async () => {
      throw "bluebubbles string failure"
    })
    const configureDaemonRuntimeLogger = vi.fn()
    vi.doMock("../../../senses/bluebubbles/index", () => ({ startBlueBubblesApp }))
    vi.doMock("../../../heart/daemon/runtime-logging", () => ({ configureDaemonRuntimeLogger }))
    mockMachineIdentity()
    mockRuntimeCredentials()

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "bluebubbles-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../../senses/bluebubbles/entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("bluebubbles string failure")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })
})
