import { beforeEach, describe, expect, it, vi } from "vitest"

const { statSync, readFileSync, existsSync, homedir, execFileSync } = vi.hoisted(() => ({
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  homedir: vi.fn(),
  execFileSync: vi.fn(),
}))

const packageManagement = vi.hoisted(() => ({
  resolve: vi.fn(),
  inspect: vi.fn(),
}))

vi.mock("node:fs", () => ({ statSync, readFileSync, existsSync }))
vi.mock("node:os", () => ({ homedir }))
vi.mock("node:child_process", () => ({ execFileSync }))
vi.mock("../../../heart/identity", () => ({ getRepoRoot: () => "/opt/ouro", getAgentBundlesRoot: () => "/home/ouro/AgentBundles" }))
vi.mock("../../../mind/bundle-manifest", () => ({ getPackageVersion: () => "0.1.0-alpha.798" }))
vi.mock("../../../heart/daemon/sanctuary-package-management", () => ({
  resolveSanctuaryPackageManagementActivation: packageManagement.resolve,
}))
vi.mock("../../../heart/daemon/sanctuary-bundle-migration", () => ({
  inspectSanctuaryPackageManagedBundle: packageManagement.inspect,
}))

import { runContainerHealthcheck, runContainerHealthcheckMain } from "../../../heart/daemon/container-healthcheck"

const NOW = 1_800_000_000_000
const AGENT = "node /opt/ouro/dist/heart/agent-entry.js --agent sanctuary"
const TELEGRAM = "node /opt/ouro/dist/senses/telegram-entry.js --agent sanctuary"
const SUPERCRONIC = "/usr/local/bin/supercronic -split-logs -inotify /home/ouro/.ouro-cli/scheduler/sanctuary.crontab"

function healthyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 1,
    status: "healthy",
    agents: { sanctuary: { status: "running", pid: 22 } },
    ...overrides,
  }
}

function run(argv = ["node", "healthcheck", "--package-managed-agent", "sanctuary", "--agent", "sanctuary"]): void {
  runContainerHealthcheck({ argv, now: () => NOW })
}

