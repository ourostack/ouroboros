import { afterEach, describe, expect, it, vi } from "vitest"

import { runOuroBotWrapper } from "../../../heart/versioning/ouro-bot-wrapper"

describe("ouro.bot wrapper", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unmock("@ouro.bot/cli/runOuroCli")
  })

  it("delegates args to canonical @ouro.bot/cli runner when available", async () => {
    const canonicalRunCli = vi.fn(async () => "wrapped-ok")
    const loadCanonicalRunner = vi.fn(async () => canonicalRunCli)
    const fallbackRunCli = vi.fn(async () => "fallback")
    const writeStdout = vi.fn()

    const result = await runOuroBotWrapper(["hatch"], {
      loadCanonicalRunner,
      fallbackRunCli,
      writeStdout,
    })

    expect(loadCanonicalRunner).toHaveBeenCalledTimes(1)
    expect(canonicalRunCli).toHaveBeenCalledWith(["hatch"])
    expect(fallbackRunCli).not.toHaveBeenCalled()
    expect(writeStdout).toHaveBeenCalledWith("wrapped-ok")
    expect(result).toBe("wrapped-ok")
  })

  it("falls back to local CLI runner when canonical package load fails", async () => {
    const loadCanonicalRunner = vi.fn(async () => {
      throw new Error("module not found")
    })
    const fallbackRunCli = vi.fn(async () => "fallback-ok")
    const writeStdout = vi.fn()

    const result = await runOuroBotWrapper(["status"], {
      loadCanonicalRunner,
      fallbackRunCli,
      writeStdout,
    })

    expect(fallbackRunCli).toHaveBeenCalledWith(["status"])
    expect(writeStdout).toHaveBeenCalledWith("fallback-ok")
    expect(result).toBe("fallback-ok")
  })

  it("handles non-Error canonical loader failures", async () => {
    const loadCanonicalRunner = vi.fn(async () => {
      throw "load-failed-string"
    })
    const fallbackRunCli = vi.fn(async () => "fallback-string")
    const writeStdout = vi.fn()

    const result = await runOuroBotWrapper(["status"], {
      loadCanonicalRunner,
      fallbackRunCli,
      writeStdout,
    })

    expect(fallbackRunCli).toHaveBeenCalledWith(["status"])
    expect(writeStdout).toHaveBeenCalledWith("fallback-string")
    expect(result).toBe("fallback-string")
  })

  it("does not write stdout when the delegated command returns an empty message", async () => {
    const canonicalRunCli = vi.fn(async () => "")
    const writeStdout = vi.fn()

    const result = await runOuroBotWrapper([], {
      loadCanonicalRunner: vi.fn(async () => canonicalRunCli),
      fallbackRunCli: vi.fn(async () => "unused"),
      writeStdout,
    })

    expect(result).toBe("")
    expect(writeStdout).not.toHaveBeenCalled()
  })

  it("uses default canonical loader and falls back when package import fails", async () => {
    vi.resetModules()
    vi.doMock("@ouro.bot/cli/runOuroCli", () => ({
      /* no runOuroCli export — simulates missing/incompatible package */
    }))
    const { runOuroBotWrapper: runWithDefaults } = await import("../../../heart/versioning/ouro-bot-wrapper")
    const fallbackRunCli = vi.fn(async () => "fallback-default")

    const result = await runWithDefaults(["up"], {
      fallbackRunCli,
    })

    expect(fallbackRunCli).toHaveBeenCalledWith(["up"])
    expect(result).toBe("fallback-default")
  })

  it("uses default local runOuroCli fallback when fallbackRunCli is omitted", async () => {
    vi.resetModules()
    const runOuroCli = vi.fn(async () => "default-local-fallback")
    vi.doMock("../../../heart/daemon/daemon-cli", () => ({ runOuroCli }))

    const { runOuroBotWrapper: runWithDefaults } = await import("../../../heart/versioning/ouro-bot-wrapper")
    const result = await runWithDefaults(["status"], {
      loadCanonicalRunner: vi.fn(async () => {
        throw new Error("canonical missing")
      }),
      writeStdout: vi.fn(),
    })

    expect(runOuroCli).toHaveBeenCalledWith(["status"])
    expect(result).toBe("default-local-fallback")
  })

  it("falls back when @ouro.bot/cli/runOuroCli is present but does not export runOuroCli", async () => {
    vi.resetModules()
    vi.doMock("@ouro.bot/cli/runOuroCli", () => ({
      notRunOuroCli: vi.fn(),
    }))

    const { runOuroBotWrapper: runWithDefaults } = await import("../../../heart/versioning/ouro-bot-wrapper")
    const fallbackRunCli = vi.fn(async () => "fallback-no-export")
    const writeStdout = vi.fn()

    const result = await runWithDefaults(["status"], {
      fallbackRunCli,
      writeStdout,
    })

    expect(fallbackRunCli).toHaveBeenCalledWith(["status"])
    expect(writeStdout).toHaveBeenCalledWith("fallback-no-export")
    expect(result).toBe("fallback-no-export")
  })

  it("uses @ouro.bot/cli/runOuroCli export from default loader when available", async () => {
    vi.resetModules()
    const canonicalRunCli = vi.fn(async () => "canonical-default")
    vi.doMock("@ouro.bot/cli/runOuroCli", () => ({
      runOuroCli: canonicalRunCli,
    }))

    const { runOuroBotWrapper: runWithDefaults } = await import("../../../heart/versioning/ouro-bot-wrapper")
    const fallbackRunCli = vi.fn(async () => "unused")
    const writeStdout = vi.fn()

    const result = await runWithDefaults(["chat", "slugger"], {
      fallbackRunCli,
      writeStdout,
    })

    expect(canonicalRunCli).toHaveBeenCalledWith(["chat", "slugger"])
    expect(fallbackRunCli).not.toHaveBeenCalled()
    expect(writeStdout).toHaveBeenCalledWith("canonical-default")
    expect(result).toBe("canonical-default")
  })
})
