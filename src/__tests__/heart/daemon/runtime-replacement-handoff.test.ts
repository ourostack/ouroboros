import { describe, expect, it, vi } from "vitest"

const nervesMocks = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: nervesMocks.emit }))

import {
  detectDaemonLaunchdJob,
  handOffDaemonRuntimeReplacement,
  isRuntimeReplacementStranded,
  parseLaunchctlJobPid,
  parseProcessParents,
  RUNTIME_REPLACEMENT_HELPER_ENV,
  type DaemonJobDetectionDeps,
  runtimeReplacementMarkerPath,
  STRANDED_REPLACEMENT_AFTER_MS,
  type RuntimeReplacementHandoffDeps,
} from "../../../heart/daemon/runtime-replacement-handoff"

function makeDeps(overrides: Partial<RuntimeReplacementHandoffDeps> = {}) {
  const child = { pid: 4242, unref: vi.fn() }
  const deps: RuntimeReplacementHandoffDeps = {
    platform: "darwin",
    env: { XPC_SERVICE_NAME: "bot.ouro.daemon", PATH: "/usr/bin", HOME: "/Users/fixture" },
    pid: 300,
    readDaemonJobPid: vi.fn(() => 100),
    readProcessParents: vi.fn(() => new Map([[300, 200], [200, 100], [100, 1]])),
    execPath: "/fixture/node",
    entryPath: "/fixture/ouro-entry.js",
    logPath: "/fixture/.ouro-cli/daemon/logs/runtime-replacement-helper.log",
    openLog: vi.fn(() => 17),
    spawn: vi.fn(() => child),
    ...overrides,
  }
  return { deps, child }
}

function detection(overrides: Partial<DaemonJobDetectionDeps> = {}): DaemonJobDetectionDeps {
  return {
    platform: "darwin",
    env: { XPC_SERVICE_NAME: "0" },
    pid: 300,
    readDaemonJobPid: vi.fn(() => 100),
    // 300 is the agent's `ouro up`, 200 its shell, 100 the daemon.
    readProcessParents: vi.fn(() => new Map([[300, 200], [200, 100], [100, 1], [400, 1]])),
    ...overrides,
  }
}

describe("detectDaemonLaunchdJob", () => {
  it("is never inside off macOS, and never for the replacement helper itself", () => {
    expect(detectDaemonLaunchdJob(detection({ platform: "linux", env: { XPC_SERVICE_NAME: "bot.ouro.daemon" } })))
      .toMatchObject({ inside: false, reason: "not_macos" })
    const helper = detection({ env: { XPC_SERVICE_NAME: "bot.ouro.daemon", [RUNTIME_REPLACEMENT_HELPER_ENV]: "1" } })
    expect(detectDaemonLaunchdJob(helper)).toMatchObject({ inside: false, reason: "replacement_helper" })
    expect(helper.readDaemonJobPid).not.toHaveBeenCalled()
  })

  it("trusts the daemon's launchd label without asking launchd", () => {
    const deps = detection({ env: { XPC_SERVICE_NAME: "bot.ouro.daemon" } })
    expect(detectDaemonLaunchdJob(deps)).toEqual({ inside: true, reason: "launchd_label", xpcServiceName: "bot.ouro.daemon", daemonPid: null })
    expect(deps.readDaemonJobPid).not.toHaveBeenCalled()
  })

  it("is inside when a shell reset the label to 0 but the daemon's pid is an ancestor", () => {
    expect(detectDaemonLaunchdJob(detection())).toEqual({ inside: true, reason: "daemon_ancestor", xpcServiceName: "0", daemonPid: 100 })
  })

  it("is outside for a terminal, the updater's job, or when the daemon job has no process", () => {
    expect(detectDaemonLaunchdJob(detection({ pid: 400 }))).toEqual({ inside: false, reason: "not_descendant", xpcServiceName: "0", daemonPid: 100 })
    expect(detectDaemonLaunchdJob(detection({ env: { XPC_SERVICE_NAME: "bot.ouro.updater" }, pid: 400 })))
      .toMatchObject({ inside: false, reason: "not_descendant", xpcServiceName: "bot.ouro.updater" })
    expect(detectDaemonLaunchdJob(detection({ env: {}, pid: 999 }))).toMatchObject({ inside: false, reason: "not_descendant", xpcServiceName: null })
    const noJob = detection({ readDaemonJobPid: vi.fn(() => null) })
    expect(detectDaemonLaunchdJob(noJob)).toMatchObject({ inside: false, reason: "no_daemon_job", daemonPid: null })
    expect(noJob.readProcessParents).not.toHaveBeenCalled()
  })

  it("fails safe to inside when launchd or the process table can't be read", () => {
    expect(detectDaemonLaunchdJob(detection({ readDaemonJobPid: vi.fn(() => { throw new Error("launchctl timed out") }) })))
      .toEqual({ inside: true, reason: "launchctl_failed", xpcServiceName: "0", daemonPid: null, error: "launchctl timed out" })
    expect(detectDaemonLaunchdJob(detection({ readProcessParents: vi.fn(() => { throw "ps missing" }) })))
      .toEqual({ inside: true, reason: "process_table_failed", xpcServiceName: "0", daemonPid: 100, error: "ps missing" })
  })

  it("stops on a parent loop instead of walking forever", () => {
    const loop = detection({ pid: 500, readProcessParents: vi.fn(() => new Map([[500, 501], [501, 500]])) })
    expect(detectDaemonLaunchdJob(loop)).toMatchObject({ inside: false, reason: "not_descendant" })
  })
})

describe("parseLaunchctlJobPid and parseProcessParents", () => {
  it("reads the job's pid from launchctl print, and null when it has none", () => {
    expect(parseLaunchctlJobPid("gui/501/bot.ouro.daemon = {\n\tactive count = 1\n\tpid = 90084\n\tstate = running\n}")).toBe(90084)
    expect(parseLaunchctlJobPid("gui/501/bot.ouro.daemon = {\n\tstate = not running\n}")).toBeNull()
  })

  it("maps each pid to its parent and skips lines that aren't two numbers", () => {
    expect(parseProcessParents("    1     0\n  300   200\nnoise\n\n")).toEqual(new Map([[1, 0], [300, 200]]))
  })
})

describe("handOffDaemonRuntimeReplacement", () => {
  it("does nothing when the command is not running inside the daemon's launchd job", () => {
    const { deps } = makeDeps({ env: { PATH: "/usr/bin" }, pid: 999 })

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
    expect(options.env[RUNTIME_REPLACEMENT_HELPER_ENV]).toBe("1")
    expect(options.env.PATH).toBe("/usr/bin")
    expect(deps.env.XPC_SERVICE_NAME).toBe("bot.ouro.daemon")
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it("logs which check decided, whether or not it hands off", () => {
    nervesMocks.emit.mockClear()
    handOffDaemonRuntimeReplacement(makeDeps({ env: { XPC_SERVICE_NAME: "0" }, pid: 999 }).deps)
    handOffDaemonRuntimeReplacement(makeDeps({ env: { XPC_SERVICE_NAME: "0" }, readDaemonJobPid: vi.fn(() => { throw new Error("timed out") }) }).deps)
    const checks = nervesMocks.emit.mock.calls.map(([event]) => event).filter((event) => event.event === "daemon.runtime_replacement_job_check")
    expect(checks.map((event) => [event.level, event.meta])).toEqual([
      ["info", { inside: false, reason: "not_descendant", xpcServiceName: "0", daemonPid: 100 }],
      ["warn", { inside: true, reason: "launchctl_failed", xpcServiceName: "0", daemonPid: null, error: "timed out" }],
    ])
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
