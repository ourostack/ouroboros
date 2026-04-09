import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  linkedVersion: "0.1.0-alpha.91",
}))

const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  getPackageVersion: vi.fn(() => "0.1.0-alpha.92"),
  getCurrentVersion: vi.fn(() => state.linkedVersion),
  getPreviousVersion: vi.fn(() => "0.1.0-alpha.90"),
  listInstalledVersions: vi.fn(() => ["0.1.0-alpha.91", "0.1.0-alpha.92"]),
  ensureLayout: vi.fn(),
  getOuroCliHome: vi.fn(() => "/mock/.ouro-cli"),
  installVersion: vi.fn(),
  activateVersion: vi.fn((version: string) => {
    state.linkedVersion = version
  }),
  buildChangelogCommand: vi.fn((from: string) => `ouro changelog --from ${from}`),
  existsSync: vi.fn(() => true),
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

vi.mock("../../../mind/bundle-manifest", () => ({
  getPackageVersion: mocks.getPackageVersion,
  getChangelogPath: vi.fn(() => "/tmp/changelog.json"),
  createBundleMeta: vi.fn(() => ({
    runtimeVersion: "0.1.0-alpha.92",
    bundleSchemaVersion: 1,
    lastUpdated: "2026-01-01T00:00:00Z",
  })),
  backfillBundleMeta: vi.fn(),
  resetBackfillTracking: vi.fn(),
  CANONICAL_BUNDLE_MANIFEST: [],
  isCanonicalBundlePath: vi.fn().mockReturnValue(true),
  findNonCanonicalBundlePaths: vi.fn().mockReturnValue([]),
}))

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs")
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readdirSync: vi.fn(() => []),
  }
})

vi.mock("../../../heart/versioning/ouro-version-manager", () => ({
  getCurrentVersion: mocks.getCurrentVersion,
  getPreviousVersion: mocks.getPreviousVersion,
  listInstalledVersions: mocks.listInstalledVersions,
  installVersion: mocks.installVersion,
  activateVersion: mocks.activateVersion,
  ensureLayout: mocks.ensureLayout,
  getOuroCliHome: mocks.getOuroCliHome,
  buildChangelogCommand: mocks.buildChangelogCommand,
}))

vi.mock("../../../heart/daemon/startup-tui", () => ({
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
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
    getCurrentCliVersion: vi.fn(() => state.linkedVersion),
    ensureCurrentVersionInstalled: vi.fn(() => {
      if (state.linkedVersion !== "0.1.0-alpha.92") {
        mocks.activateVersion("0.1.0-alpha.92", {})
      }
    }),
    ...overrides,
  }
}

describe("ouro up runtime-version sync", () => {
  afterEach(() => {
    vi.clearAllMocks()
    state.linkedVersion = "0.1.0-alpha.91"
  })

  it("heals a stale CurrentVersion symlink when the running runtime version is newer", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.92" })),
    })

    await runOuroCli(["up"], deps)

    expect(mocks.installVersion).not.toHaveBeenCalled()
    expect(mocks.activateVersion).toHaveBeenCalledWith("0.1.0-alpha.92", {})
    expect(state.linkedVersion).toBe("0.1.0-alpha.92")
  })

  it("reports the healed runtime-version activation in ouro up output", async () => {
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.92" })),
    })

    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])
    expect(calls).toContain("ouro updated to 0.1.0-alpha.92 (was 0.1.0-alpha.91)")
    expect(calls).toContain("review changes with: ouro changelog --from 0.1.0-alpha.91")
  })

  it("omits changelog hint when buildChangelogCommand returns null", async () => {
    mocks.buildChangelogCommand.mockReturnValueOnce(null)
    const deps = makeDeps({
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.92" })),
    })

    await runOuroCli(["up"], deps)

    const calls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])
    expect(calls).toContain("ouro updated to 0.1.0-alpha.92 (was 0.1.0-alpha.91)")
    expect(calls).not.toContainEqual(expect.stringContaining("review changes with"))
  })
})
