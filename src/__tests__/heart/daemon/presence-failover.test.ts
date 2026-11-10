import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import {
  failoverLeasePath, failoverSenses, holdsFailover, mayRunSense, ownedSharedSenses, readFailoverLeases, readPeerRecords, readPresence,
  readPresenceForAgent, writeFailoverLeases, writeLocalPresenceSettings, writePeerRecord, type FailoverLease, type PeerRecord,
} from "../../../heart/daemon/presence"
import { PresenceTicker } from "../../../heart/daemon/presence-daemon"
import { presenceFailover, presenceStatusJson, renderPresenceStatus } from "../../../heart/daemon/presence-roster"
import { renderWhereAmI } from "../../../mind/where-am-i"

beforeAll(() => { vi.useFakeTimers({ now: Date.parse("2026-11-10T17:00:00.000Z"), toFake: ["Date"] }) })
afterAll(() => { vi.useRealTimers() })

const LAPTOP = "machine_laptop"
const MINI = "machine_mini"
const V = "0.1.0-alpha.1084"
const NOW = new Date("2026-11-10T17:00:00.000Z")
const ROSTER = {
  schema: 1,
  minVersion: V,
  machines: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" }, { machineId: MINI, name: "aris-mac-mini", role: "always-on" }],
  owners: { teams: MINI, habits: MINI },
}
const rec = (machineId: string, extra: Partial<PeerRecord> = {}): PeerRecord => ({ machineId, version: V, seenAt: "2026-11-10T16:50:00.000Z", ...extra })
const lease = (extra: Partial<FailoverLease> = {}): FailoverLease => ({ sense: "teams", machine: LAPTOP, from: MINI, since: "2026-11-10T16:55:00.000Z", reason: "the bot endpoint stopped answering for 3 min", ...extra })
const presence = (records: PeerRecord[], leases: FailoverLease[] = []) => readPresence({ presence: ROSTER }, true, records, leases)!

let tmp: string
let agentRoot: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-failover-"))
  agentRoot = path.join(tmp, "AgentBundles", "o.ouro")
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ enabled: true, presence: ROSTER }))
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe("presence failover: who runs a shared sense", () => {
  it("lets a stand-in run the sense even though the gone owner's last record still claims it", () => {
    const records = [rec(LAPTOP), rec(MINI, { owns: ["teams", "habits"] })]
    expect(mayRunSense(presence(records), LAPTOP, "teams")).toBe(false)
    const standing = presence(records, [lease()])
    expect(holdsFailover(standing, LAPTOP, "teams")).toBe(true)
    expect(mayRunSense(standing, LAPTOP, "teams")).toBe(true)
    expect(ownedSharedSenses(standing, LAPTOP)).toEqual(["teams"])
    expect(failoverSenses(standing, LAPTOP)).toEqual(["teams"])
    // A lease is about the machine that holds it, and about one sense.
    expect(mayRunSense(standing, LAPTOP, "habits")).toBe(false)
    expect(holdsFailover(standing, MINI, "teams")).toBe(false)
  })

  it("never makes the owner wait on a stand-in, but still waits on a real previous owner", () => {
    const standIn = rec(LAPTOP, { owns: ["teams"], failover: ["teams"] })
    expect(mayRunSense(presence([standIn, rec(MINI)]), MINI, "teams")).toBe(true)
    const handedOff = rec(LAPTOP, { owns: ["teams"] })
    expect(mayRunSense(presence([handedOff, rec(MINI)]), MINI, "teams")).toBe(false)
  })

  it("reads only well-formed leases, and none from a missing or malformed file", () => {
    expect(readFailoverLeases(agentRoot)).toEqual([])
    fs.mkdirSync(path.dirname(failoverLeasePath(agentRoot)), { recursive: true })
    fs.writeFileSync(failoverLeasePath(agentRoot), "{")
    expect(readFailoverLeases(agentRoot)).toEqual([])
    fs.writeFileSync(failoverLeasePath(agentRoot), JSON.stringify({ leases: "no" }))
    expect(readFailoverLeases(agentRoot)).toEqual([])
    fs.writeFileSync(failoverLeasePath(agentRoot), JSON.stringify({ leases: [
      7, { sense: "cli", machine: LAPTOP, from: MINI, since: "x" }, { sense: "teams", machine: LAPTOP, from: MINI }, { sense: "teams", machine: LAPTOP, from: MINI, since: "s" },
    ] }))
    expect(readFailoverLeases(agentRoot)).toEqual([{ sense: "teams", machine: LAPTOP, from: MINI, since: "s", reason: "" }])
    writeFailoverLeases(agentRoot, [lease()])
    expect(readFailoverLeases(agentRoot)).toEqual([lease()])
  })

  it("keeps the leases a presence was read with, and none when there are none", () => {
    expect(presence([rec(LAPTOP), rec(MINI)]).failover).toBeUndefined()
    writeFailoverLeases(agentRoot, [lease()])
    const home = path.join(tmp, "home")
    writeLocalPresenceSettings({ enabled: true }, home)
    expect(readPresenceForAgent(agentRoot, { homeDir: home, env: {} })!.failover).toEqual([lease()])
  })
})

