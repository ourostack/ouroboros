import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const mockMachineRuntimeConfig = vi.hoisted(() => ({
  result: undefined as any,
}))

vi.mock("../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: vi.fn(() => ({ machineId: "machine_test" })),
}))

vi.mock("../../heart/runtime-credentials", () => ({
  refreshMachineRuntimeCredentialConfig: vi.fn(async () => mockMachineRuntimeConfig.result ?? {
    ok: false,
    reason: "missing",
    itemPath: "vault:slugger:runtime/machines/machine_test/config",
    error: "missing machine config",
  }),
}))

import {
  checkRsvpCutover,
  runRsvpCutover,
  type RsvpCutoverDeps,
} from "../../rsvp/cutover"

const tempRoots: string[] = []
const legacyLabel = "com.arimendelow.rsvp-tracker"
const forbiddenChatGuid = "any;+;secret-chat-guid"
const forbiddenServerUrl = "http://127.0.0.1:1234"
const forbiddenSharedSecret = "shared-bluebubbles-password"

function makeLegacyRoot(options: { sendEnabled?: boolean } = {}): { legacyRoot: string; sharedSecretsPath: string } {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-cutover-"))
  tempRoots.push(legacyRoot)
  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-shared-secrets-"))
  tempRoots.push(sharedRoot)
  const sharedSecretsPath = path.join(sharedRoot, "bluebubbles-secrets.json")
  fs.writeFileSync(sharedSecretsPath, JSON.stringify({
    bluebubbles: {
      password: forbiddenSharedSecret,
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
      server_url: forbiddenServerUrl,
      chat_guid: forbiddenChatGuid,
      secrets_path: sharedSecretsPath,
      send_enabled: options.sendEnabled ?? true,
    },
  }, null, 2), "utf-8")
  fs.writeFileSync(path.join(legacyRoot, "rsvp_tracker.py"), [
    "#!/usr/bin/env python3",
    "def send_report(config, message):",
    "    return config['bluebubbles']['chat_guid'], message",
    "",
  ].join("\n"), "utf-8")
  fs.writeFileSync(path.join(legacyRoot, `${legacyLabel}.plist`), [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\">",
    "<dict>",
    "<key>Label</key>",
    `<string>${legacyLabel}</string>`,
    "<key>ProgramArguments</key>",
    "<array>",
    `<string>${path.join(legacyRoot, "rsvp_tracker.py")}</string>`,
    "</array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n"), "utf-8")
  return { legacyRoot, sharedSecretsPath }
}

function cutoverDeps(options: {
  launchAgentLoaded?: boolean
  legacyProcessRunning?: boolean
  nativeBlueBubblesHealthy?: boolean
} = {}): RsvpCutoverDeps {
  return {
    existsSync: fs.existsSync,
    readFileSync: (filePath) => fs.readFileSync(filePath, "utf-8"),
    writeFileSync: (filePath, contents) => fs.writeFileSync(filePath, contents, "utf-8"),
    mkdirSync: (dirPath) => fs.mkdirSync(dirPath, { recursive: true }),
    renameSync: fs.renameSync,
    copyFileSync: fs.copyFileSync,
    now: () => new Date("2026-07-09T19:00:00.000Z"),
    getLaunchAgentState: vi.fn(async () => ({
      label: legacyLabel,
      loaded: options.launchAgentLoaded ?? false,
      source: "injected",
    })),
    getLegacyProcessState: vi.fn(async () => ({
      running: options.legacyProcessRunning ?? false,
      count: options.legacyProcessRunning ? 1 : 0,
      source: "injected",
    })),
    checkNativeBlueBubblesCredential: vi.fn(async () => ({
      ok: options.nativeBlueBubblesHealthy ?? true,
      detail: options.nativeBlueBubblesHealthy === false
        ? "machine runtime/config missing bluebubbles attachment"
        : "native BlueBubbles credential healthy",
    })),
    unloadLaunchAgent: vi.fn(async () => ({ ok: true })),
  }
}

