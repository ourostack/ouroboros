import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const mockRsvpConfig = vi.hoisted(() => ({
  importLegacyRsvpConfig: vi.fn(),
}))

const mockBlueBubblesClient = vi.hoisted(() => ({
  sendText: vi.fn(async () => ({ guid: "TEST-RSVP-SMOKE-GUID" })),
}))

const mockRuntimeCredentialConfig = vi.hoisted(() => ({
  readRuntimeCredentialConfig: vi.fn((agentName: string) => ({
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/config`,
    error: `no runtime credentials loaded for ${agentName}`,
  })),
  readMachineRuntimeCredentialConfig: vi.fn((agentName: string) => ({
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/machines/<this-machine>/config`,
    error: `no machine runtime credentials loaded for ${agentName}`,
  })),
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
    readRuntimeCredentialConfig: mockRuntimeCredentialConfig.readRuntimeCredentialConfig,
    readMachineRuntimeCredentialConfig: mockRuntimeCredentialConfig.readMachineRuntimeCredentialConfig,
    refreshRuntimeCredentialConfig: mockRuntimeCredentialConfig.refreshRuntimeCredentialConfig,
    refreshMachineRuntimeCredentialConfig: mockRuntimeCredentialConfig.refreshMachineRuntimeCredentialConfig,
  }
})

vi.mock("../../../senses/bluebubbles/client", async () => ({
  createBlueBubblesClient: vi.fn(() => mockBlueBubblesClient),
}))

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: vi.fn(() => ({ machineId: "machine_test" })),
}))

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { buildRsvpSnapshot } from "../../../rsvp/snapshot"
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

function passingRsvpCutoverDeps(legacyRoot: string): NonNullable<OuroCliDeps["rsvpCutoverDeps"]> {
  return {
    getLaunchAgentState: vi.fn(async () => ({ label: "com.arimendelow.rsvp-tracker", loaded: false, source: "injected" })),
    getLegacyProcessState: vi.fn(async () => ({ running: false, count: 0, source: "injected" })),
    checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "native BlueBubbles credential healthy" })),
    homeDir: vi.fn(() => path.dirname(legacyRoot)),
  }
}

function writeLatestRsvpSnapshot(agentRoot: string): void {
  const snapshot = buildRsvpSnapshot({
    agent: "slugger",
    fetchedAt: "2026-07-10T10:00:00.000Z",
    source: { kind: "aisleplanner", weddingId: "484532", eventId: "2081539", adapter: "aisleplanner-api-v1" },
    guests: {
      pending_1: { first_name: "Casey", last_name: "Pending", attending_status: null },
      attending_1: { first_name: "Alex", last_name: "Attending", attending_status: "attending" },
    },
    allGuests: {
      pending_1: { first_name: "Casey", last_name: "Pending" },
      attending_1: { first_name: "Alex", last_name: "Attending" },
    },
    provenance: { kind: "live-fetch", fetchedBy: "unit-test" },
  })
  fs.mkdirSync(path.join(agentRoot, "state", "rsvp", "snapshots"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "state", "rsvp", "snapshots", "latest.json"), JSON.stringify(snapshot), "utf-8")
}

