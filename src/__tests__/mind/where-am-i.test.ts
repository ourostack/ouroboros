import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { renderWhereAmI, whereAmISection, type MachineInfo } from "../../mind/where-am-i"
import { readPresence, writeLocalPresenceSettings, writePeerRecord, type PeerRecord } from "../../heart/daemon/presence"

// Record freshness depends on the clock; pin it.
beforeAll(() => { vi.useFakeTimers({ now: Date.parse("2026-11-10T03:05:00.000Z"), toFake: ["Date"] }) })
afterAll(() => { vi.useRealTimers() })

const LAPTOP = "machine_laptop"
const MINI = "machine_mini"
const V = "0.1.0-alpha.1003"
const NOW = Date.parse("2026-11-10T04:00:00.000Z")

const roster = (owners: Record<string, string>) => ({
  schema: 1,
  minVersion: V,
  machines: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" }, { machineId: MINI, name: "aris-mac-mini", role: "always-on" }],
  owners,
})
const agentJson = { home: { machineId: LAPTOP, machineName: "Aris-MacBook-Pro" }, presence: roster({ teams: MINI, telegram: LAPTOP, mail: LAPTOP, bluebubbles: LAPTOP, voice: LAPTOP, a2a: LAPTOP, habits: MINI }) }

const mini: MachineInfo = { machineId: MINI, name: "aris-mac-mini", role: "always-on", os: "macOS 26", location: "home" }

describe("renderWhereAmI", () => {
  it("renders nothing without presence", () => {
    expect(renderWhereAmI(null, mini, NOW)).toBe("")
  })

  it("names this machine, its peers with last-seen times, and who owns what", () => {
    const records: PeerRecord[] = [
      { machineId: LAPTOP, version: V, seenAt: "2026-11-10T03:57:00.000Z", os: "macOS 26", location: "office", appSessions: { at: "x", counts: { working: 4, idle: 2 } } },
      { machineId: MINI, version: V, seenAt: "2026-11-10T04:00:00.000Z" },
    ]
    expect(renderWhereAmI(readPresence(agentJson, true, records), mini, NOW)).toBe([
      "## where i am",
      "i am on aris-mac-mini (always-on), macOS 26, at home. i am one named agent present on 2 machines; each presence runs on its own machine and we share this bundle through git.",
      "my peers:",
      "- Aris-MacBook-Pro (laptop, macOS 26, office): last seen 3 min ago on 0.1.0-alpha.1003; copilot app sessions: 4 working, 2 idle",
      "shared senses i own here: teams, habits.",
      "owned by a peer: telegram (Aris-MacBook-Pro), mail (Aris-MacBook-Pro), bluebubbles (Aris-MacBook-Pro), voice (Aris-MacBook-Pro), a2a (Aris-MacBook-Pro).",
      "machine-scoped senses (cli, shepherd, app-sessions) run on every presence and see only their own machine.",
    ].join("\n"))
  })

  it("says when a peer has not been seen and shared senses stay with home meanwhile", () => {
    const text = renderWhereAmI(readPresence(agentJson, true, [{ machineId: MINI, version: V, seenAt: "bad" }]), mini, NOW)
    expect(text).toContain("- Aris-MacBook-Pro (laptop): not seen yet (no presence record)")
    expect(text).toContain("shared senses i own here: none.")
    expect(text).toContain("until Aris-MacBook-Pro publishes a current presence record, every shared sense stays with home.")
  })

  it("words times in hours and days, empty session counts, and several unseen machines", () => {
    const three = { ...agentJson, presence: { ...roster({}), machines: [...roster({}).machines, { machineId: "machine_c", name: "c", role: "peer" }] } }
    const hoursAgo = renderWhereAmI(readPresence(three, true, [
      { machineId: LAPTOP, version: V, seenAt: "2026-11-10T01:00:00.000Z", appSessions: { at: "x", counts: {} } },
    ]), mini, NOW)
    expect(hoursAgo).toContain("last seen 3 h ago on 0.1.0-alpha.1003\n")
    expect(hoursAgo).toContain("until aris-mac-mini, c publish a current presence record")
    const daysAgo = renderWhereAmI(readPresence(agentJson, true, [{ machineId: LAPTOP, version: V, seenAt: "2026-11-05T04:00:00.000Z" }]), mini, NOW)
    expect(daysAgo).toContain("last seen 5 days ago")
    expect(renderWhereAmI(readPresence(agentJson, true, [{ machineId: LAPTOP, version: V, seenAt: "garbage" }]), mini, NOW)).toContain("last seen at an unknown time")
    expect(renderWhereAmI(readPresence(agentJson, true, [{ machineId: LAPTOP, version: V, seenAt: "2026-11-10T04:00:00.000Z" }]), mini)).toContain("last seen")
  })

  it("says so when this is the only presence", () => {
    const alone = { presence: { schema: 1, machines: [{ machineId: MINI, name: "aris-mac-mini", role: "always-on" }], owners: {} } }
    const text = renderWhereAmI(readPresence(alone, true, [{ machineId: MINI, version: V, seenAt: "2026-11-10T04:00:00.000Z" }]), mini, NOW)
    expect(text).toContain("present on 1 machine;")
    expect(text).toContain("my peers: none; this is my only presence.")
    expect(text).not.toContain("owned by a peer")
  })
})

describe("whereAmISection", () => {
  let tmp: string
  let home: string
  let root: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "where-am-i-"))
    home = path.join(tmp, "home")
    root = path.join(tmp, "slugger.ouro")
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify(agentJson))
    writePeerRecord(root, { machineId: LAPTOP, version: V, seenAt: new Date().toISOString() })
  })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  const identity = (machineId: string): void => {
    fs.mkdirSync(path.join(home, ".ouro-cli"), { recursive: true })
    fs.writeFileSync(path.join(home, ".ouro-cli", "machine.json"), JSON.stringify({ schemaVersion: 1, machineId, createdAt: "x", updatedAt: "x", hostnameAliases: [] }))
  }

  it("is empty while presence is off, without an identity, or off the roster", () => {
    expect(whereAmISection(root, home)).toBe("")
    writeLocalPresenceSettings({ enabled: true }, home)
    expect(whereAmISection(root, home)).toBe("")
    identity("machine_stranger")
    expect(whereAmISection(root, home)).toBe("")
  })

  it("renders this machine with its location, or a default from its role", () => {
    writeLocalPresenceSettings({ enabled: true }, home)
    identity(MINI)
    expect(whereAmISection(root, home)).toContain("i am on aris-mac-mini (always-on),")
    expect(whereAmISection(root, home)).toContain("at home.")
    identity(LAPTOP)
    expect(whereAmISection(root, home)).toContain("at an unknown location.")
    writeLocalPresenceSettings({ enabled: true, location: "office" }, home)
    expect(whereAmISection(root, home)).toContain("i am on Aris-MacBook-Pro (laptop),")
    expect(whereAmISection(root, home)).toContain("at office.")
  })

  it("is empty when the bundle cannot be read", () => {
    writeLocalPresenceSettings({ enabled: true }, home)
    expect(whereAmISection(path.join(tmp, "missing.ouro"), home)).toBe("")
  })

  it("uses the real home directory by default", () => {
    expect(typeof whereAmISection(path.join(tmp, "missing.ouro"))).toBe("string")
  })
})
