import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  pruneStaleEphemeralBundles: vi.fn(() => [] as string[]),
  upProgressStartPhase: vi.fn(),
  upProgressCompletePhase: vi.fn(),
  upProgressEnd: vi.fn(),
  upProgressRender: vi.fn(() => ""),
  upProgressUpdateDetail: vi.fn(),
  upProgressAnnounceStep: vi.fn(),
  UpProgressConstructor: vi.fn(),
}))

vi.mock("../../../heart/versioning/update-hooks", () => ({
  applyPendingUpdates: (...a: any[]) => mocks.applyPendingUpdates(...a),
  registerUpdateHook: (...a: any[]) => mocks.registerUpdateHook(...a),
  getRegisteredHooks: vi.fn(() => []),
  clearRegisteredHooks: vi.fn(),
}))

vi.mock("../../../heart/daemon/hooks/bundle-meta", () => ({
  bundleMetaHook: vi.fn(),
}))

vi.mock("../../../heart/daemon/stale-bundle-prune", () => ({
  pruneStaleEphemeralBundles: (...a: any[]) => mocks.pruneStaleEphemeralBundles(...a),
}))

vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
}))

vi.mock("../../../heart/daemon/up-progress", () => ({
  UpProgress: class MockUpProgress {
    constructor(...args: any[]) {
      mocks.UpProgressConstructor(...args)
    }
    startPhase = mocks.upProgressStartPhase
    completePhase = mocks.upProgressCompletePhase
    end = mocks.upProgressEnd
    render = mocks.upProgressRender
    updateDetail = mocks.upProgressUpdateDetail
    announceStep = mocks.upProgressAnnounceStep
  },
}))

import { runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    ...overrides,
  }
}

