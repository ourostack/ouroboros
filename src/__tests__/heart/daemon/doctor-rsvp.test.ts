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
import { checkRsvp, runDoctorChecks } from "../../../heart/daemon/doctor"
import { RSVP_CONFIG_POLICY_VERSION, rsvpConfigPath } from "../../../rsvp/config"

const tempRoots: string[] = []

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
  fs.writeFileSync(path.join(habitsDir, "rsvp-ari-rachel.md"), "---\nname: rsvp-ari-rachel\nstatus: active\n---\n", "utf-8")
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
})
