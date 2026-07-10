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

vi.mock("../../../heart/runtime-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/runtime-credentials")>("../../../heart/runtime-credentials")
  return {
    ...actual,
    refreshRuntimeCredentialConfig: vi.fn(async (agentName: string) => ({
      ok: false,
      reason: "missing",
      itemPath: `vault:${agentName}:runtime/config`,
      error: `no runtime credentials stored at vault:${agentName}:runtime/config`,
    })),
    refreshMachineRuntimeCredentialConfig: vi.fn(async (agentName: string, machineId: string) => ({
      ok: false,
      reason: "missing",
      itemPath: `vault:${agentName}:runtime/machines/${machineId}/config`,
      error: `no machine runtime credentials stored at vault:${agentName}:runtime/machines/${machineId}/config`,
    })),
  }
})

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: vi.fn(() => ({ machineId: "machine_test" })),
}))

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"

const forbiddenCliIncidentChatGuid = "any;+;rsvp-cli-secret-chat"

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

function seedRsvpOperationalBundle(): ReturnType<typeof createTmpBundle> {
  const tmp = createTmpBundle({ agentName: "slugger" })
  fs.mkdirSync(path.join(tmp.agentRoot, "habits"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "rsvp"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "state", "senses", "context-packets"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "state", "rsvp", "outbound"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "state", "rsvp", "snapshots"), { recursive: true })
  fs.writeFileSync(
    path.join(tmp.agentRoot, "habits", "rsvp-ari-rachel.md"),
    "---\nname: rsvp-ari-rachel\nstatus: active\ncadence: 0 10 * * *\n---\n",
    "utf-8",
  )
  fs.writeFileSync(path.join(tmp.agentRoot, "rsvp", "config.json"), JSON.stringify({
    schemaVersion: 1,
    policyVersion: "rsvp-config/v1",
    agent: "slugger",
    mode: "shadow",
    source: { kind: "aisleplanner", weddingId: "484532", eventId: "2081539" },
    credentialRef: { runtimeConfigItem: "runtime/config", runtimeConfigPath: "rsvp.aisleplanner" },
    bluebubblesRoute: { chatGuid: forbiddenCliIncidentChatGuid, chatIdentifier: "wedding-chat" },
  }), "utf-8")
  fs.writeFileSync(path.join(tmp.agentRoot, "state", "senses", "context-packets", "ledger.jsonl"), `${JSON.stringify({
    id: "ctx_cli_1",
    sense: "bluebubbles",
    scope: "same-chat",
    createdAt: "2026-07-09T18:00:00.000Z",
  })}\n`, "utf-8")
  fs.writeFileSync(path.join(tmp.agentRoot, "state", "rsvp", "outbound", "ledger.json"), JSON.stringify({
    reservations: [{ idempotencyKey: "rsvp:cli", status: "accepted" }],
  }), "utf-8")
  fs.writeFileSync(path.join(tmp.agentRoot, "state", "rsvp", "snapshots", "latest.json"), JSON.stringify({
    snapshotId: "snap_cli_latest",
    counts: { attending: 149, declined: 123, pending: 1 },
  }), "utf-8")
  fs.writeFileSync(path.join(tmp.agentRoot, "state", "rsvp", "spend-ledger.json"), JSON.stringify({
    runs: [{ operationId: "habit_cli_1", provider: "none", tokens: 0 }],
  }), "utf-8")
  return tmp
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
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--allow-send"])).toThrow(/shadow.*allow-send/)
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

  it("executes RSVP legacy-render offline and leaves the legacy root byte-unchanged", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-cli-legacy-render-"))
    const outputPath = path.join(os.tmpdir(), `rsvp-cli-legacy-render-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(path.join(legacyRoot, "guests.json"), JSON.stringify({
      guests: {
        pending_1: { first_name: "Casey", last_name: "Pending", attending_status: "pending" },
      },
    }), "utf-8")
    const before = fs.readdirSync(legacyRoot).map((name) => [name, fs.readFileSync(path.join(legacyRoot, name), "utf-8")])
    const deps = createMockDeps()
    try {
      const result = await runOuroCli(["rsvp", "legacy-render", "--legacy-root", legacyRoot, "--output", outputPath], deps)
      const rendered = JSON.parse(fs.readFileSync(outputPath, "utf-8"))

      expect(result).toContain(outputPath)
      expect(result).not.toMatch(/registered|planned/i)
      expect(rendered).toMatchObject({
        schemaVersion: 1,
        sideEffect: false,
        legacyRootHashBefore: expect.any(String),
        legacyRootHashAfter: expect.any(String),
      })
      expect(rendered.legacyRootHashAfter).toBe(rendered.legacyRootHashBefore)
      expect(fs.readdirSync(legacyRoot).map((name) => [name, fs.readFileSync(path.join(legacyRoot, name), "utf-8")])).toEqual(before)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(legacyRoot, { recursive: true, force: true })
      fs.rmSync(outputPath, { force: true })
    }
  })

  it("supports legacy-render JSON mode with a generated output path", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-cli-legacy-render-json-"))
    fs.writeFileSync(path.join(legacyRoot, "guests.json"), JSON.stringify({
      guests: {
        pending_1: { first_name: "Casey", last_name: "Pending", attending_status: "pending" },
      },
    }), "utf-8")
    const deps = createMockDeps()
    try {
      const result = await runOuroCli(["rsvp", "legacy-render", "--legacy-root", legacyRoot, "--json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed).toMatchObject({
        ok: true,
        command: "rsvp.legacy-render",
        sideEffect: false,
        result: {
          sideEffect: false,
          outputPath: expect.stringContaining("ouro-rsvp-legacy-render-"),
        },
      })
      expect(fs.existsSync(parsed.result.outputPath)).toBe(true)
      fs.rmSync(parsed.result.outputPath, { force: true })
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(legacyRoot, { recursive: true, force: true })
    }
  })

  it("executes RSVP replay fixtures without daemon or live endpoint access", async () => {
    const tmp = seedRsvpOperationalBundle()
    const fixturePath = path.join(os.tmpdir(), `rsvp-cli-fixture-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(fixturePath, JSON.stringify({
      schemaVersion: 1,
      policyVersion: "rsvp-replay/v1",
      agent: "slugger",
      expected: {
        contextPacketHash: "sha256:fixture-context",
        modelInputHash: "sha256:fixture-model-input",
      },
      privacy: {
        rawLiveTranscriptStored: false,
        searchIndex: false,
        vectorIndex: false,
      },
      question: "who is pending?",
      snapshot: {
        snapshotId: "snap_cli_latest",
        pendingGuests: ["Casey Pending"],
      },
    }), "utf-8")
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = await runOuroCli(["rsvp", "replay", "--agent", "slugger", "--fixture", fixturePath, "--json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed).toMatchObject({
        ok: true,
        command: "rsvp.replay",
        agent: "slugger",
        sideEffect: false,
        replay: {
          contextPacketHash: "sha256:fixture-context",
          modelInputHash: "sha256:fixture-model-input",
          answer: expect.stringContaining("Casey Pending"),
        },
      })
      expect(result).not.toMatch(/registered|planned/i)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(fixturePath, { force: true })
      tmp.cleanup()
    }
  })

  it("writes explicit RSVP output files and supports text mode without daemon access", async () => {
    const tmp = seedRsvpOperationalBundle()
    const outputPath = path.join(os.tmpdir(), `rsvp-cli-incident-${process.pid}-${Date.now()}.json`)
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = await runOuroCli(["rsvp", "incident", "--agent", "slugger", "--output", outputPath], deps)
      const written = JSON.parse(fs.readFileSync(outputPath, "utf-8"))

      expect(result).toContain(outputPath)
      expect(written).toMatchObject({
        schemaVersion: 1,
        agent: "slugger",
        sideEffect: false,
        latestFetch: {
          snapshotId: "snap_cli_latest",
        },
      })
      expect(deps.writeStdout).toHaveBeenCalledWith(result)
      expect(deps.sendCommand).not.toHaveBeenCalled()

      const textOnly = await runOuroCli(["rsvp", "incident", "--agent", "slugger"], deps)
      expect(textOnly).toBe("rsvp.incident: wrote side-effect-free bundle agent=slugger")
    } finally {
      fs.rmSync(outputPath, { force: true })
      tmp.cleanup()
    }
  })

  it("runs RSVP doctor locally with stable check ids instead of returning a placeholder registration", async () => {
    const tmp = seedRsvpOperationalBundle()
    const setExitCode = vi.fn()
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, setExitCode })
    try {
      const result = await runOuroCli(["rsvp", "doctor", "--agent", "slugger", "--json", "--strict"], deps)
      const parsed = JSON.parse(result)

      expect(parsed).toMatchObject({
        ok: false,
        command: "rsvp.doctor",
        agent: "slugger",
        sideEffect: false,
        strict: true,
        doctor: {
          summary: expect.objectContaining({ failed: expect.any(Number) }),
          categories: [
            expect.objectContaining({
              name: "RSVP",
              checks: expect.arrayContaining([
                expect.objectContaining({ id: "rsvp.native_config" }),
                expect.objectContaining({ id: "rsvp.context_packet_ledger" }),
                expect.objectContaining({ id: "rsvp.habit.schedule" }),
                expect.objectContaining({ id: "rsvp.latest_fetch" }),
                expect.objectContaining({ id: "rsvp.delivery.reconciliation" }),
                expect.objectContaining({ id: "rsvp.spend_timeline" }),
              ]),
            }),
          ],
        },
      })
      expect(result).not.toMatch(/registered|planned/i)
      expect(setExitCode).toHaveBeenCalledWith(1)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("runs RSVP doctor with injected cutover deps even when PATH is unavailable", async () => {
    const tmp = seedRsvpOperationalBundle()
    const originalPath = process.env.PATH
    const deps = createMockDeps({
      bundlesRoot: tmp.bundlesRoot,
      rsvpCutoverDeps: {
        getLaunchAgentState: vi.fn(async () => ({ label: "com.arimendelow.rsvp-tracker", loaded: false, source: "injected" })),
        getLegacyProcessState: vi.fn(async () => ({ running: false, count: 0, source: "injected" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      },
    })
    try {
      delete process.env.PATH
      const result = await runOuroCli(["rsvp", "doctor", "--agent", "slugger", "--json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed).toMatchObject({
        command: "rsvp.doctor",
        sideEffect: false,
        doctor: {
          categories: [
            expect.objectContaining({ name: "RSVP" }),
          ],
        },
      })
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
      tmp.cleanup()
    }
  })

  it("writes the real RSVP incident bundle from the CLI without leaking raw BlueBubbles coordinates", async () => {
    const tmp = seedRsvpOperationalBundle()
    const outputPath = path.join(os.tmpdir(), `rsvp-cli-incident-real-${process.pid}-${Date.now()}.json`)
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
      const result = await runOuroCli(["rsvp", "incident", "--agent", "slugger", "--output", outputPath], deps)
      const written = JSON.parse(fs.readFileSync(outputPath, "utf-8"))

      expect(result).toContain(outputPath)
      expect(result).not.toMatch(/registered|planned/i)
      expect(written).toMatchObject({
        schemaVersion: 1,
        agent: "slugger",
        sideEffect: false,
        doctor: {
          summary: expect.objectContaining({ failed: expect.any(Number) }),
        },
        contextPacketLedger: {
          latestPacketId: "ctx_cli_1",
        },
        habitSchedule: {
          activeHabit: "rsvp-ari-rachel",
        },
      })
      expect(JSON.stringify(written)).not.toContain(forbiddenCliIncidentChatGuid)
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(outputPath, { force: true })
      tmp.cleanup()
    }
  })

  it("rejects RSVP incident bundle execution without an agent before reading bundle state", async () => {
    const deps = createMockDeps()

    const result = await runOuroCli(["rsvp", "incident", "--json"], deps)
    const parsed = JSON.parse(result)

    expect(parsed).toMatchObject({
      ok: false,
      command: "rsvp.incident",
      sideEffect: false,
      requires: "--agent",
    })
    expect(deps.sendCommand).not.toHaveBeenCalled()
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

  it("surfaces unsuccessful legacy config imports from the local RSVP CLI", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-cli-failure-"))
    mockRsvpConfig.importLegacyRsvpConfig.mockResolvedValue({
      ok: false,
      reason: "missing_secret",
      actor: "human-required",
      message: "legacy RSVP secret is missing",
    })
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    try {
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
        message: "legacy RSVP secret is missing",
        result: { ok: false, reason: "missing_secret" },
      })
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

  it("passes no-agent cutover previews through injected cutover deps and preserves the --yes gate", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-cli-cutover-no-agent-"))
    const deps = createMockDeps({
      rsvpCutoverDeps: {
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => JSON.stringify({ bluebubbles: { enabled: false } })),
        getLaunchAgentState: vi.fn(async () => ({ label: "com.arimendelow.rsvp-tracker", loaded: false, source: "injected" })),
        getLegacyProcessState: vi.fn(async () => ({ running: false, count: 0, source: "injected" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      },
    })
    try {
      const result = JSON.parse(await runOuroCli([
        "rsvp",
        "cutover",
        "--legacy-root",
        legacyRoot,
        "--action",
        "retire-legacy-send-config",
        "--json",
      ], deps))

      expect(result).toMatchObject({
        ok: false,
        command: "rsvp.cutover",
        sideEffect: false,
        action: "retire-legacy-send-config",
        requires: "--yes",
      })
      expect(result).not.toHaveProperty("agent")
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(legacyRoot, { recursive: true, force: true })
    }
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
