import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { listAllBundleAgents, listHomeBundleAgents, readAgentHomeElsewhere } from "../../../heart/daemon/agent-discovery"
import { checkAgentHomes, readUpstreamAgentConfig } from "../../../heart/daemon/agent-home"
import { generateDaemonPlist } from "../../../heart/daemon/launchd"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { writeLocalPresenceSettings, writePeerRecord } from "../../../heart/daemon/presence"

// Record freshness depends on the clock; pin it.
beforeAll(() => { vi.useFakeTimers({ now: Date.parse("2026-11-10T03:05:00.000Z"), toFake: ["Date"] }) })
afterAll(() => { vi.useRealTimers() })

const LAPTOP = "machine_laptop"
const MINI = "machine_mini"
const V = "0.1.0-alpha.1003"
const VAULT = { email: "a@ouro.bot", serverUrl: "https://vault.ouro.bot" }
const HOME = { machineId: LAPTOP, machineName: "Aris-MacBook-Pro", since: "2026-10-10T00:00:00.000Z" }
const ROSTER = {
  schema: 1,
  minVersion: V,
  machines: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop" }, { machineId: MINI, name: "aris-mac-mini", role: "always-on" }],
  owners: { teams: MINI, habits: LAPTOP },
}

let tmp: string
let bundlesRoot: string