describe("container healthcheck", () => {
  beforeEach(() => {
    homedir.mockReset().mockReturnValue("/home/ouro")
    statSync.mockReset().mockReturnValue({ mtimeMs: NOW - 1_000 })
    readFileSync.mockReset().mockReturnValue(JSON.stringify(healthyState()))
    existsSync.mockReset().mockReturnValue(true)
    execFileSync.mockReset().mockReturnValue(`${AGENT}\n${TELEGRAM}\n${SUPERCRONIC}\n`)
    packageManagement.resolve.mockReset().mockReturnValue({ kind: "active", packageRoot: "/opt/ouro/deploy/unraid/sanctuary.ouro", agentRoot: "/home/ouro/AgentBundles/sanctuary.ouro", runtimePackageVersion: "0.1.0-alpha.798" })
    packageManagement.inspect.mockReset().mockReturnValue({ ok: true, data: { runtimePackageVersion: "0.1.0-alpha.798", packagedBundleVersion: "0.1.0-alpha.798", liveBundleVersion: "0.1.0-alpha.798", parity: "exact", mismatchCodes: [], journalState: "absent", ready: true, repair: { actor: "none", action: "none" } } })
    process.exitCode = undefined
  })

  it("passes only for a fresh healthy PID-1 daemon with one managed Telegram and scheduler process", () => {
    expect(() => run()).not.toThrow()
    expect(execFileSync).toHaveBeenCalledWith("ps", ["-eo", "args="], { encoding: "utf8", timeout: 2_000 })
    expect(process.exitCode).toBeUndefined()
  })

  it.each([
    ["missing agent", () => run(["node", "healthcheck"])],
    ["health state unavailable", () => { statSync.mockImplementation(() => { throw new Error("missing") }); run() }],
    ["health state stale", () => { statSync.mockReturnValue({ mtimeMs: NOW - 90_001 }); run() }],
    ["health state stale", () => { statSync.mockReturnValue({ mtimeMs: NOW + 1_001 }); run() }],
    ["daemon is not PID 1", () => { readFileSync.mockReturnValue(JSON.stringify(healthyState({ pid: 2 }))); run() }],
    ["daemon is not PID 1", () => { existsSync.mockImplementation((value: string) => value !== "/proc/1"); run() }],
    ["daemon status is not ready", () => { readFileSync.mockReturnValue(JSON.stringify(healthyState({ status: "starting" }))); run() }],
    ["managed agent is not running", () => { readFileSync.mockReturnValue(JSON.stringify(healthyState({ agents: {} }))); run() }],
    ["managed agent is not running", () => { readFileSync.mockReturnValue(JSON.stringify(healthyState({ agents: { sanctuary: { status: "stopped", pid: 22 } } }))); run() }],
    ["managed agent is not running", () => { readFileSync.mockReturnValue(JSON.stringify(healthyState({ agents: { sanctuary: { status: "running", pid: "22" } } }))); run() }],
    ["managed agent is not running", () => { readFileSync.mockReturnValue(JSON.stringify(healthyState({ agents: { sanctuary: { status: "running", pid: 0 } } }))); run() }],
    ["managed process inventory is unavailable", () => { execFileSync.mockImplementation(() => { throw new Error("ps failed") }); run() }],
    ["managed agent is not running exactly once", () => { execFileSync.mockReturnValue(`${TELEGRAM}\n${SUPERCRONIC}\n`); run() }],
    ["managed Telegram sense is not running exactly once", () => { execFileSync.mockReturnValue(`${AGENT}\n${SUPERCRONIC}\n`); run() }],
    ["managed Supercronic scheduler is not running exactly once", () => { execFileSync.mockReturnValue(`${AGENT}\n${TELEGRAM}\n`); run() }],
  ])("fails closed when %s", (reason, action) => {
    expect(action).toThrow(reason)
    expect(process.exitCode).toBe(1)
  })

  it("accepts a partial daemon status", () => {
    readFileSync.mockReturnValue(JSON.stringify(healthyState({ status: "partial" })))
    expect(() => run()).not.toThrow()
  })

  it.each([
    ["invalid package-managed Sanctuary activation", () => packageManagement.resolve.mockReturnValue({ kind: "inactive" })],
    ["invalid package-managed Sanctuary activation", () => packageManagement.resolve.mockReturnValue({ kind: "invalid", failure: new Error("bounded") })],
    ["package-managed Sanctuary bundle is not ready", () => packageManagement.inspect.mockReturnValue({ ok: true, data: { runtimePackageVersion: "0.1.0-alpha.798", packagedBundleVersion: "0.1.0-alpha.798", liveBundleVersion: "old", parity: "mismatch", mismatchCodes: ["managed_file_content"], journalState: "absent", ready: false, repair: { actor: "human-required", action: "restart_from_verified_release" } } })],
    ["package-managed Sanctuary bundle is not ready", () => packageManagement.inspect.mockReturnValue({ ok: true, data: { runtimePackageVersion: "0.1.0-alpha.798", packagedBundleVersion: "0.1.0-alpha.798", liveBundleVersion: "0.1.0-alpha.798", parity: "exact", mismatchCodes: [], journalState: "committing", ready: false, repair: { actor: "human-required", action: "run_verified_update_recovery" } } })],
    ["package-managed Sanctuary bundle is not ready", () => packageManagement.inspect.mockReturnValue({ ok: false, error: { code: "invalid_journal", message: "Sanctuary update recovery is required", degraded: true, repair: { actor: "human-required", action: "run_verified_update_recovery" } } })],
    ["package-managed Sanctuary inspection unavailable", () => packageManagement.inspect.mockImplementation(() => { throw new Error("raw path") })],
  ])("fails readiness before process inventory when %s", (reason, arrange) => {
    arrange()
    expect(() => run()).toThrow(reason)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it.each([
    [["node", "healthcheck", "--agent", "sanctuary"]],
    [["node", "healthcheck", "--package-managed-agent", "sanctuary", "--package-managed-agent", "sanctuary", "--agent", "sanctuary"]],
  ])("rejects a missing or duplicate package flag through the shared activation parser", (argv) => {
    packageManagement.resolve.mockReturnValue({ kind: "invalid", failure: new Error("bounded") })
    expect(() => run(argv)).toThrow("invalid package-managed Sanctuary activation")
    expect(packageManagement.resolve).toHaveBeenCalledWith(expect.objectContaining({ mode: "production", argv, managedAgents: ["sanctuary"] }))
    expect(packageManagement.inspect).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it("accepts exact parity with a preserved rollback journal", () => {
    packageManagement.inspect.mockReturnValue({ ok: true, data: { runtimePackageVersion: "0.1.0-alpha.798", packagedBundleVersion: "0.1.0-alpha.798", liveBundleVersion: "0.1.0-alpha.798", parity: "exact", mismatchCodes: [], journalState: "rollback", ready: true, repair: { actor: "none", action: "none" } } })
    expect(() => run()).not.toThrow()
  })

  it("uses the live process arguments and clock by default", () => {
    const originalArgv = process.argv
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW)
    process.argv = ["node", "healthcheck", "--package-managed-agent", "sanctuary", "--agent", "sanctuary"]
    try {
      expect(() => runContainerHealthcheck()).not.toThrow()
    } finally {
      process.argv = originalArgv
      now.mockRestore()
    }
  })

  it("runs only when invoked as the container entrypoint", () => {
    const runner = vi.fn()

    runContainerHealthcheckMain(false, runner)
    expect(runner).not.toHaveBeenCalled()

    runContainerHealthcheckMain(true, runner)
    expect(runner).toHaveBeenCalledTimes(1)
  })
})
