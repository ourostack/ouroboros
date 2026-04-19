import { describe, expect, it, vi } from "vitest"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
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

vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
}))

vi.mock("../../../heart/daemon/up-progress", () => ({
  UpProgress: class MockUpProgress {
    startPhase = vi.fn()
    completePhase = vi.fn()
    updateDetail = vi.fn()
    end = vi.fn()
    render = vi.fn(() => "")
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

describe("ouro up: CLI update flow", () => {
  it("installs and activates newer version, then re-execs", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(deps.installCliVersion).toHaveBeenCalledWith("0.1.0-alpha.90")
    expect(deps.activateCliVersion).toHaveBeenCalledWith("0.1.0-alpha.90")
    // Update message is now rendered via UpProgress.completePhase, not writeStdout
    expect(deps.reExecFromNewVersion).toHaveBeenCalledWith(["up"])
  })

  it("does not install when registry returns same version", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.80" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: vi.fn() as unknown as (args: string[]) => never,
    })

    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    expect(deps.activateCliVersion).not.toHaveBeenCalled()
    expect(deps.reExecFromNewVersion).not.toHaveBeenCalled()
  })

  it("logs warning and proceeds when registry fetch fails", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, error: "network timeout" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: vi.fn() as unknown as (args: string[]) => never,
    })

    // Should not throw — proceeds to start daemon normally
    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    // Daemon should still start
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })

  it("keeps booting when the update check never answers", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(() => new Promise<never>(() => {})),
      updateCheckTimeoutMs: 1,
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: vi.fn() as unknown as (args: string[]) => never,
    })

    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })

  it("skips update check entirely when checkForCliUpdate is not provided", async () => {
    const deps = makeDeps({
      // No checkForCliUpdate — should skip update flow
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
    })

    await runOuroCli(["up"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    expect(deps.activateCliVersion).not.toHaveBeenCalled()
    // Daemon should still start
    expect(deps.startDaemonProcess).toHaveBeenCalled()
  })

  it("re-execs with original args after update", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    // reExec called with ["up"] — the original args
    expect(reExec).toHaveBeenCalledWith(["up"])
  })

  it("prints a changelog follow-up command when a newer version is installed", async () => {
    const reExec = vi.fn(() => { throw new Error("__REEXEC__") }) as unknown as (args: string[]) => never
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.90" })),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      reExecFromNewVersion: reExec,
    })

    await expect(runOuroCli(["up"], deps)).rejects.toThrow("__REEXEC__")

    expect(deps.writeStdout).toHaveBeenCalledWith("review changes with: ouro changelog --from 0.1.0-alpha.80")
  })

  it("does not double-print 'ouro updated to' when both symlink-flip and bundle-meta paths fire in the same process", async () => {
    // Regression: in the npx code path, the same `runOuroCli` invocation
    // hits both detector paths back-to-back:
    //
    //   path 2 (line 884): ensureCurrentVersionInstalled flips the symlink
    //   from old → new during performSystemSetup. The pre/post symlink
    //   comparison fires.
    //
    //   path 3 (line 909): bundle-meta.json still has the old version
    //   (applyPendingUpdates hasn't written the new one yet at the time
    //   `previousCliVersion` is captured). The previous-vs-current
    //   comparison fires.
    //
    // Verified live on 2026-04-08: `npx --yes @ouro.bot/cli@latest up`
    // printed "ouro updated to ..." twice. Path 3 was supposed to be
    // suppressed by `linkedVersionBeforeUp !== currentVersion` (which
    // skips the cross-process re-exec case from path 1), but that guard
    // doesn't catch the in-process double-fire case from path 2.
    //
    // The fix: track an in-process `printedUpdateMessage` flag that path 3
    // checks before printing. Path 3 still acts as a fallback when path 2
    // didn't fire (e.g., when ensureCurrentVersionInstalled isn't injected
    // or it failed to activate the symlink), so we can't just delete it.
    //
    // This test simulates the npx scenario:
    //   - getCurrentCliVersion returns the OLD version pre-setup
    //   - ensureCurrentVersionInstalled flips the symlink during setup
    //     (mocked as a side-effect that mutates the getCurrentCliVersion
    //     return value to the new version)
    //   - applyPendingUpdates is called against bundle-meta still showing
    //     the old version (so previousCliVersion ends up old)
    //
    // and asserts that "ouro updated to" is printed exactly once.
    const runtimeVersion = "0.1.0-alpha.271"
    const oldVersion = "0.1.0-alpha.270"

    let symlinkVersion = oldVersion
    const ensureCurrentVersionInstalled = vi.fn(() => {
      symlinkVersion = runtimeVersion
    })

    mocks.applyPendingUpdates.mockResolvedValueOnce({
      updated: [{ agent: "slugger", from: oldVersion, to: runtimeVersion }],
    })

    // The runtime version comes from getPackageVersion(), which reads the
    // installed package.json. Stub it via vi.spyOn so the runtime version
    // matches our scenario.
    const bundleManifest = await import("../../../mind/bundle-manifest")
    const getPackageVersionSpy = vi.spyOn(bundleManifest, "getPackageVersion").mockReturnValue(runtimeVersion)

    // readFirstBundleMetaVersion is called from cli-defaults; stub it via
    // the same module so cli-exec sees `previousCliVersion = oldVersion`.
    const cliDefaults = await import("../../../heart/daemon/cli-defaults")
    const readFirstBundleMetaVersionSpy = vi.spyOn(cliDefaults, "readFirstBundleMetaVersion").mockReturnValue(oldVersion)

    try {
      const deps = makeDeps({
        // Update check: no update available (we're already at latest because
        // npx downloaded the latest into this process).
        checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: runtimeVersion })),
        installCliVersion: vi.fn(async () => {}),
        activateCliVersion: vi.fn(),
        // getCurrentCliVersion reads the symlink, which the
        // ensureCurrentVersionInstalled side-effect mutates mid-test.
        getCurrentCliVersion: vi.fn(() => symlinkVersion),
        ensureCurrentVersionInstalled,
        reExecFromNewVersion: vi.fn() as unknown as (args: string[]) => never,
      })

      await runOuroCli(["up"], deps)

      const writeStdoutMock = deps.writeStdout as ReturnType<typeof vi.fn>
      const updatedToCalls = writeStdoutMock.mock.calls
        .map((c: unknown[]) => c[0] as string)
        .filter((msg: string) => msg.includes("ouro updated to"))

      // Exactly one print, not two.
      expect(updatedToCalls).toHaveLength(1)
      expect(updatedToCalls[0]).toBe(`ouro updated to ${runtimeVersion} (was ${oldVersion})`)
    } finally {
      getPackageVersionSpy.mockRestore()
      readFirstBundleMetaVersionSpy.mockRestore()
    }
  })
})
