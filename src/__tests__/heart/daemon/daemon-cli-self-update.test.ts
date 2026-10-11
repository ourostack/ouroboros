import { describe, expect, it, vi } from "vitest"

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
    checkSocketAlive: vi.fn(async () => false),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    setExitCode: vi.fn(),
    ...overrides,
  }
}

describe("ouro self-update: parsing", () => {
  it("parses the interactive and unattended forms", () => {
    expect(parseOuroCommand(["self-update"])).toEqual({ kind: "self-update" })
    expect(parseOuroCommand(["self-update", "--unattended"])).toEqual({ kind: "self-update", unattended: true })
  })

  it("rejects unknown flags", () => {
    expect(() => parseOuroCommand(["self-update", "--force"])).toThrow("Usage: ouro self-update [--unattended]")
  })
})

describe("ouro self-update: execution", () => {
  it("reports the pass and installs the updater agent afterwards", async () => {
    const order: string[] = []
    const deps = makeDeps({
      runSelfUpdate: vi.fn(async () => { order.push("update"); return { outcome: "updated" as const, summary: "updated a -> b via github" } }),
      ensureUpdaterAgent: vi.fn(() => { order.push("agent"); return "installed" as const }),
    })

    const result = await runOuroCli(["self-update"], deps)

    expect(result).toBe("self-update: updated: updated a -> b via github\nunattended updater: installed (runs hourly and at login)")
    expect(order).toEqual(["update", "agent"])
    expect(deps.setExitCode).not.toHaveBeenCalled()
  })

  it("sets a failing exit code for failed passes and notes a pending reload", async () => {
    const deps = makeDeps({
      runSelfUpdate: vi.fn(async () => ({ outcome: "rolled-back" as const, summary: "rolled back" })),
      ensureUpdaterAgent: vi.fn(() => "written-reload-pending" as const),
    })

    const result = await runOuroCli(["self-update", "--unattended"], deps)

    expect(result).toBe("self-update: rolled-back: rolled back\nunattended updater: refreshed; reloads on the next interactive run")
    expect(deps.setExitCode).toHaveBeenCalledWith(1)
  })

  it("says when the platform has no unattended updater, but not in unattended runs", async () => {
    const run = vi.fn(async () => ({ outcome: "current" as const, summary: "current at b" }))
    const interactive = makeDeps({ runSelfUpdate: run, ensureUpdaterAgent: vi.fn(() => null) })
    expect(await runOuroCli(["self-update"], interactive)).toBe("self-update: current: current at b\nunattended updater: not available on this platform")

    const unattended = makeDeps({ runSelfUpdate: run, ensureUpdaterAgent: vi.fn(() => null) })
    expect(await runOuroCli(["self-update", "--unattended"], unattended)).toBe("self-update: current: current at b")

    const unchanged = makeDeps({ runSelfUpdate: run, ensureUpdaterAgent: vi.fn(() => "unchanged" as const) })
    expect(await runOuroCli(["self-update"], unchanged)).toBe("self-update: current: current at b")

    const noAgent = makeDeps({ runSelfUpdate: run })
    expect(await runOuroCli(["self-update"], noAgent)).toBe("self-update: current: current at b")
  })

  it("keeps the update result when the agent cannot be installed", async () => {
    const deps = makeDeps({
      runSelfUpdate: vi.fn(async () => ({ outcome: "busy" as const, summary: "another ouro self-update is already running" })),
      ensureUpdaterAgent: vi.fn(() => { throw new Error("launchctl: permission denied") }),
    })
    expect(await runOuroCli(["self-update"], deps)).toBe(
      "self-update: busy: another ouro self-update is already running\nunattended updater: could not install: launchctl: permission denied",
    )
  })

  it("fails clearly when the runtime has no self-update", async () => {
    const deps = makeDeps()
    expect(await runOuroCli(["self-update"], deps)).toBe("self-update is not available in this runtime")
    expect(deps.setExitCode).toHaveBeenCalledWith(1)
  })
})

describe("ouro status: update line", () => {
  it("appends the update line when the daemon is down", async () => {
    const deps = makeDeps({
      sendCommand: vi.fn(async () => { throw Object.assign(new Error("connect ENOENT /tmp/ouro-test.sock"), { code: "ENOENT" }) }),
      readUpdateStatusLine: () => "Updates: current at 0.1.0-alpha.896 (checked 5m ago via github)",
      healthFilePath: "/nonexistent/daemon-health.json",
    })

    const result = await runOuroCli(["status"], deps)

    expect(result.endsWith("\n\nUpdates: current at 0.1.0-alpha.896 (checked 5m ago via github)")).toBe(true)
  })

  it("leaves status untouched when the update line is unavailable or throws", async () => {
    const down = () => vi.fn(async () => { throw Object.assign(new Error("connect ENOENT /tmp/ouro-test.sock"), { code: "ENOENT" }) })
    const none = await runOuroCli(["status"], makeDeps({ sendCommand: down(), readUpdateStatusLine: () => null, healthFilePath: "/nonexistent/h.json" }))
    const throwing = await runOuroCli(["status"], makeDeps({ sendCommand: down(), readUpdateStatusLine: () => { throw new Error("bad") }, healthFilePath: "/nonexistent/h.json" }))
    expect(none).not.toContain("Updates:")
    expect(throwing).toBe(none)
  })

  it("appends the update line to a running daemon's status", async () => {
    const deps = makeDeps({
      sendCommand: vi.fn(async () => ({ ok: true, summary: "daemon running" })),
      readUpdateStatusLine: () => "Updates: needs attention: unreachable 1h ago on 0.1.0-alpha.805: no release source answered",
    })
    const result = await runOuroCli(["status"], deps)
    expect(result).toContain("\n\nUpdates: needs attention: unreachable")
  })
})
