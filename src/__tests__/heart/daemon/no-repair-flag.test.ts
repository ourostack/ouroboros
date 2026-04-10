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

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(async () => ({ ok: true, data: {} })),
    startDaemonProcess: vi.fn(async () => ({ pid: 123 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
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
    mocks.pollDaemonStartup.mockResolvedValueOnce({ stable: ["agent1"], degraded: [] })

    const deps = makeDeps({ promptInput })

    await runOuroCli(["up", "--no-repair"], deps)

    // No repair prompts issued
    expect(promptInput).not.toHaveBeenCalled()
  })

  it("ouro up --no-repair with degraded agents skips repair and writes degraded summary", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_repair_degraded_test", message: "test" })
    const promptInput = vi.fn(async () => "y")
    const writeStdout = vi.fn()
    mocks.pollDaemonStartup.mockResolvedValueOnce({
      stable: [],
      degraded: [
        { agent: "slugger", errorReason: "missing credentials", fixHint: "run ouro auth slugger" },
        { agent: "helper", errorReason: "stopped" },
      ],
    })

    const deps = makeDeps({ promptInput, writeStdout })

    await runOuroCli(["up", "--no-repair"], deps)

    // No repair prompts issued — the key behavioral difference
    expect(promptInput).not.toHaveBeenCalled()
    // Should write degraded summary to stdout
    const allOutput = writeStdout.mock.calls.map((c: any[]) => c[0]).join("\n")
    expect(allOutput).toContain("slugger")
    expect(allOutput).toContain("helper: stopped")
    expect(allOutput).toContain("fix: run ouro auth slugger")
    expect(allOutput).toMatch(/degrad/i)
  })

  it("ouro up (no flag) with degraded agents enters interactive repair", async () => {
    emitNervesEvent({ component: "daemon", event: "daemon.no_flag_degraded_test", message: "test" })
    const promptInput = vi.fn(async () => "n")
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
