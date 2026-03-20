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

describe("ouro rollback: parsing", () => {
  it("parses 'rollback' with no version", () => {
    expect(parseOuroCommand(["rollback"])).toEqual({ kind: "rollback" })
  })

  it("parses 'rollback' with a specific version", () => {
    expect(parseOuroCommand(["rollback", "0.1.0-alpha.74"])).toEqual({
      kind: "rollback",
      version: "0.1.0-alpha.74",
    })
  })
})

describe("ouro rollback: execution", () => {
  it("rolls back to previous version when no version arg", async () => {
    const deps = makeDeps({
      getPreviousCliVersion: vi.fn(() => "0.1.0-alpha.79"),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      activateCliVersion: vi.fn(),
      sendCommand: vi.fn(async () => ({ ok: true, message: "stopped" })),
    })

    const result = await runOuroCli(["rollback"], deps)

    expect(deps.activateCliVersion).toHaveBeenCalledWith("0.1.0-alpha.79")
    expect(deps.sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", { kind: "daemon.stop" })
    expect(result).toContain("rolled back to 0.1.0-alpha.79")
    expect(result).toContain("was 0.1.0-alpha.80")
  })

  it("outputs error when no previous version exists", async () => {
    const deps = makeDeps({
      getPreviousCliVersion: vi.fn(() => null),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      activateCliVersion: vi.fn(),
    })

    const result = await runOuroCli(["rollback"], deps)

    expect(deps.activateCliVersion).not.toHaveBeenCalled()
    expect(result).toContain("no previous version")
  })

  it("installs and activates a specific version when not already cached", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.79", "0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      sendCommand: vi.fn(async () => ({ ok: true, message: "stopped" })),
    })

    const result = await runOuroCli(["rollback", "0.1.0-alpha.74"], deps)

    expect(deps.installCliVersion).toHaveBeenCalledWith("0.1.0-alpha.74")
    expect(deps.activateCliVersion).toHaveBeenCalledWith("0.1.0-alpha.74")
    expect(result).toContain("rolled back to 0.1.0-alpha.74")
  })

  it("skips install when specific version is already cached", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => ["0.1.0-alpha.74", "0.1.0-alpha.80"]),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      installCliVersion: vi.fn(async () => {}),
      activateCliVersion: vi.fn(),
      sendCommand: vi.fn(async () => ({ ok: true, message: "stopped" })),
    })

    const result = await runOuroCli(["rollback", "0.1.0-alpha.74"], deps)

    expect(deps.installCliVersion).not.toHaveBeenCalled()
    expect(deps.activateCliVersion).toHaveBeenCalledWith("0.1.0-alpha.74")
    expect(result).toContain("rolled back to 0.1.0-alpha.74")
  })

  it("outputs error when install of specific version fails", async () => {
    const deps = makeDeps({
      listCliVersions: vi.fn(() => []),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      installCliVersion: vi.fn(async () => { throw new Error("npm install failed") }),
      activateCliVersion: vi.fn(),
    })

    const result = await runOuroCli(["rollback", "0.1.0-alpha.74"], deps)

    expect(deps.activateCliVersion).not.toHaveBeenCalled()
    expect(result).toContain("npm install failed")
  })

  it("daemon stop failure is non-fatal — rollback still succeeds", async () => {
    const deps = makeDeps({
      getPreviousCliVersion: vi.fn(() => "0.1.0-alpha.79"),
      getCurrentCliVersion: vi.fn(() => "0.1.0-alpha.80"),
      activateCliVersion: vi.fn(),
      sendCommand: vi.fn(async () => { throw new Error("socket not found") }),
    })

    const result = await runOuroCli(["rollback"], deps)

    // Symlinks should still be flipped
    expect(deps.activateCliVersion).toHaveBeenCalledWith("0.1.0-alpha.79")
    expect(result).toContain("rolled back to 0.1.0-alpha.79")
  })
})