function bundle(agent: string, config: Record<string, unknown>): string {
  const root = path.join(bundlesRoot, `${agent}.ouro`)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "agent.json"), `${JSON.stringify({ enabled: true, vault: VAULT, ...config }, null, 2)}\n`)
  return root
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "presence-discovery-"))
  bundlesRoot = path.join(tmp, "AgentBundles")
  fs.mkdirSync(bundlesRoot)
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe("discovery under a presence roster", () => {
  it("runs the agent on every roster machine when presence is on", () => {
    bundle("ouroboros", { home: HOME, presence: ROSTER })
    const rows = listAllBundleAgents({ bundlesRoot, machineId: MINI, hostnameAliases: [], presenceEnabled: true })
    expect(rows).toEqual([expect.objectContaining({ name: "ouroboros", homeState: "here", presence: true })])
    expect(listHomeBundleAgents({ bundlesRoot, machineId: MINI, hostnameAliases: [], presenceEnabled: true })).toEqual(["ouroboros"])
    expect(listHomeBundleAgents({ bundlesRoot, machineId: LAPTOP, hostnameAliases: [], presenceEnabled: true })).toEqual(["ouroboros"])
  })

  it("keeps today's one-home behaviour with the flag off, even when the bundle has a roster (mixed versions)", () => {
    bundle("ouroboros", { home: HOME, presence: ROSTER })
    const legacy = listAllBundleAgents({ bundlesRoot, machineId: MINI, hostnameAliases: [], presenceEnabled: false })
    const today = (() => {
      fs.writeFileSync(path.join(bundlesRoot, "ouroboros.ouro", "agent.json"), JSON.stringify({ enabled: true, vault: VAULT, home: HOME }))
      return listAllBundleAgents({ bundlesRoot, machineId: MINI, hostnameAliases: [], presenceEnabled: false })
    })()
    expect(legacy).toEqual(today)
    expect(legacy[0]).toEqual(expect.objectContaining({ homeState: "elsewhere" }))
    expect(legacy[0]!.presence).toBeUndefined()
  })

  it("leaves machines off the roster to the home lease, and counts presence as holding a home", () => {
    bundle("ouroboros", { home: HOME, presence: ROSTER })
    bundle("homeless", {})
    expect(listAllBundleAgents({ bundlesRoot, machineId: "machine_other", hostnameAliases: [], presenceEnabled: true }).map((row) => row.homeState)).toEqual(["fallback", "elsewhere"])
    expect(listAllBundleAgents({ bundlesRoot, machineId: MINI, hostnameAliases: [], presenceEnabled: true }).map((row) => row.homeState)).toEqual(["unclaimed", "here"])
  })

  it("reads the local flag when the caller does not say", () => {
    bundle("ouroboros", { home: HOME, presence: ROSTER })
    vi.stubEnv("OURO_PRESENCE", "1")
    try {
      expect(listAllBundleAgents({ bundlesRoot, machineId: MINI, hostnameAliases: [] })[0]!.presence).toBe(true)
      expect(readAgentHomeElsewhere(path.join(bundlesRoot, "ouroboros.ouro"), MINI)).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("lets a roster machine take turns while home names another machine", () => {
    const root = bundle("ouroboros", { home: HOME, presence: ROSTER })
    expect(readAgentHomeElsewhere(root, MINI, true)).toBeNull()
    expect(readAgentHomeElsewhere(root, MINI, false)).toEqual(expect.objectContaining({ machineId: LAPTOP }))
    expect(readAgentHomeElsewhere(root, "machine_other", true)).toEqual(expect.objectContaining({ machineId: LAPTOP }))
  })
})

describe("lease checks for agents present by roster", () => {
  it("accepts an upstream roster that still lists this machine, and skips an unknown upstream", async () => {
    bundle("ouroboros", { home: HOME, presence: ROSTER })
    const readUpstreamHome = vi.fn(async () => HOME)
    const ok = await checkAgentHomes({ managedAgents: ["ouroboros"], machineId: MINI, bundlesRoot, presenceEnabled: true, readUpstreamHome, readUpstreamConfig: async () => ({ home: HOME, presence: ROSTER }) })
    expect(ok.displaced).toEqual([])
    expect(readUpstreamHome).not.toHaveBeenCalled()
    const unknown = await checkAgentHomes({ managedAgents: ["ouroboros"], machineId: MINI, bundlesRoot, presenceEnabled: true, readUpstreamConfig: async () => undefined })
    expect(unknown.displaced).toEqual([])
  })

  it("stops the agent when the upstream roster dropped this machine and home is elsewhere", async () => {
    bundle("ouroboros", { home: HOME, presence: ROSTER })
    const dropped = await checkAgentHomes({
      managedAgents: ["ouroboros"], machineId: MINI, bundlesRoot, presenceEnabled: true,
      readUpstreamConfig: async () => ({ home: HOME, presence: { ...ROSTER, machines: [ROSTER.machines[0]] } }),
    })
    expect(dropped.displaced).toEqual(["ouroboros"])
    expect(dropped.health.message).toContain("left the presence roster and moved to Aris-MacBook-Pro")
    const noHome = await checkAgentHomes({
      managedAgents: ["ouroboros"], machineId: MINI, bundlesRoot, presenceEnabled: true,
      readUpstreamConfig: async () => ({}),
    })
    expect(noHome.displaced).toEqual([])
    const homeHere = await checkAgentHomes({
      managedAgents: ["ouroboros"], machineId: MINI, bundlesRoot, presenceEnabled: true,
      readUpstreamConfig: async () => ({ home: { machineId: MINI, machineName: "mini" } }),
    })
    expect(homeHere.displaced).toEqual([])
  })

  it("reads no upstream config for a bundle without sync", async () => {
    const root = bundle("ouroboros", { home: HOME })
    expect(await readUpstreamAgentConfig(root)).toBeUndefined()
  })
})

describe("daemon plist Nice", () => {
  const base = { nodePath: "/n", entryPath: "/e", socketPath: "/s" }
  it("adds Nice only when set to a non-zero integer", () => {
    expect(generateDaemonPlist({ ...base, nice: 10 })).toContain("<key>Nice</key>\n  <integer>10</integer>")
    expect(generateDaemonPlist({ ...base, nice: 0 })).not.toContain("Nice")
    expect(generateDaemonPlist({ ...base, nice: 2.5 })).not.toContain("Nice")
    expect(generateDaemonPlist(base)).not.toContain("Nice")
  })
})

describe("sense ownership in the daemon", () => {
  afterEach(() => {
    vi.doUnmock("../../../heart/daemon/process-manager")
    vi.resetModules()
  })

  it("skips a shared sense another machine owns, and follows handoffs both ways", async () => {
    bundle("slugger", { senses: { teams: { enabled: true }, mail: { enabled: true }, shepherd: { enabled: false } } })
    let options: { configCheck: (name: string) => Promise<{ ok: boolean; skip?: boolean; error?: string }> } | null = null
    const snapshots: Array<{ name: string; status: string; pid?: number | null }> = []
    const startAgent = vi.fn(async (name: string) => { snapshots.push({ name, status: "running", pid: 42 }) })
    const stopAgent = vi.fn(async (name: string) => { snapshots.splice(snapshots.findIndex((row) => row.name === name), 1) })
    vi.resetModules()
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class {
        constructor(opts: typeof options) { options = opts }
        startAgent = startAgent
        stopAgent = stopAgent
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = () => snapshots
      },
    }))
    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    let ownsTeams = false
    let presenceApplies = true
    let flagOn = true
    const manager = new DaemonSenseManager({
      agents: ["slugger"],
      bundlesRoot,
      presenceFlagOn: () => flagOn,
      presenceOwner: (_agent, sense) => (presenceApplies && sense === "teams" ? { owns: ownsTeams, owner: ownsTeams ? MINI : LAPTOP } : null),
    })
    const skipped = await options!.configCheck("slugger:teams")
    expect(skipped).toEqual({ ok: false, skip: true, error: "teams: not owner; slugger's presence roster gives it to machine_laptop" })

    await manager.reconcilePresence()
    expect(startAgent).not.toHaveBeenCalled()
    ownsTeams = true
    await manager.reconcilePresence()
    expect(startAgent).toHaveBeenCalledWith("slugger:teams")
    await manager.reconcilePresence()
    expect(startAgent).toHaveBeenCalledTimes(1)
    ownsTeams = false
    await manager.reconcilePresence()
    expect(stopAgent).toHaveBeenCalledWith("slugger:teams")
    // The flag is turned off here at runtime: keep holding until the daemon restarts and publishes the leave.
    presenceApplies = false
    flagOn = false
    await manager.reconcilePresence()
    expect(startAgent).toHaveBeenCalledTimes(1)
    // The roster goes away while presence stays on: back to the home lease, so the held sense starts again.
    flagOn = true
    await manager.reconcilePresence()
    expect(startAgent).toHaveBeenCalledTimes(2)
    await manager.reconcilePresence()
    expect(startAgent).toHaveBeenCalledTimes(2)
  })

  it("says another machine when the roster names no owner", async () => {
    bundle("slugger", { senses: { teams: { enabled: true } } })
    let options: { configCheck: (name: string) => Promise<{ ok: boolean; skip?: boolean; error?: string }> } | null = null
    vi.resetModules()
    vi.doMock("../../../heart/daemon/process-manager", () => ({
      DaemonProcessManager: class {
        constructor(opts: typeof options) { options = opts }
        startAutoStartAgents = vi.fn(async () => undefined)
        stopAll = vi.fn(async () => undefined)
        listAgentSnapshots = () => [{ name: "slugger:teams", status: "stopped" }]
      },
    }))
    const { DaemonSenseManager } = await import("../../../heart/daemon/sense-manager")
    const manager = new DaemonSenseManager({ agents: ["slugger"], bundlesRoot, presenceOwner: () => ({ owns: false, owner: null }) })
    expect((await options!.configCheck("slugger:teams")).error).toBe("teams: not owner; slugger's presence roster gives it to another machine")
    await expect(manager.reconcilePresence()).resolves.toBeUndefined()
  })
})

