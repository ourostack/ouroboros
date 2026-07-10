import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"

const tempRoots: string[] = []
const legacyLabel = "com.arimendelow.rsvp-tracker"

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

function makeLegacyRoot(): { legacyRoot: string; sharedSecretsPath: string } {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-cli-cutover-"))
  tempRoots.push(legacyRoot)
  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-cli-shared-"))
  tempRoots.push(sharedRoot)
  const sharedSecretsPath = path.join(sharedRoot, "bluebubbles.json")
  fs.writeFileSync(sharedSecretsPath, JSON.stringify({
    bluebubbles: { password: "shared-bluebubbles-password" },
  }, null, 2), "utf-8")
  fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
    aisleplanner: {
      username: "ari@example.com",
      password: "aisleplanner-password",
      wedding_id: "484532",
      event_id: "2081539",
    },
    bluebubbles: {
      server_url: "http://127.0.0.1:1234",
      chat_guid: "any;+;secret-chat-guid",
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

function redactedCutoverDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      ok: false,
      detail: "machine runtime/config missing bluebubbles attachment",
    })),
    unloadLaunchAgent: vi.fn(async () => ({ ok: true })),
    now: () => new Date("2026-07-09T19:05:00.000Z"),
    ...overrides,
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("ouro rsvp cutover CLI", () => {
  it("parses explicit check, LaunchAgent quarantine, and legacy-send retirement actions", () => {
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
      "cutover",
      "--agent",
      "slugger",
      "--legacy-root",
      "/Users/arimendelow/Projects/rsvp-tracker",
      "--action",
      "retire-legacy-send-config",
      "--yes",
      "--json",
    ])).toEqual({
      kind: "rsvp.cutover",
      agent: "slugger",
      legacyRoot: "/Users/arimendelow/Projects/rsvp-tracker",
      action: "retire-legacy-send-config",
      yes: true,
      json: true,
    })

    expect(parseOuroCommand([
      "rsvp",
      "cutover",
      "--agent",
      "slugger",
      "--legacy-root",
      "/Users/arimendelow/Projects/rsvp-tracker",
      "--action",
      "quarantine-launchd",
      "--yes",
    ])).toEqual({
      kind: "rsvp.cutover",
      agent: "slugger",
      legacyRoot: "/Users/arimendelow/Projects/rsvp-tracker",
      action: "quarantine-launchd",
      yes: true,
    })
  })

  it("executes cutover check locally with all native live-send gate booleans and no daemon call", async () => {
    const { legacyRoot } = makeLegacyRoot()
    const deps = createMockDeps({
      rsvpCutoverDeps: redactedCutoverDeps(),
    } as Partial<OuroCliDeps>)

    const result = await runOuroCli([
      "rsvp",
      "cutover",
      "--agent",
      "slugger",
      "--legacy-root",
      legacyRoot,
      "--action",
      "check",
      "--json",
    ], deps)
    const parsed = JSON.parse(result)

    expect(parsed).toMatchObject({
      ok: true,
      command: "rsvp.cutover",
      action: "check",
      agent: "slugger",
      sideEffect: false,
      sendAllowed: false,
      checks: {
        launchAgentInactive: false,
        legacyProcessInactive: false,
        legacyConfigSendInactive: false,
        legacyLiveSendInactive: false,
        nativeBlueBubblesCredentialHealthy: false,
      },
    })
    expect(parsed.message).not.toMatch(/registered|planned/i)
    expect(JSON.stringify(parsed)).not.toContain("shared-bluebubbles-password")
    expect(JSON.stringify(parsed)).not.toContain("secret-chat-guid")
    expect(JSON.stringify(parsed)).not.toContain("127.0.0.1:1234")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("requires --yes for mutating cutover actions and retires only legacy send config when confirmed", async () => {
    const { legacyRoot, sharedSecretsPath } = makeLegacyRoot()
    const configPath = path.join(legacyRoot, "config.json")
    const configBefore = fs.readFileSync(configPath, "utf-8")
    const sharedSecretsBefore = fs.readFileSync(sharedSecretsPath, "utf-8")
    const deps = createMockDeps({
      rsvpCutoverDeps: redactedCutoverDeps({
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
      }),
    } as Partial<OuroCliDeps>)

    const preview = JSON.parse(await runOuroCli([
      "rsvp",
      "cutover",
      "--agent",
      "slugger",
      "--legacy-root",
      legacyRoot,
      "--action",
      "retire-legacy-send-config",
      "--json",
    ], deps))

    expect(preview).toMatchObject({
      ok: false,
      command: "rsvp.cutover",
      action: "retire-legacy-send-config",
      sideEffect: false,
      requires: "--yes",
    })
    expect(fs.readFileSync(configPath, "utf-8")).toBe(configBefore)
    expect(fs.readFileSync(sharedSecretsPath, "utf-8")).toBe(sharedSecretsBefore)

    const result = JSON.parse(await runOuroCli([
      "rsvp",
      "cutover",
      "--agent",
      "slugger",
      "--legacy-root",
      legacyRoot,
      "--action",
      "retire-legacy-send-config",
      "--yes",
      "--json",
    ], deps))

    expect(result).toMatchObject({
      ok: true,
      command: "rsvp.cutover",
      action: "retire-legacy-send-config",
      sideEffect: true,
      checks: {
        legacyConfigSendInactive: true,
      },
      rollback: {
        configBackupPath: expect.any(String),
      },
    })
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
      bluebubbles: { send_enabled: false },
    })
    expect(fs.readFileSync(sharedSecretsPath, "utf-8")).toBe(sharedSecretsBefore)
    expect(JSON.stringify(result)).not.toContain("shared-bluebubbles-password")
    expect(JSON.stringify(result)).not.toContain("secret-chat-guid")
  })
})
