import { describe, expect, it, vi } from "vitest"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
}))

vi.mock("../../../heart/daemon/update-hooks", () => ({
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
    checkSocketAlive: vi.fn(async () => false),
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
  it("lists versions with current and previous markers", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.78", "0.1.0-alpha.79", "0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      getPreviousCliVersion: vi.fn(() => "0.1.0-alpha.79"),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("0.1.0-alpha.80")
    expect(result).toContain("* current")
    expect(result).toContain("0.1.0-alpha.79")
    expect(result).toContain("(previous)")
    expect(result).toContain("0.1.0-alpha.78")
  })

  it("outputs 'no versions installed' when list is empty", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => []),
      getCurrentCliVersion: vi.fn(() => null),
      getPreviousCliVersion: vi.fn(() => null),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toBe("no versions installed")
  })

  it("shows single version marked as current", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      getPreviousCliVersion: vi.fn(() => null),
    })

    const result = await runOuroCli(["versions"], deps)

    expect(result).toContain("0.1.0-alpha.80")
    expect(result).toContain("* current")
    expect(result).not.toContain("(previous)")
  })
})
