import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockRuntimeConfigs = vi.hoisted(() => new Map<string, any>())
const mockMachineRuntimeConfigs = vi.hoisted(() => new Map<string, any>())
vi.mock("../../../heart/runtime-credentials", () => ({
  refreshRuntimeCredentialConfig: vi.fn(async (agentName: string) => mockRuntimeConfigs.get(agentName) ?? {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/config`,
    error: `no runtime credentials stored at vault:${agentName}:runtime/config`,
  }),
  refreshMachineRuntimeCredentialConfig: vi.fn(async (agentName: string, machineId: string) => mockMachineRuntimeConfigs.get(agentName) ?? {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/machines/${machineId}/config`,
    error: `no machine runtime credentials stored at vault:${agentName}:runtime/machines/${machineId}/config`,
  }),
}))

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: vi.fn(() => ({ machineId: "machine_test" })),
}))

import type { DoctorDeps } from "../../../heart/daemon/doctor-types"
import { checkHabits, checkRsvp, runDoctorChecks } from "../../../heart/daemon/doctor"
import { RSVP_CONFIG_POLICY_VERSION, rsvpConfigPath } from "../../../rsvp/config"

const tempRoots: string[] = []
const legacyLabel = "com.arimendelow.rsvp-tracker"
const forbiddenLegacyChatGuid = "any;+;legacy-secret-chat-guid"
const forbiddenLegacyServerUrl = "http://127.0.0.1:1234"
const forbiddenLegacySecret = "legacy-shared-bluebubbles-password"

function makeBundlesRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-rsvp-"))
  tempRoots.push(root)
  return root
}

function writeAgent(root: string, agent = "slugger"): string {
  const agentRoot = path.join(root, `${agent}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "claude" },
    agentFacing: { provider: "anthropic", model: "claude" },
    phrases: { thinking: [], tool: [], followup: [] },
  }), "utf-8")
  return agentRoot
}

function writeRsvpHabit(agentRoot: string): void {
  const habitsDir = path.join(agentRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  fs.writeFileSync(path.join(habitsDir, "rsvp-wedding.md"), [
    "---",
    "name: rsvp-wedding",
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
    "Refresh native RSVP state.",
    "",
  ].join("\n"), "utf-8")
}

function writeMalformedRsvpHabit(agentRoot: string): void {
  const habitsDir = path.join(agentRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  fs.writeFileSync(path.join(habitsDir, "rsvp-wedding.md"), "---\nname: rsvp-wedding\nstatus: active\ncadence: 0 10 * * *\n---\n", "utf-8")
}

function writeNativeRsvpConfig(agentRoot: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(rsvpConfigPath(agentRoot)), { recursive: true })
  fs.writeFileSync(rsvpConfigPath(agentRoot), JSON.stringify({
    schemaVersion: 1,
    policyVersion: RSVP_CONFIG_POLICY_VERSION,
    agent: "slugger",
    mode: "shadow",
    source: {
      kind: "aisleplanner",
      weddingId: "484532",
      eventId: "2081539",
    },
    credentialRef: {
      runtimeConfigItem: "runtime/config",
      runtimeConfigPath: "rsvp.aisleplanner",
    },
    bluebubblesRoute: {
      chatGuid: "any;+;wedding-chat",
      chatIdentifier: "wedding-chat",
    },
    ...overrides,
  }), "utf-8")
}

function writeLegacyRsvpRoot(): { legacyRoot: string; sharedSecretsPath: string } {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-legacy-rsvp-"))
  tempRoots.push(legacyRoot)
  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-legacy-rsvp-secrets-"))
  tempRoots.push(sharedRoot)
  const sharedSecretsPath = path.join(sharedRoot, "bluebubbles.json")
  fs.writeFileSync(sharedSecretsPath, JSON.stringify({
    bluebubbles: {
      password: forbiddenLegacySecret,
    },
  }, null, 2), "utf-8")
  fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
    aisleplanner: {
      username: "ari@example.com",
      password: "aisleplanner-password",
      wedding_id: "484532",
      event_id: "2081539",
    },
    bluebubbles: {
      server_url: forbiddenLegacyServerUrl,
      chat_guid: forbiddenLegacyChatGuid,
      secrets_path: sharedSecretsPath,
      send_enabled: true,
    },
  }, null, 2), "utf-8")
  fs.writeFileSync(path.join(legacyRoot, `${legacyLabel}.plist`), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\">",
    "<dict>",
    "<key>Label</key>",
    `<string>${legacyLabel}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n"), "utf-8")
  return { legacyRoot, sharedSecretsPath }
}

function depsFor(bundlesRoot: string): DoctorDeps {
  return {
    existsSync: fs.existsSync,
    readFileSync: (p) => fs.readFileSync(p, "utf-8"),
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
    checkSocketAlive: vi.fn(async () => true),
    socketPath: "/tmp/ouro.sock",
    bundlesRoot,
    homedir: path.dirname(bundlesRoot),
    envPath: "/usr/bin",
    platform: "darwin",
  }
}

function withRsvpCutoverDeps(deps: DoctorDeps, legacyRoot: string): DoctorDeps {
  return {
    ...deps,
    rsvpCutoverLegacyRoot: legacyRoot,
    rsvpCutoverDeps: {
      existsSync: fs.existsSync,
      readFileSync: (p: string) => fs.readFileSync(p, "utf-8"),
      getLaunchAgentState: vi.fn(async () => ({
        label: legacyLabel,
        loaded: true,
        source: "injected",
      })),
      getLegacyProcessState: vi.fn(async () => ({
        running: true,
        count: 1,
        source: "injected",
      })),
      checkNativeBlueBubblesCredential: vi.fn(async () => ({
        ok: true,
        detail: "native BlueBubbles credential healthy",
      })),
    },
  } as DoctorDeps
}

function seedRuntime(agent = "slugger"): void {
  mockRuntimeConfigs.set(agent, {
    ok: true,
    itemPath: `vault:${agent}:runtime/config`,
    revision: "runtime_rev",
    updatedAt: "2026-07-09T17:50:00.000Z",
    config: {
      rsvp: {
        aisleplanner: {
          username: "ari@example.com",
          password: "aisleplanner-secret",
        },
      },
    },
  })
  mockMachineRuntimeConfigs.set(agent, {
    ok: true,
    itemPath: `vault:${agent}:runtime/machines/machine_test/config`,
    revision: "machine_rev",
    updatedAt: "2026-07-09T17:50:00.000Z",
    config: {
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "bluebubbles-secret",
      },
    },
  })
}

