import { beforeEach, describe, expect, it, vi } from "vitest"

const { statSync, readFileSync, existsSync, homedir, execFileSync } = vi.hoisted(() => ({
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  homedir: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock("node:fs", () => ({ statSync, readFileSync, existsSync }))
vi.mock("node:os", () => ({ homedir }))
vi.mock("node:child_process", () => ({ execFileSync }))

import { runContainerHealthcheck } from "../../../heart/daemon/container-healthcheck"

const NOW = 1_800_000_000_000
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

function run(argv = ["node", "healthcheck", "--agent", "sanctuary"]): void {
  runContainerHealthcheck({ argv, now: () => NOW })
}

describe("container healthcheck", () => {
  beforeEach(() => {
    homedir.mockReset().mockReturnValue("/home/ouro")
    statSync.mockReset().mockReturnValue({ mtimeMs: NOW - 1_000 })
    readFileSync.mockReset().mockReturnValue(JSON.stringify(healthyState()))
    existsSync.mockReset().mockReturnValue(true)
    execFileSync.mockReset().mockReturnValue(`${TELEGRAM}\n${SUPERCRONIC}\n`)
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
    ["managed agent is not running", () => { existsSync.mockImplementation((value: string) => value !== "/proc/22"); run() }],
    ["managed process inventory is unavailable", () => { execFileSync.mockImplementation(() => { throw new Error("ps failed") }); run() }],
    ["managed Telegram sense is not running exactly once", () => { execFileSync.mockReturnValue(SUPERCRONIC); run() }],
    ["managed Supercronic scheduler is not running exactly once", () => { execFileSync.mockReturnValue(TELEGRAM); run() }],
  ])("fails closed when %s", (reason, action) => {
    expect(action).toThrow(reason)
    expect(process.exitCode).toBe(1)
  })

  it("accepts a partial daemon status", () => {
    readFileSync.mockReturnValue(JSON.stringify(healthyState({ status: "partial" })))
    expect(() => run()).not.toThrow()
  })

  it("uses the live process arguments and clock by default", () => {
    const originalArgv = process.argv
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW)
    process.argv = ["node", "healthcheck", "--agent", "sanctuary"]
    try {
      expect(() => runContainerHealthcheck()).not.toThrow()
    } finally {
      process.argv = originalArgv
      now.mockRestore()
    }
  })
})
