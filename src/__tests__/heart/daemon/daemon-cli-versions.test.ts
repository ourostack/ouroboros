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

import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

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

describe("ouro versions: parsing", () => {
  it("parses 'versions'", () => {
    expect(parseOuroCommand(["versions"])).toEqual({ kind: "versions" })
  })
})

describe("ouro versions: execution", () => {
  it("lists local versions and published update availability", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.78", "0.1.0-alpha.79", "0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      getPreviousCliVersion: vi.fn(() => "0.1.0-alpha.79"),
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.81" })),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("0.1.0-alpha.80")
    expect(result).toContain("* current")
    expect(result).toContain("0.1.0-alpha.79")
    expect(result).toContain("(previous)")
    expect(result).toContain("0.1.0-alpha.78")
    expect(result).toContain("published latest: 0.1.0-alpha.81 (update available)")
  })

  it("shows published version as up to date when no update is available", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      getPreviousCliVersion: vi.fn(() => null),
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.80" })),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("0.1.0-alpha.80")
    expect(result).toContain("* current")
    expect(result).toContain("published latest: 0.1.0-alpha.80 (up to date)")
  })

  it("shows published status even when no versions are installed", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => []),
      getCurrentCliVersion: vi.fn(() => null),
      getPreviousCliVersion: vi.fn(() => null),
      checkForCliUpdate: vi.fn(async () => ({ available: true, latestVersion: "0.1.0-alpha.81" })),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("no versions installed")
    expect(result).toContain("published latest: 0.1.0-alpha.81 (update available)")
  })

  it("degrades cleanly when published version lookup errors", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      getPreviousCliVersion: vi.fn(() => null),
      checkForCliUpdate: vi.fn(async () => ({ available: false, error: "registry unavailable" })),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("0.1.0-alpha.80")
    expect(result).toContain("published latest: unavailable (skipped; registry unavailable)")
  })

  it("does not hang forever when the published version lookup stalls", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      getPreviousCliVersion: vi.fn(() => null),
      checkForCliUpdate: vi.fn(() => new Promise<never>(() => {})),
      updateCheckTimeoutMs: 1,
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("0.1.0-alpha.80")
    expect(result).toContain("published latest: unavailable (skipped; registry did not answer)")
  })

  it("renders versions as a shared board in TTY mode", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.80", "0.1.0-alpha.81"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.81"),
      getPreviousCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      checkForCliUpdate: vi.fn(async () => ({ available: false, latestVersion: "0.1.0-alpha.81" })),
      isTTY: true,
      stdoutColumns: 74,
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("___    _   _")
    expect(result).toContain("Versions")
    expect(result).toContain("0.1.0-alpha.81")
    expect(result).toContain("published latest")
  })
})
