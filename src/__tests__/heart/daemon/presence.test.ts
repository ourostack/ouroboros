import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  SHARED_SENSES,
  compareVersions,
  effectiveOwner,
  emitOwnershipChange,
  findRosterMachine,
  isRosterMember,
  isSharedSense,
  ownedSharedSenses,
  ownsSense,
  parsePeerRecord,
  parsePresenceBlock,
  presenceSettingsPath,
  readLocalPresenceSettings,
  readPeerRecords,
  readPresence,
  readPresenceForAgent,
  rosterMachine,
  writeLocalPresenceSettings,
  writePeerRecord,
  type PeerRecord,
} from "../../../heart/daemon/presence"

const LAPTOP = "machine_laptop"
const MINI = "machine_mini"
const V = "0.1.0-alpha.1003"

function block(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    minVersion: V,
    machines: [
      { machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" },
      { machineId: MINI, name: "aris-mac-mini", role: "always-on" },
    ],
    owners: { teams: MINI, habits: LAPTOP },
    ...extra,
  }
}

function record(machineId: string, version = V): PeerRecord {
  return { machineId, version, seenAt: "2026-11-10T03:00:00.000Z" }
}

const agentJson = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  home: { machineId: LAPTOP, machineName: "Aris-MacBook-Pro", since: "2026-10-10T00:00:00.000Z" },
  presence: block(),
  ...extra,
})

describe("parsePresenceBlock", () => {
  it("parses a schema 1 block, dropping unusable machines and owners", () => {
    expect(parsePresenceBlock({
      schema: 1,
      machines: [{ machineId: LAPTOP }, { machineId: LAPTOP, name: "dup" }, "junk", { name: "no id" }, { machineId: MINI, name: "mini", role: "always-on" }],
      owners: { teams: MINI, mail: "", voice: 3 },
    })).toEqual({
      schema: 1,
      machines: [{ machineId: LAPTOP, name: LAPTOP, role: "peer" }, { machineId: MINI, name: "mini", role: "always-on" }],
      owners: { teams: MINI },
    })
  })

  it("keeps minVersion and tolerates missing owners", () => {
    expect(parsePresenceBlock({ schema: 1, minVersion: V, machines: [{ machineId: MINI }] })).toEqual({
      schema: 1, minVersion: V, machines: [{ machineId: MINI, name: MINI, role: "peer" }], owners: {},
    })
  })

  it("refuses other schemas, missing machines and empty rosters", () => {
    expect(parsePresenceBlock(null)).toBeNull()
    expect(parsePresenceBlock({ schema: 2, machines: [{ machineId: MINI }] })).toBeNull()
    expect(parsePresenceBlock({ schema: 1 })).toBeNull()
    expect(parsePresenceBlock({ schema: 1, machines: [{}] })).toBeNull()
  })
})

describe("compareVersions", () => {
  it("orders prereleases numerically and releases after prereleases", () => {
    expect(compareVersions("0.1.0-alpha.1003", "0.1.0-alpha.999")).toBe(1)
    expect(compareVersions("0.1.0-alpha.999", "0.1.0-alpha.1003")).toBe(-1)
    expect(compareVersions("0.1.0-alpha.1003", "0.1.0-alpha.1003")).toBe(0)
    expect(compareVersions("v0.2.0", "0.1.9")).toBe(1)
    expect(compareVersions("0.1.0", "0.1.0-alpha.5")).toBe(1)
    expect(compareVersions("0.1.0-alpha.5", "0.1.0")).toBe(-1)
    expect(compareVersions("0.1", "0.1.0")).toBe(0)
    expect(compareVersions("0.1.0-alpha", "0.1.0-alpha.1")).toBe(-1)
    expect(compareVersions("0.1.0-alpha.1", "0.1.0-alpha")).toBe(1)
    expect(compareVersions("0.1.0-beta.1", "0.1.0-alpha.9")).toBe(1)
  })
})

