import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

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
    rmSync: (filePath) => fs.rmSync(filePath, { recursive: true, force: true }),
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

function expectRedacted(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(forbiddenChatGuid)
  expect(serialized).not.toContain(forbiddenServerUrl)
  expect(serialized).not.toContain(forbiddenSharedSecret)
  expect(serialized).not.toContain("rsvp_tracker.py --live")
}

afterEach(() => {
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
})
