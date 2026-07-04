import { afterEach, describe, expect, it, vi } from "vitest"

function runtimeCredentialMock(overrides: Record<string, unknown> = {}) {
  return {
    waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
    readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
    readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
    refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    refreshMachineRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    ...overrides,
  }
}

function mockWorkerModules(startPrivateRuntimeWorker = vi.fn(async () => undefined)) {
  const startLegacyWorker = vi.fn(async () => undefined)
  vi.doMock("../../senses/private-runtime-worker", () => ({ startPrivateRuntimeWorker }))
  vi.doMock("../../senses/inner-dialog-worker", () => ({ startInnerDialogWorker: startLegacyWorker }))
  return { startPrivateRuntimeWorker, startLegacyWorker }
}

describe("agent entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the canonical private-runtime worker instead of the legacy worker shim", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("starts unified agent runtime when --agent is present", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    expect(configureCliRuntimeLogger).toHaveBeenCalledWith("self")
    await vi.waitFor(() => {
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("continues startup when runtime config refresh is unavailable", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault locked")
    })
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("starts unified agent runtime without waiting for runtime config refresh", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(() => new Promise(() => undefined))
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("accepts daemon runtime bootstrap before starting work", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    const refreshMachineRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    const waitForRuntimeCredentialBootstrap = vi.fn(async () => true)
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      waitForRuntimeCredentialBootstrap,
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/config", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      refreshRuntimeCredentialConfig,
      refreshMachineRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(waitForRuntimeCredentialBootstrap).toHaveBeenCalledWith("slugger")
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    expect(refreshRuntimeCredentialConfig).not.toHaveBeenCalled()
    expect(refreshMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
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

    const startPrivateRuntimeWorker = vi.fn(async () => {
      throw new Error("worker failed")
    })
    mockWorkerModules(startPrivateRuntimeWorker)
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

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

    const startPrivateRuntimeWorker = vi.fn(async () => {
      throw "worker string failure"
    })
    mockWorkerModules(startPrivateRuntimeWorker)
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

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