describe("peer records", () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-")) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it("parses records with optional facts, refusing incomplete ones", () => {
    expect(parsePeerRecord({ ...record(MINI), name: "aris-mac-mini", os: "macOS 26", location: " ", owns: ["teams", 4], appSessions: { at: "x", counts: { idle: 2 } } })).toEqual({
      ...record(MINI), name: "aris-mac-mini", os: "macOS 26", owns: ["teams"], appSessions: { at: "x", counts: { idle: 2 } },
    })
    expect(parsePeerRecord("nope")).toBeNull()
    expect(parsePeerRecord({ machineId: MINI, version: V })).toBeNull()
  })

  it("writes each machine's own file and reads every valid one back", () => {
    writePeerRecord(tmp, record(MINI))
    writePeerRecord(tmp, record(LAPTOP, "0.1.0-alpha.1002"))
    fs.writeFileSync(path.join(tmp, "presence", "broken.json"), "{")
    fs.writeFileSync(path.join(tmp, "presence", "machine_other.json"), JSON.stringify(record(MINI)))
    fs.writeFileSync(path.join(tmp, "presence", "notes.txt"), "ignored")
    expect(readPeerRecords(tmp)).toEqual([record(LAPTOP, "0.1.0-alpha.1002"), record(MINI)])
  })

  it("reads no records from a bundle without a presence folder", () => {
    expect(readPeerRecords(tmp)).toEqual([])
  })
})

describe("local presence settings", () => {
  let home: string
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "presence-home-")) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it("is off without a file, on with one, and the environment overrides both ways", () => {
    expect(readLocalPresenceSettings(home, {})).toEqual({ enabled: false })
    expect(readLocalPresenceSettings(home, { OURO_PRESENCE: "1" })).toEqual({ enabled: true })
    writeLocalPresenceSettings({ enabled: true, location: "office" }, home)
    expect(presenceSettingsPath(home)).toBe(path.join(home, ".ouro-cli", "presence.json"))
    expect(readLocalPresenceSettings(home, {})).toEqual({ enabled: true, location: "office" })
    expect(readLocalPresenceSettings(home, { OURO_PRESENCE: "0" })).toEqual({ enabled: false, location: "office" })
  })

  it("treats a malformed file as off", () => {
    fs.mkdirSync(path.join(home, ".ouro-cli"))
    fs.writeFileSync(presenceSettingsPath(home), "[]")
    expect(readLocalPresenceSettings(home, {})).toEqual({ enabled: false })
  })
})