function seedRsvpOperationalBundle(): ReturnType<typeof createTmpBundle> {
  const tmp = createTmpBundle({ agentName: "slugger" })
  const legacyRoot = path.join(tmp.agentRoot, "legacy-rsvp")
  fs.mkdirSync(path.join(tmp.agentRoot, "habits"), { recursive: true })
  fs.mkdirSync(legacyRoot, { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "rsvp"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "state", "senses", "context-packets"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "state", "rsvp", "outbound"), { recursive: true })
  fs.mkdirSync(path.join(tmp.agentRoot, "state", "rsvp", "snapshots"), { recursive: true })
  fs.writeFileSync(
    path.join(tmp.agentRoot, "habits", "rsvp-ari-rachel.md"),
    [
      "---",
      "name: rsvp-ari-rachel",
      "status: active",
      "cadence: 0 10 * * *",
      "rsvp:",
      "  policyVersion: rsvp-habit/v1",
      "  mode: shadow",
      "  sense: bluebubbles",
      "  source: aisleplanner",
      "  routeRef: rsvp/config.json#bluebubblesRoute",
      "  snapshotRef: state/rsvp/snapshots/latest.json",
      "  outboundStateRef: state/rsvp/outbound-state.json",
      "  budgetRef: state/rsvp/spend-ledger.json",
      "  idempotencyRef: state/rsvp/outbound-state.json",
      "  liveSendEligible: false",
      "---",
      "",
    ].join("\n"),
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
    cutover: { legacyRoot },
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
  writeLatestRsvpSnapshot(tmp.agentRoot)
  fs.writeFileSync(path.join(tmp.agentRoot, "state", "rsvp", "spend-ledger.json"), JSON.stringify({
    runs: [{ operationId: "habit_cli_1", provider: "none", tokens: 0 }],
  }), "utf-8")
  return tmp
}

afterEach(() => {
  mockRsvpConfig.importLegacyRsvpConfig.mockReset()
  mockBlueBubblesClient.sendText.mockClear()
  mockRuntimeCredentialConfig.readRuntimeCredentialConfig.mockClear()
  mockRuntimeCredentialConfig.readMachineRuntimeCredentialConfig.mockClear()
  mockRuntimeCredentialConfig.refreshRuntimeCredentialConfig.mockClear()
  mockRuntimeCredentialConfig.refreshMachineRuntimeCredentialConfig.mockClear()
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
    expect(() => parseOuroCommand(["rsvp", "bogus"])).toThrow(/Usage: ouro rsvp/)
    expect(() => parseOuroCommand(["rsvp", "config", "bad"])).toThrow(/Usage: ouro rsvp config import-legacy/)
    expect(() => parseOuroCommand(["rsvp", "habit", "bad"])).toThrow(/Usage: ouro rsvp habit stage/)
    expect(parseOuroCommand(["rsvp", "doctor", "--output", "/tmp/rsvp-doctor.json"])).toEqual({
      kind: "rsvp.doctor",
      outputPath: "/tmp/rsvp-doctor.json",
    })
    expect(() => parseOuroCommand(["rsvp", "doctor", "--output", "\n"])).toThrow(/requires a non-empty path/)
    expect(() => parseOuroCommand(["rsvp", "doctor", "--wat"])).toThrow(/Usage: ouro rsvp doctor/)
    expect(() => parseOuroCommand(["rsvp", "incident", "--wat"])).toThrow(/Usage: ouro rsvp incident/)
    expect(parseOuroCommand(["rsvp", "replay", "--fixture", "/tmp/replay.json", "--output", "/tmp/replay-output.json"])).toEqual({
      kind: "rsvp.replay",
      fixturePath: "/tmp/replay.json",
      outputPath: "/tmp/replay-output.json",
    })
    expect(() => parseOuroCommand(["rsvp", "replay"])).toThrow(/requires --fixture/)
    expect(() => parseOuroCommand(["rsvp", "config", "import-legacy", "--agent", "slugger", "--mode", "shadow"])).toThrow(/legacy-root/)
    expect(parseOuroCommand([
      "rsvp",
      "config",
      "import-legacy",
      "--legacy-root",
      "/tmp/legacy-rsvp",
      "--mode",
      "live",
      "--yes",
      "--output",
      "/tmp/import.json",
    ])).toEqual({
      kind: "rsvp.config.import-legacy",
      legacyRoot: "/tmp/legacy-rsvp",
      mode: "live",
      yes: true,
      outputPath: "/tmp/import.json",
    })
    expect(() => parseOuroCommand(["rsvp", "config", "import-legacy", "--legacy-root", "/tmp/legacy-rsvp", "--mode", "preflight"])).toThrow(/mode must be shadow or live/)
    expect(() => parseOuroCommand(["rsvp", "config", "import-legacy", "--legacy-root", "/tmp/legacy-rsvp"])).toThrow(/requires --mode/)
    expect(parseOuroCommand(["rsvp", "cutover", "--legacy-root", "/tmp/legacy-rsvp", "--action", "check", "--output", "/tmp/cutover.json"])).toEqual({
      kind: "rsvp.cutover",
      legacyRoot: "/tmp/legacy-rsvp",
      action: "check",
      outputPath: "/tmp/cutover.json",
    })
    expect(parseOuroCommand(["rsvp", "cutover", "--legacy-root", "/tmp/legacy-rsvp", "--action", "quarantine-launchd", "--yes"])).toEqual({
      kind: "rsvp.cutover",
      legacyRoot: "/tmp/legacy-rsvp",
      action: "quarantine-launchd",
      yes: true,
    })
    expect(() => parseOuroCommand(["rsvp", "cutover", "--action", "check"])).toThrow(/requires --legacy-root/)
    expect(() => parseOuroCommand(["rsvp", "cutover", "--legacy-root", "/tmp/legacy-rsvp"])).toThrow(/requires --action/)
    expect(() => parseOuroCommand(["rsvp", "cutover", "--legacy-root", "/tmp/legacy-rsvp", "--action", "delete-everything"])).toThrow(/action must be/)
    expect(() => parseOuroCommand(["rsvp", "cutover", "--legacy-root", "/tmp/legacy-rsvp", "--action", "check", "--wat"])).toThrow(/Usage: ouro rsvp cutover/)
    expect(parseOuroCommand(["rsvp", "legacy-render", "--agent", "slugger", "--legacy-root", "/tmp/legacy-rsvp"])).toEqual({
      kind: "rsvp.legacy-render",
      agent: "slugger",
      legacyRoot: "/tmp/legacy-rsvp",
    })
    expect(() => parseOuroCommand(["rsvp", "legacy-render"])).toThrow(/requires --legacy-root/)
    expect(() => parseOuroCommand(["rsvp", "legacy-render", "--legacy-root", "/tmp/legacy-rsvp", "--wat"])).toThrow(/Usage: ouro rsvp legacy-render/)
    expect(() => parseOuroCommand(["rsvp", "config", "import-legacy", "--legacy-root", "/tmp/legacy-rsvp", "--mode", "shadow", "--wat"])).toThrow(/Usage: ouro rsvp config import-legacy/)
    expect(() => parseOuroCommand(["rsvp", "replay", "--fixture", "/tmp/replay.json", "--wat"])).toThrow(/Usage: ouro rsvp replay/)
    expect(() => parseOuroCommand(["rsvp", "habit", "stage", "--mode", "shadow", "--cadence", "0 10 * * *", "--wat"])).toThrow(/Usage: ouro rsvp habit stage/)
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--allow-send", "--no-send"])).toThrow(/allow-send/)
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--mode", "preflight"])).toThrow(/mode must be shadow or live/)
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--allow-send"])).toThrow(/shadow.*allow-send/)
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--mode", "live"])).toThrow(/live requires --allow-send/)
    expect(parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--mode", "live", "--allow-send"])).toEqual({
      kind: "rsvp.refresh",
      agent: "slugger",
      mode: "live",
      allowSend: true,
    })
    expect(() => parseOuroCommand(["rsvp", "refresh", "--agent", "slugger", "--wat"])).toThrow(/Usage: ouro rsvp refresh/)
    expect(() => parseOuroCommand(["rsvp", "compare", "--legacy", "/tmp/legacy.json"])).toThrow(/requires --native/)
    expect(() => parseOuroCommand(["rsvp", "compare", "--native", "/tmp/native.json"])).toThrow(/requires --legacy/)
    expect(() => parseOuroCommand(["rsvp", "compare", "--native", "/tmp/native.json", "--legacy", "/tmp/legacy.json", "--wat"])).toThrow(/Usage: ouro rsvp compare/)
    expect(() => parseOuroCommand(["rsvp", "smoke", "--mode", "shadow", "--surface", "bluebubbles"])).toThrow(/preflight or live/)
    expect(() => parseOuroCommand(["rsvp", "smoke", "--mode", "preflight", "--surface", "sms"])).toThrow(/surface must be bluebubbles/)
    expect(() => parseOuroCommand(["rsvp", "smoke", "--mode", "preflight"])).toThrow(/requires --surface/)
    expect(() => parseOuroCommand(["rsvp", "smoke", "--surface", "bluebubbles", "--wat"])).toThrow(/Usage: ouro rsvp smoke/)
    expect(() => parseOuroCommand(["rsvp", "smoke", "--agent", "slugger", "--mode", "live", "--surface", "bluebubbles"])).toThrow(/--allow-send/)
    expect(() => parseOuroCommand(["rsvp", "habit", "stage", "--mode", "preflight", "--cadence", "0 10 * * *"])).toThrow(/mode must be shadow or live/)
    expect(() => parseOuroCommand(["rsvp", "habit", "stage", "--cadence", "0 10 * * *"])).toThrow(/requires --mode/)
    expect(() => parseOuroCommand(["rsvp", "habit", "stage", "--agent", "slugger", "--mode", "live", "--cadence", "daily"])).toThrow(/cadence/)
  })
})