describe("presence failover: take and release", () => {
  const take = (extra: Partial<Parameters<typeof presenceFailover>[0]> = {}) => presenceFailover({
    agent: "o", agentRoot, machineId: LAPTOP, action: "take", sense: "teams", now: NOW, presence: presence([rec(LAPTOP), rec(MINI)]), ...extra,
  })

  it("takes a sense in place of its owner, once, and releases it", () => {
    expect(take({ reason: "  the bot endpoint answered 502 for 3 min " })).toEqual({ ok: true, message: expect.stringContaining("Aris-MacBook-Pro now runs o's teams in place of aris-mac-mini (the bot endpoint answered 502 for 3 min)") })
    expect(readFailoverLeases(agentRoot)).toEqual([{ sense: "teams", machine: LAPTOP, from: MINI, since: NOW.toISOString(), reason: "the bot endpoint answered 502 for 3 min" }])
    expect(take({ presence: presence([rec(LAPTOP), rec(MINI)], readFailoverLeases(agentRoot)) }).message).toBe("Aris-MacBook-Pro is already standing in for aris-mac-mini on o's teams")
    expect(take({ action: "release" }).message).toBe("released o's teams: this machine stops it within about a minute, and its owner runs it")
    expect(readFailoverLeases(agentRoot)).toEqual([])
    expect(take({ action: "release" }).message).toBe("this machine was not standing in for o's teams; nothing to release")
  })

  it("names a default reason, and replaces a stale lease on the same sense", () => {
    writeFailoverLeases(agentRoot, [lease({ machine: "machine_old" }), lease({ sense: "mail" })])
    expect(take().message).toContain("(aris-mac-mini stopped answering)")
    expect(readFailoverLeases(agentRoot).map((entry) => `${entry.sense}@${entry.machine}`)).toEqual(["mail@machine_laptop", "teams@machine_laptop"])
  })

  it("refuses without presence, for a machine-scoped sense, off the roster, or on the owner itself", () => {
    expect(take({ presence: null })).toEqual({ ok: false, message: "presence is off here or o has no roster, so there is no owner to stand in for" })
    expect(take({ sense: "cli" }).message).toContain("cli is not a shared sense")
    expect(take({ machineId: "machine_stranger" }).message).toContain("this machine is not on o's roster")
    expect(take({ machineId: MINI })).toEqual({ ok: false, message: "aris-mac-mini already owns o's teams; there is nothing to stand in for" })
    expect(readFailoverLeases(agentRoot)).toEqual([])
  })

  it("names an owner that is off the roster by its id", () => {
    const offRoster = readPresence({ presence: { ...ROSTER, owners: { teams: "machine_gone" } } }, true, [rec(LAPTOP), rec(MINI)])!
    expect(take({ presence: offRoster }).message).toContain("in place of machine_gone")
  })
})

