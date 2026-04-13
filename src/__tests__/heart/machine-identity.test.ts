import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  getMachineIdentityPath,
  loadOrCreateMachineIdentity,
  type MachineIdentity,
} from "../../heart/machine-identity"

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

describe("machine identity", () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-machine-home-"))
    mockEmitNervesEvent.mockClear()
  })

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it("uses a stable machine.json path under the Ouro CLI home", () => {
    emitTestEvent("machine identity path")
    expect(getMachineIdentityPath(homeDir)).toBe(path.join(homeDir, ".ouro-cli", "machine.json"))
  })

  it("creates a random machine id that is not derived from hostname", () => {
    emitTestEvent("machine identity creates random id")
    const now = new Date("2026-04-12T17:40:00.000Z")

    const identity = loadOrCreateMachineIdentity({
      homeDir,
      now: () => now,
      hostname: () => "ari-macbook",
      randomId: () => "machine_random_123",
    })

    expect(identity).toEqual({
      schemaVersion: 1,
      machineId: "machine_random_123",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      hostnameAliases: ["ari-macbook"],
    })
    expect(identity.machineId).not.toContain("ari-macbook")
    expect(fs.existsSync(getMachineIdentityPath(homeDir))).toBe(true)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "config/identity",
      event: "config.machine_identity_created",
    }))
  })

  it("survives hostname changes and records new aliases", () => {
    emitTestEvent("machine identity hostname aliases")
    const first = loadOrCreateMachineIdentity({
      homeDir,
      now: () => new Date("2026-04-12T17:40:00.000Z"),
      hostname: () => "old-host",
      randomId: () => "machine_random_123",
    })

    const second = loadOrCreateMachineIdentity({
      homeDir,
      now: () => new Date("2026-04-12T18:00:00.000Z"),
      hostname: () => "new-host",
      randomId: () => "machine_random_should_not_be_used",
    })

    expect(second.machineId).toBe(first.machineId)
    expect(second.hostnameAliases).toEqual(["old-host", "new-host"])
    expect(second.updatedAt).toBe("2026-04-12T18:00:00.000Z")
  })

  it("loads an existing identity without rewriting when hostname is already known", () => {
    emitTestEvent("machine identity stable load")
    const machinePath = getMachineIdentityPath(homeDir)
    const identity: MachineIdentity = {
      schemaVersion: 1,
      machineId: "machine_existing",
      createdAt: "2026-04-12T17:00:00.000Z",
      updatedAt: "2026-04-12T17:00:00.000Z",
      hostnameAliases: ["same-host"],
    }
    fs.mkdirSync(path.dirname(machinePath), { recursive: true })
    fs.writeFileSync(machinePath, `${JSON.stringify(identity, null, 2)}\n`, "utf-8")
    const before = fs.statSync(machinePath).mtimeMs

    const loaded = loadOrCreateMachineIdentity({
      homeDir,
      now: () => new Date("2026-04-12T18:00:00.000Z"),
      hostname: () => "same-host",
      randomId: () => "machine_unused",
    })

    expect(loaded).toEqual(identity)
    expect(fs.statSync(machinePath).mtimeMs).toBe(before)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "config/identity",
      event: "config.machine_identity_loaded",
    }))
  })

  it("replaces corrupt machine files with a new valid identity", () => {
    emitTestEvent("machine identity corrupt file")
    const machinePath = getMachineIdentityPath(homeDir)
    fs.mkdirSync(path.dirname(machinePath), { recursive: true })
    fs.writeFileSync(machinePath, "not json{{{", "utf-8")

    const identity = loadOrCreateMachineIdentity({
      homeDir,
      now: () => new Date("2026-04-12T19:00:00.000Z"),
      hostname: () => "repair-host",
      randomId: () => "machine_repaired",
    })

    expect(identity.machineId).toBe("machine_repaired")
    expect(identity.hostnameAliases).toEqual(["repair-host"])
    expect(JSON.parse(fs.readFileSync(machinePath, "utf-8"))).toEqual(identity)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      component: "config/identity",
      event: "config.machine_identity_invalid",
    }))
  })
})