afterEach(() => {
  mockRuntimeConfigs.clear()
  mockMachineRuntimeConfigs.clear()
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("RSVP doctor checks", () => {
  it("fails a staged RSVP habit before native config exists", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)

    const category = await checkRsvp(depsFor(bundlesRoot))

    expect(category.name).toBe("RSVP")
    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "slugger.ouro RSVP native config",
        status: "fail",
        detail: expect.stringContaining("missing native RSVP config"),
      }),
    ]))
  })

  it("passes ready RSVP config without leaking AislePlanner or BlueBubbles secrets", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()

    const category = await checkRsvp(depsFor(bundlesRoot))

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "slugger.ouro RSVP native config", status: "pass" }),
      expect.objectContaining({ label: "slugger.ouro RSVP AislePlanner credentials", status: "pass" }),
      expect.objectContaining({ label: "slugger.ouro RSVP BlueBubbles attachment", status: "pass" }),
    ]))
    expect(JSON.stringify(category)).not.toContain("aisleplanner-secret")
    expect(JSON.stringify(category)).not.toContain("bluebubbles-secret")
  })

  it("adds a native live-send preflight that blocks while the legacy sender is still live", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()
    const { legacyRoot } = writeLegacyRsvpRoot()

    const category = await checkRsvp(withRsvpCutoverDeps(depsFor(bundlesRoot), legacyRoot))

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "slugger.ouro RSVP legacy live-send preflight",
        status: "fail",
        detail: expect.stringContaining("sendAllowed=false"),
      }),
    ]))
    const preflight = category.checks.find((check) => check.label === "slugger.ouro RSVP legacy live-send preflight")
    expect(preflight?.detail).toContain("launchAgentInactive=false")
    expect(preflight?.detail).toContain("legacyProcessInactive=false")
    expect(preflight?.detail).toContain("legacyConfigSendInactive=false")
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacySecret)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyChatGuid)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyServerUrl)
  })

  it("passes native live-send preflight once the legacy sender is inactive", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()
    const { legacyRoot } = writeLegacyRsvpRoot()
    const configPath = path.join(legacyRoot, "config.json")
    const legacyConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    legacyConfig.bluebubbles.send_enabled = false
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig), "utf-8")
    const deps = {
      ...depsFor(bundlesRoot),
      rsvpCutoverLegacyRoot: legacyRoot,
      rsvpCutoverDeps: {
        existsSync: fs.existsSync,
        readFileSync: (p: string) => fs.readFileSync(p, "utf-8"),
        getLaunchAgentState: vi.fn(async () => ({
          label: legacyLabel,
          loaded: false,
          source: "injected",
        })),
        getLegacyProcessState: vi.fn(async () => ({
          running: false,
          count: 0,
          source: "injected",
        })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({
          ok: true,
          detail: "native BlueBubbles credential healthy",
        })),
      },
    } as DoctorDeps

    const category = await checkRsvp(deps)

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "slugger.ouro RSVP legacy live-send preflight",
        status: "pass",
        detail: expect.stringContaining("sendAllowed=true"),
      }),
    ]))
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacySecret)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyChatGuid)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyServerUrl)
  })

  it("uses the native RSVP config cutover root for doctor live-send preflight", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)
    const configuredLegacy = writeLegacyRsvpRoot()
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-rsvp-home-"))
    tempRoots.push(homeDir)
    const defaultLegacyRoot = path.join(homeDir, "Projects", "rsvp-tracker")
    fs.mkdirSync(defaultLegacyRoot, { recursive: true })
    fs.writeFileSync(path.join(defaultLegacyRoot, "config.json"), JSON.stringify({
      bluebubbles: { enabled: false, send_enabled: false },
    }), "utf-8")
    writeNativeRsvpConfig(agentRoot, {
      cutover: { legacyRoot: configuredLegacy.legacyRoot },
    })
    seedRuntime()
    const deps = {
      ...depsFor(bundlesRoot),
      homedir: homeDir,
      rsvpCutoverDeps: {
        existsSync: fs.existsSync,
        readFileSync: (p: string) => fs.readFileSync(p, "utf-8"),
        getLaunchAgentState: vi.fn(async (input: { legacyRoot: string }) => ({
          label: legacyLabel,
          loaded: input.legacyRoot === configuredLegacy.legacyRoot,
          source: "injected",
        })),
        getLegacyProcessState: vi.fn(async (input: { legacyRoot: string }) => ({
          running: input.legacyRoot === configuredLegacy.legacyRoot,
          count: input.legacyRoot === configuredLegacy.legacyRoot ? 1 : 0,
          source: "injected",
        })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({
          ok: true,
          detail: "native BlueBubbles credential healthy",
        })),
      },
    } as DoctorDeps

    const category = await checkRsvp(deps)

    expect(deps.rsvpCutoverDeps.getLaunchAgentState).toHaveBeenCalledWith(expect.objectContaining({
      legacyRoot: configuredLegacy.legacyRoot,
    }))
    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "rsvp.cutover.live_send_preflight",
        status: "fail",
        detail: expect.stringContaining("legacyProcessInactive=false"),
      }),
    ]))
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacySecret)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyChatGuid)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyServerUrl)
  })

  it("emits stable RSVP doctor ids for operational health surfaces", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()
    const { legacyRoot } = writeLegacyRsvpRoot()

    const category = await checkRsvp(withRsvpCutoverDeps(depsFor(bundlesRoot), legacyRoot))

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rsvp.native_config", label: "slugger.ouro RSVP native config", status: "pass" }),
      expect.objectContaining({ id: "rsvp.aisleplanner.credentials", label: "slugger.ouro RSVP AislePlanner credentials", status: "pass" }),
      expect.objectContaining({ id: "rsvp.bluebubbles.attachment_identity", label: "slugger.ouro RSVP BlueBubbles attachment identity", status: "pass" }),
      expect.objectContaining({ id: "rsvp.context_packet_ledger", label: "slugger.ouro RSVP context packet ledger" }),
      expect.objectContaining({ id: "rsvp.habit.schedule", label: "slugger.ouro RSVP habit schedule" }),
      expect.objectContaining({ id: "rsvp.cutover.live_send_preflight", label: "slugger.ouro RSVP legacy live-send preflight", status: "fail" }),
      expect.objectContaining({ id: "rsvp.latest_fetch", label: "slugger.ouro RSVP latest fetch" }),
      expect.objectContaining({ id: "rsvp.delivery.reconciliation", label: "slugger.ouro RSVP delivery reconciliation" }),
      expect.objectContaining({ id: "rsvp.spend_timeline", label: "slugger.ouro RSVP spend timeline" }),
    ]))
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacySecret)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyChatGuid)
    expect(JSON.stringify(category)).not.toContain(forbiddenLegacyServerUrl)
  })

  it("skips RSVP cutover preflight when no configured or default legacy root exists", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-rsvp-no-legacy-home-"))
    tempRoots.push(homedir)
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()

    const category = await checkRsvp({ ...depsFor(bundlesRoot), homedir })

    expect(category.checks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rsvp.cutover.live_send_preflight" }),
    ]))
  })

  it("uses the default RSVP legacy root for cutover preflight when config omits one", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-rsvp-default-legacy-home-"))
    const legacyRoot = path.join(homedir, "Projects", "rsvp-tracker")
    tempRoots.push(homedir)
    fs.mkdirSync(legacyRoot, { recursive: true })
    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({ bluebubbles: { enabled: false } }), "utf-8")
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()
    const deps = {
      ...depsFor(bundlesRoot),
      homedir,
      rsvpCutoverDeps: {
        existsSync: fs.existsSync,
        readFileSync: (p: string) => fs.readFileSync(p, "utf-8"),
        getLaunchAgentState: vi.fn(async () => ({ label: legacyLabel, loaded: false, source: "injected" })),
        getLegacyProcessState: vi.fn(async () => ({ running: false, count: 0, source: "injected" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      },
    } as DoctorDeps

    const category = await checkRsvp(deps)

    expect(deps.rsvpCutoverDeps.getLaunchAgentState).toHaveBeenCalledWith(expect.objectContaining({ legacyRoot }))
    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rsvp.cutover.live_send_preflight", status: "pass" }),
    ]))
  })

  it("fails RSVP habit schedule health when the active habit lacks typed metadata", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMalformedRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot)
    seedRuntime()

    const category = await checkRsvp(depsFor(bundlesRoot))

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "rsvp.habit.schedule",
        label: "slugger.ouro RSVP habit schedule",
        status: "fail",
        detail: expect.stringMatching(/typed RSVP habit metadata/i),
      }),
    ]))
  })

  it("reports cancelled and degraded habit lifecycle states by name and reason", () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "cancelled-report.md"),
      "---\nstatus: cancelled\ncadence: 24h\n---\n\nDo not run.",
      "utf8",
    )
    fs.writeFileSync(
      path.join(habitsDir, "invalid-report.md"),
      "---\nstatus: retired\ncadence: 24h\n---\n\nInvalid definition.",
      "utf8",
    )
    fs.mkdirSync(path.join(habitsDir, "unreadable-report.md"))

    const category = checkHabits(depsFor(bundlesRoot))

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "habits.lifecycle",
        label: "slugger.ouro habit lifecycle",
        status: "fail",
        detail: expect.stringMatching(/cancelled-report=cancelled/),
      }),
      expect.objectContaining({
        id: "habits.lifecycle",
        detail: expect.stringMatching(/invalid-report=degraded\(invalid_status\)/),
      }),
      expect.objectContaining({
        id: "habits.lifecycle",
        detail: expect.stringMatching(/unreadable-report=degraded\(read_error\)/),
      }),
      expect.objectContaining({
        label: "slugger.ouro launchd plists",
        status: "pass",
        detail: "no active scheduled habits require launchd",
      }),
    ]))
  })

  it("surfaces missing runtime credentials and route coordinates as actionable checks", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeRsvpHabit(agentRoot)
    writeNativeRsvpConfig(agentRoot, {
      bluebubblesRoute: { chatGuid: "" },
    })

    const category = await checkRsvp(depsFor(bundlesRoot))

    expect(category.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "slugger.ouro RSVP AislePlanner credentials",
        status: "fail",
        detail: expect.stringContaining("vault:slugger:runtime/config"),
      }),
      expect.objectContaining({
        label: "slugger.ouro RSVP BlueBubbles route",
        status: "fail",
        detail: expect.stringContaining("chatGuid"),
      }),
    ]))
  })

  it("is included in runDoctorChecks and stays quiet for agents with no RSVP signals", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeAgent(bundlesRoot, "plain")

    const result = await runDoctorChecks(depsFor(bundlesRoot), { category: "RSVP" })

    expect(result.categories).toHaveLength(1)
    expect(result.categories[0]).toMatchObject({
      name: "RSVP",
      checks: [expect.objectContaining({
        label: "plain.ouro RSVP",
        status: "pass",
        detail: "not configured",
      })],
    })
  })

  it("stays quiet when an unreadable habits directory prevents RSVP signal discovery", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "plain")
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    const deps = depsFor(bundlesRoot)
    const category = await checkRsvp({
      ...deps,
      readdirSync: (entry) => {
        if (entry === habitsDir) throw new Error("permission denied")
        return fs.readdirSync(entry)
      },
    })

    expect(category).toMatchObject({
      name: "RSVP",
      checks: [expect.objectContaining({
        label: "plain.ouro RSVP",
        status: "pass",
        detail: "not configured",
      })],
    })
  })
})
