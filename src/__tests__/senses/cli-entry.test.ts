import { afterEach, describe, expect, it, vi } from "vitest"

describe("cli entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the CLI sense when --agent is present", async () => {
    vi.resetModules()

    const main = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    vi.doMock("../../senses/cli", () => ({ main }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "cli-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/cli-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(main).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("continues startup when runtime config refresh is unavailable", async () => {
    vi.resetModules()

    const main = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault locked")
    })
    vi.doMock("../../senses/cli", () => ({ main }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "cli-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/cli-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(main).toHaveBeenCalledTimes(1)
    })
    argvSpy.mockRestore()
  })

  it("fails fast when --agent is missing", async () => {
    vi.resetModules()

    vi.doMock("../../senses/cli", () => ({ main: vi.fn() }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "cli-entry.js"])

    await import("../../senses/cli-entry")
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

  it("prints CLI startup errors and exits", async () => {
    vi.resetModules()

    const main = vi.fn(() => {
      throw new Error("cli failed")
    })
    vi.doMock("../../senses/cli", () => ({ main }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "cli-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/cli-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("cli failed")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("stringifies non-Error CLI startup failures", async () => {
    vi.resetModules()

    const main = vi.fn(() => {
      throw "cli string failure"
    })
    vi.doMock("../../senses/cli", () => ({ main }))
    vi.doMock("../../heart/runtime-credentials", () => ({
      refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    }))

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "cli-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../senses/cli-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("cli string failure")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })
})
