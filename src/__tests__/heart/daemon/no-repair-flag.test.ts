import * as fs from "fs"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"

// Hoisted mocks
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => ({ updated: [] })),
  registerUpdateHook: vi.fn(),
  pollDaemonStartup: vi.fn(async () => ({ stable: [], degraded: [] })),
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
  pollDaemonStartup: (...a: any[]) => mocks.pollDaemonStartup(...a),
  assessStability: vi.fn(),
  renderStartupProgress: vi.fn(() => ""),
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { runOuroCli } from "../../../heart/daemon/daemon-cli"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
) as { version: string }

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(async (_socketPath, command) => {
      if (command.kind === "daemon.status") {
        return {
          ok: true,
          data: {
            overview: {
              daemon: "running",
              health: "ok",
              socketPath: "/tmp/ouro-test.sock",
              version: PACKAGE_VERSION.version,
              workerCount: 0,
              senseCount: 0,
            },
            senses: [],
            workers: [],
          },
        }
      }
      return { ok: true, data: {} }
    }),
    startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    listDiscoveredAgents: vi.fn(async () => []),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    bundlesRoot: "/tmp/ouro-test-bundles-nonexistent",
    ...overrides,
  }
}

describe("--no-repair flag: parsing", () => {
  it("parses 'ouro up --no-repair' with noRepair: true", () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_parse_test", message: "test" })
    const cmd = parseOuroCommand(["up", "--no-repair"])
    expect(cmd).toEqual({ kind: "daemon.up", noRepair: true })
  })

  it("parses 'ouro up' without noRepair field", () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_parse_default_test", message: "test" })
    const cmd = parseOuroCommand(["up"])
    expect(cmd).toEqual({ kind: "daemon.up" })
  })

  it("parses bare 'ouro' (no args) without noRepair field", () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_parse_bare_test", message: "test" })
    const cmd = parseOuroCommand([])
    expect(cmd).toEqual({ kind: "daemon.up" })
  })
})

describe("--no-repair flag: daemon.up handler", () => {
  it("ouro up --no-repair with all agents healthy exits cleanly, no repair prompts", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_healthy_test", message: "test" })
    const promptInput = vi.fn(async () => "y")
    const setExitCode = vi.fn()
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["agent1"], degraded: [] })

    const deps = makeDeps({ promptInput, setExitCode })

    await runOuroCli(["up", "--no-repair"], deps)

    // No repair prompts issued
    expect(promptInput).not.toHaveBeenCalled()
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it("ouro up --no-repair with degraded agents skips repair and writes degraded summary", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_degraded_test", message: "test" })
    const promptInput = vi.fn(async () => "y")
    const writeStdout = vi.fn()
    const setExitCode = vi.fn()
    mocks.pollDaemonStartup.mockResolvedValueOnce({
      stable: [],
      degraded: [
        { agent: "slugger", errorReason: "missing credentials", fixHint: "run ouro auth slugger" },
        { agent: "helper", errorReason: "stopped" },
      ],
    })

    const deps = makeDeps({ promptInput, writeStdout, setExitCode })

    await runOuroCli(["up", "--no-repair"], deps)

    // No repair prompts issued — the key behavioral difference
    expect(promptInput).not.toHaveBeenCalled()
    // Should write degraded summary to stdout
    const allOutput = writeStdout.mock.calls.map((c: any[]) => c[0]).join("\n")
    expect(allOutput).toContain("slugger")
    expect(allOutput).toContain("helper: stopped")
    expect(allOutput).toContain("next: run ouro auth slugger")
    expect(allOutput).toContain("Provider checks need attention")
    expect(allOutput).toContain("Provider checks need attention\n\nslugger: missing credentials")
    expect(allOutput).toContain("\n\nhelper: stopped")
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it("ouro up --no-repair reports degraded agents when the daemon is already running", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_existing_degraded_test", message: "test" })
    const promptInput = vi.fn(async () => "y")
    const writeStdout = vi.fn()
    const setExitCode = vi.fn()
    mocks.pollDaemonStartup.mockResolvedValueOnce({
      stable: ["slugger"],
      degraded: [
        { agent: "ouroboros", errorReason: "missing github-copilot provider", fixHint: "run ouro auth ouroboros" },
      ],
    })

    const deps = makeDeps({
      promptInput,
      writeStdout,
      setExitCode,
      checkSocketAlive: vi.fn(async () => true),
      sendCommand: vi.fn(async () => ({
        ok: true,
        data: {
          overview: {
            daemon: "running",
            health: "warn",
            socketPath: "/tmp/ouro-test.sock",
            outlookUrl: "unavailable",
            version: PACKAGE_VERSION.version,
            lastUpdated: "unknown",
            repoRoot: "unknown",
            configFingerprint: "unknown",
            workerCount: 0,
            senseCount: 0,
            entryPath: "unknown",
            mode: "production",
          },
          senses: [],
          workers: [],
        },
      })),
    })

    await runOuroCli(["up", "--no-repair"], deps)

    expect(promptInput).not.toHaveBeenCalled()
    expect(mocks.pollDaemonStartup).toHaveBeenCalledWith(expect.objectContaining({
      daemonPid: null,
      socketPath: "/tmp/ouro-test.sock",
    }))
    const allOutput = writeStdout.mock.calls.map((c: any[]) => c[0]).join("\n")
    expect(allOutput).toContain("\u2713 starting daemon \u2014 already running")
    expect(allOutput).toContain("ouroboros: missing github-copilot provider")
    expect(allOutput).toContain("next: run ouro auth ouroboros")
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it("ouro up (no flag) with degraded agents enters interactive repair", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_flag_degraded_test", message: "test" })
    const promptInput = vi.fn(async () => "y")
    mocks.pollDaemonStartup.mockResolvedValueOnce({
      stable: [],
      degraded: [
        { agent: "slugger", errorReason: "missing credentials", fixHint: "run ouro auth slugger" },
      ],
    })

    const deps = makeDeps({ promptInput })

    await runOuroCli(["up"], deps)

    // Interactive repair SHOULD prompt (existing Unit 5 behavior)
    expect(promptInput).toHaveBeenCalled()
  })
})
