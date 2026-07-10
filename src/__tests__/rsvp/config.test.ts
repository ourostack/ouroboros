import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RSVP_CONFIG_POLICY_VERSION,
  importLegacyRsvpConfig,
  readRsvpConfig,
  rsvpConfigPath,
  validateRsvpReadiness,
  writeRsvpConfig,
  type RsvpNativeConfig,
} from "../../rsvp/config"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const tempRoots: string[] = []

function tempAgentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rsvp-config-"))
  tempRoots.push(root)
  return root
}

function readyConfig(overrides: Partial<RsvpNativeConfig> = {}): RsvpNativeConfig {
  return {
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
      accountId: "icloud",
    },
    ...overrides,
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("native RSVP config", () => {
  it("writes and reads a secret-free native config and validates ready runtime credentials", () => {
    const agentRoot = tempAgentRoot()
    const configPath = writeRsvpConfig(agentRoot, readyConfig())

    expect(configPath).toBe(rsvpConfigPath(agentRoot))
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("super-secret")

    const read = readRsvpConfig(agentRoot)
    expect(read).toMatchObject({ ok: true, config: readyConfig() })

    const readiness = validateRsvpReadiness({
      agent: "slugger",
      agentRoot,
      runtimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        revision: "runtime_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: {
          rsvp: {
            aisleplanner: {
              username: "ari@example.com",
              password: "super-secret",
            },
          },
        },
      },
      machineRuntimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/machines/machine/config",
        revision: "machine_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "bluebubbles-secret",
          },
          bluebubblesChannel: {
            requestTimeoutMs: 30000,
          },
        },
      },
    })

    expect(readiness).toMatchObject({
      status: "ready",
      config: readyConfig(),
      credentials: {
        username: "ari@example.com",
        password: "super-secret",
      },
    })
    expect(readiness.checks.every((check) => check.status === "pass")).toBe(true)
    expect(JSON.stringify(readiness.redacted)).not.toContain("super-secret")
    expect(JSON.stringify(readiness.redacted)).not.toContain("bluebubbles-secret")
  })

  it("blocks on missing native config, missing IDs, missing credentials, and missing BlueBubbles attachment config", () => {
    const missingRoot = tempAgentRoot()
    expect(validateRsvpReadiness({
      agent: "slugger",
      agentRoot: missingRoot,
      runtimeConfig: { ok: false, reason: "missing", itemPath: "vault:slugger:runtime/config", error: "missing" },
      machineRuntimeConfig: { ok: false, reason: "missing", itemPath: "vault:slugger:runtime/machines/machine/config", error: "missing" },
    })).toMatchObject({
      status: "blocked",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "rsvp.native_config", status: "fail", actor: "agent-runnable" }),
      ]),
    })

    const badRoot = tempAgentRoot()
    writeRsvpConfig(badRoot, readyConfig({
      source: { kind: "aisleplanner", weddingId: "", eventId: "" },
      bluebubblesRoute: { chatGuid: "" },
    }))

    const readiness = validateRsvpReadiness({
      agent: "slugger",
      agentRoot: badRoot,
      runtimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        revision: "runtime_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: { rsvp: { aisleplanner: { username: "", password: "" } } },
      },
      machineRuntimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/machines/machine/config",
        revision: "machine_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: { bluebubbles: {} },
      },
    })

    expect(readiness.status).toBe("blocked")
    expect(readiness.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rsvp.aisleplanner_source", status: "fail", actor: "agent-runnable" }),
      expect.objectContaining({ id: "rsvp.aisleplanner_credentials", status: "fail", actor: "human-required" }),
      expect.objectContaining({ id: "rsvp.bluebubbles_route", status: "fail", actor: "agent-runnable" }),
      expect.objectContaining({ id: "rsvp.bluebubbles_attachment", status: "fail", actor: "agent-runnable" }),
    ]))
  })

  it("imports legacy RSVP config into native config plus runtime/config without leaking secrets", async () => {
    const agentRoot = tempAgentRoot()
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-config-"))
    tempRoots.push(legacyRoot)
    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      aisleplanner: {
        username: "ari@example.com",
        password: "legacy-secret",
        wedding_id: 484532,
        event_id: 2081539,
      },
      bluebubbles: {
        server_url: "http://localhost:1234",
        secrets_path: "/tmp/legacy-rsvp-bluebubbles-secrets.json",
        chat_guid: "any;+;wedding-chat",
      },
    }), "utf-8")

    const mergeRuntimeConfig = vi.fn(async () => ({
      ok: true as const,
      itemPath: "vault:slugger:runtime/config",
      revision: "runtime_imported",
      updatedAt: "2026-07-09T17:45:00.000Z",
      config: {},
    }))

    const result = await importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
      now: new Date("2026-07-09T17:45:00.000Z"),
      mergeRuntimeConfig,
    })

    expect(result).toMatchObject({
      ok: true,
      configPath: rsvpConfigPath(agentRoot),
      runtimeConfigItem: "vault:slugger:runtime/config",
      redactedConfig: {
        source: { weddingId: "484532", eventId: "2081539" },
        bluebubblesRoute: { chatGuid: "any;+;wedding-chat" },
      },
    })
    expect(mergeRuntimeConfig).toHaveBeenCalledWith("slugger", {
      rsvp: {
        aisleplanner: {
          username: "ari@example.com",
          password: "legacy-secret",
        },
      },
    }, new Date("2026-07-09T17:45:00.000Z"))

    const rawNativeConfig = fs.readFileSync(rsvpConfigPath(agentRoot), "utf-8")
    expect(rawNativeConfig).toContain("484532")
    expect(rawNativeConfig).toContain("any;+;wedding-chat")
    expect(rawNativeConfig).toContain(legacyRoot)
    expect(rawNativeConfig).not.toContain("legacy-secret")
    expect(rawNativeConfig).not.toContain("secrets_path")
    expect(readRsvpConfig(agentRoot)).toMatchObject({
      ok: true,
      config: {
        cutover: { legacyRoot },
      },
    })
    expect(JSON.stringify(result)).not.toContain("legacy-secret")
  })

  it("hard-fails malformed or unconfirmed legacy imports without writing native state", async () => {
    const agentRoot = tempAgentRoot()
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-config-"))
    tempRoots.push(legacyRoot)
    fs.writeFileSync(path.join(legacyRoot, "config.json"), "{not-json", "utf-8")

    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "malformed_legacy_config",
      actor: "agent-runnable",
    })
    expect(fs.existsSync(rsvpConfigPath(agentRoot))).toBe(false)

    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      aisleplanner: { username: "ari@example.com", wedding_id: 484532, event_id: 2081539 },
      bluebubbles: { chat_guid: "any;+;wedding-chat" },
    }), "utf-8")

    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "missing_secret",
      actor: "human-required",
    })

    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: false,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "confirmation_required",
      actor: "human-required",
    })
    expect(fs.existsSync(rsvpConfigPath(agentRoot))).toBe(false)
  })

  it("rejects malformed native config shapes and unreadable JSON", () => {
    const agentRoot = tempAgentRoot()
    const configPath = rsvpConfigPath(agentRoot)
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, "{not-json", "utf-8")
    expect(readRsvpConfig(agentRoot)).toMatchObject({
      ok: false,
      reason: "malformed",
      message: "native RSVP config is not valid JSON",
    })

    const invalids: unknown[] = [
      null,
      { ...readyConfig(), schemaVersion: 2 },
      { ...readyConfig(), policyVersion: "old" },
      { ...readyConfig(), agent: 42 },
      { ...readyConfig(), mode: "maybe" },
      { ...readyConfig(), source: [] },
      { ...readyConfig(), source: { kind: "other", weddingId: "1", eventId: "2" } },
      { ...readyConfig(), source: { kind: "aisleplanner", weddingId: 1, eventId: "2" } },
      { ...readyConfig(), credentialRef: null },
      { ...readyConfig(), credentialRef: { runtimeConfigItem: "other", runtimeConfigPath: "rsvp.aisleplanner" } },
      { ...readyConfig(), credentialRef: { runtimeConfigItem: "runtime/config", runtimeConfigPath: "other" } },
      { ...readyConfig(), bluebubblesRoute: null },
      { ...readyConfig(), bluebubblesRoute: { chatGuid: 42 } },
      { ...readyConfig(), bluebubblesRoute: { chatGuid: "chat", chatIdentifier: 42 } },
      { ...readyConfig(), bluebubblesRoute: { chatGuid: "chat", accountId: 42 } },
      { ...readyConfig(), cutover: [] },
      { ...readyConfig(), cutover: { legacyRoot: 42 } },
    ]

    for (const invalid of invalids) {
      fs.writeFileSync(configPath, JSON.stringify(invalid), "utf-8")
      expect(readRsvpConfig(agentRoot)).toMatchObject({
        ok: false,
        reason: "malformed",
        message: "native RSVP config is malformed",
      })
    }
  })

  it("reports missing legacy config, missing coordinates, vault failures, and config write failures", async () => {
    const agentRoot = tempAgentRoot()
    const missingLegacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-config-"))
    tempRoots.push(missingLegacyRoot)

    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot: missingLegacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "missing_legacy_config",
      actor: "agent-runnable",
    })

    fs.writeFileSync(path.join(missingLegacyRoot, "config.json"), JSON.stringify({
      aisleplanner: {
        username: "ari@example.com",
        password: "legacy-secret",
        wedding_id: {},
        event_id: 2081539,
      },
      bluebubbles: { chat_guid: "any;+;wedding-chat" },
    }), "utf-8")

    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot: missingLegacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "missing_coordinates",
      actor: "agent-runnable",
    })

    fs.writeFileSync(path.join(missingLegacyRoot, "config.json"), JSON.stringify({
      aisleplanner: {
        username: "ari@example.com",
        password: "legacy-secret",
        wedding_id: 484532,
        event_id: 2081539,
      },
      bluebubbles: { chat_guid: "any;+;wedding-chat", account_id: "icloud" },
    }), "utf-8")

    const vaultFailure = await importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot: missingLegacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(async () => {
        throw new Error("vault locked with legacy-secret")
      }),
    })
    expect(vaultFailure).toMatchObject({
      ok: false,
      reason: "vault_unavailable",
      actor: "human-required",
      message: expect.stringContaining("vault locked"),
    })
    expect(JSON.stringify(vaultFailure)).not.toContain("legacy-secret")

    const fileRoot = path.join(agentRoot, "not-a-directory")
    fs.writeFileSync(fileRoot, "blocking file", "utf-8")
    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot: fileRoot,
      legacyRoot: missingLegacyRoot,
      mode: "live",
      confirm: true,
      mergeRuntimeConfig: vi.fn(async () => ({
        ok: true as const,
        itemPath: "vault:slugger:runtime/config",
        revision: "runtime_imported",
        updatedAt: "2026-07-09T17:45:00.000Z",
        config: {},
      })),
    })).resolves.toMatchObject({
      ok: false,
      reason: "write_failed",
      actor: "agent-runnable",
    })
  })

  it("covers malformed nested runtime objects and non-object legacy config payloads", async () => {
    const agentRoot = tempAgentRoot()
    writeRsvpConfig(agentRoot, readyConfig())

    const noMachineReadiness = validateRsvpReadiness({
      agent: "slugger",
      agentRoot,
      runtimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        revision: "runtime_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: { rsvp: [] },
      },
    })
    expect(noMachineReadiness).toMatchObject({
      status: "blocked",
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "rsvp.aisleplanner_credentials", status: "fail" }),
        expect.objectContaining({ id: "rsvp.bluebubbles_attachment", status: "fail", detail: "machine runtime/config: missing" }),
      ]),
    })

    const malformedNested = validateRsvpReadiness({
      agent: "slugger",
      agentRoot,
      runtimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/config",
        revision: "runtime_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: { rsvp: { aisleplanner: [] } },
      },
      machineRuntimeConfig: {
        ok: true,
        itemPath: "vault:slugger:runtime/machines/machine/config",
        revision: "machine_rev",
        updatedAt: "2026-07-09T17:40:00.000Z",
        config: { bluebubbles: [] },
      },
    })
    expect(malformedNested.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "rsvp.aisleplanner_credentials", status: "fail" }),
      expect.objectContaining({ id: "rsvp.bluebubbles_attachment", status: "fail" }),
    ]))

    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-config-"))
    tempRoots.push(legacyRoot)
    fs.writeFileSync(path.join(legacyRoot, "config.json"), "[]", "utf-8")
    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "malformed_legacy_config",
    })

    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      aisleplanner: null,
      bluebubbles: null,
    }), "utf-8")
    await expect(importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(),
    })).resolves.toMatchObject({
      ok: false,
      reason: "missing_secret",
    })

    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      aisleplanner: {
        username: "ari@example.com",
        password: "legacy-secret",
        wedding_id: 484532,
        event_id: 2081539,
      },
      bluebubbles: { chat_guid: "any;+;wedding-chat" },
    }), "utf-8")
    const stringFailure = await importLegacyRsvpConfig({
      agent: "slugger",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
      mergeRuntimeConfig: vi.fn(async () => {
        throw "vault string failure with legacy-secret" // eslint-disable-line no-throw-literal
      }),
    })
    expect(stringFailure).toMatchObject({ ok: false, reason: "vault_unavailable" })
    expect(JSON.stringify(stringFailure)).not.toContain("legacy-secret")
  })

  it("uses the default runtime/config merge writer and fails safely when no vault is configured", async () => {
    const agentRoot = tempAgentRoot()
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rsvp-config-"))
    tempRoots.push(legacyRoot)
    fs.writeFileSync(path.join(legacyRoot, "config.json"), JSON.stringify({
      aisleplanner: {
        username: "ari@example.com",
        password: "legacy-secret",
        wedding_id: 484532,
        event_id: 2081539,
      },
      bluebubbles: { chat_guid: "any;+;wedding-chat" },
    }), "utf-8")

    const result = await importLegacyRsvpConfig({
      agent: "rsvp-test-agent-without-vault",
      agentRoot,
      legacyRoot,
      mode: "shadow",
      confirm: true,
    })

    expect(result).toMatchObject({
      ok: false,
      reason: "vault_unavailable",
      actor: "human-required",
    })
    expect(JSON.stringify(result)).not.toContain("legacy-secret")
    expect(fs.existsSync(rsvpConfigPath(agentRoot))).toBe(false)
  })
})
