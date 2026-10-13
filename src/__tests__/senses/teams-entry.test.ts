import { afterEach, describe, expect, it, vi } from "vitest"

describe("teams entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the Teams sense when --agent is present", async () => {
    vi.resetModules()

    const startTeamsApp = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    vi.doMock("../../senses/teams", () => ({ startTeamsApp }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "teams-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/teams-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(startTeamsApp).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("continues startup when runtime config refresh is unavailable", async () => {
    vi.resetModules()

    const startTeamsApp = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault locked")
    })
    vi.doMock("../../senses/teams", () => ({ startTeamsApp }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "teams-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/teams-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(startTeamsApp).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("waits for the bot's credentials before starting, and skips the vault when they are already loaded", async () => {
    vi.resetModules()

    const startTeamsApp = vi.fn()
    let loaded: (() => void) | undefined
    const refreshRuntimeCredentialConfig = vi.fn(() => new Promise<void>((resolve) => { loaded = resolve }))
    const runtime = {
      waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
      refreshRuntimeCredentialConfig,
    }
    vi.doMock("../../senses/teams", () => ({ startTeamsApp }))
    vi.doMock("../../heart/runtime-credentials", () => runtime)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "teams-entry.js", "--agent", "slugger"])

    await import("../../senses/teams-entry")
    await vi.waitFor(() => expect(refreshRuntimeCredentialConfig).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(startTeamsApp).not.toHaveBeenCalled()
    loaded!()
    await vi.waitFor(() => expect(startTeamsApp).toHaveBeenCalledTimes(1))

    for (const ready of [{ bootstrapped: true, cached: false }, { bootstrapped: false, cached: true }]) {
      vi.resetModules()
      startTeamsApp.mockClear()
      refreshRuntimeCredentialConfig.mockClear()
      runtime.waitForRuntimeCredentialBootstrap.mockResolvedValue(ready.bootstrapped)
      runtime.readRuntimeCredentialConfig.mockReturnValue(ready.cached ? { ok: true } as never : { ok: false, reason: "missing" })
      vi.doMock("../../senses/teams", () => ({ startTeamsApp }))
      vi.doMock("../../heart/runtime-credentials", () => runtime)
      await import("../../senses/teams-entry")
      await vi.waitFor(() => expect(startTeamsApp).toHaveBeenCalledTimes(1))
      expect(refreshRuntimeCredentialConfig).not.toHaveBeenCalled()
    }
    argvSpy.mockRestore()
  })

  it("fails fast when --agent is missing", async () => {
    vi.resetModules()

    vi.doMock("../../senses/teams", () => ({ startTeamsApp: vi.fn() }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "teams-entry.js"])

    await import("../../senses/teams-entry")
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

  it("prints Teams startup errors and exits", async () => {
    vi.resetModules()

    const startTeamsApp = vi.fn(() => {
      throw new Error("teams failed")
    })
    vi.doMock("../../senses/teams", () => ({ startTeamsApp }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "teams-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/teams-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("teams failed")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("stringifies non-Error Teams startup failures", async () => {
    vi.resetModules()

    const startTeamsApp = vi.fn(() => {
      throw "teams string failure"
    })
    vi.doMock("../../senses/teams", () => ({ startTeamsApp }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "teams-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/teams-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("teams string failure")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })
})