describe("ouro rsvp CLI execution", () => {
  it("dispatches side-effect-free RSVP commands locally without contacting the daemon", async () => {
    const tmp = seedRsvpOperationalBundle()
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })
    const commands: Array<{ argv: string[]; kind: string }> = [
      { argv: ["rsvp", "doctor", "--agent", "slugger", "--json"], kind: "rsvp.doctor" },
      { argv: ["rsvp", "incident", "--agent", "slugger", "--json"], kind: "rsvp.incident" },
      { argv: ["rsvp", "cutover", "--agent", "slugger", "--legacy-root", "/tmp/legacy-rsvp", "--action", "check", "--json"], kind: "rsvp.cutover" },
      { argv: ["rsvp", "import-legacy", "--agent", "slugger", "--legacy-root", "/tmp/legacy-rsvp", "--mode", "shadow", "--json"], kind: "rsvp.import-legacy" },
      { argv: ["rsvp", "refresh", "--agent", "slugger", "--mode", "shadow", "--no-send", "--json"], kind: "rsvp.refresh" },
      { argv: ["rsvp", "compare", "--agent", "slugger", "--native", "/tmp/native.json", "--legacy", "/tmp/legacy.json", "--json"], kind: "rsvp.compare" },
      { argv: ["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], kind: "rsvp.smoke" },
    ]

    try {
      for (const command of commands) {
        const result = await runOuroCli(command.argv, deps)
        const parsed = JSON.parse(result)
        expect(parsed).toMatchObject({
          command: command.kind,
          sideEffect: false,
        })
        expect(typeof parsed.ok).toBe("boolean")
      }

      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("fails RSVP habit staging closed when no agent is supplied", async () => {
    const deps = createMockDeps()

    const result = JSON.parse(await runOuroCli([
      "rsvp",
      "habit",
      "stage",
      "--mode",
      "shadow",
      "--cadence",
      "0 10 * * *",
      "--json",
    ], deps))

    expect(result).toMatchObject({
      ok: false,
      command: "rsvp.habit.stage",
      sideEffect: false,
      requires: "--agent",
    })
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
          snapshotId: expect.stringMatching(/^rsvp_/),
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

  it("discovers the default RSVP legacy root and runs cutover preflight without injected deps", async () => {
    const tmp = seedRsvpOperationalBundle()
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-doctor-home-"))
    const legacyRoot = path.join(homeDir, "Projects", "rsvp-tracker")
    fs.mkdirSync(legacyRoot, { recursive: true })
    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      bluebubbles: { enabled: false },
    }), "utf-8")
    const deps = createMockDeps({
      bundlesRoot: tmp.bundlesRoot,
      homeDir,
    })
    try {
      const result = await runOuroCli(["rsvp", "doctor", "--agent", "slugger", "--json"], deps)
      const parsed = JSON.parse(result)
      const rsvpCategory = (parsed.doctor.categories as Array<{ name?: string; checks: unknown[] }>)
        .find((category) => category.name === "RSVP")

      expect(rsvpCategory?.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "rsvp.cutover.live_send_preflight",
          detail: expect.stringContaining("legacyConfigSendInactive=true"),
        }),
      ]))
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
      tmp.cleanup()
    }
  }, 10_000)

  it("reports passing RSVP doctor checks when no agent has RSVP configured", async () => {
    const tmp = createTmpBundle({ agentName: "plain" })
    const setExitCode = vi.fn()
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, setExitCode })
    try {
      const result = JSON.parse(await runOuroCli(["rsvp", "doctor", "--agent", "plain", "--json", "--strict"], deps))

      expect(result).toMatchObject({
        ok: true,
        command: "rsvp.doctor",
        agent: "plain",
        sideEffect: false,
        strict: true,
        message: "RSVP doctor checks passed",
      })
      expect(setExitCode).not.toHaveBeenCalled()
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("uses the default bundle root for RSVP doctor when deps do not inject one", async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-doctor-default-home-"))
    const agentRoot = path.join(homeRoot, "AgentBundles", "plain.ouro")
    const originalHome = process.env.HOME
    const setExitCode = vi.fn()
    const deps = createMockDeps({ setExitCode })

    try {
      fs.mkdirSync(agentRoot, { recursive: true })
      fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "minimax", model: "minimax-text-01" },
        agentFacing: { provider: "minimax", model: "minimax-text-01" },
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }), "utf-8")
      process.env.HOME = homeRoot

      const result = JSON.parse(await runOuroCli(["rsvp", "doctor", "--agent", "plain", "--json", "--strict"], deps))

      expect(result).toMatchObject({
        ok: true,
        command: "rsvp.doctor",
        agent: "plain",
        sideEffect: false,
        strict: true,
        message: "RSVP doctor checks passed",
      })
      expect(setExitCode).not.toHaveBeenCalled()
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      fs.rmSync(homeRoot, { recursive: true, force: true })
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
    const tmp = seedRsvpOperationalBundle()
    const legacyRoot = path.join(tmp.agentRoot, "legacy-rsvp")
    const deps = createMockDeps({
      bundlesRoot: tmp.bundlesRoot,
      rsvpCutoverDeps: passingRsvpCutoverDeps(legacyRoot),
    })

    try {
      const preflight = await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], deps)
      expect(JSON.parse(preflight)).toMatchObject({
        ok: true,
        command: "rsvp.smoke",
        sideEffect: false,
        allowSend: false,
      })

      mockRuntimeCredentialConfig.refreshMachineRuntimeCredentialConfig.mockResolvedValueOnce({
        ok: true,
        config: {
          bluebubbles: { serverUrl: "http://127.0.0.1:1234", password: "secret" },
          bluebubblesChannel: { port: 18790, webhookPath: "/bluebubbles-webhook", requestTimeoutMs: 30_000 },
        },
      })
      const live = await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "live", "--surface", "bluebubbles", "--allow-send", "--json"], deps)
      expect(JSON.parse(live)).toMatchObject({
        ok: true,
        command: "rsvp.smoke",
        sideEffect: true,
        allowSend: true,
      })
      expect(mockBlueBubblesClient.sendText).toHaveBeenCalledWith(expect.objectContaining({
        text: "Pending (1/2): Casey Pending",
      }))
      expect(deps.sendCommand).not.toHaveBeenCalled()
    } finally {
      tmp.cleanup()
    }
  })

  it("returns structured smoke guidance when the latest RSVP snapshot is missing or invalid", async () => {
    const tmp = seedRsvpOperationalBundle()
    const latestPath = path.join(tmp.agentRoot, "state", "rsvp", "snapshots", "latest.json")
    const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot })

    try {
      fs.rmSync(latestPath)
      const missing = JSON.parse(await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], deps))
      expect(missing).toMatchObject({
        ok: false,
        command: "rsvp.smoke",
        sideEffect: false,
        allowSend: false,
        sendAllowed: false,
        requires: "latest RSVP snapshot",
        result: {
          ok: false,
          path: latestPath,
        },
      })

      fs.writeFileSync(latestPath, JSON.stringify({ schemaVersion: 1, policyVersion: "rsvp-snapshot/v1" }), "utf-8")
      const invalid = JSON.parse(await runOuroCli(["rsvp", "smoke", "--agent", "slugger", "--mode", "preflight", "--surface", "bluebubbles", "--json"], deps))
      expect(invalid).toMatchObject({
        ok: false,
        command: "rsvp.smoke",
        requires: "latest RSVP snapshot",
        result: {
          ok: false,
          path: latestPath,
        },
      })
      expect(String(invalid.result.message)).toContain("invalid RSVP snapshot")
    } finally {
      tmp.cleanup()
    }
  })
})
