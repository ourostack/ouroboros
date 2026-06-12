import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

const { mockGetAgentDaemonLogsDir } = vi.hoisted(() => ({
  mockGetAgentDaemonLogsDir: vi.fn(),
}))

vi.mock("../../../heart/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../heart/identity")>()),
  getAgentDaemonLogsDir: (...args: any[]) => mockGetAgentDaemonLogsDir(...args),
}))

import { getCommandHelp } from "../../../heart/daemon/cli-help"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn(async () => true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    listDiscoveredAgents: vi.fn(async () => ["slugger"]),
    ...overrides,
  }
}

function eventLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    time: "2026-06-11T20:00:00.000Z",
    level: "info",
    component: "daemon",
    event: "daemon.habit_run_complete",
    message: "habit run complete",
    ...overrides,
  })
}

describe("ouro nerves-review CLI", () => {
  const cleanup: string[] = []

  afterEach(() => {
    mockGetAgentDaemonLogsDir.mockReset()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("parses review filters and json output", () => {
    expect(parseOuroCommand([
      "nerves-review",
      "--agent", "slugger",
      "--process", "mailbox",
      "--component", "daemon",
      "--event", "habit",
      "--since", "30m",
      "--limit", "5",
      "--json",
    ])).toEqual({
      kind: "nerves-review",
      agent: "slugger",
      process: "mailbox",
      component: "daemon",
      event: "habit",
      since: "30m",
      limit: 5,
      json: true,
    })
  })

  it("includes nerves-review help in command registry", () => {
    const help = getCommandHelp("nerves-review")
    expect(help).toContain("ouro nerves-review")
    expect(help).toContain("--component")
    expect(help).toContain("--event")
  })

  it("prints focused nerves-review help through CLI help routing", async () => {
    const deps = makeDeps()

    expect(parseOuroCommand(["nerves-review", "--help"])).toEqual({ kind: "help", command: "nerves-review" })
    const result = await runOuroCli(["nerves-review", "--help"], deps)

    expect(result).toContain("ouro nerves-review")
    expect(result).toContain("--since <duration>")
    expect(result).toContain("--json")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("rejects invalid limits and unknown options at parse time", () => {
    expect(() => parseOuroCommand(["nerves-review", "--limit", "0"])).toThrow("--limit must be an integer between 1 and 1000")
    expect(() => parseOuroCommand(["nerves-review", "--limit", "1001"])).toThrow("--limit must be an integer between 1 and 1000")
    expect(() => parseOuroCommand(["nerves-review", "--limit", "01"])).toThrow("--limit must be an integer between 1 and 1000")
    expect(() => parseOuroCommand(["nerves-review", "--event"])).toThrow("Usage")
    expect(() => parseOuroCommand(["nerves-review", "--unknown"])).toThrow("Usage")
  })

  it("prints filtered text output from local nerves logs without daemon access", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-review-"))
    cleanup.push(logsDir)
    fs.writeFileSync(path.join(logsDir, "daemon.ndjson"), [
      eventLine({ component: "mailbox", event: "mailbox.started", message: "mailbox started" }),
      eventLine({ component: "daemon", event: "daemon.habit_run_complete", message: "habit done" }),
    ].join("\n") + "\n", "utf-8")
    mockGetAgentDaemonLogsDir.mockReturnValue(logsDir)
    const deps = makeDeps()

    const result = await runOuroCli(["nerves-review", "--agent", "slugger", "--component", "daemon", "--event", "habit"], deps)

    expect(mockGetAgentDaemonLogsDir).toHaveBeenCalledWith("slugger")
    expect(result).toContain("daemon/daemon.habit_run_complete")
    expect(result).toContain("habit done")
    expect(result).not.toContain("mailbox started")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("resolves a sole discovered agent and filters by level", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-review-level-"))
    cleanup.push(logsDir)
    fs.writeFileSync(path.join(logsDir, "daemon.ndjson"), [
      eventLine({ level: "info", message: "quiet info" }),
      eventLine({ level: "warn", message: "important warning" }),
    ].join("\n") + "\n", "utf-8")
    mockGetAgentDaemonLogsDir.mockReturnValue(logsDir)
    const deps = makeDeps({ listDiscoveredAgents: vi.fn(async () => ["slugger"]) })

    const result = await runOuroCli(["nerves-review", "--level", "warn"], deps)

    expect(mockGetAgentDaemonLogsDir).toHaveBeenCalledWith("slugger")
    expect(result).toContain("[warn ]")
    expect(result).toContain("important warning")
    expect(result).not.toContain("quiet info")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("prints a no-match message for missing local nerves logs", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-review-empty-"))
    cleanup.push(logsDir)
    mockGetAgentDaemonLogsDir.mockReturnValue(logsDir)
    const deps = makeDeps()

    const result = await runOuroCli(["nerves-review", "--agent", "slugger", "--component", "absent"], deps)

    expect(result).toBe(`(no matching nerves events in ${path.join(logsDir, "daemon.ndjson")})`)
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("returns agent-selection guidance before reading logs when multiple agents are discovered", async () => {
    const deps = makeDeps({ listDiscoveredAgents: vi.fn(async () => ["alpha", "beta"]) })

    const result = await runOuroCli(["nerves-review"], deps)

    expect(result).toContain("multiple agents found: alpha, beta")
    expect(result).toContain("Re-run with --agent <name>.")
    expect(mockGetAgentDaemonLogsDir).not.toHaveBeenCalled()
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("prints raw JSON lines when --json is set", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-review-json-"))
    cleanup.push(logsDir)
    const raw = eventLine({ component: "mailbox", event: "mailbox.habit_run_summary_read" })
    fs.writeFileSync(path.join(logsDir, "mailbox.ndjson"), `${raw}\n`, "utf-8")
    mockGetAgentDaemonLogsDir.mockReturnValue(logsDir)

    const result = await runOuroCli(["nerves-review", "--agent", "slugger", "--process", "mailbox", "--json"], makeDeps())

    expect(result).toBe(raw)
  })

  it("sets exit code 2 for invalid durations", async () => {
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-review-invalid-"))
    cleanup.push(logsDir)
    mockGetAgentDaemonLogsDir.mockReturnValue(logsDir)
    const setExitCode = vi.fn()

    const result = await runOuroCli(["nerves-review", "--since", "forever"], makeDeps({ setExitCode }))

    expect(result).toContain("not a valid duration")
    expect(setExitCode).toHaveBeenCalledWith(2)
  })
})