describe("ouro up: UpProgress integration", () => {
  it("emits at least one nerves event", () => {
    emitNervesEvent({ component: "daemon", event: "daemon.cli_up_progress_test", message: "testing up progress" })
  })

  it("creates an UpProgress instance during daemon.up", async () => {
    mocks.UpProgressConstructor.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.UpProgressConstructor).toHaveBeenCalled()
  })

  it("does not force ouro up progress into non-TTY mode", async () => {
    mocks.UpProgressConstructor.mockClear()
    const deps = makeDeps({
      isTTY: true,
      writeRaw: vi.fn(),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.UpProgressConstructor).toHaveBeenCalledWith(expect.objectContaining({
      isTTY: true,
    }))
  })

  it("lets the shared UpProgress TUI own the tty masthead render path", async () => {
    const writeRaw = vi.fn()
    const deps = makeDeps({
      isTTY: true,
      writeRaw,
    })

    await runOuroCli(["up"], deps)

    expect(writeRaw).not.toHaveBeenCalled()
  })

  it("calls startPhase('update check') before update check", async () => {
    mocks.upProgressStartPhase.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressStartPhase).toHaveBeenCalledWith("update check")
  })

  it("shows a live detail line while checking the registry", async () => {
    mocks.upProgressUpdateDetail.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressUpdateDetail).toHaveBeenCalledWith(
      "checking npm registry\ncontinuing startup if it stays quiet",
    )
  })

  it("calls completePhase('update check', 'up to date') when no update available", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith("update check", "up to date")
  })

  it("calls completePhase('update check', 'skipped; registry did not answer') when the registry stalls", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(() => new Promise<never>(() => {})),
      updateCheckTimeoutMs: 1,
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "update check",
      "skipped; registry did not answer",
    )
  })

  it("calls completePhase('update check', 'skipped; update check unavailable') when the update check throws", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => { throw new Error("kaboom") }),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "update check",
      "skipped; update check unavailable",
    )
  })

  it("calls completePhase with version when update is installed", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    // end() must be called before re-exec
    mocks.upProgressEnd.mockClear()
    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "update check",
      expect.stringContaining("0.1.0-alpha.90"),
    )
    expect(mocks.upProgressEnd).toHaveBeenCalled()
  })

  it("calls startPhase('system setup') for system setup phase", async () => {
    mocks.upProgressStartPhase.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressStartPhase).toHaveBeenCalledWith("system setup")
  })

  it("calls completePhase('system setup') after system setup", async () => {
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith("system setup")
  })

  it("calls startPhase('starting daemon') for daemon start", async () => {
    mocks.upProgressStartPhase.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressStartPhase).toHaveBeenCalledWith("starting daemon")
  })

  it("completes starting daemon explicitly before provider checks", async () => {
    mocks.upProgressStartPhase.mockClear()
    mocks.upProgressCompletePhase.mockClear()
    const deps = makeDeps({
      checkSocketAlive: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(true),
      sendCommand: vi.fn(async (_socketPath, command) => {
        if (command.kind === "daemon.status") {
          return {
            ok: true,
            summary: "running",
            data: {
              overview: {
                daemon: "running",
                health: "ok",
                socketPath: "/tmp/ouro-test.sock",
                version: "0.1.0-alpha.20",
                lastUpdated: "2026-03-09T11:00:00.000Z",
                workerCount: 0,
                senseCount: 0,
              },
              senses: [],
              workers: [],
            },
          }
        }
        return { ok: true, summary: "ok" }
      }),
    })

    await runOuroCli(["up"], deps)

    const completeDaemonIndex = mocks.upProgressCompletePhase.mock.calls.findIndex(
      (call: unknown[]) => call[0] === "starting daemon",
    )
    const startProviderIndex = mocks.upProgressStartPhase.mock.calls.findIndex(
      (call: unknown[]) => call[0] === "provider checks",
    )
    expect(completeDaemonIndex).toBeGreaterThanOrEqual(0)
    expect(startProviderIndex).toBeGreaterThanOrEqual(0)
    expect(mocks.upProgressCompletePhase.mock.invocationCallOrder[completeDaemonIndex]).toBeLessThan(
      mocks.upProgressStartPhase.mock.invocationCallOrder[startProviderIndex]!,
    )
  })

  it("keeps daemon startup unresolved and surfaces replacement breadcrumbs when a drift restart does not answer", async () => {
    vi.useFakeTimers()
    mocks.upProgressCompletePhase.mockClear()
    mocks.upProgressEnd.mockClear()
    mocks.upProgressAnnounceStep.mockClear()
    const sendCommand = vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          summary: "running",
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: "0.1.0-alpha.1",
              lastUpdated: "2026-03-09T11:00:00.000Z",
              workerCount: 0,
              senseCount: 0,
            },
            senses: [],
            workers: [],
          },
        }
      }
      return { ok: true, summary: "ok" }
    })
    const checkSocketAlive = vi.fn(async () => checkSocketAlive.mock.calls.length === 1)
    const deps = makeDeps({
      sendCommand,
      checkSocketAlive,
      startDaemonProcess: vi.fn(async () => ({ pid: 456 })),
      cleanupStaleSocket: vi.fn(),
    })

    try {
      const resultPromise = runOuroCli(["up"], deps)
      await vi.advanceTimersByTimeAsync(10_500)
      const result = await resultPromise

      expect(result).toContain("replacement daemon did not answer in time")
      expect(mocks.upProgressCompletePhase).not.toHaveBeenCalledWith("starting daemon", expect.anything())
      expect(mocks.upProgressAnnounceStep.mock.calls.some(
        (call: unknown[]) => String(call[0]).includes("replacement"),
      )).toBe(true)
      expect(mocks.upProgressEnd).toHaveBeenCalled()
      expect(deps.writeStdout).toHaveBeenCalledWith(result)
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses plain-English replacement breadcrumbs while swapping in a new daemon", async () => {
    mocks.upProgressAnnounceStep.mockClear()
    const sendCommand = vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          summary: "running",
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: "0.1.0-alpha.1",
              lastUpdated: "2026-03-09T11:00:00.000Z",
              workerCount: 0,
              senseCount: 0,
            },
            senses: [],
            workers: [],
          },
        }
      }
      return { ok: true, summary: "ok" }
    })
    const deps = makeDeps({
      sendCommand,
      checkSocketAlive: vi.fn(async () => true),
      startDaemonProcess: vi.fn(async () => ({ pid: 456 })),
      cleanupStaleSocket: vi.fn(),
    })

    await runOuroCli(["up"], deps)

    const announced = mocks.upProgressAnnounceStep.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(announced).toContain("checking whether an older background service is already running")
    expect(announced).toContain("stopping the older background service")
    expect(announced).toContain("starting the replacement background service")
    expect(announced).toContain("waiting for the replacement background service to answer")
  })

  it("calls end() before pollDaemonStartup takes over", async () => {
    mocks.upProgressEnd.mockClear()
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressEnd).toHaveBeenCalled()
  })

  it("calls end() before re-exec", async () => {
    mocks.upProgressEnd.mockClear()
    const endCallOrder: string[] = []
    mocks.upProgressEnd.mockImplementation(() => endCallOrder.push("end"))
    const reExec = vi.fn(() => {
      endCallOrder.push("reexec")
      throw new Error("__REEXEC__")
    }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(endCallOrder.indexOf("end")).toBeLessThan(endCallOrder.indexOf("reexec"))
  })

  it("calls end() before repair prompts (--no-repair path)", async () => {
    mocks.upProgressEnd.mockClear()
    const deps = makeDeps({
      checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    })

    // Make pollDaemonStartup return degraded agents
    const { pollDaemonStartup } = await import("../../../heart/daemon/startup-tui")
    vi.mocked(pollDaemonStartup).mockResolvedValueOnce({
      stable: [],
      degraded: [{ agent: "test", errorReason: "bad", fixHint: "fix it" }],
    })

    await runOuroCli(["up", "--no-repair"], deps)

    expect(mocks.upProgressEnd).toHaveBeenCalled()
  })

  it("reports pruned bundles via completePhase", async () => {
    mocks.upProgressCompletePhase.mockClear()
    mocks.pruneStaleEphemeralBundles.mockReturnValueOnce(["stale.ouro", "dead.ouro"])
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "bundle cleanup",
      expect.stringContaining("2"),
    )
  })

  it("reports singular pruned bundle without trailing s", async () => {
    mocks.upProgressCompletePhase.mockClear()
    mocks.pruneStaleEphemeralBundles.mockReturnValueOnce(["stale.ouro"])
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "bundle cleanup",
      "pruned 1 stale bundle",
    )
  })

  it("reports agent updates via completePhase", async () => {
    mocks.upProgressCompletePhase.mockClear()
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "alpha", from: "0.1.0-alpha.80", to: "0.1.0-alpha.90" },
        { agent: "beta", from: "0.1.0-alpha.80", to: "0.1.0-alpha.90" },
      ],
    })
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "agent updates",
      expect.stringContaining("2"),
    )
  })

  it("reports singular agent update without trailing s", async () => {
    mocks.upProgressCompletePhase.mockClear()
    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [
        { agent: "alpha", from: "0.1.0-alpha.80", to: "0.1.0-alpha.90" },
      ],
    })
    const deps = makeDeps()

    await runOuroCli(["up"], deps)

    expect(mocks.upProgressCompletePhase).toHaveBeenCalledWith(
      "agent updates",
      "1 agent to runtime 0.1.0-alpha.90 (was 0.1.0-alpha.80)",
    )
  })

  it("progress phases appear in correct order", async () => {
    const phaseOrder: string[] = []
    mocks.upProgressStartPhase.mockImplementation((label: string) => phaseOrder.push(`start:${label}`))
    mocks.upProgressCompletePhase.mockImplementation((label: string) => phaseOrder.push(`complete:${label}`))
    mocks.upProgressEnd.mockImplementation(() => phaseOrder.push("end"))

    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    const updateCheckStart = phaseOrder.indexOf("start:update check")
    const updateCheckComplete = phaseOrder.indexOf("complete:update check")
    const systemSetupStart = phaseOrder.indexOf("start:system setup")
    const daemonStart = phaseOrder.indexOf("start:starting daemon")
    const end = phaseOrder.indexOf("end")

    expect(updateCheckStart).toBeGreaterThanOrEqual(0)
    expect(updateCheckComplete).toBeGreaterThan(updateCheckStart)
    expect(systemSetupStart).toBeGreaterThan(updateCheckComplete)
    expect(daemonStart).toBeGreaterThan(systemSetupStart)
    expect(end).toBeGreaterThan(daemonStart)
  })

  it("does not call writeStdout for progress messages (checking/starting/up to date)", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false })),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
    })

    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    expect(calls).not.toContain("checking for updates...")
    expect(calls).not.toContain("up to date.")
    expect(calls).not.toContain("starting daemon...")
  })
})
