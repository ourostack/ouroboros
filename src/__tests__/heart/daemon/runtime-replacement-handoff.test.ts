import { describe, expect, it, vi } from "vitest"

import {
  handOffDaemonRuntimeReplacement,
  isInsideDaemonLaunchdJob,
  isRuntimeReplacementStranded,
  runtimeReplacementMarkerPath,
  STRANDED_REPLACEMENT_AFTER_MS,
  type RuntimeReplacementHandoffDeps,
} from "../../../heart/daemon/runtime-replacement-handoff"

function makeDeps(overrides: Partial<RuntimeReplacementHandoffDeps> = {}) {
  const child = { pid: 4242, unref: vi.fn() }
  const deps: RuntimeReplacementHandoffDeps = {
    platform: "darwin",
    env: { XPC_SERVICE_NAME: "bot.ouro.daemon", PATH: "/usr/bin", HOME: "/Users/fixture" },
    execPath: "/fixture/node",
    entryPath: "/fixture/ouro-entry.js",
    logPath: "/fixture/.ouro-cli/daemon/logs/runtime-replacement-helper.log",
    openLog: vi.fn(() => 17),
    spawn: vi.fn(() => child),
    ...overrides,
  }
  return { deps, child }
}

describe("isInsideDaemonLaunchdJob", () => {
  it("is true only on macOS when launchd's job label is the daemon's", () => {
    expect(isInsideDaemonLaunchdJob({ XPC_SERVICE_NAME: "bot.ouro.daemon" }, "darwin")).toBe(true)
    expect(isInsideDaemonLaunchdJob({ XPC_SERVICE_NAME: "bot.ouro.updater" }, "darwin")).toBe(false)
    expect(isInsideDaemonLaunchdJob({ XPC_SERVICE_NAME: "0" }, "darwin")).toBe(false)
    expect(isInsideDaemonLaunchdJob({}, "darwin")).toBe(false)
    expect(isInsideDaemonLaunchdJob({ XPC_SERVICE_NAME: "bot.ouro.daemon" }, "linux")).toBe(false)
  })
})

describe("handOffDaemonRuntimeReplacement", () => {
  it("does nothing when the command is not running inside the daemon's launchd job", () => {
    const { deps } = makeDeps({ env: { PATH: "/usr/bin" } })

    expect(handOffDaemonRuntimeReplacement(deps)).toBeNull()
    expect(deps.spawn).not.toHaveBeenCalled()
    expect(deps.openLog).not.toHaveBeenCalled()
  })

  it("refuses when it cannot tell which entry script to rerun", () => {
    const { deps } = makeDeps({ entryPath: undefined })

    expect(() => handOffDaemonRuntimeReplacement(deps)).toThrow("could not tell which ouro entry script to run as the detached helper")
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it("starts a detached `ouro up` in its own session, outside the daemon's job, with output going to a log", () => {
    const { deps, child } = makeDeps()

    const result = handOffDaemonRuntimeReplacement(deps)

    expect(result).toEqual({ pid: 4242, logPath: "/fixture/.ouro-cli/daemon/logs/runtime-replacement-helper.log" })
    expect(deps.openLog).toHaveBeenCalledWith("/fixture/.ouro-cli/daemon/logs/runtime-replacement-helper.log")
    expect(deps.spawn).toHaveBeenCalledTimes(1)
    const [file, args, options] = vi.mocked(deps.spawn).mock.calls[0]!
    expect(file).toBe("/fixture/node")
    expect(args).toEqual(["/fixture/ouro-entry.js", "up"])
    expect(options.detached).toBe(true)
    expect(options.stdio).toEqual(["ignore", 17, 17])
    // The helper must not look like it is still inside the daemon's job, or it
    // would hand off again instead of doing the replacement.
    expect(options.env.XPC_SERVICE_NAME).toBeUndefined()
    expect(options.env.OURO_UNATTENDED).toBe("1")
    expect(options.env.PATH).toBe("/usr/bin")
    expect(deps.env.XPC_SERVICE_NAME).toBe("bot.ouro.daemon")
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it("reports an unknown pid when the helper starts without one", () => {
    const { deps } = makeDeps({ spawn: vi.fn(() => ({ unref: vi.fn() })) })

    expect(handOffDaemonRuntimeReplacement(deps)).toEqual({
      pid: null,
      logPath: "/fixture/.ouro-cli/daemon/logs/runtime-replacement-helper.log",
    })
  })

  it("throws rather than letting the caller replace in place when the helper cannot start", () => {
    const { deps } = makeDeps({ spawn: vi.fn(() => { throw new Error("EAGAIN") }) })

    expect(() => handOffDaemonRuntimeReplacement(deps)).toThrow("could not start the detached helper: EAGAIN")
  })

  it("throws when the helper log cannot be opened, and names non-Error failures", () => {
    const { deps } = makeDeps({ openLog: vi.fn(() => { throw "disk gone" }) })

    expect(() => handOffDaemonRuntimeReplacement(deps)).toThrow("could not start the detached helper: disk gone")
    expect(deps.spawn).not.toHaveBeenCalled()
  })
})

describe("isRuntimeReplacementStranded", () => {
  const now = Date.parse("2026-11-16T05:00:00.000Z")
  const old = now - STRANDED_REPLACEMENT_AFTER_MS

  it("keeps the marker under the CLI home's daemon folder", () => {
    expect(runtimeReplacementMarkerPath("/fixture/.ouro-cli")).toBe("/fixture/.ouro-cli/daemon/runtime-replacement-pending")
  })

  it("is true only when an old replacement marker remains and the label is unloaded", () => {
    const unloaded = vi.fn(() => false)
    expect(isRuntimeReplacementStranded({ markerWrittenAtMs: old, nowMs: now, labelLoaded: unloaded })).toBe(true)
    expect(isRuntimeReplacementStranded({ markerWrittenAtMs: old, nowMs: now, labelLoaded: () => true })).toBe(false)
  })

  it("does not ask launchd when no replacement is pending or one may still be running", () => {
    const labelLoaded = vi.fn(() => false)
    expect(isRuntimeReplacementStranded({ markerWrittenAtMs: null, nowMs: now, labelLoaded })).toBe(false)
    expect(isRuntimeReplacementStranded({ markerWrittenAtMs: old + 1, nowMs: now, labelLoaded })).toBe(false)
    expect(labelLoaded).not.toHaveBeenCalled()
  })
})
