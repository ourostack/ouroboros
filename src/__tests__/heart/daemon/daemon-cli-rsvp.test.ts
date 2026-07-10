import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const mockRsvpConfig = vi.hoisted(() => ({
  importLegacyRsvpConfig: vi.fn(),
}))

vi.mock("../../../rsvp/config", async () => {
  const actual = await vi.importActual<typeof import("../../../rsvp/config")>("../../../rsvp/config")
  return {
    ...actual,
    importLegacyRsvpConfig: mockRsvpConfig.importLegacyRsvpConfig,
  }
})

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockRejectedValue(new Error("daemon should not be called")),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

afterEach(() => {
  mockRsvpConfig.importLegacyRsvpConfig.mockReset()
})

describe("ouro rsvp CLI parsing", () => {
  it("parses the native RSVP operational command group", () => {
    expect(parseOuroCommand(["rsvp", "doctor", "--agent", "slugger", "--json", "--strict"])).toEqual({
      kind: "rsvp.doctor",
      agent: "slugger",
      json: true,
      strict: true,
    })
    expect(parseOuroCommand(["rsvp", "incident", "--agent", "slugger", "--output", "/tmp/rsvp-incident.json"])).toEqual({
      kind: "rsvp.incident",
      agent: "slugger",
      outputPath: "/tmp/rsvp-incident.json",
    })
    expect(parseOuroCommand([
      "rsvp",
      "cutover",
      "--agent",
      "slugger",
      "--legacy-root",
      "/Users/arimendelow/Projects/rsvp-tracker",
      "--action",
      "check",
      "--json",
    ])).toEqual({
      kind: "rsvp.cutover",
      agent: "slugger",
      legacyRoot: "/Users/arimendelow/Projects/rsvp-tracker",
      action: "check",
      json: true,
    })
    expect(parseOuroCommand([
      "rsvp",
      "legacy-render",
      "--legacy-root",
      "/Users/arimendelow/Projects/rsvp-tracker",
      "--output",
      "/tmp/legacy.json",
    ])).toEqual({
      kind: "rsvp.legacy-render",
      legacyRoot: "/Users/arimendelow/Projects/rsvp-tracker",
      outputPath: "/tmp/legacy.json",
    })
    expect(parseOuroCommand(["rsvp", "replay", "--agent", "slugger", "--fixture", "/tmp/replay.json", "--json"])).toEqual({
      kind: "rsvp.replay",
      agent: "slugger",
      fixturePath: "/tmp/replay.json",
      json: true,
    })
    expect(parseOuroCommand([
      "rsvp",
      "config",
      "import-legacy",
      "--agent",
      "slugger",
      "--legacy-root",
      "/Users/arimendelow/Projects/rsvp-tracker",
      "--mode",
      "shadow",
      "--yes",
      "--output",
      "/tmp/import.json",
    ])).toEqual({
      kind: "rsvp.config.import-legacy",
      agent: "slugger",
      legacyRoot: "/Users/arimendelow/Projects/rsvp-tracker",
      mode: "shadow",
      yes: true,
      outputPath: "/tmp/import.json",
    })
    expect(parseOuroCommand([
      "rsvp",
      "habit",
      "stage",
      "--agent",
      "slugger",
      "--mode",
      "shadow",
      "--cadence",
      "0 10 * * *",
      "--output",
      "/tmp/habit.json",
    ])).toEqual({
      kind: "rsvp.habit.stage",
      agent: "slugger",
      mode: "shadow",
      cadence: "0 10 * * *",
      outputPath: "/tmp/habit.json",
    })
    expect(parseOuroCommand([
      "rsvp",
      "import-legacy",
      "--agent",
      "slugger",
      "--legacy-root",
      "/Users/arimendelow/Projects/rsvp-tracker",
      "--mode",
      "shadow",
      "--output",
      "/tmp/import-legacy.json",
    ])).toEqual({
      kind: "rsvp.import-legacy",
      agent: "slugger",
      legacyRoot: "/Users/arimendelow/Projects/rsvp-tracker",
      mode: "shadow",
      outputPath: "/tmp/import-legacy.json",
    })
    expect(parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--output", "/tmp/refresh.json"])).toEqual({
      kind: "rsvp.refresh",
      agent: "slugger",
      mode: "shadow",
      noSend: true,
      outputPath: "/tmp/refresh.json",
    })
    expect(parseOuroCommand(["rsvp", "compare", "--agent", "slugger", "--native", "/tmp/native.json", "--legacy", "/tmp/legacy.json", "--output", "/tmp/compare.json"])).toEqual({
      kind: "rsvp.compare",
      agent: "slugger",
      nativePath: "/tmp/native.json",
      legacyPath: "/tmp/legacy.json",
      outputPath: "/tmp/compare.json",
    })
    expect(parseOuroCommand([
      "rsvp",
      "smoke",
      "--agent",
      "slugger",
      "--mode",
      "preflight",
      "--surface",
      "bluebubbles",
      "--question",
      "who is pending?",
      "--output",
      "/tmp/smoke.json",
      "--replay-output",
      "/tmp/replay.json",
    ])).toEqual({
      kind: "rsvp.smoke",
      agent: "slugger",
      mode: "preflight",
      surface: "bluebubbles",
      question: "who is pending?",
      outputPath: "/tmp/smoke.json",
      replayOutputPath: "/tmp/replay.json",
    })
    expect(parseOuroCommand(["rsvp", "smoke", "--agent", "slugger", "--mode", "live", "--surface", "bluebubbles", "--allow-send"])).toEqual({
      kind: "rsvp.smoke",
      agent: "slugger",
      mode: "live",
      surface: "bluebubbles",
      allowSend: true,
    })
  })

  it("rejects unsafe or malformed RSVP invocations with focused guidance", () => {
    expect(() => parseOuroCommand(["rsvp"])).toThrow(/Usage: ouro rsvp/)
    expect(() => parseOuroCommand(["rsvp", "config", "import-legacy", "--agent", "slugger", "--mode", "shadow"])).toThrow(/legacy-root/)
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--allow-send", "--no-send"])).toThrow(/allow-send/)
    expect(() => parseOuroCommand(["rsvp", "smoke", "--agent", "slugger", "--mode", "live", "--surface", "bluebubbles"])).toThrow(/--allow-send/)
    expect(() => parseOuroCommand(["rsvp", "habit", "stage", "--agent", "slugger", "--mode", "live", "--cadence", "daily"])).toThrow(/cadence/)
  })
})