describe("ouro presence", () => {
  let homeDir: string
  let out: string[]
  let deps: OuroCliDeps

  beforeEach(() => {
    homeDir = path.join(tmp, "home")
    fs.mkdirSync(homeDir)
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
      bundlesRoot,
      homeDir,
      now: () => Date.parse("2026-11-10T04:00:00.000Z"),
    } as OuroCliDeps
  })

  it("parses join, handoff, status and location, and refuses anything else", () => {
    expect(parseOuroCommand(["presence", "join", "--agent", "o", "--role", "always-on", "--name", "mini"])).toEqual({ kind: "presence.join", agent: "o", role: "always-on", name: "mini" })
    expect(parseOuroCommand(["presence", "join", "--agent", "o"])).toEqual({ kind: "presence.join", agent: "o" })
    expect(parseOuroCommand(["presence", "handoff", "teams", "mini", "--agent", "o"])).toEqual({ kind: "presence.handoff", agent: "o", sense: "teams", machine: "mini" })
    expect(parseOuroCommand(["presence", "status", "--agent", "o"])).toEqual({ kind: "presence.status", agent: "o" })
    expect(parseOuroCommand(["presence", "location", "office"])).toEqual({ kind: "presence.location", location: "office" })
    for (const bad of [["presence"], ["presence", "status"], ["presence", "location"], ["presence", "join", "--agent", "o", "--role"], ["presence", "join", "--agent", "o", "--bogus", "x"], ["presence", "handoff", "teams", "--agent", "o"], ["presence", "nope", "--agent", "o"]]) {
      expect(() => parseOuroCommand(bad)).toThrow("Usage: ouro presence")
    }
  })

  it("joins this machine, turns presence on, shows status, hands a sense off, and records the location", async () => {
    bundle("o", { home: HOME })
    const joined = await runOuroCli(["presence", "join", "--agent", "o", "--role", "always-on", "--name", "aris-mac-mini"], deps)
    expect(joined).toContain("aris-mac-mini (always-on) is on o's roster")
    expect(joined).toContain("presence is on for this machine")
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, ".ouro-cli", "presence.json"), "utf-8"))).toEqual({ enabled: true })
    const machineId = (JSON.parse(fs.readFileSync(path.join(homeDir, ".ouro-cli", "machine.json"), "utf-8")) as { machineId: string }).machineId
    expect(await runOuroCli(["presence", "status", "--agent", "o"], deps)).toContain("- aris-mac-mini (this machine): always-on; no presence record yet")
    expect(JSON.parse(await runOuroCli(["presence", "status", "--agent", "o", "--json"], deps))).toEqual(expect.objectContaining({ enabled: true, owns: [], legacy: ["aris-mac-mini", "machine_laptop"] }))
    writePeerRecord(path.join(bundlesRoot, "o.ouro"), { machineId, version: V, seenAt: "2026-11-10T04:00:00.000Z" })
    // home (the laptop) is not on the roster, so a home-only daemon there may still run teams: refused.
    const handed = await runOuroCli(["presence", "handoff", "teams", "aris-mac-mini", "--agent", "o"], deps)
    expect(handed).toContain("machine_laptop may still run a daemon that only knows `home`")
    expect(await runOuroCli(["presence", "location", "office"], deps)).toBe("this machine's location is now office")
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, ".ouro-cli", "presence.json"), "utf-8"))).toEqual({ enabled: true, location: "office" })
  })

  it("names the machine after its hostname with a default role", async () => {
    bundle("o", {})
    expect(await runOuroCli(["presence", "join", "--agent", "o"], deps)).toContain("(peer) is on o's roster")
  })

  it("reports failures with a non-zero exit", async () => {
    expect(await runOuroCli(["presence", "status", "--agent", "missing"], deps)).toContain("cannot read missing's agent.json")
    expect(deps.setExitCode).toHaveBeenCalledWith(1)
    bundle("o", {})
    expect(await runOuroCli(["presence", "handoff", "teams", "x", "--agent", "o"], deps)).toContain("o has no presence roster")
    expect(await runOuroCli(["presence", "join", "--agent", "missing"], deps)).toContain("cannot read")
  })

  it("shows status while presence is off on this machine", async () => {
    bundle("o", { presence: ROSTER })
    writeLocalPresenceSettings({ enabled: false }, homeDir)
    expect(await runOuroCli(["presence", "status", "--agent", "o"], deps)).toContain("presence is off on this machine")
  })
})