function baseFsDeps(extra: RsvpCutoverDeps = {}): RsvpCutoverDeps {
  return {
    existsSync: fs.existsSync,
    readFileSync: (filePath) => fs.readFileSync(filePath, "utf-8"),
    writeFileSync: (filePath, contents) => fs.writeFileSync(filePath, contents, "utf-8"),
    mkdirSync: (dirPath) => fs.mkdirSync(dirPath, { recursive: true }),
    renameSync: fs.renameSync,
    copyFileSync: fs.copyFileSync,
    now: () => new Date("2026-07-09T19:00:00.000Z"),
    ...extra,
  }
}

function expectRedacted(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(forbiddenChatGuid)
  expect(serialized).not.toContain(forbiddenServerUrl)
  expect(serialized).not.toContain(forbiddenSharedSecret)
  expect(serialized).not.toContain("rsvp_tracker.py --live")
}

afterEach(() => {
  mockMachineRuntimeConfig.result = undefined
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("RSVP legacy cutover checks", () => {
  it("blocks native live send when any legacy sender or native credential gate is unhealthy", async () => {
    const { legacyRoot, sharedSecretsPath } = makeLegacyRoot({ sendEnabled: true })
    const configBefore = fs.readFileSync(path.join(legacyRoot, "config.json"), "utf-8")
    const sharedSecretsBefore = fs.readFileSync(sharedSecretsPath, "utf-8")

    const report = await checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({
        launchAgentLoaded: true,
        legacyProcessRunning: true,
        nativeBlueBubblesHealthy: false,
      }),
    })

    expect(report).toMatchObject({
      ok: true,
      agent: "slugger",
      legacyRoot,
      sideEffect: false,
      checks: {
        launchAgentInactive: false,
        legacyProcessInactive: false,
        legacyConfigSendInactive: false,
        legacyLiveSendInactive: false,
        nativeBlueBubblesCredentialHealthy: false,
      },
      sendAllowed: false,
    })
    expect(report.denialReasons).toEqual(expect.arrayContaining([
      "legacy LaunchAgent is still loaded",
      "legacy RSVP process is still running",
      "legacy RSVP config can still send BlueBubbles messages",
      "legacy live-send path is still active",
      "native BlueBubbles credential is not healthy",
    ]))
    expectRedacted(report)
    expect(fs.readFileSync(path.join(legacyRoot, "config.json"), "utf-8")).toBe(configBefore)
    expect(fs.readFileSync(sharedSecretsPath, "utf-8")).toBe(sharedSecretsBefore)
  })

  it("allows native live send only after every legacy and native credential gate is healthy", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })

    const report = await checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({
        launchAgentLoaded: false,
        legacyProcessRunning: false,
        nativeBlueBubblesHealthy: true,
      }),
    })

    expect(report).toMatchObject({
      checks: {
        launchAgentInactive: true,
        legacyProcessInactive: true,
        legacyConfigSendInactive: true,
        legacyLiveSendInactive: true,
        nativeBlueBubblesCredentialHealthy: true,
      },
      sendAllowed: true,
      denialReasons: [],
    })
    expectRedacted(report)
  })

  it("uses the default process uid when probing launchd without injected cutover deps", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })
    const spawnSync = vi.fn(() => ({ status: 1, stdout: "", stderr: "" }))

    const report = await checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: baseFsDeps({
        platform: "darwin",
        spawnSync,
        checkNativeBlueBubblesCredential: vi.fn(async () => ({
          ok: true,
          detail: "native BlueBubbles credential healthy",
        })),
      }),
    })

    expect(report.checks.launchAgentInactive).toBe(true)
    expect(spawnSync).toHaveBeenCalledWith("launchctl", [
      "print",
      `gui/${process.getuid!()}/${legacyLabel}`,
    ], expect.objectContaining({ encoding: "utf-8", timeout: 5_000 }))
  })

  it("requires --yes before retiring legacy send config and does not mutate shared Slugger secrets", async () => {
    const { legacyRoot, sharedSecretsPath } = makeLegacyRoot({ sendEnabled: true })
    const configPath = path.join(legacyRoot, "config.json")
    const configBefore = fs.readFileSync(configPath, "utf-8")
    const sharedSecretsBefore = fs.readFileSync(sharedSecretsPath, "utf-8")

    const preview = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "retire-legacy-send-config",
      yes: false,
      deps: cutoverDeps(),
    })

    expect(preview).toMatchObject({
      ok: false,
      action: "retire-legacy-send-config",
      sideEffect: false,
      requires: "--yes",
    })
    expect(fs.readFileSync(configPath, "utf-8")).toBe(configBefore)
    expect(fs.readFileSync(sharedSecretsPath, "utf-8")).toBe(sharedSecretsBefore)

    const result = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "retire-legacy-send-config",
      yes: true,
      deps: cutoverDeps(),
    })

    expect(result).toMatchObject({
      ok: true,
      action: "retire-legacy-send-config",
      sideEffect: true,
      checks: {
        legacyConfigSendInactive: true,
      },
      rollback: {
        configBackupPath: expect.any(String),
      },
    })
    expect(fs.existsSync(result.rollback.configBackupPath)).toBe(true)
    expect(fs.readFileSync(sharedSecretsPath, "utf-8")).toBe(sharedSecretsBefore)
    expect(fs.readFileSync(configPath, "utf-8")).not.toBe(configBefore)
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
      bluebubbles: {
        send_enabled: false,
      },
    })
    expectRedacted(result)
  })

  it("quarantines the legacy LaunchAgent only with --yes and preserves rollback evidence", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })
    const plistPath = path.join(legacyRoot, `${legacyLabel}.plist`)
    const deps = cutoverDeps({ launchAgentLoaded: true })

    const preview = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "quarantine-launchd",
      yes: false,
      deps,
    })

    expect(preview).toMatchObject({
      ok: false,
      action: "quarantine-launchd",
      sideEffect: false,
      requires: "--yes",
    })
    expect(fs.existsSync(plistPath)).toBe(true)
    expect(deps.unloadLaunchAgent).not.toHaveBeenCalled()

    const result = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "quarantine-launchd",
      yes: true,
      deps,
    })

    expect(result).toMatchObject({
      ok: true,
      action: "quarantine-launchd",
      sideEffect: true,
      rollback: {
        launchAgentBackupPath: expect.any(String),
      },
    })
    expect(deps.unloadLaunchAgent).toHaveBeenCalledWith(expect.objectContaining({
      label: legacyLabel,
      legacyRoot,
    }))
    expect(fs.existsSync(plistPath)).toBe(false)
    expect(fs.existsSync(result.rollback.launchAgentBackupPath)).toBe(true)
    expectRedacted(result)
  })

  it("treats absent and malformed legacy config as separate cutover states", async () => {
    const absentRoot = path.join(os.tmpdir(), `ouro-rsvp-absent-${process.pid}-${Date.now()}`)
    await expect(checkRsvpCutover({
      legacyRoot: absentRoot,
    })).resolves.toMatchObject({
      checks: {
        launchAgentInactive: true,
        legacyProcessInactive: true,
        legacyConfigSendInactive: true,
        legacyLiveSendInactive: true,
        nativeBlueBubblesCredentialHealthy: false,
      },
      sendAllowed: false,
    })

    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot: absentRoot,
      deps: baseFsDeps(),
    })).resolves.toMatchObject({
      checks: {
        launchAgentInactive: true,
        legacyProcessInactive: true,
        legacyConfigSendInactive: true,
        legacyLiveSendInactive: true,
        nativeBlueBubblesCredentialHealthy: false,
      },
      sendAllowed: false,
    })

    const rootWithoutConfig = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-no-config-"))
    tempRoots.push(rootWithoutConfig)
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot: rootWithoutConfig,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({
      checks: {
        legacyConfigSendInactive: true,
        legacyLiveSendInactive: true,
        nativeBlueBubblesCredentialHealthy: true,
      },
      sendAllowed: true,
    })

    fs.writeFileSync(path.join(rootWithoutConfig, "config.json"), "{not-json", "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot: rootWithoutConfig,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({
      checks: {
        legacyConfigSendInactive: false,
        legacyLiveSendInactive: false,
      },
      sendAllowed: false,
    })

    fs.writeFileSync(path.join(rootWithoutConfig, "config.json"), "[]", "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot: rootWithoutConfig,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({
      checks: {
        legacyConfigSendInactive: false,
        legacyLiveSendInactive: false,
      },
      sendAllowed: false,
    })
  })

  it("recognizes disabled or missing legacy BlueBubbles send coordinates as inactive", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: true })
    const configPath = path.join(legacyRoot, "config.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))

    config.bluebubbles = { enabled: false }
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({ sendAllowed: true })

    config.bluebubbles = { disabled: true }
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({ sendAllowed: true })

    config.bluebubbles = { server_url: forbiddenServerUrl }
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({ sendAllowed: true })

    delete config.bluebubbles
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({ sendAllowed: true })

    config.bluebubbles = { sendEnabled: false }
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({ sendAllowed: true })

    config.bluebubbles = {
      serverUrl: forbiddenServerUrl,
      chatGuid: forbiddenChatGuid,
      secretsPath: "/tmp/shared-secret.json",
    }
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8")
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({
      checks: {
        legacyConfigSendInactive: false,
        legacyLiveSendInactive: false,
      },
      sendAllowed: false,
    })
  })

  it("uses default launchctl, process, and native BlueBubbles health probes without leaking raw coordinates", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: true })
    const spawnProbe = vi.fn((command: string) => command === "launchctl"
      ? { status: 0, stdout: "" }
      : {
        status: 0,
        stdout: [
          `123 python3 ${path.join(legacyRoot, "rsvp_tracker.py")}`,
          "456 node vitest rsvp_tracker.py",
          "789 python3 unrelated.py",
          "",
        ].join("\n"),
      })
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }))
    mockMachineRuntimeConfig.result = {
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_test/config",
      revision: "rev",
      updatedAt: "2026-07-09T19:00:00.000Z",
      config: {
        bluebubbles: {
          serverUrl: "http://bluebubbles.local/",
          password: "native-password",
        },
        bluebubblesChannel: {
          requestTimeoutMs: 1234,
        },
      },
    }

    const report = await checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => 501,
        homeDir: () => path.dirname(legacyRoot),
        spawnSync: spawnProbe,
        fetchImpl,
      }),
    })

    expect(report).toMatchObject({
      checks: {
        launchAgentInactive: false,
        legacyProcessInactive: false,
        legacyConfigSendInactive: false,
        legacyLiveSendInactive: false,
        nativeBlueBubblesCredentialHealthy: true,
      },
      sendAllowed: false,
    })
    expect(spawnProbe).toHaveBeenCalledWith("launchctl", ["print", `gui/501/${legacyLabel}`], expect.any(Object))
    expect(spawnProbe).toHaveBeenCalledWith("ps", ["-axo", "pid=,command="], expect.any(Object))
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://bluebubbles.local/api/v1/message/count?password=native-password",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    )
    expectRedacted(report)
  })

  it("covers default native credential health failure modes", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })
    const healthyLegacyDeps = baseFsDeps({
      getLaunchAgentState: vi.fn(async () => ({ label: legacyLabel, loaded: false, source: "injected" })),
      getLegacyProcessState: vi.fn(async () => ({ running: false, count: 0, source: "injected" })),
      platform: "darwin",
      getUid: () => 501,
      homeDir: () => path.dirname(legacyRoot),
      fetchImpl: vi.fn(async () => new Response("", { status: 200 })),
    })

    await expect(checkRsvpCutover({ legacyRoot, deps: healthyLegacyDeps })).resolves.toMatchObject({
      checks: { nativeBlueBubblesCredentialHealthy: false },
      sendAllowed: false,
    })

    await expect(checkRsvpCutover({ agent: "slugger", legacyRoot, deps: healthyLegacyDeps })).resolves.toMatchObject({
      checks: { nativeBlueBubblesCredentialHealthy: false },
      sendAllowed: false,
    })

    mockMachineRuntimeConfig.result = {
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_test/config",
      revision: "rev",
      updatedAt: "2026-07-09T19:00:00.000Z",
      config: { bluebubbles: {} },
    }
    await expect(checkRsvpCutover({ agent: "slugger", legacyRoot, deps: healthyLegacyDeps })).resolves.toMatchObject({
      checks: { nativeBlueBubblesCredentialHealthy: false },
      sendAllowed: false,
    })

    mockMachineRuntimeConfig.result = {
      ok: true,
      itemPath: "vault:slugger:runtime/machines/machine_test/config",
      revision: "rev",
      updatedAt: "2026-07-09T19:00:00.000Z",
      config: { bluebubbles: { serverUrl: "http://bluebubbles.local", password: "native-password" } },
    }
    const fetchNonOk = vi.fn(async () => new Response("", { status: 503 }))
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: { ...healthyLegacyDeps, fetchImpl: fetchNonOk },
    })).resolves.toMatchObject({
      checks: { nativeBlueBubblesCredentialHealthy: false },
      sendAllowed: false,
    })

    const fetchThrows = vi.fn(async () => {
      throw new Error("network down")
    })
    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: { ...healthyLegacyDeps, fetchImpl: fetchThrows },
    })).resolves.toMatchObject({
      checks: { nativeBlueBubblesCredentialHealthy: false },
      sendAllowed: false,
    })
  })

  it("covers default launchd and process probe fallback branches", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })

    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: baseFsDeps({
        platform: "linux",
        spawnSync: vi.fn(() => ({ status: 1, stdout: "" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({
      checks: {
        launchAgentInactive: true,
        legacyProcessInactive: true,
      },
      sendAllowed: true,
    })

    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => null,
        spawnSync: vi.fn(() => ({ status: 1, stdout: "" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({
      checks: {
        launchAgentInactive: true,
        legacyProcessInactive: true,
      },
      sendAllowed: true,
    })

    await expect(checkRsvpCutover({
      agent: "slugger",
      legacyRoot,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => 501,
        spawnSync: vi.fn(() => ({ status: 1 })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({
      checks: {
        launchAgentInactive: true,
        legacyProcessInactive: true,
      },
      sendAllowed: true,
    })
  })

  it("uses the default LaunchAgent unload fallback and still quarantines local plist evidence", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })
    const plistPath = path.join(legacyRoot, `${legacyLabel}.plist`)
    const spawnProbe = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValue({ status: 0, stdout: "" })

    const result = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => 501,
        homeDir: () => path.dirname(legacyRoot),
        spawnSync: spawnProbe,
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })

    expect(spawnProbe).toHaveBeenCalledWith("launchctl", ["bootout", `gui/501/${legacyLabel}`], expect.any(Object))
    expect(spawnProbe).toHaveBeenCalledWith("launchctl", ["unload", "-w", plistPath], expect.any(Object))
    expect(fs.existsSync(plistPath)).toBe(false)
    expect(fs.existsSync(result.rollback.launchAgentBackupPath)).toBe(true)
    expect(result.sideEffect).toBe(true)
  })

  it("routes run action check through the side-effect-free cutover check", async () => {
    const { legacyRoot } = makeLegacyRoot({ sendEnabled: false })

    await expect(runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "check",
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })).resolves.toMatchObject({
      action: "check",
      sideEffect: false,
      sendAllowed: true,
    })
  })

  it("handles default LaunchAgent unload when there is no plist candidate to quarantine", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-no-plist-"))
    tempRoots.push(legacyRoot)
    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      bluebubbles: { send_enabled: false },
    }), "utf-8")
    const spawnProbe = vi.fn(() => ({ status: 1, stdout: "" }))

    const result = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => 501,
        homeDir: () => path.dirname(legacyRoot),
        spawnSync: spawnProbe,
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })

    expect(spawnProbe).toHaveBeenCalledWith("launchctl", ["bootout", `gui/501/${legacyLabel}`], expect.any(Object))
    expect(result.rollback.launchAgentBackupPath).toBe("")
    expect(result.sideEffect).toBe(true)
  })

  it("calls injected LaunchAgent unload without a plist path when no candidate exists", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-injected-no-plist-"))
    tempRoots.push(legacyRoot)
    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      bluebubbles: { send_enabled: false },
    }), "utf-8")
    const unloadLaunchAgent = vi.fn(async () => ({ ok: true }))

    await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        getLaunchAgentState: vi.fn(async () => ({ label: legacyLabel, loaded: false, source: "injected" })),
        getLegacyProcessState: vi.fn(async () => ({ running: false, count: 0, source: "injected" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
        unloadLaunchAgent,
      }),
    })

    expect(unloadLaunchAgent).toHaveBeenCalledWith({
      label: legacyLabel,
      legacyRoot,
    })
  })

  it("covers default LaunchAgent unload platform, uid, and bootout variants", async () => {
    const linuxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-linux-quarantine-"))
    tempRoots.push(linuxRoot)
    fs.writeFileSync(path.join(linuxRoot, "config.json"), JSON.stringify({ bluebubbles: { send_enabled: false } }), "utf-8")
    await expect(runRsvpCutover({
      agent: "slugger",
      legacyRoot: linuxRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        platform: "linux",
        spawnSync: vi.fn(() => ({ status: 1, stdout: "" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({ sideEffect: true })

    const uidRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-uid-quarantine-"))
    tempRoots.push(uidRoot)
    fs.writeFileSync(path.join(uidRoot, "config.json"), JSON.stringify({ bluebubbles: { send_enabled: false } }), "utf-8")
    await expect(runRsvpCutover({
      agent: "slugger",
      legacyRoot: uidRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => null,
        spawnSync: vi.fn(() => ({ status: 1, stdout: "" })),
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({ sideEffect: true })

    const { legacyRoot: bootoutRoot } = makeLegacyRoot({ sendEnabled: false })
    const bootoutSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValue({ status: 1, stdout: "" })
    await expect(runRsvpCutover({
      agent: "slugger",
      legacyRoot: bootoutRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => 501,
        homeDir: () => path.dirname(bootoutRoot),
        spawnSync: bootoutSpawn,
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({
      sideEffect: true,
      rollback: { launchAgentBackupPath: expect.any(String) },
    })

    const { legacyRoot: unloadFailRoot } = makeLegacyRoot({ sendEnabled: false })
    const unloadFailSpawn = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValue({ status: 1, stdout: "" })
    await expect(runRsvpCutover({
      agent: "slugger",
      legacyRoot: unloadFailRoot,
      action: "quarantine-launchd",
      yes: true,
      deps: baseFsDeps({
        platform: "darwin",
        getUid: () => 501,
        homeDir: () => path.dirname(unloadFailRoot),
        spawnSync: unloadFailSpawn,
        checkNativeBlueBubblesCredential: vi.fn(async () => ({ ok: true, detail: "healthy" })),
      }),
    })).resolves.toMatchObject({
      sideEffect: true,
      rollback: { launchAgentBackupPath: expect.any(String) },
    })
  })

  it("retires malformed legacy config with a rollback backup instead of preserving malformed send state", async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-malformed-retire-"))
    tempRoots.push(legacyRoot)
    const configPath = path.join(legacyRoot, "config.json")
    fs.writeFileSync(configPath, "{not-json", "utf-8")

    const result = await runRsvpCutover({
      agent: "slugger",
      legacyRoot,
      action: "retire-legacy-send-config",
      yes: true,
      deps: cutoverDeps({ nativeBlueBubblesHealthy: true }),
    })

    expect(fs.existsSync(result.rollback.configBackupPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
      bluebubbles: { send_enabled: false },
    })
  })

  it("can retire a temp legacy config through the default filesystem dependencies", async () => {
    const { legacyRoot, sharedSecretsPath } = makeLegacyRoot({ sendEnabled: true })
    const sharedSecretsBefore = fs.readFileSync(sharedSecretsPath, "utf-8")
    const configPath = path.join(legacyRoot, "config.json")

    const result = await runRsvpCutover({
      legacyRoot,
      action: "retire-legacy-send-config",
      yes: true,
    })

    expect(result).toMatchObject({
      action: "retire-legacy-send-config",
      sideEffect: true,
      rollback: {
        configBackupPath: expect.any(String),
        manifestPath: expect.any(String),
      },
    })
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
      bluebubbles: {
        send_enabled: false,
        enabled: false,
        disabled: true,
      },
    })
    expect(fs.existsSync(result.rollback.configBackupPath)).toBe(true)
    expect(fs.existsSync(result.rollback.manifestPath)).toBe(true)
    expect(fs.readFileSync(sharedSecretsPath, "utf-8")).toBe(sharedSecretsBefore)
  })
})