describe("ouro rsvp CLI execution", () => {
  it("dispatches side-effect-free RSVP commands locally without contacting the daemon", async () => {
    const deps = createMockDeps()
    const commands: Array<{ argv: string[]; kind: string }> = [
      { argv: ["rsvp", "doctor", "--agent", "slugger", "--json"], kind: "rsvp.doctor" },
      { argv: ["rsvp", "incident", "--agent", "slugger", "--json"], kind: "rsvp.incident" },
      { argv: ["rsvp", "cutover", "--agent", "slugger", "--legacy-root", "/tmp/legacy-rsvp", "--action", "check", "--json"], kind: "rsvp.cutover" },
      { argv: ["rsvp", "legacy-render", "--legacy-root", "/tmp/legacy-rsvp", "--json"], kind: "rsvp.legacy-render" },
      { argv: ["rsvp", "replay", "--agent", "slugger", "--fixture", "/tmp/replay.json", "--json"], kind: "rsvp.replay" },
      { argv: ["rsvp", "habit", "stage", "--agent", "slugger", "--mode", "shadow", "--cadence", "0 10 * * *", "--json"], kind: "rsvp.habit.stage" },
      { argv: ["rsvp", "import-legacy", "--agent", "slugger", "--legacy-root", "/tmp/legacy-rsvp", "--mode", "shadow", "--json"], kind: "rsvp.import-legacy" },
      { argv: ["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], kind: "rsvp.refresh" },
      { argv: ["rsvp", "compare", "--agent", "slugger", "--native", "/tmp/native.json", "--legacy", "/tmp/legacy.json", "--json"], kind: "rsvp.compare" },
      { argv: ["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], kind: "rsvp.smoke" },
    ]

    for (const command of commands) {
      const result = await runOuroCli(command.argv, deps)
      const parsed = JSON.parse(result)
      expect(parsed).toMatchObject({
        ok: true,
        command: command.kind,
        sideEffect: false,
      })
    }

    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("writes explicit RSVP output files and supports text mode without daemon access", async () => {
    const outputPath = path.join(os.tmpdir(), `rsvp-cli-incident-${process.pid}-${Date.now()}.json`)
    const deps = createMockDeps()
    try {
      const result = await runOuroCli(["rsvp", "incident", "--agent", "slugger", "--output", outputPath], deps)

      expect(result).toBe("rsvp.incident: dry run agent=slugger")
      expect(JSON.parse(fs.readFileSync(outputPath, "utf-8"))).toMatchObject({
        ok: true,
        command: "rsvp.incident",
        sideEffect: false,
        agent: "slugger",
      })
      expect(deps.writeStdout).toHaveBeenCalledWith(result)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(outputPath, { force: true })
    }
  })

  it("requires --yes before legacy config import mutates native RSVP config", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-cli-"))
    try {
      mockRsvpConfig.importLegacyRsvpConfig.mockResolvedValue({
        ok: true,
        configPath: path.join(tmp.agentRoot, "rsvp", "config.json"),
        runtimeConfigItem: "vault:slugger:runtime/config",
        redactedConfig: {
          source: { kind: "aisleplanner", weddingId: "wed-1", eventId: "event-1" },
          bluebubblesRoute: { chatGuid: "iMessage;-;chat" },
          mode: "shadow",
        },
      })
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })

      const preview = await runOuroCli([
        "rsvp",
        "config",
        "import-legacy",
        "--agent",
        "slugger",
        "--legacy-root",
        legacyRoot,
        "--mode",
        "shadow",
        "--json",
      ], deps)
      expect(JSON.parse(preview)).toMatchObject({
        ok: true,
        command: "rsvp.config.import-legacy",
        sideEffect: false,
        requires: "--yes",
      })
      expect(mockRsvpConfig.importLegacyRsvpConfig).not.toHaveBeenCalled()

      const result = await runOuroCli([
        "rsvp",
        "config",
        "import-legacy",
        "--agent",
        "slugger",
        "--legacy-root",
        legacyRoot,
        "--mode",
        "shadow",
        "--yes",
        "--json",
      ], deps)

      expect(JSON.parse(result)).toMatchObject({
        ok: true,
        command: "rsvp.config.import-legacy",
        sideEffect: true,
        result: { ok: true },
      })
      expect(mockRsvpConfig.importLegacyRsvpConfig).toHaveBeenCalledWith(expect.objectContaining({
        agent: "slugger",
        agentRoot: tmp.agentRoot,
        legacyRoot,
        mode: "shadow",
        confirm: true,
      }))
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
      fs.rmSync(legacyRoot, { recursive: true, force: true })
    }
  })

  it("rejects confirmed legacy config import when no agent is selected", async () => {
    const deps = createMockDeps()

    const result = await runOuroCli([
      "rsvp",
      "config",
      "import-legacy",
      "--legacy-root",
      "/tmp/legacy-rsvp",
      "--mode",
      "shadow",
      "--yes",
      "--json",
    ], deps)

    expect(JSON.parse(result)).toMatchObject({
      ok: false,
      command: "rsvp.config.import-legacy",
      sideEffect: false,
      requires: "--agent",
    })
    expect(mockRsvpConfig.importLegacyRsvpConfig).not.toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("only marks live smoke as send-capable when --allow-send is explicit", async () => {
    const deps = createMockDeps()

    const preflight = await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], deps)
    expect(JSON.parse(preflight)).toMatchObject({
      ok: true,
      command: "rsvp.smoke",
      sideEffect: false,
      allowSend: false,
    })

    const live = await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "live", "--surface", "bluebubbles", "--allow-send", "--json"], deps)
    expect(JSON.parse(live)).toMatchObject({
      ok: true,
      command: "rsvp.smoke",
      sideEffect: true,
      allowSend: true,
    })
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })
})