describe("presence failover: what this machine says about it", () => {
  it("shows the lease in status, json and where i am", () => {
    const standing = presence([rec(LAPTOP), rec(MINI, { owns: ["teams"] })], [lease(), lease({ machine: "machine_other", sense: "habits" })])
    expect(presenceStatusJson({ presence: standing, machineId: LAPTOP, settings: { enabled: true } })).toMatchObject({
      owns: ["teams"],
      failover: [{ sense: "teams", from: "aris-mac-mini", since: "2026-11-10T16:55:00.000Z", reason: "the bot endpoint stopped answering for 3 min" }],
    })
    expect(presenceStatusJson({ presence: presence([rec(LAPTOP), rec(MINI)], [lease({ from: "machine_gone" })]), machineId: LAPTOP, settings: { enabled: true } }).failover[0]!.from).toBe("machine_gone")
    expect(renderPresenceStatus({ agent: "o", presence: standing, flagEnabled: true, machineId: LAPTOP, now: NOW }))
      .toContain("- teams: aris-mac-mini; this machine stands in for it since 2026-11-10T16:55:00.000Z (the bot endpoint stopped answering for 3 min)")
    const where = renderWhereAmI(standing, { machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop", os: "macOS 26", location: "office" }, NOW.getTime())
    expect(where).toContain("i am running teams here in place of aris-mac-mini since 5 min ago, because the bot endpoint stopped answering for 3 min; aris-mac-mini takes it back as soon as it runs again.")
    expect(where).not.toContain("teams (aris-mac-mini)")
    expect(renderWhereAmI(presence([rec(LAPTOP), rec(MINI)], [lease({ reason: "" })]), { machineId: LAPTOP, name: "l", role: "laptop", os: "m", location: "o" }, NOW.getTime()))
      .toContain("because it stopped answering;")
  })

  it("lets the returning owner say it runs the sense, not that it waits on the stand-in", () => {
    const back = presence([rec(LAPTOP, { owns: ["teams"], failover: ["teams"] }), rec(MINI)])
    const where = renderWhereAmI(back, { machineId: MINI, name: "aris-mac-mini", role: "always-on", os: "macOS 26", location: "home" }, NOW.getTime())
    expect(where).toContain("shared senses that run here: teams,")
    expect(where).not.toContain("waiting for")
  })

  it("publishes the stand-in's senses in its record at once, and again when it lets go", async () => {
    const bundlesRoot = path.dirname(agentRoot)
    let current = presence([rec(LAPTOP), rec(MINI)])
    const ticker = new PresenceTicker({
      agents: ["o"], bundlesRoot, machineId: LAPTOP, version: V, homeDir: path.join(tmp, "home"), now: () => NOW,
      readPresence: () => current, sync: vi.fn(async () => undefined), startSchedulers: vi.fn(), stopSchedulers: vi.fn(), schedulersRunning: () => false,
    })
    await ticker.tick()
    expect(readPeerRecords(agentRoot)[0]).toMatchObject({ owns: [] })
    expect(readPeerRecords(agentRoot)[0]!.failover).toBeUndefined()
    current = presence([rec(LAPTOP), rec(MINI)], [lease()])
    await ticker.tick()
    expect(readPeerRecords(agentRoot)[0]).toMatchObject({ owns: ["teams"], failover: ["teams"] })
    current = presence([rec(LAPTOP), rec(MINI)])
    await ticker.tick()
    expect(readPeerRecords(agentRoot)[0]!.failover).toBeUndefined()
  })
})

describe("ouro presence failover", () => {
  let homeDir: string
  let deps: OuroCliDeps
  let out: string[]

  beforeEach(() => {
    homeDir = path.join(tmp, "home")
    out = []
    deps = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: (text: string) => { out.push(text) },
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      setExitCode: vi.fn(),
      bundlesRoot: path.dirname(agentRoot),
      homeDir,
      now: () => NOW.getTime(),
    } as OuroCliDeps
  })

  it("parses take and release, with an optional reason for take", () => {
    expect(parseOuroCommand(["presence", "failover", "take", "teams", "--agent", "o"])).toEqual({ kind: "presence.failover", agent: "o", action: "take", sense: "teams" })
    expect(parseOuroCommand(["presence", "failover", "take", "teams", "--reason", "down 3 min", "--agent", "o"])).toEqual({ kind: "presence.failover", agent: "o", action: "take", sense: "teams", reason: "down 3 min" })
    expect(parseOuroCommand(["presence", "failover", "release", "teams", "--agent", "o"])).toEqual({ kind: "presence.failover", agent: "o", action: "release", sense: "teams" })
    for (const bad of [
      ["presence", "failover", "--agent", "o"], ["presence", "failover", "take", "--agent", "o"], ["presence", "failover", "grab", "teams", "--agent", "o"],
      ["presence", "failover", "release", "teams", "--reason", "x", "--agent", "o"], ["presence", "failover", "take", "teams", "--reason", "--agent", "o"],
      ["presence", "failover", "take", "teams", "--why", "x", "--agent", "o"],
    ]) expect(() => parseOuroCommand(bad)).toThrow("Usage: ouro presence")
  })

  it("takes and releases through the CLI, and status --json shows it", async () => {
    await runOuroCli(["presence", "join", "--agent", "o", "--role", "laptop", "--name", "Aris-MacBook-Pro"], deps)
    const machineId = (JSON.parse(fs.readFileSync(path.join(homeDir, ".ouro-cli", "machine.json"), "utf-8")) as { machineId: string }).machineId
    const roster = { ...ROSTER, machines: [{ machineId, name: "Aris-MacBook-Pro", role: "laptop" }, ROSTER.machines[1]] }
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ enabled: true, presence: roster }))
    writePeerRecord(agentRoot, rec(machineId))
    writePeerRecord(agentRoot, rec(MINI, { owns: ["teams"] }))
    expect(await runOuroCli(["presence", "failover", "take", "teams", "--reason", "endpoint answered 502 for 3 min", "--agent", "o"], deps))
      .toContain("Aris-MacBook-Pro now runs o's teams in place of aris-mac-mini (endpoint answered 502 for 3 min)")
    const status = JSON.parse(await runOuroCli(["presence", "status", "--agent", "o", "--json"], deps)) as { owns: string[]; failover: Array<{ sense: string }> }
    expect(status.owns).toEqual(["teams"])
    expect(status.failover).toEqual([expect.objectContaining({ sense: "teams", from: "aris-mac-mini" })])
    expect(await runOuroCli(["presence", "failover", "release", "teams", "--agent", "o"], deps)).toContain("released o's teams")
    expect(await runOuroCli(["presence", "failover", "take", "cli", "--agent", "o"], deps)).toContain("cli is not a shared sense")
    expect(deps.setExitCode).toHaveBeenCalledWith(1)
  })
})