describe("readPresence", () => {
  it("is null with the flag off, without a block, or for a non-object agent.json (today's one-home lease)", () => {
    expect(readPresence(agentJson(), false, [])).toBeNull()
    expect(readPresence({ home: agentJson().home }, true, [])).toBeNull()
    expect(readPresence("x", true, [])).toBeNull()
  })

  it("marks roster machines without a record, or below minVersion, as possibly legacy", () => {
    expect(readPresence(agentJson(), true, [record(MINI)])?.legacy).toEqual([LAPTOP])
    expect(readPresence(agentJson(), true, [record(MINI), record(LAPTOP, "0.1.0-alpha.988")])?.legacy).toEqual([LAPTOP])
    expect(readPresence(agentJson(), true, [record(MINI), record(LAPTOP)])?.legacy).toEqual([])
    const noMin = agentJson({ presence: block({ minVersion: undefined }) })
    expect(readPresence(noMin, true, [record(MINI), record(LAPTOP, "0.0.1")])?.legacy).toEqual([])
  })

  it("reads an agent's roster from its bundle, null when the flag is off or agent.json is unreadable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-agent-"))
    try {
      const home = path.join(tmp, "home")
      const root = path.join(tmp, "a.ouro")
      fs.mkdirSync(root)
      expect(readPresenceForAgent(root, { homeDir: home, env: { OURO_PRESENCE: "1" } })).toBeNull()
      fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify(agentJson()))
      writePeerRecord(root, record(MINI))
      expect(readPresenceForAgent(root, { homeDir: home, env: {} })).toBeNull()
      expect(readPresenceForAgent(root, { homeDir: home, env: { OURO_PRESENCE: "1" } })?.peers).toEqual([record(MINI)])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("ownership", () => {
  const current = readPresence(agentJson(), true, [record(MINI), record(LAPTOP)])!
  const mixed = readPresence(agentJson(), true, [record(MINI)])!

  it("knows which senses are shared", () => {
    expect(SHARED_SENSES).toContain("teams")
    expect(isSharedSense("habits")).toBe(true)
    expect(isSharedSense("shepherd")).toBe(false)
  })

  it("gives each shared sense to its named owner once every machine runs presence", () => {
    expect(ownsSense(current, MINI, "teams")).toBe(true)
    expect(ownsSense(current, LAPTOP, "teams")).toBe(false)
    expect(ownsSense(current, LAPTOP, "habits")).toBe(true)
    expect(ownedSharedSenses(current, MINI)).toEqual(["teams"])
  })

  it("runs machine-scoped senses on every roster machine and nothing off the roster", () => {
    expect(ownsSense(current, MINI, "app-sessions")).toBe(true)
    expect(ownsSense(current, LAPTOP, "shepherd")).toBe(true)
    expect(ownsSense(current, "machine_stranger", "shepherd")).toBe(false)
    expect(isRosterMember(current, "machine_stranger")).toBe(false)
  })

  it("keeps every shared sense with home while any roster machine may run a home-only daemon", () => {
    expect(effectiveOwner(mixed, "teams")).toBe(LAPTOP)
    expect(ownsSense(mixed, MINI, "teams")).toBe(false)
    expect(ownsSense(mixed, LAPTOP, "teams")).toBe(true)
  })

  it("falls back to the declared owner without a home, then home, then the first machine", () => {
    const noHome = readPresence(agentJson({ home: undefined }), true, [record(MINI)])!
    expect(effectiveOwner(noHome, "teams")).toBe(MINI)
    expect(effectiveOwner(current, "mail")).toBe(LAPTOP)
    const neither = readPresence(agentJson({ home: undefined }), true, [record(MINI), record(LAPTOP)])!
    expect(effectiveOwner(neither, "mail")).toBe(LAPTOP)
  })

  it("finds roster machines by name or id, ignoring case and .local", () => {
    expect(findRosterMachine(current, "ARIS-MAC-MINI.local")?.machineId).toBe(MINI)
    expect(findRosterMachine(current, LAPTOP)?.name).toBe("Aris-MacBook-Pro")
    expect(findRosterMachine(current, "nope")).toBeUndefined()
    expect(rosterMachine(current, MINI)?.role).toBe("always-on")
  })

  it("logs ownership arriving and leaving", () => {
    expect(() => emitOwnershipChange("ouroboros", "teams", true, MINI)).not.toThrow()
    expect(() => emitOwnershipChange("ouroboros", "teams", false, null)).not.toThrow()
  })
})

describe("local presence commands and priority", () => {
  it("reads nice, the location command and arrival commands, ignoring malformed ones", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "presence-cmds-"))
    try {
      fs.mkdirSync(path.join(home, ".ouro-cli"))
      fs.writeFileSync(presenceSettingsPath(home), JSON.stringify({ enabled: true, nice: 10, locationCommand: ["mac", "where"], onArrive: { office: ["mac", "arrival"], bad: [1], empty: [] } }))
      expect(readLocalPresenceSettings(home, {})).toEqual({ enabled: true, nice: 10, locationCommand: ["mac", "where"], onArrive: { office: ["mac", "arrival"] } })
      fs.writeFileSync(presenceSettingsPath(home), JSON.stringify({ enabled: true, nice: 99, locationCommand: "mac where", onArrive: { bad: "x" } }))
      expect(readLocalPresenceSettings(home, {})).toEqual({ enabled: true })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