describe("ouro presence status --json", () => {
  it("prints this machine, its peers and what it owns", async () => {
    const { presenceStatusJson } = await import("../../../heart/daemon/presence-roster")
    const { readPresence } = await import("../../../heart/daemon/presence")
    expect(parseOuroCommand(["presence", "status", "--json", "--agent", "o"])).toEqual({ kind: "presence.status", agent: "o", json: true })
    const presence = readPresence({ home: HOME, presence: ROSTER }, true, [{ machineId: LAPTOP, version: V, seenAt: "2026-11-10T03:59:00.000Z", location: "office" }, { machineId: MINI, version: V, seenAt: "2026-11-10T03:58:00.000Z" }])
    expect(presenceStatusJson({ presence, machineId: MINI, settings: { enabled: true } })).toEqual({
      enabled: true,
      machine: { machineId: MINI, name: "aris-mac-mini", role: "always-on", location: "home" },
      peers: [{ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop", seenAt: "2026-11-10T03:59:00.000Z", version: V, location: "office" }],
      owns: ["teams"],
      owners: { teams: "aris-mac-mini", telegram: "Aris-MacBook-Pro", mail: "Aris-MacBook-Pro", bluebubbles: "Aris-MacBook-Pro", voice: "Aris-MacBook-Pro", a2a: "Aris-MacBook-Pro", habits: "Aris-MacBook-Pro" },
      legacy: [],
    })
    const legacy = readPresence({ presence: { ...ROSTER, owners: { teams: "machine_gone" } } }, true, [])
    const json = presenceStatusJson({ presence: legacy, machineId: LAPTOP, settings: { enabled: true, location: "office" } })
    expect(json.machine).toEqual({ machineId: LAPTOP, name: "Aris-MacBook-Pro", role: "laptop", location: "office" })
    expect(json.peers[0]).toEqual({ machineId: MINI, name: "aris-mac-mini", role: "always-on", seenAt: null, version: null, location: null })
    expect(json.legacy).toEqual(["Aris-MacBook-Pro", "aris-mac-mini"])
    expect(json.owners.teams).toBe("machine_gone")
    expect(presenceStatusJson({ presence: legacy, machineId: "machine_x", settings: { enabled: true } }).machine).toEqual({ machineId: "machine_x", name: null, role: null, location: null })
    expect(presenceStatusJson({ presence: null, machineId: MINI, settings: { enabled: false } })).toEqual({ enabled: false, machine: null, peers: [], owns: [], owners: {}, legacy: [] })
  })
})

describe("ouro rollback below presence", () => {
  it("leaves this machine's presence rosters, and says so", async () => {
    const homeDir = path.join(tmp, "home")
    fs.mkdirSync(path.join(homeDir, ".ouro-cli"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".ouro-cli", "machine.json"), JSON.stringify({ schemaVersion: 1, machineId: MINI, createdAt: "x", updatedAt: "x", hostnameAliases: [] }))
    const root = bundle("o", { presence: ROSTER })
    writePeerRecord(root, { machineId: MINI, version: V, seenAt: "2026-11-10T03:00:00.000Z" })
    const base = {
      socketPath: "/tmp/ouro-test.sock",
      sendCommand: vi.fn(async () => { throw new Error("no daemon") }),
      startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
      writeStdout: vi.fn(),
      checkSocketAlive: vi.fn(async () => false),
      cleanupStaleSocket: vi.fn(),
      fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
      setExitCode: vi.fn(),
      bundlesRoot,
      homeDir,
      getCurrentCliVersion: () => V,
      getPreviousCliVersion: () => "0.1.0-alpha.988",
      activateCliVersion: vi.fn(),
      listCliVersions: () => [V, "0.1.0-alpha.988"],
    } as unknown as OuroCliDeps
    const message = await runOuroCli(["rollback"], base)
    expect(message).toContain("rolled back to 0.1.0-alpha.988")
    expect(message).toContain("this machine left the presence roster of o, so their shared senses stay with home")
    expect(fs.existsSync(path.join(root, "presence", `${MINI}.json`))).toBe(false)
    const again = await runOuroCli(["rollback", "0.1.0-alpha.988"], base)
    expect(again).not.toContain("left the presence roster")
    // A bundle whose sync cannot publish the leave refuses the rollback unless forced.
    const syncing = bundle("s", { presence: ROSTER, sync: { enabled: true, remote: "origin" } })
    writePeerRecord(syncing, { machineId: MINI, version: V, seenAt: "2026-11-10T03:00:00.000Z" })
    const refused = await runOuroCli(["rollback"], { ...base, syncLockWaitMs: 0 } as OuroCliDeps)
    expect(refused).toContain("could not publish that this machine left s's presence roster, so nothing was rolled back")
    writePeerRecord(syncing, { machineId: MINI, version: V, seenAt: "2026-11-10T03:00:00.000Z" })
    expect(await runOuroCli(["rollback", "--force"], { ...base, syncLockWaitMs: 0 } as OuroCliDeps)).toContain("left the presence roster of s")
    fs.rmSync(path.join(homeDir, ".ouro-cli", "machine.json"))
    writePeerRecord(root, { machineId: MINI, version: V, seenAt: "2026-11-10T03:00:00.000Z" })
    expect(await runOuroCli(["rollback"], base)).not.toContain("left the presence roster")
    expect(parseOuroCommand(["rollback", "--force"])).toEqual({ kind: "rollback", force: true })
    expect(parseOuroCommand(["rollback", "0.1.0-alpha.74", "--force"])).toEqual({ kind: "rollback", version: "0.1.0-alpha.74", force: true })
  })
})
